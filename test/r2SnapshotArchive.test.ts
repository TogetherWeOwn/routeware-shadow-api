import { describe, expect, it } from "vitest";
import {
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

  const bucket: Pick<R2Bucket, "put" | "createMultipartUpload"> = {
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
