import { CsvControlCharacterError } from "../lib/csvParse";
import { problemJsonResponse, problemType } from "../lib/problem";
import { SnapshotImportIdentityError } from "../lib/snapshot/importIdentity";
import { InvalidSnapshotCsvError } from "../lib/snapshot/streamSync";

/**
 * Edge guards for the `...-snapshot/import` routes, kept in their
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

/** Reject non-CSV media types before reading the body or writing D1. */
export function rejectUnsupportedSnapshotImportContentType(
  input: { url: string; contentType: string | null },
  env?: Env
): Response | null {
  // Media types are case-insensitive and may carry parameters (RFC 9110 §8.3.1).
  // noUncheckedIndexedAccess: `split(...)[0]` is `string | undefined`; default
  // to "" so a missing part falls through to the 415 below, as before.
  const firstPart = input.contentType?.split(";", 1)[0];
  const mediaType = firstPart?.trim().toLowerCase() ?? "";
  if (mediaType === "text/csv" || mediaType === "application/octet-stream") {
    return null;
  }
  return problemJsonResponse({
    type: problemType("unsupported-media-type", env),
    title: "Unsupported Media Type",
    status: 415,
    detail:
      "Snapshot import requires Content-Type: text/csv or application/octet-stream. See docs/PROBLEMS.md#unsupported-media-type.",
    instance: new URL(input.url).pathname
  });
}

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
 * read guard) → 413; CSV shape, control-character or strict identity errors
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
  if (e instanceof SnapshotImportIdentityError) {
    return problemJsonResponse({
      type: problemType("bad-request", env),
      title: "Bad Request",
      status: 400,
      detail: `${e.message} See docs/PROBLEMS.md#bad-request.`,
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
        : `${invalidCsvMessage(e)} See docs/PROBLEMS.md#bad-request.`,
      instance: new URL(url).pathname
    });
  }
  return null;
}

function invalidCsvMessage(e: unknown): string {
  return (e instanceof InvalidSnapshotCsvError && e.clientMessage) || "Snapshot import body is not valid CSV.";
}
