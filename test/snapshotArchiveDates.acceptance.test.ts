import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import {
  csvBasename,
  renderSnapshotManifest,
  snapshotR2ObjectKey,
  SNAPSHOT_MANIFEST_VERSION,
  type SnapshotArchiveTable,
  type SnapshotManifest
} from "../src/lib/r2SnapshotArchive";

/**
 * R21-01 acceptance: list archived dates per table.
 *
 * An authorized agent can browse which dates hold archives for a table
 * instead of guessing dates one 404 at a time, via the dedicated
 * `GET /api/v1/snapshots/{table}` operation. The archive writer publishes
 * one date manifest per day merging every table's entry
 * (`snapshots/YYYY-MM-DD.manifest.json`); this route scans those sidecars
 * and lists the dates holding this table.
 *
 * ACCEPTANCE CONTRACT (the Builder implements exactly this; this file is the
 * oracle and must NOT be edited by the Builder):
 *
 * - Operation: `GET /api/v1/snapshots/{table}` (no second segment, so no
 *   conflict with the date or `latest` routes at any merge order),
 *   `operationId: "listSnapshotArchiveDates"`, tag `data-snapshot`,
 *   `x-access: sync-secret`, `x-effect: local-read`. `table` reuses the
 *   existing `customer|address|container` enum (with an OpenAPI example, as
 *   the date route has); anything else is 400 `bad-request` before any R2
 *   read runs. `limit` is `1..366`, default `30` (with an OpenAPI example);
 *   out-of-range or non-integer values are 400 before any R2 read. Unknown
 *   query params are ignored, consistent with the D1 list policy.
 * - Auth: the sync-secret gate, identical to the date route. No bearer hits
 *   the outer 401 naming `SHADOW_API_TOKEN` (even with an invalid table or
 *   limit, because the outer middleware runs first); the general API token
 *   and the read-only token pass the outer GET gate and then hit the inner
 *   401 with the canonical sync-secret detail plus `instance` for the
 *   request pathname (no query string). Auth precedes all R2 work: a
 *   throwing R2 double still answers 401, never 500.
 * - Listing: scan the `snapshots/` prefix for keys matching
 *   `snapshots/YYYY-MM-DD.manifest.json` (other keys — per-date CSVs,
 *   malformed names, other prefixes — are ignored, never 500), read each
 *   manifest newest-first, and include the date only when its `files` map
 *   holds that table's entry (`{table}.csv`). Each entry carries
 *   `{date, bytes, sha256}` from the manifest (hashes/sizes only, never row
 *   data); the date is the key's `YYYY-MM-DD`. Integrity fields are read,
 *   never re-verified: stale shares still serve, and CSV objects are never
 *   read at all. Response is 200 JSON
 *   `{table, dates: [{date, bytes, sha256}], truncated}` with `dates`
 *   newest-first, sliced to `limit`.
 * - `truncated`: `true` when more manifest keys remain unexamined after
 *   stopping (whether due to `limit` or the scan budget) or the R2 list
 *   itself truncates — i.e. possibly more dates exist. `false` otherwise.
 *   Scan budget is 366 manifests newest-first. Zero archives (no manifests,
 *   or none holding this table) is HTTP 200 with an empty list and
 *   `truncated: false` (unless the budget exhausts with possibly more), not
 *   404: a listing, never a fetch. The listing never answers 404 for any
 *   input: empty is 200, invalid table/limit is 400.
 * - Failures: unbound `SNAPSHOTS` returns the existing fixed 503 shape
 *   (same wording as the date route). An R2 list/read failure or an
 *   unparseable manifest (not JSON, or failing `isSnapshotManifest` for ANY
 *   entry — validation runs before table filtering) returns a fixed
 *   sanitized 500 — `type` internal, `title` "Internal Server Error",
 *   `status` 500,
 *   `detail: "Snapshot archive date listing for table=${table} is
 *   unreadable. Re-run the table sync to republish it. See
 *   docs/PROBLEMS.md#internal."`, `instance` the request pathname (no
 *   query). Never R2 key bytes, manifest bytes, exception text, or stack —
 *   and never the generic `onError` body (which carries `requestId` and no
 *   `instance`); the handler answers directly.
 * - Caching: emits a content-hash ETag over the served JSON bytes
 *   (`"fnv64-<hex>"`, quoted, exactly like the date route's hash family);
 *   `If-None-Match` carrying the current tag, or `*`, answers 304 with an
 *   empty body and the ETag preserved. Even an empty listing has an ETag
 *   and 304s. `Cache-Control: no-store` rides on 200 and 304 via the shared
 *   API middleware. The explicit-date route is unchanged.
 *
 * RED-before-build: on the pre-implementation head every dates-route test
 * below fails (`/snapshots/{table}` with no second segment matches no route,
 * so Hono answers 404; the OpenAPI inventory tests updated alongside fail on
 * the missing operation). The outer-gate and date-route regression tests pass
 * both before and after — they pin shared gates, not new behavior.
 *
 * Hermetic: the route never touches D1 or the upstream host. One happy-path
 * test seeds the real test R2 bucket (fresh per test file) to prove the live
 * `list({prefix})` integration; every other content test uses in-memory R2
 * doubles so distinct date keys cannot accumulate across tests in this file.
 * Unexpected outbound fetch throws.
 */

