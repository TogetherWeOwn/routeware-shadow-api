/**
 * Optional R2 archive of the raw Routeware CSV (same bytes as D1 sync), per table.
 * History: `snapshot-history/YYYY-MM-DD/<timestamp>-<uuid>/<table>.csv`.
 * Date aliases remain at `snapshots/YYYY-MM-DD/<table>.csv` for compatibility.
 */

import { errorKind, logEvent } from "./logger";
import { readReportStreamStallTimeoutMs, readWithStallTimeout } from "./upstreamTimeout";

export type SnapshotArchiveTable = "customer" | "address" | "container";

/**
 * Machine-readable R2 outcome for one table's archive leg.
 *
 * The cron's structured line keys on this — a failed or disabled archive must
 * never again hide behind a D1 `outcome:success`. Only the status, the object
 * key (`snapshot-history/<date>/<run>/<table>.csv`, no row data) and the failure message
 * travel here — never row data (CONVENTIONS.md fact 2).
 */
export type R2ArchiveStatus = "stored" | "disabled" | "failed";

export type R2ArchiveDetail = {
  status: R2ArchiveStatus;
  /** Disabled reason or failure message (message-only, never row data). */
  reason?: string;
  /** History key attempted/stored. UTC timestamp + random run id + table — no PII. */
  key?: string;
};

const R2_ARCHIVE_STATUSES: readonly string[] = ["stored", "disabled", "failed"];

/** Status guard for local archive results; wire callers must project, not retain the object. */
export function isR2ArchiveDetail(v: unknown): v is R2ArchiveDetail {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return false;
  }
  const s = (v as { status?: unknown }).status;
  return typeof s === "string" && R2_ARCHIVE_STATUSES.includes(s);
}

/**
 * Pick only sanctioned wire metadata before it can reach chained cron reports.
 * Keys and arbitrary properties never cross this boundary. Known publication
 * stages become fixed classifications, never driver messages or their suffixes.
 */
export function projectR2ArchiveDetail(v: unknown): R2ArchiveDetail | undefined {
  if (!isR2ArchiveDetail(v)) return undefined;
  const out: R2ArchiveDetail = { status: v.status };
  if (typeof v.reason !== "string") return out;
  if (v.status === "disabled") {
    if (v.reason === "SNAPSHOTS binding unbound" || v.reason === "SNAPSHOTS_R2_ENABLED=false") {
      out.reason = v.reason;
    }
  } else if (v.status === "failed") {
    if (v.reason === "R2 publication unavailable" || v.reason === "R2 outcome unreported") {
      out.reason = v.reason;
    } else if (v.reason.startsWith("daily alias: ")) {
      out.reason = "daily alias: R2 publication unavailable";
    }
  } else {
    for (const stage of ["history manifest", "daily manifest", "latest pointer"]) {
      if (v.reason.startsWith(`manifest: ${stage}: `)) {
        out.reason = `manifest: ${stage}: R2 publication unavailable`;
        break;
      }
    }
  }
  return out;
}

/** S3 / R2 minimum part size for multipart uploads; last part may be smaller. */
export const R2_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

/** Per-table run identity: UUID prevents collisions even within one millisecond. */
export function snapshotR2HistoryObjectKey(
  table: SnapshotArchiveTable,
  date = new Date()
): string {
  const timestamp = date.toISOString();
  const run = `${timestamp.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  return `snapshot-history/${timestamp.slice(0, 10)}/${run}/${table}.csv`;
}

/** Stable JSON manifest pointing to the last fully published table archive. */
export function snapshotR2LatestObjectKey(table: SnapshotArchiveTable): string {
  return `snapshot-latest/${table}.json`;
}

/** Compatibility alias: the last successfully copied CSV for this UTC date. */
export function snapshotR2ObjectKey(
  table: SnapshotArchiveTable,
  date = new Date()
): string {
  const d = date.toISOString().slice(0, 10);
  return `snapshots/${d}/${table}.csv`;
}

/**
 * Sidecar integrity manifest for one UTC date's archive.
 *
 * Key: `snapshots/YYYY-MM-DD.manifest.json` — a sibling of the date's CSV
 * "directory" (R2 has no real directories, so the manifest sits next to it,
 * not inside it). Content is hashes, sizes and keys only — never row data —
 * so it is safe to log, print and commit as a fixture.
 */
export const SNAPSHOT_MANIFEST_VERSION = 1;

export type SnapshotManifestFileEntry = {
  /** Full R2 key, e.g. `snapshots/2026-09-28/customer.csv`. */
  key: string;
  /** Lowercase hex sha256 of the exact bytes stored at `key`. */
  sha256: string;
  /** Byte length of the stored object. */
  bytes: number;
};

export type SnapshotManifest = {
  version: 1;
  /** UTC date the archive belongs to, `YYYY-MM-DD`. */
  date: string;
  /** CSV basename (`customer.csv`) → entry. Only archived tables are listed. */
  files: Record<string, SnapshotManifestFileEntry>;
};

export function snapshotR2ManifestObjectKey(date = new Date()): string {
  const d = date.toISOString().slice(0, 10);
  return `snapshots/${d}.manifest.json`;
}

/** sha256 of `data` as lowercase hex (Worker `crypto.subtle`; no row data logged). */
export async function sha256HexBytes(data: Uint8Array): Promise<string> {
  // `digest` wants `Uint8Array<ArrayBuffer>`; a generic `Uint8Array` may view
  // a `SharedArrayBuffer`, so narrow the buffer kind here. Runtime bytes are
  // unchanged — this only reads them.
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Render a manifest deterministically (sorted basenames, trailing newline). */
export function renderSnapshotManifest(manifest: SnapshotManifest): string {
  const files: Record<string, SnapshotManifestFileEntry> = {};
  for (const name of Object.keys(manifest.files).sort()) {
    const entry = manifest.files[name];
    if (entry === undefined) {
      continue;
    }
    files[name] = entry;
  }
  return `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
}

