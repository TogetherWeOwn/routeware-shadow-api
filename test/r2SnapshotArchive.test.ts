import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveReportCsvToR2AfterD1,
  putReadableStreamToR2,
  R2_MULTIPART_PART_SIZE
} from "../src/lib/r2SnapshotArchive";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c);
      }
      controller.close();
    }
  });
}

function createMockBucket() {
  const putCalls: { key: string; size: number }[] = [];
  const multipart: {
    parts: { partNumber: number; size: number }[];
  } = { parts: [] };

  const mpu = {
    key: "k",
    uploadId: "id",
    async uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView) {
      const n =
        value instanceof ArrayBuffer
          ? value.byteLength
          : (value as ArrayBufferView).byteLength;
      multipart.parts.push({ partNumber, size: n });
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete(_parts: { partNumber: number; etag: string }[]) {
      return { httpEtag: "final" } as R2Object;
    },
    async abort() {
      // no-op
    }
  };

  const bucket: Pick<R2Bucket, "put" | "get" | "createMultipartUpload"> = {
    async get() {
      return null;
    },
    async put(key, value) {
      let size = 0;
      if (value === null) {
        size = 0;
      } else if (value instanceof ArrayBuffer) {
        size = value.byteLength;
      } else {
        const v = value as ArrayBufferView;
        size = v.byteLength;
      }
      putCalls.push({ key, size });
      return {} as R2Object;
    },
    async createMultipartUpload() {
      return mpu as R2MultipartUpload;
    }
  };

  return { bucket, putCalls, multipart, mpu };
}

describe("putReadableStreamToR2", () => {
  it("empty stream uses a single put (0 bytes)", async () => {
    const { bucket, putCalls } = createMockBucket();
    await putReadableStreamToR2(
      bucket as R2Bucket,
      "snap/x.csv",
      streamFromChunks([]),
      { httpMetadata: { contentType: "text/csv" } }
    );
    expect(putCalls).toEqual([{ key: "snap/x.csv", size: 0 }]);
  });

  it("sub–5 MiB uses one put, no multipart", async () => {
    const { bucket, putCalls, multipart } = createMockBucket();
    const small = new Uint8Array(900);
    small.fill(7);
    await putReadableStreamToR2(
      bucket as R2Bucket,
      "snap/s.csv",
      streamFromChunks([small]),
      { httpMetadata: { contentType: "text/csv" } }
    );
    expect(putCalls).toEqual([{ key: "snap/s.csv", size: 900 }]);
    expect(multipart.parts).toEqual([]);
  });

  it("exact 5 MiB is one multipart part then complete", async () => {
    const { bucket, putCalls, multipart } = createMockBucket();
    const a = new Uint8Array(R2_MULTIPART_PART_SIZE);
    a.fill(2);
    await putReadableStreamToR2(
      bucket as R2Bucket,
      "snap/m.csv",
      streamFromChunks([a]),
      { httpMetadata: { contentType: "text/csv" } }
    );
    expect(putCalls).toEqual([]);
    expect(multipart.parts).toEqual([
      { partNumber: 1, size: R2_MULTIPART_PART_SIZE }
    ]);
  });

  it("5 MiB + 10 B yields two parts", async () => {
    const { bucket, putCalls, multipart } = createMockBucket();
    const a = new Uint8Array(R2_MULTIPART_PART_SIZE);
    a.fill(3);
    const b = new Uint8Array(10);
    b.fill(4);
    await putReadableStreamToR2(
      bucket as R2Bucket,
      "snap/l.csv",
      streamFromChunks([a, b]),
      { httpMetadata: { contentType: "text/csv" } }
    );
    expect(putCalls).toEqual([]);
    expect(multipart.parts).toEqual([
      { partNumber: 1, size: R2_MULTIPART_PART_SIZE },
      { partNumber: 2, size: 10 }
    ]);
  });
});

