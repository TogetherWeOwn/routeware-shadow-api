import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import {
  csvBasename,
  renderSnapshotManifest,
  sha256HexBytes,
  snapshotR2HistoryObjectKey,
  snapshotR2LatestObjectKey,
  snapshotR2ObjectKey,
  SNAPSHOT_MANIFEST_VERSION,
  type SnapshotArchiveTable,
  type SnapshotManifest
} from "../src/lib/r2SnapshotArchive";

/**
 * R20-01 acceptance: download the latest archived snapshot CSV by table alone.
 *
 * An authorized agent can fetch the newest archived snapshot CSV for a table
 * without first discovering which date last synced, via the dedicated
 * `GET /api/v1/snapshots/{table}/latest` operation. The archive writer
 * publishes `snapshot-latest/{table}.json` pointers after every archive
 * (`src/lib/r2SnapshotArchive.ts`); this route resolves the pointer and
 * serves the CSV it names.
 *
 * ACCEPTANCE CONTRACT (the Builder implements exactly this; this file is the
 * oracle and must NOT be edited by the Builder):
 *
 * - Operation: `GET /api/v1/snapshots/{table}/latest`,
 *   `operationId: "getSnapshotLatestArchive"`, tag `data-snapshot`,
 *   `x-access: sync-secret`, `x-effect: local-read`. `table` reuses the
 *   existing `customer|address|container` enum (with an OpenAPI example, as
 *   the date route has); anything else is 400 `bad-request` before any R2
 *   read runs.
 * - Auth: the sync-secret gate, identical to the date route. No bearer hits
 *   the outer 401 naming `SHADOW_API_TOKEN`; the general API token and the
 *   read-only token pass the outer GET gate and then hit the inner 401 with
 *   the canonical sync-secret detail plus `instance` for the request path.
 * - Pointer resolution: read `snapshot-latest/{table}.json` (via
 *   `snapshotR2LatestObjectKey`), parse it as JSON, require
 *   `isSnapshotManifest`, and serve `files["{table}.csv"].key`. The
 *   pointer's `sha256`/`bytes`/`date` fields are NOT re-verified (manifest
 *   re-verification is out of scope): a stale hash still serves.
 * - Serving: the shared spreadsheet-safe re-encode
 *   (`measureSpreadsheetSafeCsv` / `spreadsheetSafeCsvStream`), so the
 *   latest download is byte-identical to the explicit-date download of the
 *   same stored CSV, with the same content-hash ETag. `Content-Length` and
 *   `ETag` describe the served bytes; `If-None-Match` carrying the current
 *   tag, or `*`, answers 304 with an empty body. `Content-Disposition` is
 *   `attachment; filename="{table}-latest.csv"`; `Content-Type` comes from
 *   the stored object (`text/csv` here).
 * - Missing pointer OR missing pointed-to CSV: the SAME fixed table-only
 *   404 — `type` not-found, `title` "Not Found", `status` 404,
 *   `detail: "No snapshot archive for table=${table}. See
 *   docs/PROBLEMS.md#not-found."`, `instance` the request pathname. The
 *   detail never carries a date, an R2 key, or pointer bytes.
 * - Corrupt pointer (not JSON, failing manifest validation, missing this
 *   table's entry, or a non-string entry key): a fixed sanitized 500 —
 *   `type` internal, `title` "Internal Server Error", `status` 500,
 *   `detail: "Snapshot latest pointer for table=${table} is unreadable.
 *   Re-run the table sync to republish it. See
 *   docs/PROBLEMS.md#internal."`, `instance` the request pathname. Never
 *   the thrown parse text, never pointer bytes, never an R2 key — and never
 *   the generic `onError` body (which carries `requestId` and no
 *   `instance`); the handler answers directly.
 * - Unbound `SNAPSHOTS`: 503 `misconfigured`, same wording as the date
 *   route. The explicit-date route is unchanged.
 *
 * RED-before-build: on the pre-implementation head every latest-route test
 * below fails (the date route's validator answers 400 for `date=latest`;
 * the OpenAPI inventory tests updated alongside fail on the missing
 * operation). The auth-outer-gate, invalid-table, and date-route regression
 * tests pass both before and after — they pin shared gates, not new
 * behavior.
 *
 * Hermetic: the route never touches D1 or the upstream host. Happy-path
 * tests seed the real test R2 bucket (fresh per test file); negative tests
 * use in-memory R2 doubles so they are order-independent despite the three
 * fixed pointer keys. Unexpected outbound fetch throws.
 */

const SYNC_SECRET = "test-sync-secret";
const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