/** Type-guard for a parsed manifest: version, date shape, and per-file entry shape. */
export function isSnapshotManifest(value: unknown): value is SnapshotManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== SNAPSHOT_MANIFEST_VERSION) return false;
  if (typeof v.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return false;
  if (typeof v.files !== "object" || v.files === null) return false;
  for (const entry of Object.values(v.files as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== "string") return false;
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) return false;
    if (typeof e.bytes !== "number" || !Number.isInteger(e.bytes) || e.bytes < 0) return false;
  }
  return true;
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
  options: { httpMetadata: R2HTTPMetadata },
  // Per-run correlation id: carried onto the abort-failure warn
  // when present; absent for direct callers without a run (unchanged records).
  runId?: string
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
        // Don't mask the primary failure, but don't hide this either: an
        // abandoned multipart upload is retained (and billed) until lifecycle
        // cleanup, so it needs to be visible in logs.
        logEvent({
          level: "warn",
          msg: "R2 multipart abort failed; upload may be left dangling",
          route: "snapshot.r2.multipart",
          key,
          ...(runId ? { runId } : {})
        });
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
 * sync must never leave a phantom archive row-set that the database never got.
 * R2 is best-effort — its failures are logged, not thrown.
 *
 * `onArchive` reports the machine-readable R2 outcome on every
 * path — disabled, stored, or failed — so the caller can surface it in the
 * cron log line instead of leaving a missing archive behind a D1
 * `outcome:success`. The callback fires at most once per call and never
 * throws (it is a pure report).
 *
 * Buffering note: the CSV is collected in memory (one buffer per chunk) so D1
 * and R2 see identical bytes; D1, each CSV put and the hash take their own
 * copy of those chunks, one after another. Snapshot exports are small enough
 * for this today (the largest is well under the 128 MiB isolate cap, and
 * `tee()`'s internal buffer would have held the same lag had one leg outrun
 * the other); if exports ever approach isolate memory, switch to a
 * byte-counted spill to a temp store.
 */
