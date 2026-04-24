/**
 * Optional R2 archive of the raw Routeware CSV (same bytes as D1 sync), per table.
 * Keys: `snapshots/YYYY-MM-DD/{customer|address|container}.csv` (UTC date).
 */

export type SnapshotArchiveTable = "customer" | "address" | "container";

/** S3 / R2 minimum part size for multipart uploads; last part may be smaller. */
export const R2_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

export function snapshotR2ObjectKey(
  table: SnapshotArchiveTable,
  date = new Date()
): string {
  const d = date.toISOString().slice(0, 10);
  return `snapshots/${d}/${table}.csv`;
}

function r2Enabled(env: Env): boolean {
  if (String(env.SNAPSHOTS_R2_ENABLED).toLowerCase() === "false") {
    return false;
  }
  return env.SNAPSHOTS !== undefined;
}

/**
 * Stream body to R2. Uses a single `put` for empty or sub–5 MiB bodies; otherwise
 * multipart with fixed 5 MiB parts (one buffer) so peak memory stays ~5 MiB for the upload.
 */
export async function putReadableStreamToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  options: { httpMetadata: R2HTTPMetadata }
): Promise<void> {
  const reader = stream.getReader();
  const buf = new Uint8Array(R2_MULTIPART_PART_SIZE);
  let off = 0;
  const uploaded: R2UploadedPart[] = [];
  let mpu: R2MultipartUpload | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.byteLength) {
        let from = 0;
        const v = value;
        while (from < v.byteLength) {
          const need = R2_MULTIPART_PART_SIZE - off;
          const take = Math.min(need, v.byteLength - from);
          buf.set(v.subarray(from, from + take), off);
          off += take;
          from += take;
          if (off === R2_MULTIPART_PART_SIZE) {
            if (mpu === null) {
              mpu = await bucket.createMultipartUpload(key, {
                httpMetadata: options.httpMetadata
              });
            }
            const partNumber = uploaded.length + 1;
            uploaded.push(await mpu.uploadPart(partNumber, buf));
            off = 0;
          }
        }
      }
      if (done) {
        break;
      }
    }

    if (mpu === null) {
      if (off === 0) {
        await bucket.put(key, new ArrayBuffer(0), {
          httpMetadata: options.httpMetadata
        });
      } else {
        await bucket.put(key, buf.subarray(0, off), {
          httpMetadata: options.httpMetadata
        });
      }
      return;
    }

    if (off > 0) {
      const partNumber = uploaded.length + 1;
      uploaded.push(await mpu.uploadPart(partNumber, buf.subarray(0, off)));
    }
    await mpu.complete(uploaded);
  } catch (e) {
    if (mpu !== null) {
      try {
        await mpu.abort();
      } catch {
        // ignore
      }
    }
    throw e;
  }
}

/**
 * Run `sync` on a tee of `body` for D1, then after success upload the other branch to R2.
 * D1 failure cancels the R2 leg. R2 failure is logged and does not fail the request (D1 is primary).
 */
export async function archiveReportCsvToR2AfterD1<T>(
  env: Env,
  table: SnapshotArchiveTable,
  body: ReadableStream<Uint8Array>,
  sync: (stream: ReadableStream<Uint8Array>) => Promise<T>
): Promise<T> {
  if (!r2Enabled(env)) {
    return sync(body);
  }
  const [forD1, forR2] = body.tee();
  let result: T;
  try {
    result = await sync(forD1);
  } catch (e) {
    try {
      await forR2.cancel();
    } catch {
      // ignore
    }
    throw e;
  }
  const key = snapshotR2ObjectKey(table);
  try {
    await putReadableStreamToR2(env.SNAPSHOTS, key, forR2, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    });
    console.log(`R2 snapshot stored: ${key}`);
  } catch (e) {
    console.error(
      `R2 snapshot put failed for ${key} (D1 sync already completed)`,
      e
    );
  }
  return result;
}