// 192.0.2.170+ is unused by every other suite (resweep .150-.168, burst
// .211-.213, archive .220+, isolation .231), so each call gets a fresh
// throttle bucket and asserts its own status, never a coincidental 429.
let ipSeq = 0;

function testEnv(): Env {
  return env as unknown as Env;
}

function bucket(): R2Bucket {
  return (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
}

async function getLatest(
  table: string,
  token: string | null,
  envOverride?: Env,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("CF-Connecting-IP", `192.0.2.${170 + ipSeq++}`);
  return app.fetch(
    new Request(`http://test.local/api/v1/snapshots/${table}/latest`, { headers }),
    (envOverride ?? testEnv()) as Env,
    CTX
  );
}

async function getDateArchive(
  table: string,
  date: string,
  token: string | null
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("CF-Connecting-IP", `192.0.2.${170 + ipSeq++}`);
  return app.fetch(
    new Request(`http://test.local/api/v1/snapshots/${table}/${date}`, { headers }),
    testEnv(),
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

const CSV_TYPE = { httpMetadata: { contentType: "text/csv; charset=utf-8" } };
const JSON_TYPE = { httpMetadata: { contentType: "application/json; charset=utf-8" } };

const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";
const latestNotFoundDetail = (table: string): string =>
  `No snapshot archive for table=${table}. See docs/PROBLEMS.md#not-found.`;
const corruptPointerDetail = (table: string): string =>
  `Snapshot latest pointer for table=${table} is unreadable. ` +
  `Re-run the table sync to republish it. See docs/PROBLEMS.md#internal.`;

/** Per-table stored bytes: distinct markers prove each pointer resolves its own CSV. */
function csvFor(table: string): string {
  return [
    "Id,CompanyName,Enabled",
    `101,${table}-one,true`,
    `102,${table}-two,false`,
    `103,"=1+HYPERLINK(""https://example.invalid"")",true`
  ].join("\n");
}

/** Hand-pinned re-encode of `csvFor`: marker column, formula escaping, LF rows. */
function readbackFor(table: string): string {
  return [
    "Id,CompanyName,Enabled,_shadow_csv_encoding",
    `101,${table}-one,true,1`,
    `102,${table}-two,false,1`,
    `103,"'=1+HYPERLINK(""https://example.invalid"")",true,1`,
    ""
  ].join("\n");
}

function fnv1a64Etag(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `"fnv64-${h.toString(16).padStart(16, "0")}"`;
}

/**
 * Seed the real test bucket: history CSV under a writer-shaped key plus the
 * per-table latest pointer naming it. Overwrites freely — every test seeds
 * exactly what it asserts, so file order never matters.
 */
async function seedLatest(
  table: SnapshotArchiveTable,
  csv: string,
  date = new Date("2026-09-27T00:00:00.000Z")
): Promise<{ historyKey: string; pointerKey: string }> {
  const historyKey = snapshotR2HistoryObjectKey(table, date);
  await bucket().put(historyKey, csv, CSV_TYPE);
  const bytes = new TextEncoder().encode(csv);
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_MANIFEST_VERSION,
    date: date.toISOString().slice(0, 10),
    files: {
      [csvBasename(table)]: {
        key: historyKey,
        sha256: await sha256HexBytes(bytes),
        bytes: bytes.byteLength
      }
    }
  };
  const pointerKey = snapshotR2LatestObjectKey(table);
  await bucket().put(pointerKey, renderSnapshotManifest(manifest), JSON_TYPE);
  return { historyKey, pointerKey };
}

/** In-memory R2 double: `get` serves `objects`, null otherwise (options ignored). */
function fakeSnapshotsBucket(objects: Record<string, string>): R2Bucket {
  return {
    get: (key: string) => {
      if (!Object.hasOwn(objects, key)) {
        return Promise.resolve(null);
      }
      const text = objects[key] as string;
      const bytes = new TextEncoder().encode(text);
      return Promise.resolve({
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text) as unknown),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          }
        }),
        etag: '"fake-etag"',
        size: bytes.byteLength,
        httpMetadata: { contentType: "text/csv; charset=utf-8" }
      });
    }
  } as unknown as R2Bucket;
}

function pointerJson(
  table: SnapshotArchiveTable,
  csvKey: string,
  sha256: string,
  bytes: number,
  date = "2026-09-27"
): string {
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_MANIFEST_VERSION,
    date,
    files: { [csvBasename(table)]: { key: csvKey, sha256, bytes } }
  };
  return renderSnapshotManifest(manifest);
}

