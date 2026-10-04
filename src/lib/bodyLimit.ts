import { problemJsonResponse, problemType } from "./problem";

/**
 * Cap for request bodies the app buffers in the isolate (TOG-6518).
 *
 * Every non-import `/api/v1/*` body is held as one `ArrayBuffer` so it can be
 * forwarded upstream (and, for saves, re-read for the anti-forgery token).
 * Those payloads are KB-scale forms and JSON, so 1 MiB is generous headroom.
 * Anything larger is rejected with 413 before the isolate holds it.
 *
 * Snapshot CSV imports are NOT subject to this cap: their handlers stream
 * `raw.body` under their own 50 MB byte cap (`SNAPSHOT_IMPORT_MAX_BYTES` in
 * `src/lib/snapshot/streamSync.ts`), and the middleware below must not buffer
 * them — see `isSnapshotImportPath`.
 */
export const MAX_BUFFERED_BODY_BYTES = 1 * 1024 * 1024;

const SNAPSHOT_IMPORT_SUFFIXES = [
  "/customer-snapshot/import",
  "/address-snapshot/import",
  "/container-snapshot/import"
] as const;

/**
 * True for the snapshot CSV import paths.
 *
 * Tolerant by design: a trailing slash (`/import/`) and case variants
 * (`/IMPORT`) reach no import handler today, but they must still take the
 * streaming exemption — buffering a full export in the isolate just to 404
 * afterwards is the OOM this module exists to prevent. The match runs on the
 * URL pathname only (never the query string) and the returned detail never
 * carries body bytes, so there is no PII surface here.
 */
export function isSnapshotImportPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  return SNAPSHOT_IMPORT_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export type BoundedBodyResult =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; receivedBytes: number };

/**
 * Read a request body without ever holding more than `maxBytes` plus one
 * chunk. Returns the concatenated buffer, or the byte count observed when the
 * cap is exceeded (the surplus chunk is dropped and the stream cancelled, so
 * the caller learns the size without the memory). A missing body reads as an
 * empty buffer, matching the old `arrayBuffer()` behaviour for bodiless
 * POSTs. Zero-length chunks are skipped, not treated as EOF.
 */
export async function readBoundedBody(
  raw: Request,
  maxBytes: number
): Promise<BoundedBodyResult> {
  const body = raw.body;
  if (!body) {
    return { ok: true, buffer: new ArrayBuffer(0) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The verdict is already decided; the finally still releases the lock.
        }
        return { ok: false, receivedBytes: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, buffer: buffer.buffer };
}

/**
 * 413 for a buffered-route body over the cap. The detail carries byte counts
 * only — never body bytes — so an oversized PII upload cannot leak through
 * its own rejection.
 */
export function bufferedBodyTooLargeProblem(
  receivedBytes: number,
  instancePath: string,
  env?: Env
): Response {
  return problemJsonResponse({
    type: problemType("payload-too-large", env),
    title: "Payload Too Large",
    status: 413,
    detail:
      `Request body is ${receivedBytes} bytes, over the ${MAX_BUFFERED_BODY_BYTES} byte ` +
      `limit for buffered routes. Split the upload or use a streaming snapshot import. ` +
      `See docs/PROBLEMS.md#payload-too-large.`,
    instance: instancePath
  });
}
