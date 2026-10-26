import { readWithStallTimeout, UpstreamTimeoutError } from "./upstreamTimeout";

/** Options for `streamCsvLines`. */
export type StreamCsvLinesOptions = {
  /**
   * Idle stall bound in ms: a `reader.read()` pending with no bytes for this
   * long rejects with a top-level `UpstreamTimeoutError` (which `app.onError`
   * maps to 502) and cancels the read. Each completed read resets the window,
   * so slow-but-progressing streams complete. A positive number enables the
   * bound; `undefined` (or a non-positive number) leaves the stream unbounded
   * — the report sync path always passes the env-derived bound, while
   * operator imports and in-memory fallbacks stay unbounded.
   */
  stallTimeoutMs?: number;
};

/** Expose a UTF-8 string as a one-chunk `ReadableStream` (small fixtures / `sync*FromCsvText` fallback). */
export function stringToUint8Stream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    }
  });
}

/** Where a logical line ends, and where the next one starts. */
type LineBreak = { end: number; nextStart: number };

/**
 * Scan `buffer` from `from` for the next unquoted line terminator, tracking quote
 * state as it goes.
 *
 * A `"` opens a quoted field only at field start (line start or just after a
 * delimiter comma, tolerating spaces/tabs); a mid-field `"` is a literal stray
 * (inch mark), not a multiline open — otherwise one bad cell silently swallows
 * every following row. `""` inside a quoted field is still an
 * escaped literal, and a `"` while already quoted still closes.
 *
 * Returns the break position, or `null` when the buffer is exhausted (or ends on a
 * bare `\r` whose `\n` may still be coming, or ends on a `"` inside quotes that
 * may be half of a straddling `""` pair) and more input is needed. `scannedTo`
 * is how far the scan got — the caller must resume from there rather than
 * rescanning, or already-seen quotes would be counted twice and flip the state.
 * `fieldStart` (whether position `from` starts a field) is carried the same way.
 */
function scanForLineBreak(
  buffer: string,
  from: number,
  inQuotes: boolean,
  fieldStart: boolean
): { at: LineBreak | null; scannedTo: number; inQuotes: boolean; fieldStart: boolean } {
  let i = from;
  let quoted = inQuotes;
  let start = fieldStart;

  while (i < buffer.length) {
    const ch = buffer[i];

    if (ch === '"') {
      if (quoted) {
        if (i + 1 >= buffer.length) {
          // Can't tell a closing quote from half of a `""` escape pair
          // straddling a chunk boundary yet; resume here once more data
          // arrives so the pair is judged exactly as unchunked input.
          return { at: null, scannedTo: i, inQuotes: quoted, fieldStart: start };
        }
        // A doubled quote inside a quoted field is an escaped literal, not a toggle.
        if (buffer[i + 1] === '"') {
          i += 2;
          continue;
        }
        quoted = false;
        start = false;
        i += 1;
        continue;
      }
      if (start) {
        quoted = true;
        start = false;
        i += 1;
        continue;
      }
      // Literal stray quote mid-field (e.g. `5" widget`): no state change.
      i += 1;
      continue;
    }

    if (quoted) {
      i += 1;
      continue;
    }

    if (ch === "\n") {
      return { at: { end: i, nextStart: i + 1 }, scannedTo: i, inQuotes: quoted, fieldStart: start };
    }

    if (ch === "\r") {
      if (i + 1 >= buffer.length) {
        // Can't tell CR from CRLF yet; resume here once more data arrives.
        return { at: null, scannedTo: i, inQuotes: quoted, fieldStart: start };
      }
      const nextStart = buffer[i + 1] === "\n" ? i + 2 : i + 1;
      return { at: { end: i, nextStart }, scannedTo: i, inQuotes: quoted, fieldStart: start };
    }

    if (ch === ",") {
      start = true;
    } else if (ch !== " " && ch !== "\t") {
      start = false;
    }
    i += 1;
  }

  return { at: null, scannedTo: i, inQuotes: quoted, fieldStart: start };
}

/**
 * Read CSV from a body stream, yielding one **logical** line at a time
 * (RFC 4180–style: newlines inside quoted fields do not end a line).
 * Avoids `await response.text()` for whole-file memory use.
 *
 * **EOF:** If the file ends without a closing `"` (stray quote / inch mark in a cell),
 * we still yield the final buffer as one line instead of failing — many Routeware
 * exports are not strictly well-formed.
 *
 * **Stall bound:** with `options.stallTimeoutMs` set, a gap with no bytes for
 * that long rejects with a top-level `UpstreamTimeoutError` (502 via
 * `app.onError`) and cancels the read; each completed read resets the window.
 */
export async function* streamCsvLines(
  body: ReadableStream<Uint8Array>,
  options?: StreamCsvLinesOptions
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const stallTimeoutMs = options?.stallTimeoutMs;
  const stalled = typeof stallTimeoutMs === "number" && stallTimeoutMs > 0;
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let buffer = "";
  let inQuotes = false;
  // First byte of `buffer` not yet scanned, plus whether it starts a field.
  // Carried across reads: restarting at 0 would re-toggle quote state over the
  // already-scanned prefix and split lines inside quoted fields whenever a
  // chunk boundary lands mid-field.
  let scanFrom = 0;
  let scanFieldStart = true;

  try {
    for (;;) {
      for (;;) {
        const scan = scanForLineBreak(buffer, scanFrom, inQuotes, scanFieldStart);
        inQuotes = scan.inQuotes;
        if (!scan.at) {
          scanFrom = scan.scannedTo;
          scanFieldStart = scan.fieldStart;
          break;
        }
        const line = buffer.slice(0, scan.at.end);
        buffer = buffer.slice(scan.at.nextStart);
        scanFrom = 0;
        scanFieldStart = true;
        if (line.length > 0) {
          yield line;
        }
      }

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const r =
          stalled && stallTimeoutMs !== undefined
            ? await readWithStallTimeout(reader, stallTimeoutMs)
            : await reader.read();
        done = r.done;
        value = r.value;
      } catch (e) {
        // A stall timeout travels top-level so `app.onError` maps it to 502;
        // wrapping it here would misreport a bounded timeout as a 500.
        if (e instanceof UpstreamTimeoutError) {
          throw e;
        }
        const m = e instanceof Error ? e.message : String(e);
        throw new Error(
          `CSV stream read failed (upstream closed, timeout, or client disconnect): ${m}`,
          { cause: e }
        );
      }

      if (value && value.byteLength) {
        buffer += decoder.decode(value, { stream: !done });
      } else if (!value && !done) {
        continue;
      }

      if (done) {
        buffer += decoder.decode();
        if (buffer.length) {
          yield buffer;
        }
        return;
      }
    }
  } finally {
    // Release on every exit — normal return, throw, and a consumer `break`
    // (which invokes this generator's return()). A leaked lock would make the
    // stream impossible to cancel or re-read.
    reader.releaseLock();
  }
}