describe("latest snapshot archive acceptance (R20-01)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // The route reads R2 only: any upstream fetch is a leak, fail loudly.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in latest-archive acceptance test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("serves the newest customer archive through the latest pointer", async () => {
    // Arrange — history CSV plus the pointer naming it, exactly as the sync
    // leg publishes them.
    const csv = csvFor("customer");
    const { historyKey, pointerKey } = await seedLatest("customer", csv);
    expect(pointerKey).toBe("snapshot-latest/customer.json");
    expect(historyKey).toMatch(
      /^snapshot-history\/2026-09-27\/2026-09-27T00-00-00-000Z-[0-9a-f-]{36}\/customer\.csv$/
    );
    const served = new TextEncoder().encode(readbackFor("customer"));

    // Act
    const res = await getLatest("customer", SYNC_SECRET);

    // Assert — the shared re-encode, served as a CSV download, with
    // Content-Length and ETag describing exactly those bytes.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-latest.csv"'
    );
    expect(res.headers.get("content-length")).toBe(String(served.byteLength));
    expect(res.headers.get("etag")).toBe(fnv1a64Etag(served));
    expect(await res.text()).toBe(readbackFor("customer"));
    // The stored history object keeps the raw Routeware bytes.
    const stored = await bucket().get(historyKey);
    expect(await stored?.text()).toBe(csv);
  });

  it.each(["customer", "address", "container"] as const)(
    "serves the latest %s archive with a table-scoped filename",
    async (table) => {
      // Arrange — each table resolves its own pointer to its own CSV.
      await seedLatest(table, csvFor(table));

      // Act
      const res = await getLatest(table, SYNC_SECRET);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="${table}-latest.csv"`
      );
      const body = await res.text();
      expect(body).toBe(readbackFor(table));
      expect(body).toContain(`${table}-one`);
    }
  );

  it("serves identical bytes to the explicit-date download for the same stored CSV", async () => {
    // Arrange — the same CSV under both the history key (via the pointer)
    // and the daily alias the date route serves.
    const csv = csvFor("customer");
    await seedLatest("customer", csv);
    const aliasKey = snapshotR2ObjectKey("customer", new Date("2026-09-27T00:00:00.000Z"));
    expect(aliasKey).toBe("snapshots/2026-09-27/customer.csv");
    await bucket().put(aliasKey, csv, CSV_TYPE);

    // Act
    const latest = await getLatest("customer", SYNC_SECRET);
    const dated = await getDateArchive("customer", "2026-09-27", SYNC_SECRET);

    // Assert — one shared re-encode: identical bodies, lengths and ETags.
    expect(latest.status).toBe(200);
    expect(dated.status).toBe(200);
    const latestBody = await latest.text();
    const datedBody = await dated.text();
    expect(latestBody).toBe(datedBody);
    expect(latestBody).toBe(readbackFor("customer"));
    expect(latest.headers.get("etag")).toBe(dated.headers.get("etag"));
    expect(latest.headers.get("content-length")).toBe(dated.headers.get("content-length"));
    expect(latest.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-latest.csv"'
    );
    expect(dated.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-2026-09-27.csv"'
    );
  });

  it("answers 304 with an empty body when If-None-Match carries the current latest ETag", async () => {
    // Arrange
    await seedLatest("address", csvFor("address"));
    const first = await getLatest("address", SYNC_SECRET);
    const etag = first.headers.get("etag");
    await first.text();

    // Act
    const res = await getLatest("address", SYNC_SECRET, undefined, {
      "if-none-match": etag ?? ""
    });

    // Assert — the ETag is a content hash of the served bytes.
    expect(etag).toBe(fnv1a64Etag(new TextEncoder().encode(readbackFor("address"))));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("answers 304 for If-None-Match: * on an existing latest archive", async () => {
    // Arrange
    await seedLatest("container", csvFor("container"));

    // Act
    const res = await getLatest("container", SYNC_SECRET, undefined, {
      "if-none-match": "*"
    });

    // Assert
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("answers a fixed table-only 404 when the latest pointer is missing", async () => {
    // Arrange — an R2 double with no pointer at all.
    const empty = { ...testEnv(), SNAPSHOTS: fakeSnapshotsBucket({}) } as unknown as Env;

    // Act
    const res = await getLatest("customer", SYNC_SECRET, empty);

    // Assert — fixed shape: no date, no key, no pointer bytes.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("not-found"));
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
    expect(body.detail).toBe(latestNotFoundDetail("customer"));
    expect(body.detail).not.toContain("2026-");
    expect(body.instance).toBe("/api/v1/snapshots/customer/latest");
    expect(body).not.toHaveProperty("requestId");
  });

  it("answers the same table-only 404 when the pointed-to CSV is missing", async () => {
    // Arrange — a valid pointer naming a key that was never stored.
    const pointer = pointerJson(
      "customer",
      "snapshot-history/2026-09-27/never-stored-run/customer.csv",
      "0".repeat(64),
      10
    );
    const missingCsv = {
      ...testEnv(),
      SNAPSHOTS: fakeSnapshotsBucket({ "snapshot-latest/customer.json": pointer })
    } as unknown as Env;

    // Act
    const res = await getLatest("customer", SYNC_SECRET, missingCsv);

    // Assert — indistinguishable from a missing pointer: table-only, fixed.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("not-found"));
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
    expect(body.detail).toBe(latestNotFoundDetail("customer"));
    expect(body.detail).not.toContain("never-stored-run");
    expect(body.instance).toBe("/api/v1/snapshots/customer/latest");
    expect(body).not.toHaveProperty("requestId");
  });

  it("answers a fixed table-only 409 when the latest archive is replaced during download", async () => {
    // Arrange — pointer and first CSV read use real R2; the conditional
    // second CSV read returns replacement metadata without a body.
    const { historyKey, pointerKey } = await seedLatest("customer", csvFor("customer"));
    const real = bucket();
    const replaced = {
      get: (key: string, options?: R2GetOptions) =>
        options?.onlyIf
          ? Promise.resolve({ httpEtag: '"replaced"', etag: "replaced", size: 0 })
          : real.get(key, options)
    } as unknown as R2Bucket;

    // Act
    const res = await getLatest(
      "customer",
      SYNC_SECRET,
      { ...testEnv(), SNAPSHOTS: replaced } as unknown as Env
    );

    // Assert — the latest-specific conflict names only the table, never
    // the resolved date, run, pointer, or storage key.
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body).toEqual({
      type: problemType("conflict"),
      title: "Conflict",
      status: 409,
      detail:
        "The snapshot archive for table=customer was replaced during the download. " +
        "Retry the download. See docs/PROBLEMS.md#conflict.",
      instance: "/api/v1/snapshots/customer/latest"
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(pointerKey);
    expect(serialized).not.toContain(historyKey);
    expect(serialized).not.toContain(historyKey.split("/")[2] as string);
    expect(serialized).not.toContain("2026-09-27");
  });

  it("answers a fixed table-only 404 when the latest archive is deleted during download", async () => {
    // Arrange — the pointer and first CSV read succeed; only the
    // conditional second CSV read observes the deletion.
    const { historyKey, pointerKey } = await seedLatest("customer", csvFor("customer"));
    const real = bucket();
    const deleted = {
      get: (key: string, options?: R2GetOptions) =>
        options?.onlyIf ? Promise.resolve(null) : real.get(key, options)
    } as unknown as R2Bucket;

    // Act
    const res = await getLatest(
      "customer",
      SYNC_SECRET,
      { ...testEnv(), SNAPSHOTS: deleted } as unknown as Env
    );

    // Assert — the same table-only not-found problem as an absent pointer,
    // not the explicit-date route's date-bearing detail.
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body).toEqual({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: latestNotFoundDetail("customer"),
      instance: "/api/v1/snapshots/customer/latest"
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(pointerKey);
    expect(serialized).not.toContain(historyKey);
    expect(serialized).not.toContain(historyKey.split("/")[2] as string);
    expect(serialized).not.toContain("2026-09-27");
  });

  it.each([
    ["is not JSON at all", "{not json"],
    [
      "fails manifest validation",
      JSON.stringify({ version: 1, date: "not-a-date", files: {} })
    ],
    [
      "lacks this table's entry",
      JSON.stringify({
        version: 1,
        date: "2026-09-27",
        files: {
          "address.csv": {
            key: "snapshots/2026-09-27/address.csv",
            sha256: "0".repeat(64),
            bytes: 10
          }
        }
      })
    ],
    [
      "carries a non-string entry key",
      JSON.stringify({
        version: 1,
        date: "2026-09-27",
        files: {
          "customer.csv": { key: 42, sha256: "0".repeat(64), bytes: 10 }
        }
      })
    ]
  ])("answers a fixed sanitized 500 when the pointer %s", async (_label, pointerText) => {
    // Arrange — the double serves only the corrupt pointer.
    const corrupt = {
      ...testEnv(),
      SNAPSHOTS: fakeSnapshotsBucket({ "snapshot-latest/customer.json": pointerText })
    } as unknown as Env;

    // Act
    const res = await getLatest("customer", SYNC_SECRET, corrupt);

    // Assert — fixed sanitized shape: table only, never pointer bytes, keys,
    // or the thrown parse text; answered by the handler, not the onError
    // backstop (which would carry requestId and no instance).
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("internal"));
    expect(body.title).toBe("Internal Server Error");
    expect(body.status).toBe(500);
    expect(body.detail).toBe(corruptPointerDetail("customer"));
    expect(body.detail).not.toContain("{not json");
    expect(body.detail).not.toContain("not-a-date");
    expect(body.instance).toBe("/api/v1/snapshots/customer/latest");
    expect(body).not.toHaveProperty("requestId");
  });

  it("serves the CSV without re-verifying the pointer's integrity fields", async () => {
    // Arrange — a well-formed pointer whose sha256/bytes are stale fiction,
    // naming a CSV that exists. Manifest re-verification is out of scope.
    const csv = csvFor("customer");
    const csvKey = "snapshot-history/2026-09-27/stale-hash-run/customer.csv";
    const stale = {
      ...testEnv(),
      SNAPSHOTS: fakeSnapshotsBucket({
        "snapshot-latest/customer.json": pointerJson("customer", csvKey, "f".repeat(64), 999999),
        [csvKey]: csv
      })
    } as unknown as Env;

    // Act
    const res = await getLatest("customer", SYNC_SECRET, stale);

    // Assert — served, not refused.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(readbackFor("customer"));
  });

  it("rejects a request with no bearer at the outer gate", async () => {
    // Arrange / Act
    const res = await getLatest("customer", null);

    // Assert — the outer gate's wording (SHADOW_API_TOKEN), not the inner check.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("rejects the general API token at the inner sync-secret check", async () => {
    // Arrange / Act — a valid app token that is NOT the sync secret.
    const res = await getLatest("customer", API_TOKEN);

    // Assert — the canonical inner 401 naming the sync secret.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe("/api/v1/snapshots/customer/latest");
  });

  it("rejects the read-only token at the inner sync-secret check", async () => {
    // Arrange / Act — passes the outer gate on GET, then hits the sync-secret check.
    const res = await getLatest("customer", READ_TOKEN);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe("/api/v1/snapshots/customer/latest");
  });

  it("answers 400 for an unknown table before any R2 read", async () => {
    // Arrange — R2 throws, so any read would surface as a 500, not a 400.
    const throwing = {
      ...testEnv(),
      SNAPSHOTS: {
        get: () => {
          throw new Error("R2 must not be read for an invalid table");
        }
      } as unknown as R2Bucket
    } as unknown as Env;

    // Act — the enum rejects both before the handler runs.
    for (const table of ["bogus", "CUSTOMER"]) {
      const res = await getLatest(table, SYNC_SECRET, throwing);

      // Assert — the anchored bad-request shape, never values.
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(problemType("bad-request"));
      expect(body.status).toBe(400);
    }
  });

  it("answers 503 when the SNAPSHOTS binding is unbound", async () => {
    // Arrange — R2 not configured at all (vs merely missing one key).
    const unbound = { ...testEnv(), SNAPSHOTS: undefined } as unknown as Env;

    // Act
    const res = await getLatest("customer", SYNC_SECRET, unbound);

    // Assert — misconfigured, not not-found.
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("misconfigured"));
    expect(body.status).toBe(503);
    expect(body.detail).toContain("SNAPSHOTS binding unbound");
  });

  it("leaves the explicit-date download unchanged", async () => {
    // Arrange — a daily alias the date route serves (regression guard: this
    // passes before and after; the new route must not disturb it).
    const aliasKey = snapshotR2ObjectKey("customer", new Date("2026-09-20T00:00:00.000Z"));
    expect(aliasKey).toBe("snapshots/2026-09-20/customer.csv");
    await bucket().put(aliasKey, csvFor("customer"), CSV_TYPE);

    // Act
    const dated = await getDateArchive("customer", "2026-09-20", SYNC_SECRET);
    const malformed = await getDateArchive("customer", "yesterday", SYNC_SECRET);

    // Assert
    expect(dated.status).toBe(200);
    expect(dated.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-2026-09-20.csv"'
    );
    expect(await dated.text()).toBe(readbackFor("customer"));
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as ProblemBody;
    expect(body.type).toBe(problemType("bad-request"));
  });

  it("publishes the latest operation for agent discovery", async () => {
    // Arrange / Act
    const res = await exports.default.fetch("http://test.local/openapi.json");

    // Assert — stable identity plus the access/effect classes agents read.
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const get = doc.paths["/api/v1/snapshots/{table}/latest"]?.["get"];
    expect(get?.["operationId"]).toBe("getSnapshotLatestArchive");
    expect(get?.["x-access"]).toBe("sync-secret");
    expect(get?.["x-effect"]).toBe("local-read");
    expect(get?.["tags"]).toContain("data-snapshot");
  });
});
