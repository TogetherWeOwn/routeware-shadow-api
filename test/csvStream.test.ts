import { describe, expect, it } from "vitest";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";

/** Emit the given strings as separate stream chunks, to control chunk boundaries. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of streamCsvLines(stream)) {
    lines.push(line);
  }
  return lines;
}

describe("streamCsvLines", () => {
  it("splits plain lines", async () => {
    // Arrange
    const stream = stringToUint8Stream("a,b\nc,d\n");

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(["a,b", "c,d"]);
  });

  it("does not split on a newline inside a quoted field", async () => {
    // Arrange — entirely within one chunk
    const stream = stringToUint8Stream('a,"line1\nline2"\nb,c\n');

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(['a,"line1\nline2"', "b,c"]);
  });

  it("keeps quote state correct when a quoted field spans a chunk boundary", async () => {
    // Arrange — the quoted field is split across two reads. This is the realistic
    // case for a large Routeware export, where chunk boundaries land inside
    // quoted cells.
    const stream = chunkedStream(['a,"line1\n', 'line2"\nb,c\n']);

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(['a,"line1\nline2"', "b,c"]);
  });

  it("keeps quote state correct across many chunk boundaries", async () => {
    // Arrange
    const stream = chunkedStream(['id,note\n1,"a', "b", "c", '"\n2,"x\ny"\n']);

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(["id,note", '1,"abc"', '2,"x\ny"']);
  });

  it("handles CRLF line endings", async () => {
    // Arrange
    const stream = stringToUint8Stream("a,b\r\nc,d\r\n");

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(["a,b", "c,d"]);
  });

  it("yields a trailing unterminated line at EOF", async () => {
    // Arrange
    const stream = stringToUint8Stream("a,b\nc,d");

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(["a,b", "c,d"]);
  });

  it("yields the remainder when the file ends inside an unclosed quote", async () => {
    // Arrange — Routeware exports are not always well-formed; a stray inch mark
    // must not swallow the rest of the file.
    const stream = stringToUint8Stream('a,b\nc,"unclosed');

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(["a,b", 'c,"unclosed']);
  });

  it("treats a doubled quote as an escaped literal, not a state toggle", async () => {
    // Arrange
    const stream = stringToUint8Stream('a,"say ""hi"" now"\nb,c\n');

    // Act
    const lines = await collect(stream);

    // Assert
    expect(lines).toEqual(['a,"say ""hi"" now"', "b,c"]);
  });
});
