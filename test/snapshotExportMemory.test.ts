import { describe, expect, it } from "vitest";
import {
  CUSTOMER_SNAPSHOT_EXPORT,
  SNAPSHOT_EXPORT_PAGE_SIZE,
  snapshotCsvResponse,
  streamSnapshotCsv
} from "../src/lib/snapshot/export";

type Runtime = {
  memoryUsage(): { heapUsed: number; arrayBuffers: number };
  gc?: () => void;
};

const runtime = (globalThis as unknown as { process: Runtime }).process;
const forceGc = (globalThis as unknown as { gc?: () => void }).gc;
const ROW_COUNT = 60_000;
const ROW_TEXT_BYTES = 2_048;
const HEAP_GROWTH_CEILING = 32 * 1024 * 1024;

const textDecoder = new TextDecoder();
function flatRowText(id: number): string {
  // Decode fresh bytes so retaining raw rows costs the full text size, not
  // just the small rope nodes V8 can use for repeat() and concatenation.
  const bytes = new Uint8Array(ROW_TEXT_BYTES).fill(120);
  const tag = `${id}:`;
  for (let i = 0; i < tag.length; i += 1) bytes[i] = tag.charCodeAt(i);
  return textDecoder.decode(bytes);
}

function generatedExportDb(onDuringPull: () => void) {
  let reads = 0;
  // Cursor of the last row served in the current pass. Each pass (the ETag
  // prepass and the body pass) restarts cursorless, chains by keyset, and
  // ends with an empty page that resets for the next pass.
  let last = 0;
  let passOpen = false;
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              reads += 1;
              if (binds.length === 1) {
                if (
                  sql.includes("WHERE") ||
                  !sql.includes("ORDER BY customer_id LIMIT ?") ||
                  sql.includes("OFFSET") ||
                  binds[0] !== SNAPSHOT_EXPORT_PAGE_SIZE ||
                  passOpen
                ) {
                  throw new Error("each export pass must start with an ordered, limited page");
                }
                passOpen = true;
              } else {
                if (
                  !sql.includes("WHERE customer_id > ? ORDER BY customer_id LIMIT ?") ||
                  sql.includes("OFFSET") ||
                  binds.length !== 2
                ) {
                  throw new Error("later export pages must use the keyset cursor");
                }
                if (!passOpen || (binds[0] as number) !== last) {
                  throw new Error(
                    `keyset cursor must resume after ${last}, got ${binds[0]}`
                  );
                }
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
                    comments: flatRowText(id),
                    enabled: 1,
                    synced_at: "2026-10-11T00:00:00.000Z"
                  };
                }
              );
              // Sample while the page rows are still live: transient buffering
              // held only during a pull() (e.g. joining every page into one
              // string) is garbage by the time the reader observes the chunk.
              onDuringPull();
              if (rows.length === 0) {
                last = 0;
                passOpen = false;
              } else {
                last = rows[rows.length - 1].customer_id as number;
              }
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
    // Encoded chunks are Uint8Array backing stores: they count in
    // `arrayBuffers`, not `heapUsed`. Sample the sum post-GC so retaining
    // every encoded chunk cannot hide off-heap.
    const combined = () => {
      const m = runtime.memoryUsage();
      return m.heapUsed + (m.arrayBuffers ?? 0);
    };
    forceGc!();
    const baseline = combined();
    let peak = baseline;
    const sample = () => {
      forceGc!();
      peak = Math.max(peak, combined());
    };

    // Direct stream path: one keyset-paged pass.
    const direct = generatedExportDb(sample);
    const reader = streamSnapshotCsv(direct.db, CUSTOMER_SNAPSHOT_EXPORT).getReader();

    let bytes = 0;
    let newlines = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      for (const byte of value) {
        if (byte === 10) newlines += 1;
      }
      sample();
      // Let an eager producer fill its queue while this slow client waits.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(direct.readCount()).toBe(Math.ceil(ROW_COUNT / SNAPSHOT_EXPORT_PAGE_SIZE) + 1);
    expect(newlines).toBe(ROW_COUNT + 1);
    expect(bytes).toBeGreaterThan(100 * 1024 * 1024);

    // Shipped 200 path: ETag prepass plus streamed body behind a Response.
    // A regression such as `await new Response(stream).arrayBuffer()`
    // buffers the whole body here, not in the direct stream above.
    const shipped = generatedExportDb(sample);
    const response = await snapshotCsvResponse(shipped.db, CUSTOMER_SNAPSHOT_EXPORT);
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toMatch(/^"fnv64-[0-9a-f]+"/);
    const body = response.body?.getReader();
    expect(body).toBeDefined();
    let bodyBytes = 0;
    let bodyNewlines = 0;
    for (;;) {
      const { done, value } = await body!.read();
      if (done) break;
      bodyBytes += value.byteLength;
      for (const byte of value) {
        if (byte === 10) bodyNewlines += 1;
      }
      sample();
      // Let an eager producer fill its queue while this slow client waits.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(shipped.readCount()).toBe(
      2 * (Math.ceil(ROW_COUNT / SNAPSHOT_EXPORT_PAGE_SIZE) + 1)
    );
    expect(bodyNewlines).toBe(ROW_COUNT + 1);
    expect(bodyBytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(bodyBytes).toBe(bytes);

    expect(peak - baseline).toBeLessThan(HEAP_GROWTH_CEILING);
  });
});
