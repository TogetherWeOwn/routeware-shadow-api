import { describe, expect, it, vi } from "vitest";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import {
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import {
  measureSpreadsheetSafeCsv,
  spreadsheetSafeCsvStream
} from "../src/lib/snapshot/archiveReadback";
import type { StreamSyncOptions } from "../src/lib/snapshot/upsert";
import {
  isUpstreamTimeout,
  UpstreamTimeoutError,
  upstreamTimeoutProblem
} from "../src/lib/upstreamTimeout";
import { recordingDb } from "./snapshotDbFake";

/**
 * R10-05 acceptance: stall-bounded streamed report CSV reads.
 *
 * `docs/PROBLEMS.md` ("Intentionally untouched") records that raw report CSV
 * downloads and CSV-to-D1/R2 consumption (`streamCsvLines` via snapshot sync
 * and archive readback) have no body deadline: a hung upstream mid-stream
 * holds the Worker toward the 300s CPU limit. These tests pin the failing
 * behavior first; the paired Builder implements the stall bound on this
 * card's branch and never edits this file.
 *
 * Contract the Builder implements (idle stall bound, NOT a total deadline):
 * - `streamCsvLines(body, { stallTimeoutMs })`: each successfully read chunk
 *   resets an idle timer; a gap with no bytes for `stallTimeoutMs` rejects
 *   with `UpstreamTimeoutError(timeoutMs)` directly (not wrapped — the
 *   existing `app.onError` maps only a top-level `UpstreamTimeoutError` to
 *   502 `bad-gateway` problem+json).
 * - `StreamSyncOptions.stallTimeoutMs` threads through `cappedLines` to
 *   `streamCsvLines` for all three `sync*SnapshotFromStream` paths.
 * - `measureSpreadsheetSafeCsv` / `spreadsheetSafeCsvStream` accept the same
 *   stall option and surface the same timeout failure.
 * - A slow-but-completing stream (bytes keep flowing, total time exceeds the
 *   stall bound) is NOT cut off: only idle gaps trip the bound.
 * - A stalled sync never reconciles or deletes: the timeout rejects before
 *   any `DELETE` is issued.
 *
 * RED-phase notes: the `stallTimeoutMs` options do not exist yet, so every
 * call site below goes through a locally cast helper (`as` + `unknown`);
 * that keeps `npm run typecheck` green while the behavior is missing. Each
 * stall test races the hung read against a 4x watchdog (same pattern as
 * `test/upstreamBody.test.ts`): today the watchdog wins and the test fails
 * with "exceeded watchdog (no stall bound?)"; after the Builder lands, the
 * 50ms stall timeout wins and the test passes. No network, no credentials.
 */

const STALL_MS = 50;
const WATCHDOG_MS = 200;
const DRIP_MS = 10;

type StallOptions = { stallTimeoutMs?: number };

function stallSyncOptions(
  base: StreamSyncOptions,
  stallTimeoutMs: number
): StreamSyncOptions {
  return { ...base, stallTimeoutMs } as StreamSyncOptions;
}

async function collectLinesWithStall(
  body: ReadableStream<Uint8Array>,
  stallTimeoutMs: number
): Promise<string[]> {
  const withStall = streamCsvLines as unknown as (
    b: ReadableStream<Uint8Array>,
    opts?: StallOptions
  ) => AsyncGenerator<string, void, undefined>;
  const lines: string[] = [];
  for await (const line of withStall(body, { stallTimeoutMs })) {
    lines.push(line);
  }
  return lines;
}

async function measureWithStall(
  body: ReadableStream<Uint8Array>,
  stallTimeoutMs: number
): Promise<{ length: number; etag: string }> {
  const withStall = measureSpreadsheetSafeCsv as unknown as (
    b: ReadableStream<Uint8Array>,
    opts?: StallOptions
  ) => Promise<{ length: number; etag: string }>;
  return withStall(body, { stallTimeoutMs });
}

function readbackStreamWithStall(
  body: ReadableStream<Uint8Array>,
  stallTimeoutMs: number
): ReadableStream<Uint8Array> {
  const withStall = spreadsheetSafeCsvStream as unknown as (
    b: ReadableStream<Uint8Array>,
    opts?: StallOptions
  ) => ReadableStream<Uint8Array>;
  return withStall(body, { stallTimeoutMs });
}

/** Held gate that never opens: emits `prefix` bytes, then stalls forever. */
function stalledAfterPrefix(prefix: string): {
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
      // Then hold: never enqueue, never close.
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

/** Gate that opens every `intervalMs`: slow-but-completing, total > stall. */
function slowDripStream(chunks: string[], intervalMs: number): ReadableStream<Uint8Array> {
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

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

async function withinWatchdog<T>(
  pending: Promise<T>,
  watchdogMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${watchdogMs}ms watchdog (no stall bound?)`)),
          watchdogMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

type SyncFn = (
  db: D1Database,
  body: ReadableStream<Uint8Array>,
  batchSize?: number,
  options?: StreamSyncOptions
) => Promise<{ upserted: number; rowCount: number; deleted: number }>;

const SYNC_SPECS: Array<{
  name: string;
  sync: SyncFn;
  header: string;
  row: (id: number) => string;
}> = [
  {
    name: "customer",
    sync: syncCustomerSnapshotFromStream,
    header: CUSTOMER_HEADER,
    row: (id) => `${id},,Co ${id},,,,,,,,,,true`
  },
  {
    name: "address",
    sync: syncAddressSnapshotFromStream,
    header: ADDRESS_HEADER,
    row: (id) => `${id},1,,${id} Main St,Killeen,TX,76541,,,false,true,,,,`
  },
  {
    name: "container",
    sync: syncContainerSnapshotFromStream,
    header: CONTAINER_HEADER,
    row: (id) => `${id},10,,SN-${id},,false,,false,,,true,${id} Main St,Killeen,TX,76541,`
  }
];

describe("streamCsvLines stall bound", () => {
  it("fails a byte-prefix-then-stall stream within the stall bound (no long hang)", async () => {
    const src = stalledAfterPrefix("a,b\nc,");
    try {
      const pending = collectLinesWithStall(src.body, STALL_MS).then(
        (lines) => ({ ok: true as const, lines }),
        (error: unknown) => ({ ok: false as const, error })
      );
      const start = Date.now();
      const settled = await withinWatchdog(pending, WATCHDOG_MS, "stalled streamCsvLines");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5_000);
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toBeInstanceOf(UpstreamTimeoutError);
        expect((settled.error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
        expect(isUpstreamTimeout(settled.error)).toBe(true);
      }
    } finally {
      src.close();
    }
  });

  it("does not cut off a slow-but-completing stream whose total time exceeds the stall bound", async () => {
    const text = ["a,b", "c,d", "e,f", "g,h", "i,j"].join("\n") + "\n";
    const chunks = chunkText(text, 2);
    // Total drip time (~chunks * DRIP_MS) exceeds STALL_MS, but every gap is DRIP_MS < STALL_MS.
    expect(chunks.length * DRIP_MS).toBeGreaterThan(STALL_MS);

    const lines = await withinWatchdog(
      collectLinesWithStall(slowDripStream(chunks, DRIP_MS), STALL_MS),
      5_000,
      "slow-drip streamCsvLines"
    );

    expect(lines).toEqual(["a,b", "c,d", "e,f", "g,h", "i,j"]);
  });

  it("completes an immediately-available stream (control)", async () => {
    const lines = await collectLinesWithStall(stringToUint8Stream("a,b\nc,d\n"), STALL_MS);

    expect(lines).toEqual(["a,b", "c,d"]);
  });
});

describe.each(SYNC_SPECS)("$name stream sync stall bound", (spec) => {
  it("fails a stalled report mid-stream within the stall bound, without reconciling or deleting", async () => {
    const { db, batches, runs } = recordingDb({ changes: 999 });
    const prefix = `${spec.header}\n${spec.row(1).slice(0, 5)}`;
    const src = stalledAfterPrefix(prefix);
    try {
      const pending = spec
        .sync(db, src.body, 80, stallSyncOptions({ reconcile: true }, STALL_MS))
        .then(
          (counts) => ({ ok: true as const, counts }),
          (error: unknown) => ({ ok: false as const, error })
        );
      const start = Date.now();
      const settled = await withinWatchdog(pending, WATCHDOG_MS, `stalled ${spec.name} sync`);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5_000);
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toBeInstanceOf(UpstreamTimeoutError);
        expect((settled.error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
        expect(isUpstreamTimeout(settled.error)).toBe(true);
      }
      expect(runs.filter((r) => r.sql.startsWith("DELETE"))).toEqual([]);
      expect(batches).toEqual([]);
    } finally {
      src.close();
    }
  });

  it("does not cut off a slow-but-completing report whose total time exceeds the stall bound", async () => {
    const { db } = recordingDb();
    const text = [spec.header, spec.row(1), spec.row(2)].join("\n") + "\n";
    const chunks = chunkText(text, 20);
    expect(chunks.length * DRIP_MS).toBeGreaterThan(STALL_MS);

    const result = await withinWatchdog(
      spec.sync(
        db,
        slowDripStream(chunks, DRIP_MS),
        80,
        stallSyncOptions({}, STALL_MS)
      ),
      5_000,
      `slow-drip ${spec.name} sync`
    );

    expect(result.rowCount).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.deleted).toBe(0);
  });
});

describe("archive readback stall bound", () => {
  it("fails measuring a stalled archive within the stall bound", async () => {
    const src = stalledAfterPrefix("Id,Value\n1,");
    try {
      const pending = measureWithStall(src.body, STALL_MS).then(
        (measured) => ({ ok: true as const, measured }),
        (error: unknown) => ({ ok: false as const, error })
      );
      const settled = await withinWatchdog(pending, WATCHDOG_MS, "stalled archive measure");

      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toBeInstanceOf(UpstreamTimeoutError);
        expect((settled.error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
      }
    } finally {
      src.close();
    }
  });

  it("fails streaming a stalled archive within the stall bound", async () => {
    const src = stalledAfterPrefix("Id,Value\n1,");
    try {
      const pending = collectBytes(readbackStreamWithStall(src.body, STALL_MS)).then(
        (bytes) => ({ ok: true as const, bytes }),
        (error: unknown) => ({ ok: false as const, error })
      );
      const settled = await withinWatchdog(pending, WATCHDOG_MS, "stalled archive stream");

      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toBeInstanceOf(UpstreamTimeoutError);
        expect((settled.error as UpstreamTimeoutError).timeoutMs).toBe(STALL_MS);
      }
    } finally {
      src.close();
    }
  });

  it("does not cut off a slow-but-completing archive whose total time exceeds the stall bound", async () => {
    const text = ["Id,Value", "1,alpha", "2,beta", "3,gamma"].join("\n") + "\n";
    const chunks = chunkText(text, 4);
    expect(chunks.length * DRIP_MS).toBeGreaterThan(STALL_MS);

    const measured = await withinWatchdog(
      measureWithStall(slowDripStream(chunks, DRIP_MS), STALL_MS),
      5_000,
      "slow-drip archive measure"
    );
    const served = await withinWatchdog(
      collectBytes(readbackStreamWithStall(slowDripStream(chunks, DRIP_MS), STALL_MS)),
      5_000,
      "slow-drip archive stream"
    );

    expect(measured.length).toBe(served.byteLength);
    expect(measured.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(served)).toContain("_shadow_csv_encoding");
  });
});

describe("stalled read timeout failure contract", () => {
  it("surfaces the stall timeout as 502 problem+json (the existing app.onError mapping)", async () => {
    // The Builder throws UpstreamTimeoutError; the existing app.onError
    // backstop (pinned in test/upstreamTimeout.test.ts) maps exactly that
    // class to 502. This pins the response shape the stalled sync inherits.
    const err = new UpstreamTimeoutError(STALL_MS);
    expect(isUpstreamTimeout(err)).toBe(true);

    const res = upstreamTimeoutProblem(STALL_MS, "/api/v1/customer-snapshot/sync");
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = await res.text();
    expect(body).toContain("bad-gateway");
    expect(body).toContain(`${STALL_MS}ms`);
    expect(body).toContain("Upstream timed out");
  });
});
