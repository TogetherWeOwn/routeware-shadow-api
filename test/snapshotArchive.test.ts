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
 * - a seeded archive streams back byte-identical (operator diffs the download
 *   against a fresh `...-snapshot/export` before recovery);
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
  envOverride?: Env
): Promise<Response> {
  const headers = new Headers();
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

const ARCHIVE_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

describe("R2 archive readback (TOG-9202)", () => {
  it("streams a seeded archive byte-identical with the writer's key", async () => {
    // Arrange — the writer's key helper names the object, exactly as the
    // sync leg does after a successful D1 stream.
    const day = new Date("2026-09-27T00:00:00.000Z");
    const key = snapshotR2ObjectKey("customer", day);
    expect(key).toBe("snapshots/2026-09-27/customer.csv");
    const seeded = await bucket().put(key, ARCHIVE_CSV, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" }
    });

    // Act — the operator download.
    const res = await getArchive("customer", "2026-09-27", SYNC_SECRET);

    // Assert — same bytes the sync archived, served as a CSV download.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-2026-09-27.csv"'
    );
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(ARCHIVE_CSV).byteLength)
    );
    // `httpEtag` is the quoted, HTTP-ready value (not R2's unquoted `etag`
    // digest) — guards the TOG-10443 CHANGES finding.
    expect(res.headers.get("etag")).toBe(seeded.httpEtag);
    expect(await res.text()).toBe(ARCHIVE_CSV);
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
