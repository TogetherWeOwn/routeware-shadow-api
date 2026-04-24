/**
 * Optional R2 archive of the raw Routeware CSV (same bytes as D1 sync), per table.
 * Keys: `snapshots/YYYY-MM-DD/{customer|address|container}.csv` (UTC date).
 */

export type SnapshotArchiveTable = "customer" | "address" | "container";

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
    await env.SNAPSHOTS.put(key, forR2, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    });
    console.log(`R2 snapshot stored: ${key}`);
  } catch (e) {
    console.error(`R2 snapshot put failed for ${key} (D1 sync already completed)`, e);
  }
  return result;
}
