import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SNAPSHOT_EXPORT,
  SNAPSHOT_EXPORT_PAGE_SIZE,
  streamSnapshotCsv
} from "../src/lib/snapshot/export";

type Runtime = {
  memoryUsage(): { heapUsed: number };
  gc?: () => void;
};

const runtime = (globalThis as unknown as { process: Runtime }).process;
const forceGc = (globalThis as unknown as { gc?: () => void }).gc;
const ROW_COUNT = 60_000;
const ROW_TEXT_BYTES = 2_048;
const HEAP_GROWTH_CEILING = 32 * 1024 * 1024;

function generatedExportDb() {
  let reads = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              reads += 1;
              if (reads === 1) {
                if (sql.includes("WHERE") || binds.length !== 1) {
                  throw new Error("first export page must start without a cursor");
                }
              } else if (
                !sql.includes("WHERE customer_id > ? ORDER BY customer_id LIMIT ?") ||
                sql.includes("OFFSET") ||
                binds.length !== 2
              ) {
                throw new Error("later export pages must use the keyset cursor");
              }
              const limit = binds[binds.length - 1] as number;
              const after = binds.length > 1 ? (binds[0] as number) : 0;
              const rows = Array.from(
                { length: Math.min(limit, ROW_COUNT - after) },
                (_, offset) => {
                  const id = after + offset + 1;
                  return {
                    customer_id: id,
                    company_name: `Synthetic ${id}`,
                    comments: `${id}:${"x".repeat(ROW_TEXT_BYTES)}`,
                    enabled: 1,
                    synced_at: "2026-10-11T00:00:00.000Z"
                  };
                }
              );
              return { results: rows } as unknown as T;
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, readCount: () => reads };
}

describe("large snapshot export memory ceiling", () => {
  it("streams 60,000 synthetic rows with bounded retained heap", async () => {
    expect(forceGc, "run this check with --expose-gc").toBeTypeOf("function");
    forceGc!();
    const baseline = runtime.memoryUsage().heapUsed;
    const { db, readCount } = generatedExportDb();
    const reader = streamSnapshotCsv(db, CUSTOMER_SNAPSHOT_EXPORT).getReader();

    let bytes = 0;
    let newlines = 0;
    let peakHeap = baseline;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (const byte of value) {
        if (byte === 10) newlines += 1;
      }
      forceGc!();
      peakHeap = Math.max(peakHeap, runtime.memoryUsage().heapUsed);
    }

    expect(readCount()).toBe(Math.ceil(ROW_COUNT / SNAPSHOT_EXPORT_PAGE_SIZE) + 1);
    expect(newlines).toBe(ROW_COUNT + 1);
    expect(bytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(peakHeap - baseline).toBeLessThan(HEAP_GROWTH_CEILING);
  });
});
