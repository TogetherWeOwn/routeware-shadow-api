import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import {
  SNAPSHOT_IMPORT_MAX_BYTES,
  STREAM_BATCH_ADDR,
  STREAM_BATCH_CONT,
  STREAM_BATCH_CUST,
  isSnapshotTooLarge,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { rejectOversizedSnapshotImport } from "../src/routes/snapshotImport";
import { recordingDb } from "./snapshotDbFake";

/**
 * Import caps count cumulative UTF-8 bytes, not characters or individual
 * chunks. The app-wide buffered-body cap must not consume these CSV streams,
 * including the trailing-slash aliases supplied by the body-size-cap slice.
 * Synthetic data + recording D1 only; no upstream requests or real imports.
 */
const SPECS = [
  {
    name: "customer",
    path: "/api/v1/customer-snapshot/import",
    header: "CustomerID,CompanyName",
    rowPrefix: "9001,",
    batchSize: STREAM_BATCH_CUST,
    sync: syncCustomerSnapshotFromStream
  },
  {
    name: "address",
    path: "/api/v1/address-snapshot/import",
    header: "PickupAddressID,CustomerID,Address",
    rowPrefix: "9001,9001,",
    batchSize: STREAM_BATCH_ADDR,
    sync: syncAddressSnapshotFromStream
  },
  {
    name: "container",
    path: "/api/v1/container-snapshot/import",
    header: "ContainerID,PickupAddressID,ContainerNote",
    rowPrefix: "9001,9001,",
    batchSize: STREAM_BATCH_CONT,
    sync: syncContainerSnapshotFromStream
  }
];

const ENCODER = new TextEncoder();
const UNIT_CAP = 1024;
const PII_PROBE = "PII-PROBE-SYNTHETIC-é";
const SYNC_SECRET = "test-sync-secret";
const TOO_LARGE = `${PROBLEM_TYPE_BASE}payload-too-large`;

function csvBytes(spec: (typeof SPECS)[number], size: number): Uint8Array {
  const prefix = `${spec.header}\n${spec.rowPrefix}${PII_PROBE}`;
  return ENCODER.encode(prefix + "x".repeat(size - ENCODER.encode(prefix).byteLength));
}

function chunked(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  }, { highWaterMark: 0 });
}

function fakeDb() {
  return recordingDb({ allResults: [{ customer_id: 9001, pickup_address_id: 9001 }] });
}

// Hono documents passing Request + bindings to app.request:
// https://hono.dev/docs/guides/testing#passing-env-to-apprequest
function requestEnv(db: D1Database): Env {
  return {
    ...env,
    CUSTOMER_DB: db,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    SHADOW_API_TOKEN: "test-api-token"
  } as unknown as Env;
}

function importRequest(path: string, body: ReadableStream<Uint8Array>): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    },
    body
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected upstream request")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("observes buffering on a non-import request (spy control)", async () => {
  const recorded = fakeDb();
  const request = importRequest("/api/v1/import-size-control", chunked(ENCODER.encode("control"), 1));
  const buffered = vi.spyOn(request, "arrayBuffer");

  // A truthy RequestInit clones the Request in Hono 4.12.14, losing its spy.
  const response = await app.request(request, undefined, requestEnv(recorded.db));

  expect(buffered).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  expect(recorded.batches).toEqual([]);
});

