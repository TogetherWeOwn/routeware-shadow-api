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
 * Returns the break position, or `null` when the buffer is exhausted (or ends on a
 * bare `\r` whose `\n` may still be coming) and more input is needed. `scannedTo`
 * is how far the scan got — the caller must resume from there rather than
 * rescanning, or already-seen quotes would be counted twice and flip the state.
 */
function scanForLineBreak(
  buffer: string,
  from: number,
  inQuotes: boolean
): { at: LineBreak | null; scannedTo: number; inQuotes: boolean } {
  let i = from;
  let quoted = inQuotes;

  while (i < buffer.length) {
    const ch = buffer[i];

    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped literal, not a toggle.
      //
      // Unlike the `\r` case below, this deliberately needs NO end-of-buffer
      // guard, even though `buffer[i + 1]` may be undefined mid-stream when the
      // two halves of a `""` pair straddle a chunk boundary. If the trailing `"`
      // really was half of a pair, we toggle here and toggle straight back on the
      // next `"` when more data arrives — same net state as consuming the pair,
      // because nothing sits between them to be judged under the wrong state. If
      // it was a genuine closing quote, the toggle was right to begin with.
      // Either way the result matches parsing the same bytes unchunked.
      if (quoted && buffer[i + 1] === '"') {
        i += 2;
        continue;
      }
      quoted = !quoted;
      i += 1;
      continue;
    }

    if (quoted) {
      i += 1;
      continue;
    }

    if (ch === "\n") {
      return { at: { end: i, nextStart: i + 1 }, scannedTo: i, inQuotes: quoted };
    }

    if (ch === "\r") {
      if (i + 1 >= buffer.length) {
        // Can't tell CR from CRLF yet; resume here once more data arrives.
        return { at: null, scannedTo: i, inQuotes: quoted };
      }
      const nextStart = buffer[i + 1] === "\n" ? i + 2 : i + 1;
      return { at: { end: i, nextStart }, scannedTo: i, inQuotes: quoted };
    }

    i += 1;
  }

  return { at: null, scannedTo: i, inQuotes: quoted };
}

/**
 * Read CSV from a body stream, yielding one **logical** line at a time
 * (RFC 4180–style: newlines inside quoted fields do not end a line).
 * Avoids `await response.text()` for whole-file memory use.
 *
 * **EOF:** If the file ends without a closing `"` (stray quote / inch mark in a cell),
 * we still yield the final buffer as one line instead of failing — many Routeware
 * exports are not strictly well-formed.
 */
export async function* streamCsvLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let buffer = "";
  let inQuotes = false;
  // First byte of `buffer` not yet scanned. Carried across reads: restarting at 0
  // would re-toggle quote state over the already-scanned prefix and split lines
  // inside quoted fields whenever a chunk boundary lands mid-field.
  let scanFrom = 0;

  try {
    for (;;) {
      for (;;) {
        const scan = scanForLineBreak(buffer, scanFrom, inQuotes);
        inQuotes = scan.inQuotes;
        if (!scan.at) {
          scanFrom = scan.scannedTo;
          break;
        }
        const line = buffer.slice(0, scan.at.end);
        buffer = buffer.slice(scan.at.nextStart);
        scanFrom = 0;
        if (line.length > 0) {
          yield line;
        }
      }

      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const r = await reader.read();
        done = r.done;
        value = r.value;
      } catch (e) {
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
