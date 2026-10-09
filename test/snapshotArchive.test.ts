import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { snapshotR2ObjectKey } from "../src/lib/r2SnapshotArchive";

/**
 * TOG-9202 (gap F1) — R2 archive readback route for operators.
 *
 * The sync path archives the raw Routeware CSV to R2
 * (`src/lib/r2SnapshotArchive.ts`, keys
 * `snapshots/YYYY-MM-DD/{customer|address|container}.csv`) but nothing read
 * it back — recovery needed wrangler CLI tribal knowledge. These tests pin
 * the privileged `GET /api/v1/snapshots/:table/:date` route through the real
 * app against the real test R2 bucket:
 *
 * - a seeded archive streams back re-encoded with the export's spreadsheet
 *   escaping (TOG-18829) while the stored object keeps the raw bytes; the
 *   Content-Length and ETag describe the served body;
 * - `If-None-Match` with the current ETag answers 304 with no body;
 * - an archive replaced between the two reads answers 409 problem+json;
 * - the writer's key helper and the route's key agree, so the readback can
 *   never drift from what the sync wrote;
 * - no bearer → outer 401, general API token → inner 401 (sync secret only);
 * - a well-formed but absent archive is 404 problem+json (absent must stay
 *   distinguishable from misconfigured R2, which is 503).
 *
 * Hermetic: the route never touches D1 or the upstream host, so no fetch
 * stub and no D1 migration are needed. Each test file gets a fresh R2
 * bucket, so the seeded keys cannot leak into other files.
 */

const SYNC_SECRET = "test-sync-secret";
const API_TOKEN = "test-api-token";

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

// Fresh TEST-NET-3 octets so the probes never share a throttle bucket with
// each other (or with the auth sweep suites): each call gets its own IP, so
// every unauthenticated hit counts as failure #1 and asserts a 401, never a
// coincidental 429.
let ipSeq = 0;

function archiveEnv(): Env {
  return env as unknown as Env;
}