describe.each(SPECS)("$name import byte limits", (spec) => {
  it.each([UNIT_CAP - 1, UNIT_CAP])("accepts %i cumulative bytes", async (size) => {
    const recorded = fakeDb();
    const bytes = csvBytes(spec, size);
    expect(bytes.byteLength).toBe(size);
    // One-byte chunks split the é encoding as well as the CSV header/row.
    const result = await spec.sync(recorded.db, chunked(bytes, 1), 80, {
      maxBytes: UNIT_CAP,
      requireDataRows: true
    });

    expect(result).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(recorded.batches).toHaveLength(1);
    const expectedField = new TextDecoder().decode(bytes).slice(
      `${spec.header}\n${spec.rowPrefix}`.length
    );
    expect(recorded.batches.flatMap((batch) => batch.flatMap((s) => s.binds)))
      .toContain(expectedField);
    expect(recorded.runs).toEqual([]);
  });

  it("rejects cap + 1 accumulated over individually small chunks", async () => {
    const recorded = fakeDb();
    const bytes = csvBytes(spec, UNIT_CAP + 1);
    const error = await spec.sync(recorded.db, chunked(bytes, 256), 80, {
      maxBytes: UNIT_CAP,
      requireDataRows: true
    }).catch((e: unknown) => e);

    expect(isSnapshotTooLarge(error)).toBe(true);
    expect(recorded.batches).toEqual([]);
    expect(recorded.selects).toEqual([]);
    expect(recorded.runs).toEqual([]);
  });

  it("rejects late overflow without reconciling or losing an earlier flushed batch", async () => {
    const recorded = fakeDb();
    const cap = 4096;
    const firstBatch = ENCODER.encode([
      spec.header,
      ...Array.from({ length: spec.batchSize }, (_, i) =>
        `${9100 + i}${spec.rowPrefix.slice(4)}${PII_PROBE}`
      ),
      ""
    ].join("\n"));
    expect(firstBatch.byteLength).toBeLessThan(cap);
    const pending = `9999${spec.rowPrefix.slice(4)}${PII_PROBE}`;
    const tail = ENCODER.encode(pending + "x".repeat(
      cap + 1 - firstBatch.byteLength - ENCODER.encode(pending).byteLength
    ));
    const bytes = new Uint8Array(cap + 1);
    bytes.set(firstBatch);
    bytes.set(tail, firstBatch.byteLength);

    // Partial imports are batch-atomic, not file-atomic (BACKFILL-RUNBOOK §5).
    const error = await spec.sync(recorded.db, chunked(bytes, firstBatch.byteLength), undefined, {
      maxBytes: cap,
      requireDataRows: true
    }).catch((e: unknown) => e);

    expect(isSnapshotTooLarge(error)).toBe(true);
    expect(recorded.batches).toHaveLength(1);
    const bindings = recorded.batches.flatMap((batch) => batch.flatMap((s) => s.binds));
    expect(bindings).toContain(9100 + spec.batchSize - 1);
    expect(bindings).not.toContain(9999);
    expect(recorded.runs).toEqual([]);
  });

  it.each([null, "not-a-number", String(UNIT_CAP - 1), String(UNIT_CAP)])(
    "leaves declaration %s to the stream counter",
    (contentLength) => {
      expect(rejectOversizedSnapshotImport({
        url: `http://test.local${spec.path}`,
        contentLength
      }, UNIT_CAP)).toBeNull();
    }
  );

  it("rejects a declared cap + 1 with problem+json", async () => {
    const response = rejectOversizedSnapshotImport({
      url: `http://test.local${spec.path}`,
      contentLength: String(UNIT_CAP + 1)
    }, UNIT_CAP);

    expect(response?.status).toBe(413);
    expect(response?.headers.get("content-type")).toContain("problem+json");
    expect(await response?.json()).toMatchObject({
      type: TOO_LARGE,
      status: 413,
      instance: spec.path
    });
  });

  it("rejects an oversized stream with no Content-Length through the real app", async () => {
    const recorded = fakeDb();
    const prefix = ENCODER.encode(`${spec.header}\n${spec.rowPrefix}${PII_PROBE}\n`);
    // Reuse 64 KiB whitespace lines: exceed the real 50 MiB cap without
    // allocating a 50 MiB fixture or triggering a batch before the overflow.
    const padding = ENCODER.encode(" ".repeat(64 * 1024 - 1) + "\n");
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === 0) {
          controller.enqueue(prefix);
          emitted += prefix.byteLength;
        } else if (emitted <= SNAPSHOT_IMPORT_MAX_BYTES) {
          controller.enqueue(padding);
          emitted += padding.byteLength;
        } else {
          controller.close();
        }
      }
    }, { highWaterMark: 0 });
    const request = importRequest(spec.path, body);
    expect(request.headers.get("content-length")).toBeNull();
    const buffered = vi.spyOn(request, "arrayBuffer");

    const response = await app.request(request, undefined, requestEnv(recorded.db));

    expect(buffered).not.toHaveBeenCalled();
    expect(emitted).toBeGreaterThan(SNAPSHOT_IMPORT_MAX_BYTES);
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const problem = await response.json();
    expect(problem).toMatchObject({ type: TOO_LARGE, status: 413, instance: spec.path });
    expect(JSON.stringify(problem)).not.toContain(PII_PROBE);
    expect(recorded.batches).toEqual([]);
    expect(recorded.selects).toEqual([]);
    expect(recorded.runs).toEqual([]);
  });

  it.each(["", "/"])("keeps import%s streaming rather than buffering", async (suffix) => {
    const recorded = fakeDb();
    const request = importRequest(spec.path + suffix, chunked(csvBytes(spec, 256), 17));
    const buffered = vi.spyOn(request, "arrayBuffer");

    const response = await app.request(request, undefined, requestEnv(recorded.db));

    expect(buffered).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(recorded.batches).toHaveLength(1);
    expect(recorded.runs).toEqual([]);
  });
});