export async function archiveReportCsvToR2AfterD1<T>(
  env: Env,
  table: SnapshotArchiveTable,
  body: ReadableStream<Uint8Array>,
  sync: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  onArchive?: (detail: R2ArchiveDetail) => void,
  // Per-run correlation id: when present, every log line on the
  // archive leg carries it, so the R2 leg attributes to its originating run.
  runId?: string
): Promise<T> {
  const disabledReason = r2DisabledReason(env);
  if (disabledReason !== null) {
    logEvent({
      level: "info",
      msg: "R2 snapshot archive disabled",
      route: "snapshot.r2.archive",
      table,
      reason: disabledReason,
      ...(runId ? { runId } : {})
    });
    onArchive?.({ status: "disabled", reason: disabledReason });
    return sync(body);
  }
  // One clock read: the CSV and its manifest entry must land on the same UTC
  // date even if the sync straddles midnight.
  const now = new Date();
  const key = snapshotR2HistoryObjectKey(table, now);
  const dailyKey = snapshotR2ObjectKey(table, now);
  const manifestKey = snapshotR2ManifestObjectKey(now);

  // Drain the source once; both legs consume identical in-memory copies.
  // Stall-bounded like the D1 leg: a hung upstream mid-stream must fail here
  // as a 502 timeout, not hold the Worker while the sync below never runs.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const stallTimeoutMs = readReportStreamStallTimeoutMs(env);
  try {
    for (;;) {
      const { done, value } = await readWithStallTimeout(reader, stallTimeoutMs);
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
  // The two CSV copies decide `failed`: the history object and the daily alias
  // the date read/restore routes serve. Either failing is a failed archive, as
  // a failed CSV put was before history keys existed. Sidecars and pointers
  // below only qualify a `stored` outcome.
  let csvKey = key;
  try {
    await putReadableStreamToR2(env.SNAPSHOTS, key, streamFromChunks(chunks), {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    }, runId);
    csvKey = dailyKey;
    await putReadableStreamToR2(env.SNAPSHOTS, dailyKey, streamFromChunks(chunks), {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    }, runId);
    // Logged only once both CSV copies landed, so "stored" never precedes a failure.
    logEvent({ level: "info", msg: "R2 snapshot stored", route: "snapshot.r2.archive", key, ...(runId ? { runId } : {}) });
  } catch (e) {
    // No CSV, no manifest entry: recording a hash for bytes that never
    // landed would make the manifest a lie. D1 already succeeded, so this
    // stays best-effort (logged, not thrown) like every other R2 failure.
    // Message-only: an R2 driver error carries no row data (same class as the
    // D1 driver text already logged elsewhere — never upstream text).
    const message = e instanceof Error ? e.message : String(e);
    logEvent({ level: "error", msg: "R2 snapshot put failed", route: "snapshot.r2.archive", key: csvKey, ...(runId ? { runId } : {}) });
    onArchive?.({
      status: "failed",
      reason: csvKey === key ? message : `daily alias: ${message}`,
      key
    });
    return result;
  }
  let stage = "history manifest";
  let stageKey = `${key}.manifest.json`;
  let outcome: R2ArchiveDetail = { status: "stored", key };
  try {
    const entry: SnapshotManifestFileEntry = {
      key,
      sha256: await sha256HexBytes(concatChunks(chunks)),
      bytes: chunks.reduce((n, c) => n + c.byteLength, 0)
    };
    const historyManifest = renderSnapshotManifest({
      version: SNAPSHOT_MANIFEST_VERSION,
      date: now.toISOString().slice(0, 10),
      files: { [csvBasename(table)]: entry }
    });
    // Each run keeps its own integrity record, even after latest is replaced.
    // R2 put metadata: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions
    const jsonOptions = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
    await env.SNAPSHOTS.put(stageKey, historyManifest, jsonOptions);
    stage = "daily manifest";
    stageKey = manifestKey;
    await updateSnapshotManifest(env.SNAPSHOTS, manifestKey, {
      [csvBasename(table)]: { ...entry, key: dailyKey }
    }, runId);
    // Publish latest last: readers never discover a CSV or manifest that has not landed.
    stage = "latest pointer";
    stageKey = snapshotR2LatestObjectKey(table);
    await env.SNAPSHOTS.put(stageKey, historyManifest, jsonOptions);
    logEvent({
      level: "info",
      msg: "R2 snapshot manifest updated",
      route: "snapshot.r2.manifest",
      manifestKey,
      ...(runId ? { runId } : {})
    });
  } catch (e) {
    // Both CSVs landed: still `stored` (the archive exists), with the failed
    // stage carried in the reason so the cron line's JSON shows an incomplete
    // publication instead of a clean archive.
    const message = e instanceof Error ? e.message : String(e);
    logEvent({
      level: "error",
      msg: "R2 snapshot manifest update failed",
      route: "snapshot.r2.manifest",
      key: stageKey,
      ...(runId ? { runId } : {})
    });
    outcome = { status: "stored", key, reason: `manifest: ${stage}: ${message}` };
  }
  onArchive?.(outcome);
  return result;
}

/** `customer` → `customer.csv`: the manifest's per-file map key. */
export function csvBasename(table: SnapshotArchiveTable): string {
  return `${table}.csv`;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Read-modify-write one table's entry into the date's sidecar manifest.
 * Creates the manifest when absent; a corrupt existing manifest
 * is replaced (warned) so one bad sidecar cannot wedge future archives —
 * `verify-r2-manifest` then reports the other tables as missing, loudly.
 *
 * Sequential-cron caveat: two same-date writers racing (not the case for the
 * sequential chained/single-invocation syncs) can clobber each other's entry
 * via last-writer-wins. That surfaces as `missing` at verify time, never as
 * a silent pass.
 */
export async function updateSnapshotManifest(
  bucket: R2Bucket,
  manifestKey: string,
  entries: Record<string, SnapshotManifestFileEntry>,
  // Per-run correlation id: carried onto the replace-path warns
  // when present; absent for direct callers without a run (unchanged records).
  runId?: string
): Promise<void> {
  const dateMatch = /snapshots\/(\d{4}-\d{2}-\d{2})\.manifest\.json$/.exec(manifestKey);
  const date = dateMatch?.[1] ?? new Date().toISOString().slice(0, 10);
  let manifest: SnapshotManifest = { version: 1, date, files: {} };
  const existing = await bucket.get(manifestKey);
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(await existing.text());
      if (isSnapshotManifest(parsed)) {
        manifest = parsed;
      } else {
        logEvent({
          level: "warn",
          msg: "R2 snapshot manifest failed validation; replacing",
          route: "snapshot.r2.manifest",
          manifestKey,
          ...(runId ? { runId } : {})
        });
      }
    } catch (parseErr) {
      logEvent({
        level: "warn",
        msg: "R2 snapshot manifest is not JSON; replacing",
        route: "snapshot.r2.manifest",
        manifestKey,
        kind: errorKind(parseErr),
        ...(runId ? { runId } : {})
      });
    }
  }
  manifest = {
    ...manifest,
    date,
    files: { ...manifest.files, ...entries }
  };
  await bucket.put(manifestKey, renderSnapshotManifest(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
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
 * Read one archived snapshot CSV back from R2 as a stream.
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