describe("archiveReportCsvToR2AfterD1 (TOG-6550)", () => {
  const logged: string[] = [];
  const errored: string[] = [];
  const realLog = console.log;
  const realError = console.error;

  beforeEach(() => {
    logged.length = 0;
    errored.length = 0;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = realLog;
    console.error = realError;
  });

  const enc = new TextEncoder();
  const csv = () => streamFromChunks([enc.encode("CustomerID\n1,,Acme")]);

  function enabledEnv(bucket: R2Bucket): Env {
    return { SNAPSHOTS: bucket } as unknown as Env;
  }

  async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
    const reader = s.getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.byteLength) {
        parts.push(value);
      }
      if (done) {
        break;
      }
    }
    reader.releaseLock();
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return new TextDecoder().decode(out);
  }

  it("writes R2 after a successful D1 sync with identical bytes on both legs", async () => {
    // Arrange
    const { bucket, putCalls } = createMockBucket();
    let d1Saw = "";

    // Act
    const result = await archiveReportCsvToR2AfterD1(
      enabledEnv(bucket as R2Bucket),
      "customer",
      csv(),
      async (s) => {
        d1Saw = await readAll(s);
        return { upserted: 1 };
      }
    );

    // Assert — both CSVs, then history sidecar and daily manifest, then latest.
    expect(result).toEqual({ upserted: 1 });
    expect(d1Saw).toBe("CustomerID\n1,,Acme");
    expect(putCalls).toHaveLength(5);
    expect(putCalls[0].key).toMatch(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/customer\.csv$/);
    expect(putCalls[1].key).toMatch(/^snapshots\/\d{4}-\d{2}-\d{2}\/customer\.csv$/);
    expect(putCalls[2].key).toBe(`${putCalls[0].key}.manifest.json`);
    expect(putCalls[3].key).toMatch(/^snapshots\/\d{4}-\d{2}-\d{2}\.manifest\.json$/);
    expect(putCalls[4].key).toBe("snapshot-latest/customer.json");
    expect(logged.some((l) => l.startsWith("R2 snapshot stored:"))).toBe(true);
  });

  it("writes nothing to R2 when D1 fails — no phantom archive", async () => {
    // Arrange
    const { bucket, putCalls, multipart } = createMockBucket();

    // Act — the sync leg throws the way a failed D1 batch does.
    const error = (await archiveReportCsvToR2AfterD1(
      enabledEnv(bucket as R2Bucket),
      "customer",
      csv(),
      async () => {
        throw new Error("D1_ERROR: database is locked");
      }
    ).catch((e: unknown) => e)) as Error;

    // Assert — the D1 error propagates and the bucket was never touched, so
    // the archive cannot hold rows D1 never got.
    expect(error.message).toBe("D1_ERROR: database is locked");
    expect(putCalls).toEqual([]);
    expect(multipart.parts).toEqual([]);
  });

  it("logs an explicit disabled reason when the R2 binding is unbound", async () => {
    // Arrange — no SNAPSHOTS binding at all (and no flag either).
    const env = {} as unknown as Env;
    let d1Ran = false;

    // Act
    const result = await archiveReportCsvToR2AfterD1(env, "customer", csv(), async () => {
      d1Ran = true;
      return "ok";
    });

    // Assert — D1 still runs, and the log names the reason (not a silent skip).
    expect(result).toBe("ok");
    expect(d1Ran).toBe(true);
    expect(logged).toEqual([
      expect.stringContaining("R2 snapshot archive disabled for customer: SNAPSHOTS binding unbound")
    ]);
  });

  it("logs an explicit disabled reason when SNAPSHOTS_R2_ENABLED=false", async () => {
    // Arrange
    const { bucket, putCalls } = createMockBucket();
    const env = {
      SNAPSHOTS: bucket,
      SNAPSHOTS_R2_ENABLED: "false"
    } as unknown as Env;

    // Act
    await archiveReportCsvToR2AfterD1(env, "address", csv(), async () => "ok");

    // Assert
    expect(putCalls).toEqual([]);
    expect(logged).toEqual([
      expect.stringContaining("R2 snapshot archive disabled for address: SNAPSHOTS_R2_ENABLED=false")
    ]);
  });

  it("keeps the D1 result when the R2 put fails — best-effort, never a 500", async () => {
    // Arrange — R2 throws; D1 already succeeded.
    const failing = {
      async put() {
        throw new Error("R2 boom");
      },
      async createMultipartUpload() {
        throw new Error("R2 boom");
      }
    } as unknown as R2Bucket;

    // Act
    const result = await archiveReportCsvToR2AfterD1(
      enabledEnv(failing),
      "container",
      csv(),
      async () => ({ upserted: 2 })
    );

    // Assert — caller sees the D1 result; the R2 failure is a logged error.
    expect(result).toEqual({ upserted: 2 });
    expect(errored.some((l) => l.includes("R2 snapshot put failed"))).toBe(true);
  });
});

describe("putReadableStreamToR2 split chunks", () => {
  it("same total split across many tiny enqueues (buffered) still makes full + remainder parts", async () => {
    const { bucket, multipart } = createMockBucket();
    const a = new Uint8Array(R2_MULTIPART_PART_SIZE);
    a.fill(5);
    const chunks: Uint8Array[] = [
      a.subarray(0, 1000),
      a.subarray(1000, 4000),
      a.subarray(4000)
    ];
    const tail = new Uint8Array(7);
    tail.fill(9);
    await putReadableStreamToR2(
      bucket as R2Bucket,
      "snap/split.csv",
      streamFromChunks([...chunks, tail]),
      { httpMetadata: { contentType: "text/csv" } }
    );
    expect(multipart.parts).toEqual([
      { partNumber: 1, size: R2_MULTIPART_PART_SIZE },
      { partNumber: 2, size: 7 }
    ]);
  });
});