const SYNC_SECRET = "test-sync-secret";
const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

// 192.0.2.240+ is unused by every other suite (archive .220-.230, resweep
// .150-.190, latest-branch .170-.210, burst .211-.213, isolation .231), so
// each call gets a fresh throttle bucket and asserts its own status, never a
// coincidental 429.
let ipSeq = 0;

function testEnv(): Env {
  return env as unknown as Env;
}

function bucket(): R2Bucket {
  return (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
}

async function getDates(
  table: string,
  token: string | null,
  query = "",
  envOverride?: Env,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("CF-Connecting-IP", `192.0.2.${240 + ipSeq++}`);
  return app.fetch(
    new Request(`http://test.local/api/v1/snapshots/${table}${query}`, { headers }),
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
  headers.set("CF-Connecting-IP", `192.0.2.${240 + ipSeq++}`);
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

type DatesEntry = {
  date: string;
  bytes: number;
  sha256: string;
};

type DatesResponse = {
  table: string;
  dates: DatesEntry[];
  truncated: boolean;
};

const CSV_TYPE = { httpMetadata: { contentType: "text/csv; charset=utf-8" } };
const JSON_TYPE = { httpMetadata: { contentType: "application/json; charset=utf-8" } };

const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";
const datesUnreadableDetail = (table: string): string =>
  `Snapshot archive date listing for table=${table} is unreadable. ` +
  `Re-run the table sync to republish it. See docs/PROBLEMS.md#internal.`;

function fnv1a64Etag(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `"fnv64-${h.toString(16).padStart(16, "0")}"`;
}

/** Deterministic 64-hex fixture: distinct per tag, always valid shape. */
function hexFor(tag: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(tag)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const seed = h.toString(16).padStart(16, "0");
  return (seed + seed + seed + seed).slice(0, 64);
}

function manifestJson(
  date: string,
  entries: Record<string, { key: string; sha256: string; bytes: number }>
): string {
  const manifest: SnapshotManifest = {
    version: SNAPSHOT_MANIFEST_VERSION,
    date,
    files: entries
  };
  return renderSnapshotManifest(manifest);
}

function entryFor(table: SnapshotArchiveTable, date: string, bytes: number): {
  key: string;
  sha256: string;
  bytes: number;
} {
  return {
    key: `snapshots/${date}/${table}.csv`,
    sha256: hexFor(`${table}:${date}`),
    bytes
  };
}

/** In-memory R2 double: `list` serves manifest keys + extras filtered by prefix; `get` serves manifests. */
function fakeSnapshotsBucket(
  manifests: Record<string, string>,
  opts: {
    extraKeys?: string[];
    listThrows?: string;
    getThrowsFor?: (key: string) => boolean;
    listObjects?: Array<{ key: string }>;
    truncated?: boolean;
  } = {}
): R2Bucket {
  const allKeys = [...Object.keys(manifests), ...(opts.extraKeys ?? [])];
  return {
    list: (listOpts?: { prefix?: string }) => {
      if (opts.listThrows !== undefined) {
        return Promise.reject(new Error(opts.listThrows));
      }
      const prefix = listOpts?.prefix ?? "";
      const objects = (opts.listObjects ?? allKeys.map((key) => ({ key }))).filter((obj) =>
        obj.key.startsWith(prefix)
      );
      return Promise.resolve({
        objects,
        truncated: opts.truncated ?? false
      });
    },
    get: (key: string) => {
      if (opts.getThrowsFor?.(key) === true) {
        return Promise.reject(new Error(`R2 get failed for ${key}`));
      }
      if (!Object.hasOwn(manifests, key)) {
        return Promise.resolve(null);
      }
      const text = manifests[key] as string;
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
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });
    }
  } as unknown as R2Bucket;
}

function withBucket(manifests: Record<string, string>, opts?: Parameters<typeof fakeSnapshotsBucket>[1]): Env {
  return { ...testEnv(), SNAPSHOTS: fakeSnapshotsBucket(manifests, opts) } as unknown as Env;
}

/** `count` consecutive UTC dates from `start` (inclusive), ascending. */
function dateRange(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00.000Z`);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("archived-date listing acceptance (R21-01)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // The route reads R2 only: any upstream fetch is a leak, fail loudly.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in dates-listing acceptance test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists newest-first dates for customer from date manifests via live R2", async () => {
    // Arrange — three date manifests seeded out of order through the real
    // test bucket, exactly as the sync leg publishes them. No CSVs are
    // seeded: the listing reads manifests only. This is the single
    // real-bucket manifest test in this file, so no other test's dates can
    // leak in (the date-route regression below seeds only a CSV alias, which
    // the scan ignores).
    const dates = ["2026-09-25", "2026-09-26", "2026-09-27"];
    for (const date of ["2026-09-26", "2026-09-27", "2026-09-25"]) {
      const key = `snapshots/${date}.manifest.json`;
      await bucket().put(
        key,
        manifestJson(date, { [csvBasename("customer")]: entryFor("customer", date, 100 + Number(date.slice(8, 10))) }),
        JSON_TYPE
      );
    }

    // Act
    const res = await getDates("customer", SYNC_SECRET);

    // Assert — newest-first, manifest values echoed exactly.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as DatesResponse;
    expect(body.table).toBe("customer");
    expect(body.truncated).toBe(false);
    expect(body.dates).toEqual(
      [...dates].reverse().map((date) => ({
        date,
        bytes: 100 + Number(date.slice(8, 10)),
        sha256: hexFor(`customer:${date}`)
      }))
    );
  });

  it.each(["customer", "address", "container"] as const)(
    "serves the %s listing from that table's manifest entries",
    async (table) => {
      // Arrange — one manifest holding all three tables; each listing sees
      // only its own entry.
      const date = "2026-09-27";
      const files: Record<string, { key: string; sha256: string; bytes: number }> = {};
      for (const t of ["customer", "address", "container"] as const) {
        files[csvBasename(t)] = entryFor(t, date, 10 + t.length);
      }
      const envOverride = withBucket({
        [`snapshots/${date}.manifest.json`]: manifestJson(date, files)
      });

      // Act
      const res = await getDates(table, SYNC_SECRET, "", envOverride);

      // Assert
      expect(res.status).toBe(200);
      const body = (await res.json()) as DatesResponse;
      expect(body.table).toBe(table);
      expect(body.truncated).toBe(false);
      expect(body.dates).toEqual([
        { date, bytes: 10 + table.length, sha256: hexFor(`${table}:${date}`) }
      ]);
    }
  );

  it("returns 200 empty when the bucket holds no manifests", async () => {
    // Arrange — an R2 double with nothing at all.
    const envOverride = withBucket({});

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — a listing, not a fetch: empty is 200, never 404.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as DatesResponse;
    expect(body).toEqual({ table: "customer", dates: [], truncated: false });
  });

  it("returns 200 empty when manifests exist but hold no entry for this table", async () => {
    // Arrange — a valid manifest holding only the address entry.
    const date = "2026-09-27";
    const envOverride = withBucket({
      [`snapshots/${date}.manifest.json`]: manifestJson(date, {
        [csvBasename("address")]: entryFor("address", date, 50)
      })
    });

    // Act — customer sees nothing, address sees the date.
    const customer = await getDates("customer", SYNC_SECRET, "", envOverride);
    const address = await getDates("address", SYNC_SECRET, "", envOverride);

    // Assert — exclusion, not an error.
    expect(customer.status).toBe(200);
    expect((await customer.json()) as DatesResponse).toEqual({
      table: "customer",
      dates: [],
      truncated: false
    });
    expect(address.status).toBe(200);
    const addressBody = (await address.json()) as DatesResponse;
    expect(addressBody.dates).toEqual([
      { date, bytes: 50, sha256: hexFor(`address:${date}`) }
    ]);
  });

  it("ignores non-manifest keys and malformed manifest names", async () => {
    // Arrange — one valid manifest plus CSV aliases, a malformed name, a bad
    // date, and another prefix's manifest. All must be ignored, never 500.
    const date = "2026-09-27";
    const envOverride = withBucket(
      {
        [`snapshots/${date}.manifest.json`]: manifestJson(date, {
          [csvBasename("customer")]: entryFor("customer", date, 77)
        })
      },
      {
        extraKeys: [
          `snapshots/${date}/customer.csv`,
          "snapshots/not-a-date.manifest.json",
          "snapshots/2026-13-99.manifest.json",
          "snapshots/2026-09-27.manifest.json.bak",
          "snapshot-history/2026-09-27/run-x/customer.csv",
          "snapshot-latest/customer.json"
        ]
      }
    );

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — only the well-formed sidecar contributes.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toEqual([{ date, bytes: 77, sha256: hexFor(`customer:${date}`) }]);
    expect(body.truncated).toBe(false);
  });

  it("slices newest-first to limit and flags truncated when more dates remain", async () => {
    // Arrange — three manifests, newest-first scan.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, Number(date.slice(8, 10)))
      });
    }
    const envOverride = withBucket(manifests);

    // Act — limit=2 keeps the two newest and reports more.
    const res = await getDates("customer", SYNC_SECRET, "?limit=2", envOverride);

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates.map((d) => d.date)).toEqual(["2026-09-27", "2026-09-26"]);
    expect(body.truncated).toBe(true);
  });

  it("honors limit=1 and limit=366 at the bounds", async () => {
    // Arrange — three manifests.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("container")]: entryFor("container", date, 5)
      });
    }
    const envOverride = withBucket(manifests);

    // Act
    const one = await getDates("container", SYNC_SECRET, "?limit=1", envOverride);
    const max = await getDates("container", SYNC_SECRET, "?limit=366", envOverride);

    // Assert — one newest with more remaining; max covers all three.
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as DatesResponse;
    expect(oneBody.dates.map((d) => d.date)).toEqual(["2026-09-27"]);
    expect(oneBody.truncated).toBe(true);
    expect(max.status).toBe(200);
    const maxBody = (await max.json()) as DatesResponse;
    expect(maxBody.dates).toHaveLength(3);
    expect(maxBody.truncated).toBe(false);
  });

  it("defaults to 30 when limit is omitted", async () => {
    // Arrange — 35 manifests; the default page keeps the 30 newest.
    const manifests: Record<string, string> = {};
    for (const date of dateRange("2026-01-01", 35)) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 9)
      });
    }
    const envOverride = withBucket(manifests);

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — 30 newest, truncated.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toHaveLength(30);
    expect(body.dates[0]?.date).toBe("2026-02-04");
    expect(body.dates[29]?.date).toBe("2026-01-06");
    expect(body.truncated).toBe(true);
  });

  it.each(["0", "367", "-5", "abc", "1.5", ""])(
    "answers 400 for limit=%s before any R2 read",
    async (limit) => {
      // Arrange — R2 throws, so any read would surface as a 500, not a 400.
      const throwing = {
        ...testEnv(),
        SNAPSHOTS: {
          list: () => {
            throw new Error("R2 must not be listed for an invalid limit");
          },
          get: () => {
            throw new Error("R2 must not be read for an invalid limit");
          }
        } as unknown as R2Bucket
      } as unknown as Env;

      // Act
      const res = await getDates("customer", SYNC_SECRET, `?limit=${limit}`, throwing);

      // Assert — the anchored bad-request shape, never values.
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(problemType("bad-request"));
      expect(body.status).toBe(400);
    }
  );

  it("flags truncated when 367 manifests exceed the 366 scan budget", async () => {
    // Arrange — 367 valid manifests, one list page (no R2 pagination).
    const manifests: Record<string, string> = {};
    for (const date of dateRange("2025-01-01", 367)) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 11)
      });
    }
    const envOverride = withBucket(manifests);

    // Act — the max page keeps the 366 newest.
    const res = await getDates("customer", SYNC_SECRET, "?limit=366", envOverride);

    // Assert — the oldest (2025-01-01) is unexamined, so truncated.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toHaveLength(366);
    expect(body.dates[0]?.date).toBe("2026-01-02");
    expect(body.dates[365]?.date).toBe("2025-01-02");
    expect(body.truncated).toBe(true);
  });

  it("keeps truncated false when exactly 366 manifests fit the budget", async () => {
    // Arrange — 366 valid manifests.
    const manifests: Record<string, string> = {};
    for (const date of dateRange("2025-01-01", 366)) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 12)
      });
    }
    const envOverride = withBucket(manifests);

    // Act
    const res = await getDates("customer", SYNC_SECRET, "?limit=366", envOverride);

    // Assert — everything examined, nothing more.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toHaveLength(366);
    expect(body.truncated).toBe(false);
  });

  it("flags truncated on an empty page when the budget exhausts with possibly more dates", async () => {
    // Arrange — the 366 newest manifests lack the customer entry; only the
    // oldest (unexamined under the budget) holds it.
    const dates = dateRange("2025-01-01", 367);
    const manifests: Record<string, string> = {};
    for (const date of dates) {
      const table: SnapshotArchiveTable = date === "2025-01-01" ? "customer" : "address";
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename(table)]: entryFor(table, date, 13)
      });
    }
    const envOverride = withBucket(manifests);

    // Act — customer sees nothing examined, but more remains.
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — empty yet truncated: conservative, possibly more.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toEqual([]);
    expect(body.truncated).toBe(true);
  });

  it.each([
    ["is not JSON at all", "{not json"],
    ["fails manifest validation", JSON.stringify({ version: 1, date: "not-a-date", files: {} })],
    [
      "carries an invalid entry shape",
      JSON.stringify({
        version: 1,
        date: "2026-09-27",
        files: { "customer.csv": { key: 42, sha256: "0".repeat(64), bytes: 10 } }
      })
    ]
  ])("answers a fixed sanitized 500 when a scanned manifest %s", async (_label, manifestText) => {
    // Arrange — the double serves only the corrupt manifest.
    const envOverride = withBucket({
      "snapshots/2026-09-27.manifest.json": manifestText
    });

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — fixed sanitized shape: table only, never manifest bytes or
    // the thrown parse text; answered by the handler, not the onError
    // backstop (which would carry requestId and no instance).
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("internal"));
    expect(body.title).toBe("Internal Server Error");
    expect(body.status).toBe(500);
    expect(body.detail).toBe(datesUnreadableDetail("customer"));
    expect(body.detail).not.toContain("{not json");
    expect(body.detail).not.toContain("not-a-date");
    expect(body.instance).toBe("/api/v1/snapshots/customer");
    expect(body).not.toHaveProperty("requestId");
  });

  it("answers the fixed 500 when a manifest is invalid even for an unqueried table", async () => {
    // Arrange — the manifest's address entry has a bad sha shape, so the
    // whole manifest fails validation even though customer is unlisted.
    // Validation runs before table filtering.
    const date = "2026-09-27";
    const envOverride = withBucket({
      [`snapshots/${date}.manifest.json`]: JSON.stringify({
        version: 1,
        date,
        files: {
          "address.csv": {
            key: `snapshots/${date}/address.csv`,
            sha256: "not-hex",
            bytes: 10
          }
        }
      })
    });

    // Act — querying the absent customer still 500s on the corrupt sidecar.
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert
    expect(res.status).toBe(500);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail).toBe(datesUnreadableDetail("customer"));
    expect(body.instance).toBe("/api/v1/snapshots/customer");
  });

  it("answers the fixed 500 when the R2 list fails", async () => {
    // Arrange — list throws with a driver message that must never travel.
    const envOverride = withBucket({}, { listThrows: "R2 list unavailable (driver boom)" });

    // Act
    const res = await getDates("address", SYNC_SECRET, "?limit=2", envOverride);

    // Assert — sanitized: no driver text, no keys; instance carries no query.
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("internal"));
    expect(body.detail).toBe(datesUnreadableDetail("address"));
    expect(body.detail).not.toContain("driver boom");
    expect(body.instance).toBe("/api/v1/snapshots/address");
    expect(body).not.toHaveProperty("requestId");
  });

  it("answers the fixed 500 when a manifest read fails", async () => {
    // Arrange — list succeeds, get throws.
    const date = "2026-09-27";
    const envOverride = withBucket(
      {
        [`snapshots/${date}.manifest.json`]: manifestJson(date, {
          [csvBasename("customer")]: entryFor("customer", date, 44)
        })
      },
      { getThrowsFor: () => true }
    );

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert
    expect(res.status).toBe(500);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("internal"));
    expect(body.detail).toBe(datesUnreadableDetail("customer"));
    expect(body.detail).not.toContain("2026-09-27");
    expect(body.instance).toBe("/api/v1/snapshots/customer");
  });

  it("serves manifest values without re-verifying them and without reading CSVs", async () => {
    // Arrange — well-formed manifests whose sha256/bytes are stale fiction;
    // any CSV read throws, proving the listing never touches CSV objects.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: {
          key: `snapshots/${date}/customer.csv`,
          sha256: "f".repeat(64),
          bytes: 999999
        }
      });
    }
    const envOverride = withBucket(manifests, {
      extraKeys: ["snapshots/2026-09-27/customer.csv"],
      getThrowsFor: (key) => key.endsWith(".csv")
    });

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", envOverride);

    // Assert — stale values served as-is, no CSV read attempted.
    expect(res.status).toBe(200);
    const body = (await res.json()) as DatesResponse;
    expect(body.dates).toEqual([
      { date: "2026-09-27", bytes: 999999, sha256: "f".repeat(64) },
      { date: "2026-09-26", bytes: 999999, sha256: "f".repeat(64) }
    ]);
  });

  it("rejects a request with no bearer at the outer gate", async () => {
    // Arrange / Act — even a throwing R2 double cannot change the gate.
    const throwing = {
      ...testEnv(),
      SNAPSHOTS: {
        list: () => {
          throw new Error("R2 must not be listed without a bearer");
        }
      } as unknown as R2Bucket
    } as unknown as Env;
    const res = await getDates("customer", null, "", throwing);

    // Assert — the outer gate's wording (SHADOW_API_TOKEN), not the inner check.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("rejects no bearer with an invalid table at the outer gate, before validation", async () => {
    // Arrange / Act — the outer middleware runs before the zod validator.
    const res = await getDates("bogus", null);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("rejects the general API token at the inner sync-secret check", async () => {
    // Arrange — a valid app token that is NOT the sync secret; R2 throws so
    // any read would surface as a 500, proving auth precedes R2.
    const throwing = {
      ...testEnv(),
      SNAPSHOTS: {
        list: () => {
          throw new Error("R2 must not be listed for the API token");
        }
      } as unknown as R2Bucket
    } as unknown as Env;

    // Act
    const res = await getDates("customer", API_TOKEN, "?limit=2", throwing);

    // Assert — the canonical inner 401 naming the sync secret; instance
    // carries the pathname without the query string.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe("/api/v1/snapshots/customer");
  });

  it("rejects the read-only token at the inner sync-secret check", async () => {
    // Arrange / Act — passes the outer gate on GET, then hits the sync-secret check.
    const res = await getDates("customer", READ_TOKEN);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("unauthorized"));
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe("/api/v1/snapshots/customer");
  });

  it("answers 400 for an unknown table before any R2 read", async () => {
    // Arrange — R2 throws, so any read would surface as a 500, not a 400.
    const throwing = {
      ...testEnv(),
      SNAPSHOTS: {
        list: () => {
          throw new Error("R2 must not be listed for an invalid table");
        },
        get: () => {
          throw new Error("R2 must not be read for an invalid table");
        }
      } as unknown as R2Bucket
    } as unknown as Env;

    // Act — the enum rejects both before the handler runs.
    for (const table of ["bogus", "CUSTOMER"]) {
      const res = await getDates(table, SYNC_SECRET, "", throwing);

      // Assert — the anchored bad-request shape, never values.
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(problemType("bad-request"));
      expect(body.status).toBe(400);
    }
  });

  it("answers 400 for an unknown table even with the API token (validator before inner gate)", async () => {
    // Arrange / Act — the zod validator runs before the handler's inner check.
    const res = await getDates("bogus", API_TOKEN);

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("bad-request"));
  });

  it("answers 503 when the SNAPSHOTS binding is unbound", async () => {
    // Arrange — R2 not configured at all (vs merely missing one key).
    const unbound = { ...testEnv(), SNAPSHOTS: undefined } as unknown as Env;

    // Act
    const res = await getDates("customer", SYNC_SECRET, "", unbound);

    // Assert — misconfigured, not not-found.
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(problemType("misconfigured"));
    expect(body.status).toBe(503);
    expect(body.detail).toContain("SNAPSHOTS binding unbound");
  });

  it("emits a content-hash ETag and answers 304 on If-None-Match", async () => {
    // Arrange — two dates; the ETag must hash the exact served bytes.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 21)
      });
    }
    const envOverride = withBucket(manifests);
    const first = await getDates("customer", SYNC_SECRET, "", envOverride);
    const firstBody = await first.text();
    const etag = first.headers.get("etag");

    // Act — replay the tag.
    const res = await getDates("customer", SYNC_SECRET, "", envOverride, {
      "if-none-match": etag ?? ""
    });

    // Assert — fnv64 over the served bytes, empty-body 304 with the tag kept.
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    expect(etag).toBe(fnv1a64Etag(new TextEncoder().encode(firstBody)));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("answers 304 for If-None-Match: * on an existing listing", async () => {
    // Arrange
    const date = "2026-09-27";
    const envOverride = withBucket({
      [`snapshots/${date}.manifest.json`]: manifestJson(date, {
        [csvBasename("address")]: entryFor("address", date, 33)
      })
    });

    // Act
    const res = await getDates("address", SYNC_SECRET, "", envOverride, {
      "if-none-match": "*"
    });

    // Assert
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("emits an ETag and 304s even for an empty listing", async () => {
    // Arrange — no manifests at all.
    const envOverride = withBucket({});
    const first = await getDates("container", SYNC_SECRET, "", envOverride);
    const etag = first.headers.get("etag");
    await first.text();

    // Act
    const res = await getDates("container", SYNC_SECRET, "", envOverride, {
      "if-none-match": etag ?? ""
    });

    // Assert — empty still caches.
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("changes the ETag when the limit changes the bytes", async () => {
    // Arrange — three dates.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 8)
      });
    }
    const envOverride = withBucket(manifests);

    // Act
    const full = await getDates("customer", SYNC_SECRET, "", envOverride);
    const one = await getDates("customer", SYNC_SECRET, "?limit=1", envOverride);

    // Assert — different bytes, different tags.
    expect(full.headers.get("etag")).not.toBe(one.headers.get("etag"));
    await full.text();
    await one.text();
  });

  it("ignores unknown query params without changing results", async () => {
    // Arrange — two dates.
    const manifests: Record<string, string> = {};
    for (const date of ["2026-09-26", "2026-09-27"]) {
      manifests[`snapshots/${date}.manifest.json`] = manifestJson(date, {
        [csvBasename("customer")]: entryFor("customer", date, 17)
      });
    }
    const envOverride = withBucket(manifests);

    // Act
    const baseline = await getDates("customer", SYNC_SECRET, "?limit=2", envOverride);
    const unknown = await getDates(
      "customer",
      SYNC_SECRET,
      "?limit=2&bogus_param=1",
      envOverride
    );

    // Assert — identical status, body and ETag.
    expect(baseline.status).toBe(200);
    expect(unknown.status).toBe(200);
    const baselineBody = await baseline.text();
    const unknownBody = await unknown.text();
    expect(unknownBody).toBe(baselineBody);
    expect(unknown.headers.get("etag")).toBe(baseline.headers.get("etag"));
  });

  it("leaves the explicit-date download unchanged", async () => {
    // Arrange — a daily alias the date route serves (regression guard: this
    // passes before and after; the new route must not disturb it).
    const csv = "CustomerID,CompanyName,Enabled\n101,Example,true\n";
    const aliasKey = snapshotR2ObjectKey("customer", new Date("2026-09-20T00:00:00.000Z"));
    expect(aliasKey).toBe("snapshots/2026-09-20/customer.csv");
    await bucket().put(aliasKey, csv, CSV_TYPE);

    // Act
    const dated = await getDateArchive("customer", "2026-09-20", SYNC_SECRET);
    const malformed = await getDateArchive("customer", "yesterday", SYNC_SECRET);

    // Assert — still a CSV download with a dated filename; bad dates still 400.
    expect(dated.status).toBe(200);
    expect(dated.headers.get("content-type")).toContain("text/csv");
    expect(dated.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-2026-09-20.csv"'
    );
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as ProblemBody;
    expect(body.type).toBe(problemType("bad-request"));
  });

  it("publishes the dates operation for agent discovery", async () => {
    // Arrange / Act
    const res = await exports.default.fetch("http://test.local/openapi.json");

    // Assert — stable identity plus the access/effect classes agents read,
    // with table and limit parameters carrying examples.
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const get = doc.paths["/api/v1/snapshots/{table}"]?.["get"] as
      | {
          operationId?: unknown;
          tags?: unknown;
          parameters?: Array<{
            name?: string;
            in?: string;
            example?: unknown;
            schema?: Record<string, unknown>;
          }>;
          [key: string]: unknown;
        }
      | undefined;
    expect(get?.["operationId"]).toBe("listSnapshotArchiveDates");
    expect(get?.["x-access"]).toBe("sync-secret");
    expect(get?.["x-effect"]).toBe("local-read");
    expect(get?.["tags"]).toContain("data-snapshot");
    const byName = Object.fromEntries((get?.parameters ?? []).map((p) => [p.name, p]));
    expect(byName["table"]?.in).toBe("path");
    expect(byName["table"]?.example ?? byName["table"]?.schema?.["example"]).toBeDefined();
    expect(byName["limit"]?.in).toBe("query");
    expect(byName["limit"]?.example ?? byName["limit"]?.schema?.["example"]).toBeDefined();
  });
});
