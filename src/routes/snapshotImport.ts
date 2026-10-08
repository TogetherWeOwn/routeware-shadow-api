import { CsvControlCharacterError } from "../lib/csvParse";
import { problemJsonResponse, problemType } from "../lib/problem";

/**
 * Edge guards for the `...-snapshot/import` routes (TOG-6279), kept in their
 * own module — not in `./shared` — so the pick applies cleanly wherever the
 * snapshot auth helpers have diverged. The input is plain data (a URL string
 * plus the declared length), never the framework context type, so callers on
 * any tree shape can build it.
 */
export type SnapshotImportGuardInput = {
  /** Request URL; only its pathname lands in the problem `instance`. */
  url: string;
  /** Value of the `Content-Length` header, or `null` when absent. */
  contentLength: string | null;
};

/**
 * Fail-fast size guard: when the declared `Content-Length` exceeds
 * `maxBytes`, return a 413 problem+json without reading the stream. A
 * missing or non-numeric declaration falls through to the streaming byte
 * counter in `src/lib/snapshot/streamSync.ts`, which rejects a lying
 * declaration the same way — so this returns `null` (not "small enough") in
 * that case.
 */
export function rejectOversizedSnapshotImport(
  input: SnapshotImportGuardInput,
  maxBytes: number,
  env?: Env
): Response | null {
  const declared = input.contentLength;
  if (declared === null) {
    return null;
  }
  const n = Number(declared);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (n <= maxBytes) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("payload-too-large", env),
    title: "Payload Too Large",
    status: 413,
    detail: `Snapshot import body declares ${declared} bytes, over the ${maxBytes} byte limit. See docs/PROBLEMS.md#payload-too-large.`,
    instance: new URL(input.url).pathname
  });
}

/**
 * Map a snapshot import failure to its problem+json response:
 * `SnapshotTooLargeError` (direct or `cause`-wrapped by `streamCsvLines`'s
 * read guard) → 413; `InvalidSnapshotCsvError` or `CsvControlCharacterError`
 * → 400. Only fixed strings and a numeric row are returned — no submitted bytes, so the
 * error body cannot leak PII. Returns `null` for anything else, which the
 * caller lets propagate to the global 500 handler.
 */
export function mapSnapshotImportError(
  url: string,
  e: unknown,
  isTooLarge: (err: unknown) => boolean,
  isInvalidCsv: (err: unknown) => boolean,
  env?: Env
): Response | null {
  if (isTooLarge(e)) {
    return problemJsonResponse({
      type: problemType("payload-too-large", env),
      title: "Payload Too Large",
      status: 413,
      detail:
        "Snapshot import body exceeds the size limit. See docs/PROBLEMS.md#payload-too-large.",
      instance: new URL(url).pathname
    });
  }
  if (e instanceof CsvControlCharacterError || isInvalidCsv(e)) {
    return problemJsonResponse({
      type: problemType("bad-request", env),
      title: "Bad Request",
      status: 400,
      detail: e instanceof CsvControlCharacterError
        ? `CSV row ${e.rowNumber} contains a disallowed control character. See docs/PROBLEMS.md#bad-request.`
        : "Snapshot import body is not valid CSV. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(url).pathname
    });
  }
  return null;
}
