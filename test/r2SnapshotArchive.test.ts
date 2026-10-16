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
  const logged: Array<Record<string, unknown>> = [];
  const errored: Array<Record<string, unknown>> = [];
  const realInfo = console.info;
  const realError = console.error;

  beforeEach(() => {
    logged.length = 0;
    errored.length = 0;
    console.info = (...args: unknown[]) => {
      logged.push(args[0] as Record<string, unknown>);
    };
    console.error = (...args: unknown[]) => {
      errored.push(args[0] as Record<string, unknown>);
    };
  });

  afterEach(() => {
    console.info = realInfo;
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
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "R2 snapshot stored",
        route: "snapshot.r2.archive",
        key: expect.stringMatching(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/customer\.csv$/)
      })
    );
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
      expect.objectContaining({
        level: "info",
        msg: "R2 snapshot archive disabled",
        route: "snapshot.r2.archive",
        table: "customer",
        reason: "SNAPSHOTS binding unbound"
      })
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
      expect.objectContaining({
        level: "info",
        msg: "R2 snapshot archive disabled",
        route: "snapshot.r2.archive",
        table: "address",
        reason: "SNAPSHOTS_R2_ENABLED=false"
      })
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
    expect(errored).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "R2 snapshot put failed",
        route: "snapshot.r2.archive",
        key: expect.stringMatching(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/container\.csv$/)
      })
    );
  });
});

describe("putReadableStreamToR2 abort failure (TOG-22168)", () => {
  const warned: Array<Record<string, unknown>> = [];
  const realWarn = console.warn;

  beforeEach(() => {
    warned.length = 0;
    console.warn = (...args: unknown[]) => {
      warned.push(args[0] as Record<string, unknown>);
    };
  });

  afterEach(() => {
    console.warn = realWarn;
  });

  it("rethows the original upload error when abort also fails, with one dangling-upload warning", async () => {
    // Arrange — a full 5 MiB part forces the multipart path; the part write
    // fails and the cleanup abort fails too. Synthetic bytes only, no PII.
    const uploadError = new Error("SYNTHETIC_UPLOAD_FAILURE_7f3a");
    const abortError = new Error("SYNTHETIC_ABORT_FAILURE_9c2e");
    const key = "snap/abort-failure.csv";
    let cancelCalled = false;
    let cancelReason: unknown;
    const body = new Uint8Array(R2_MULTIPART_PART_SIZE);
    body.fill(0x41);
    // Note: no close() here — the stream stays open when the part write
    // fails, so reader.cancel() reaches this cancel hook (a closed stream
    // would make cancel a no-op and hide the teardown assertion).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
      },
      cancel(reason) {
        cancelCalled = true;
        cancelReason = reason;
      }
    });
    const mpu = {
      async uploadPart() {
        throw uploadError;
      },
      async complete() {
        throw new Error("complete must not run after a part failure");
      },
      async abort() {
        throw abortError;
      }
    };
    const bucket = {
      async createMultipartUpload() {
        return mpu as unknown as R2MultipartUpload;
      }
    } as unknown as R2Bucket;

    // Act
    const caught = await putReadableStreamToR2(bucket, key, stream, {
      httpMetadata: { contentType: "text/csv" }
    }).then(
      () => null,
      (e: unknown) => e
    );

    // Assert — the original upload error is rethrown unchanged, not the abort error.
    expect(caught).toBe(uploadError);
    // Assert — exactly one fixed-shape warning identifying the dangling upload.
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      level: "warn",
      msg: "R2 multipart abort failed; upload may be left dangling",
      route: "snapshot.r2.multipart",
      key
    });
    expect(Object.keys(warned[0]).sort()).toEqual([
      "key",
      "level",
      "ms",
      "msg",
      "route"
    ]);
    // Assert — no uploaded bytes or PII leak into the warning record.
    const serialized = JSON.stringify(warned[0]);
    expect(serialized).not.toContain("SYNTHETIC_UPLOAD_FAILURE_7f3a");
    expect(serialized).not.toContain("SYNTHETIC_ABORT_FAILURE_9c2e");
    expect(serialized).not.toContain("AAAA");
    // Assert — the source stream is torn down and its lock released.
    expect(cancelCalled).toBe(true);
    expect(cancelReason).toBe(uploadError);
    expect(stream.locked).toBe(false);
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
