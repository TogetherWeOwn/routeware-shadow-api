import { describe, expect, it, vi } from "vitest";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { archiveReportCsvToR2AfterD1 } from "../src/lib/r2SnapshotArchive";
import {
  DEFAULT_REPORT_STREAM_STALL_TIMEOUT_MS,
  readReportStreamStallTimeoutMs,
  readWithStallTimeout,
  UpstreamTimeoutError
} from "../src/lib/upstreamTimeout";

/**
 * R10-05 builder edges: timer-reset/cancel behavior around the stall bound
 * that the paired acceptance file (`test/streamedReportStallBound.test.ts`)
 * does not pin. No network, no credentials.
 */

const STALL_MS = 50;

function stalledBody(prefix: string): {
  body: ReadableStream<Uint8Array>;
  cancel: ReturnType<typeof vi.fn>;
  close: () => void;
} {
  const cancel = vi.fn();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (prefix) {
        c.enqueue(new TextEncoder().encode(prefix));
      }
    },
    cancel(...args: unknown[]) {
      (cancel as (...a: unknown[]) => void)(...args);
      try {
        controller?.close();
      } catch {
        // Already closed.
      }
    }
  });
  return {
    body,
    cancel,
    close() {
      try {
        controller?.close();
      } catch {
        // Already closed or cancelled.
      }
    }
  };
}

function dripStream(chunks: string[], intervalMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++] ?? "";
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      controller.enqueue(encoder.encode(chunk));
    }
  });
}

async function collectLines(body: ReadableStream<Uint8Array>, stallTimeoutMs?: number): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of streamCsvLines(body, { stallTimeoutMs })) {
    lines.push(line);
  }
  return lines;
}

describe("streamCsvLines stall edges", () => {
  it("cancels the stalled read and throws the timeout top-level (never wrapped)", async () => {
    const src = stalledBody("a,b\nc,");
    try {
      const error = await collectLines(src.body, STALL_MS).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(UpstreamTimeoutError);
      expect((error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
      // The read-guard wrap would misreport a bounded timeout as a 500.
      expect((error as Error).message).not.toContain("CSV stream read failed");
      expect((error as Error).cause).toBeUndefined();
      expect(src.cancel).toHaveBeenCalledTimes(1);
    } finally {
      src.close();
    }
  });

  it("resets the window on every read: gaps near the bound still complete", async () => {
    // 8 reads x 30ms gaps = ~240ms total, far past STALL_MS, but no single
    // gap trips the bound because each completed read restarts the window.
    const text = "r0c0,r0c1\nr1c0,r1c1\nr2c0,r2c1\nr3c0,r3c1\n";
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 4) {
      chunks.push(text.slice(i, i + 4));
    }
    expect(chunks.length).toBeGreaterThanOrEqual(8);

    const lines = await collectLines(dripStream(chunks, 30), STALL_MS);
    expect(lines).toEqual(["r0c0,r0c1", "r1c0,r1c1", "r2c0,r2c1", "r3c0,r3c1"]);
  });

  it("leaves the stream unbounded when the stall bound is absent or non-positive", async () => {
    await expect(collectLines(stringToUint8Stream("a,b\n"), undefined)).resolves.toEqual([
      "a,b"
    ]);
    await expect(collectLines(stringToUint8Stream("a,b\n"), 0)).resolves.toEqual(["a,b"]);
    await expect(collectLines(stringToUint8Stream("a,b\n"), -1)).resolves.toEqual(["a,b"]);
  });

  it("still wraps non-timeout read failures with their cause", async () => {
    const boom = new Error("upstream reset");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(boom);
      }
    });
    const error = await collectLines(body, STALL_MS).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpstreamTimeoutError);
    expect((error as Error).message).toContain("CSV stream read failed");
    expect((error as Error).cause).toBe(boom);
  });
});

describe("readWithStallTimeout", () => {
  it("resolves the read result when bytes arrive in time", async () => {
    const reader = stringToUint8Stream("x").getReader();
    try {
      const first = await readWithStallTimeout(reader, STALL_MS);
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBeGreaterThan(0);
      const second = await readWithStallTimeout(reader, STALL_MS);
      expect(second.done).toBe(true);
    } finally {
      reader.releaseLock();
    }
  });

  it("rethrows a non-timeout read error verbatim", async () => {
    const boom = new Error("socket reset");
    const reader = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(boom);
      }
    }).getReader();
    try {
      await expect(readWithStallTimeout(reader, STALL_MS)).rejects.toBe(boom);
    } finally {
      reader.releaseLock();
    }
  });
});

describe("readReportStreamStallTimeoutMs", () => {
  it("defaults to 30s without env", () => {
    expect(DEFAULT_REPORT_STREAM_STALL_TIMEOUT_MS).toBe(30_000);
    expect(readReportStreamStallTimeoutMs()).toBe(30_000);
    expect(readReportStreamStallTimeoutMs({} as unknown as Env)).toBe(30_000);
  });

  it("honors a positive binding as string or number", () => {
    expect(
      readReportStreamStallTimeoutMs({
        REPORT_STREAM_STALL_TIMEOUT_MS: "5000"
      } as unknown as Env)
    ).toBe(5_000);
    expect(
      readReportStreamStallTimeoutMs({
        REPORT_STREAM_STALL_TIMEOUT_MS: 7_500
      } as unknown as Env)
    ).toBe(7_500);
  });

  it("falls back to the default on absent or invalid bindings", () => {
    for (const value of [0, -1, "0", "-5", "abc", "", null]) {
      expect(
        readReportStreamStallTimeoutMs({
          REPORT_STREAM_STALL_TIMEOUT_MS: value
        } as unknown as Env)
      ).toBe(30_000);
    }
  });
});

describe("R2 archive drain stall bound", () => {
  it("fails a stalled upstream drain as a timeout before sync ever runs", async () => {
    const src = stalledBody("CustomerID,Enabled\n1,");
    const sync = vi.fn(async (_stream: ReadableStream<Uint8Array>) => "synced");
    const env = {
      SNAPSHOTS: {},
      REPORT_STREAM_STALL_TIMEOUT_MS: String(STALL_MS)
    } as unknown as Env;
    try {
      const error = await archiveReportCsvToR2AfterD1(env, "customer", src.body, sync).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(UpstreamTimeoutError);
      expect((error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
      expect(sync).not.toHaveBeenCalled();
      expect(src.cancel).toHaveBeenCalledTimes(1);
    } finally {
      src.close();
    }
  });
});
