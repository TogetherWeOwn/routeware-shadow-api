import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import app from "../src/app";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { fetchReportCsvForPath } from "../src/lib/snapshot/reportFetch";
import { spreadsheetSafeCsvStream } from "../src/lib/snapshot/archiveReadback";
import * as readback from "../src/lib/snapshot/archiveReadback";
import {
  runAddressSnapshotSync,
  runContainerSnapshotSync,
  runCustomerSnapshotSync
} from "../src/lib/snapshot/orchestration";
import { recordingDb } from "./snapshotDbFake";
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

vi.mock("../src/lib/snapshot/reportFetch", () => ({
  fetchReportCsvForPath: vi.fn()
}));

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

async function drain(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  void reader.closed.catch(() => {});
  try {
    while (!(await reader.read()).done) {
      // Consume until EOF or the stream's own error.
    }
  } finally {
    reader.releaseLock();
  }
}

async function withinWatchdog<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("stall bound exceeded watchdog")), 500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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

describe("snapshot runner stall wiring", () => {
  const runners = [
    { table: "customer", run: runCustomerSnapshotSync, header: "CustomerID,Enabled\n1,", config: "CUSTOMER_REPORT_EXPORT_PATH" },
    { table: "address", run: runAddressSnapshotSync, header: "PickupAddressID,CustomerID\n1,", config: "ADDRESS_REPORT_EXPORT_PATH" },
    { table: "container", run: runContainerSnapshotSync, header: "ContainerID,PickupAddressID\n1,", config: "CONTAINER_REPORT_EXPORT_PATH" }
  ];

  for (const { table, run, header, config } of runners) {
    it.each(["dry-run", "R2-disabled", "R2-unbound"] as const)(
      `${table} bounds a stalled report through the %s entry point`,
      async (mode) => {
        const src = stalledBody(header);
        const db = recordingDb();
        vi.mocked(fetchReportCsvForPath).mockResolvedValueOnce(new Response(src.body));
        const bindings = {
          CUSTOMER_DB: db.db,
          [config]: "/Reports/synthetic.csv",
          REPORT_STREAM_STALL_TIMEOUT_MS: "50",
          ...(mode === "R2-unbound" ? {} : { SNAPSHOTS: {}, SNAPSHOTS_R2_ENABLED: "false" })
        } as unknown as Env;
        try {
          const error = await withinWatchdog(run(bindings, { dryRun: mode === "dry-run" })).then(
            () => null,
            (e: unknown) => e
          );
          expect(error).toBeInstanceOf(UpstreamTimeoutError);
          expect((error as UpstreamTimeoutError).timeoutMs).toBe(50);
          expect(src.cancel).toHaveBeenCalledTimes(1);
          expect(db.batches).toEqual([]);
          expect(db.runs).toEqual([]);
          expect(db.selects).toEqual([]);
        } finally {
          src.close();
          vi.mocked(fetchReportCsvForPath).mockReset();
        }
      }
    );
  }
});

describe("archive readback stall cancellation", () => {
  it("forwards a readback stream stall to the underlying body exactly once", async () => {
    const src = stalledBody("CustomerID,Enabled\n1,");
    try {
      const error = await withinWatchdog(
        drain(spreadsheetSafeCsvStream(src.body, { stallTimeoutMs: 50 }))
      ).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamTimeoutError);
      expect((error as UpstreamTimeoutError).timeoutMs).toBe(50);
      expect(src.cancel).toHaveBeenCalledTimes(1);
      expect(src.cancel.mock.calls[0]?.[0]).toBeInstanceOf(UpstreamTimeoutError);
    } finally {
      src.close();
    }
  });
});

describe("archive route stall wiring", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  async function getArchive(bucket: R2Bucket): Promise<Response> {
    // The app awaits a throttle DO reset before reaching R2. Its cold-start
    // scheduling is unrelated to the stream's 50ms bound and can consume the
    // 500ms watchdog before a read starts. Keep auth real but give this fixture
    // its own immediate reset transport; the archive and stall timers stay real.
    return app.fetch(
      new Request("http://test.local/api/v1/snapshots/customer/2026-10-21", {
        headers: { authorization: "Bearer test-sync-secret" }
      }),
      {
        ...env,
        AUTH_SESSION: {
          idFromName: (name: string) => env.AUTH_SESSION.idFromName(name),
          get: () => ({
            async fetch() {
              return new Response(null, { status: 204 });
            }
          })
        },
        SNAPSHOTS: bucket,
        REPORT_STREAM_STALL_TIMEOUT_MS: "50"
      } as unknown as Env,
      ctx
    );
  }

  it("returns a PII-free 502 and cancels a stalled measurement pass using the env bound", async () => {
    const src = stalledBody("CustomerID,CompanyName\n1,SyntheticMustNotLeak");
    const get = vi.fn(async () => ({ body: src.body, etag: "stored" }));
    try {
      const response = await withinWatchdog(getArchive({ get } as unknown as R2Bucket));
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      const problem = await response.json() as { title: string; status: number; detail: string };
      expect(problem.title).toBe("Upstream timed out");
      expect(problem.status).toBe(502);
      expect(problem.detail).toContain("50ms");
      expect(JSON.stringify(problem)).not.toContain("SyntheticMustNotLeak");
      expect(src.cancel).toHaveBeenCalledTimes(1);
      expect(src.cancel.mock.calls[0]?.[0]).toBeInstanceOf(UpstreamTimeoutError);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      src.close();
    }
  });

  it("bounds and cancels the route's second R2 source with the transport isolated", async () => {
    // Keep the real route, re-encoder, timer and upstream cancellation. Replace
    // only the outgoing pipe: workerd's test pool reports unhandled rejections
    // for native pipe aborts even in a minimal reproduction without app code.
    // This pins timeout wiring, not post-header transport error propagation;
    // snapshotArchive.test.ts exercises successful native fixed-length output.
    const encode = readback.spreadsheetSafeCsvStream;
    let outcome: Promise<unknown> | undefined;
    const transport = vi.spyOn(readback, "spreadsheetSafeCsvStream").mockImplementation((body, options) => {
      const stream = encode(body, options);
      stream.pipeTo = () => {
        const pending = drain(stream);
        outcome = pending.then(() => null, (error: unknown) => error);
        return pending;
      };
      return stream;
    });
    const src = stalledBody("CustomerID,Enabled\n1,");
    const get = vi.fn()
      .mockResolvedValueOnce({ body: stringToUint8Stream("CustomerID,Enabled\n1,true\n"), etag: "stored" })
      .mockResolvedValueOnce({ body: src.body, etag: "stored" });
    let response: Response | undefined;
    try {
      response = await withinWatchdog(getArchive({ get } as unknown as R2Bucket));
      expect(response.status).toBe(200);
      expect(outcome).toBeDefined();
      const error = await withinWatchdog(outcome!);
      expect(error).toBeInstanceOf(UpstreamTimeoutError);
      expect((error as UpstreamTimeoutError).timeoutMs).toBe(50);
      expect(src.cancel).toHaveBeenCalledTimes(1);
      expect(src.cancel.mock.calls[0]?.[0]).toBeInstanceOf(UpstreamTimeoutError);
      expect(get).toHaveBeenCalledTimes(2);
      expect(get.mock.calls[1]).toEqual([
        "snapshots/2026-10-21/customer.csv", { onlyIf: { etagMatches: "stored" } }
      ]);
    } finally {
      src.close();
      await response?.body?.cancel();
      transport.mockRestore();
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