function bucket(): R2Bucket {
  return (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
}

async function getArchive(
  table: string,
  date: string,
  token: string | null,
  envOverride?: Env,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  // 192.0.2.220+ is unused by every other suite (sweep .64-.141 + .150+,
  // burst .211, isolation .231, throttle .44/.71), so buckets never leak.
  headers.set("CF-Connecting-IP", `192.0.2.${220 + ipSeq++}`);
  return app.fetch(
    new Request(`http://test.local/api/v1/snapshots/${table}/${date}`, { headers }),
    (envOverride ?? archiveEnv()) as Env,
    CTX
  );
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

const ARCHIVE_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";

const ARCHIVE_CSV = [
  ARCHIVE_HEADER,
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true",
  '103,,"=1+HYPERLINK(""https://example.invalid"")",Kim,,Lee,,,,,,,false'
].join("\n");

const ARCHIVE_READBACK = [
  `${ARCHIVE_HEADER},_shadow_csv_encoding`,
  "101,,Acme Corp,John,,Doe,,,,,,,true,1",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true,1",
  `103,,"'=1+HYPERLINK(""https://example.invalid"")",Kim,,Lee,,,,,,,false,1`,
  ""
].join("\n");

const CSV_TYPE = { httpMetadata: { contentType: "text/csv; charset=utf-8" } };

function fnv1a64Etag(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `"fnv64-${h.toString(16).padStart(16, "0")}"`;
}

describe("R2 archive readback (TOG-9202, TOG-18829)", () => {
  it("serves the archive re-encoded for spreadsheets and leaves the stored object unchanged", async () => {
    // Arrange — the writer's key helper names the object, exactly as the
    // sync leg does after a successful D1 stream.
    const day = new Date("2026-09-27T00:00:00.000Z");
    const key = snapshotR2ObjectKey("customer", day);
    expect(key).toBe("snapshots/2026-09-27/customer.csv");
    await bucket().put(key, ARCHIVE_CSV, CSV_TYPE);
    const served = new TextEncoder().encode(ARCHIVE_READBACK);

    // Act — the operator download.
    const res = await getArchive("customer", "2026-09-27", SYNC_SECRET);

    // Assert — the export's marker and escaping, served as a CSV download,
    // with Content-Length and ETag describing exactly those bytes.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-2026-09-27.csv"'
    );
    expect(res.headers.get("content-length")).toBe(String(served.byteLength));
    expect(res.headers.get("etag")).toBe(fnv1a64Etag(served));
    expect(await res.text()).toBe(ARCHIVE_READBACK);
    // The stored object and the sync input keep the raw Routeware bytes.
    const stored = await bucket().get(key);
    expect(await stored?.text()).toBe(ARCHIVE_CSV);
  });

  it("answers 304 with an empty body when If-None-Match carries the current ETag", async () => {
    // Arrange
    await bucket().put("snapshots/2026-09-26/customer.csv", ARCHIVE_CSV, CSV_TYPE);
    const first = await getArchive("customer", "2026-09-26", SYNC_SECRET);
    const etag = first.headers.get("etag");
    await first.text();

    // Act
    const res = await getArchive("customer", "2026-09-26", SYNC_SECRET, undefined, {
      "if-none-match": etag ?? ""
    });

    // Assert
    expect(etag).toBe(fnv1a64Etag(new TextEncoder().encode(ARCHIVE_READBACK)));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("answers 409 problem+json when the archive is replaced between the two reads", async () => {
    // Arrange — the second read is conditional on the first read's ETag; a
    // replacement makes R2 answer with metadata and no body.
    await bucket().put("snapshots/2026-09-25/customer.csv", ARCHIVE_CSV, CSV_TYPE);
    const real = bucket();
    const replaced = {
      get: (key: string, options?: R2GetOptions) =>
        options?.onlyIf
          ? Promise.resolve({ httpEtag: '"replaced"', etag: "replaced", size: 0 })
          : real.get(key, options)
    } as unknown as R2Bucket;

    // Act
    const res = await getArchive(
      "customer",
      "2026-09-25",
      SYNC_SECRET,
      { ...archiveEnv(), SNAPSHOTS: replaced } as unknown as Env
    );

    // Assert — a retryable conflict, never a body built from the stale length.
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("conflict"));
    expect(body.title).toBe("Conflict");
    expect(body.detail).toContain("replaced during the download");
  });

  it("rejects a request with no bearer at the outer gate", async () => {
    // Arrange / Act
    const res = await getArchive("customer", "2026-09-27", null);

    // Assert — the outer gate's wording (SHADOW_API_TOKEN), not the inner check.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("rejects the general API token at the inner sync-secret check", async () => {
    // Arrange / Act — a valid app token that is NOT the sync secret.
    const res = await getArchive("customer", "2026-09-27", API_TOKEN);

    // Assert — the canonical inner 401 naming the sync secret.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toBe(
      "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized."
    );
    expect(body.instance).toBe("/api/v1/snapshots/customer/2026-09-27");
  });

  it("answers 404 problem+json for a well-formed but absent archive", async () => {
    // Arrange / Act — valid shape, never seeded.
    const res = await getArchive("customer", "1999-01-01", SYNC_SECRET);

    // Assert — absent stays distinguishable from a failed archive.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("not-found"));
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
    expect(body.detail).toContain("table=customer date=1999-01-01");
  });

  it("answers 400 for an unknown table and for a malformed date", async () => {
    // Arrange / Act — zod rejects both before any R2 read runs.
    const badTable = await getArchive("bogus", "2026-09-27", SYNC_SECRET);
    const badDate = await getArchive("customer", "yesterday", SYNC_SECRET);

    // Assert — the anchored bad-request shape, never values.
    for (const res of [badTable, badDate]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(problemType("bad-request"));
      expect(body.status).toBe(400);
    }
  });

  it("answers 503 when the SNAPSHOTS binding is unbound", async () => {
    // Arrange — R2 not configured at all (vs merely missing one key).
    const unbound = { ...archiveEnv(), SNAPSHOTS: undefined } as unknown as Env;

    // Act
    const res = await getArchive("customer", "2026-09-27", SYNC_SECRET, unbound);

    // Assert — misconfigured, not not-found.
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("misconfigured"));
    expect(body.status).toBe(503);
    expect(body.detail).toContain("SNAPSHOTS binding unbound");
  });
});
