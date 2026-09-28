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

/**
 * Why the R2 archive is off, or `null` when it is on. Kept as a reason (not a
 * boolean) so the disabled path can log *why* nothing was archived — an absent
 * archive must be distinguishable from a failed one when the cron is green.
 */
function r2DisabledReason(env: Env): string | null {
  if (String(env.SNAPSHOTS_R2_ENABLED).toLowerCase() === "false") {
    return "SNAPSHOTS_R2_ENABLED=false";
  }
  if (env.SNAPSHOTS === undefined) {
    return "SNAPSHOTS binding unbound";
  }
  return null;
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
      } catch (abortErr) {
        // Don't mask the primary failure, but don't hide this either: an
        // abandoned multipart upload is retained (and billed) until lifecycle
        // cleanup, so it needs to be visible in logs.
        console.warn(
          `R2 multipart abort failed for ${key}; upload may be left dangling:`,
          abortErr instanceof Error ? abortErr.message : String(abortErr)
        );
      }
    }
    // Tear the source down promptly rather than leaving it half-read.
    await reader.cancel(e).catch(() => undefined);
    throw e;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream `body` through D1 (`sync`) first, then upload the **same bytes** to R2.
 *
 * D1 is primary and the R2 write runs strictly after it resolves: a failed D1
 * sync must never leave a phantom archive row-set that the database never got
 * (TOG-6550). R2 is best-effort — its failures are logged, not thrown.
 *
 * Buffering note: the CSV is collected in memory (one buffer per chunk) so D1
 * and R2 see identical bytes. Snapshot exports are small enough for this today
 * (the largest is well under the 128 MiB isolate cap, and `tee()`'s internal
 * buffer would have held the same lag had one leg outrun the other); if exports
 * ever approach isolate memory, switch to a byte-counted spill to a temp store.
 */
export async function archiveReportCsvToR2AfterD1<T>(
  env: Env,
  table: SnapshotArchiveTable,
  body: ReadableStream<Uint8Array>,
  sync: (stream: ReadableStream<Uint8Array>) => Promise<T>
): Promise<T> {
  const disabledReason = r2DisabledReason(env);
  if (disabledReason !== null) {
    console.log(
      `R2 snapshot archive disabled for ${table}: ${disabledReason}`
    );
    return sync(body);
  }
  const key = snapshotR2ObjectKey(table);

  // Drain the source once; both legs consume identical in-memory copies.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.byteLength) {
        chunks.push(value.slice());
      }
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = await sync(streamFromChunks(chunks));
  try {
    await putReadableStreamToR2(env.SNAPSHOTS, key, streamFromChunks(chunks), {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    });
    console.log(`R2 snapshot stored: ${key}`);
  } catch (e) {
    console.error(`R2 snapshot put failed for ${key}`, e);
  }
  return result;
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  const copies = chunks.map((c) => c.slice());
  return new ReadableStream({
    start(controller) {
      for (const c of copies) {
        controller.enqueue(c);
      }
      controller.close();
    }
  });
}

/**
 * Read one archived snapshot CSV back from R2 as a stream (TOG-7394).
 *
 * Inverse of the R2 leg in `archiveReportCsvToR2AfterD1`: returns the stored
 * bytes for `snapshots/YYYY-MM-DD/{table}.csv` so the caller can re-sync them
 * into D1 (via `sync*SnapshotFromStream`) or serve them elsewhere. `null`
 * when no object exists at that key — an absent archive, not an error.
 * Throws when the archive is disabled (same reasons as the write path),
 * because a restore without a bound bucket cannot proceed.
 */
export async function restoreSnapshotCsvFromR2(
  env: Env,
  table: SnapshotArchiveTable,
  date = new Date()
): Promise<ReadableStream<Uint8Array> | null> {
  const disabledReason = r2DisabledReason(env);
  if (disabledReason !== null) {
    throw new Error(
      `R2 snapshot restore unavailable for ${table}: ${disabledReason}`
    );
  }
  const key = snapshotR2ObjectKey(table, date);
  const obj = await env.SNAPSHOTS.get(key);
  if (obj === null) {
    return null;
  }
  return obj.body;
}
