/** Expose a UTF-8 string as a one-chunk `ReadableStream` (small fixtures / `sync*FromCsvText` fallback). */
export function stringToUint8Stream(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    }
  });
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

  for (;;) {
    let i = 0;
    while (i < buffer.length) {
      const ch = buffer[i];
      if (ch === '"') {
        if (inQuotes && buffer[i + 1] === '"') {
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i += 1;
        continue;
      }
      if (!inQuotes) {
        if (ch === "\n") {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          i = 0;
          if (line.length > 0) {
            yield line;
          }
          continue;
        }
        if (ch === "\r") {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === "\n") {
              const line = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              i = 0;
              if (line.length > 0) {
                yield line;
              }
              continue;
            }
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            i = 0;
            if (line.length > 0) {
              yield line;
            }
            continue;
          }
          break;
        }
      }
      i += 1;
    }

    const { done, value } = await reader.read();
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
}
