import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";
import { stringToUint8Stream } from "../src/lib/csvStream";
import { syncCustomerSnapshotFromStream } from "../src/lib/snapshot/streamSync";

/**
 * Customer snapshot changes feed (TOG-8877).
 *
 * `GET /api/v1/customer-snapshot/changes?since=<ts>` is the incremental-sync
 * counterpart to the full table list: it returns only rows with
 * `synced_at > since` in `(synced_at, customer_id)` keyset order. `synced_at`
 * is stamped per sync run, so every upserted row in run N shares run N's
 * timestamp and a client holding run N-1's timestamp sees the whole run-N
 * delta on replay.
 *
 * These tests replay two syncs through the real `syncCustomerSnapshotFromStream`
 * against the real migrated test D1, then read the feed through the real app
 * (like `test/snapshotSyncE2E.test.ts`): empty `since` is the epoch (first
 * page sees the whole table), `since` = run-1 stamp sees only run-2 rows,
 * `limit` caps the page with a string `synced_at` `nextCursor`, and a bad
 * cursor or limit is a 400 before any D1 read. Fixtures are synthetic
 * customer ids in the 71xx range — no real PII.
 */

const SECRET = "test-sync-secret";

const HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";

const RUN_1_AT = "2026-09-01T00:00:00.000Z";
const RUN_2_AT = "2026-09-02T00:00:00.000Z";

const RUN_1_CSV = [
  HEADER,
  "7101,,Co 7101,Ada,,Lovelace,,,,,,,true",
  "7102,,Co 7102,Grace,,Hopper,,,,,,,true"
].join("\n");

// Run 2 renames 7102 and adds 7103. No reconcile: 7101 keeps its run-1 stamp,
// so the run-2 delta is exactly {7102, 7103}.
const RUN_2_CSV = [
  HEADER,
  "7102,,Co 7102 Renamed,Grace,,Hopper,,,,,,,true",
  "7103,,Co 7103,Alan,,Turing,,,,,,,true"
].join("\n");

const ROW_COLUMNS = [
  "customer_id",
  "customer_type_id",
  "company_name",
  "first_name",
  "middle_initial",
  "last_name",
  "name_suffix",
  "customer_number",
  "sub_customer_number",
  "phone1",
  "phone2",
  "comments",
  "enabled",
  "synced_at"
];

type ChangesBody = {
  rows: Array<Record<string, unknown>>;
  total: number;
  nextCursor: string | null;
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function sync(csv: string, syncedAt: string): Promise<void> {
  const r = await syncCustomerSnapshotFromStream(db(), stringToUint8Stream(csv), undefined, {
    syncedAt
  });
  expect(r.rowCount).toBe(2);
}

async function getChanges(query = ""): Promise<{ status: number; body: ChangesBody }> {
  const res = await exports.default.fetch(
    `http://test.local/api/v1/customer-snapshot/changes${query}`,
    { headers: { authorization: `Bearer ${SECRET}` } }
  );
  const body = (await res.json()) as ChangesBody;
  return { status: res.status, body };
}

describe("customer snapshot changes feed", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
    await sync(RUN_1_CSV, RUN_1_AT);
  });

  it("returns every row in (synced_at, customer_id) order when since is omitted", async () => {
    // Act — no `since`: the epoch, so the first page sees the whole table.
    const { status, body } = await getChanges();

    // Assert
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.customer_id)).toEqual([7101, 7102]);
    expect(body.rows.map((r) => r.synced_at)).toEqual([RUN_1_AT, RUN_1_AT]);
    // Short page ⇒ no further pages.
    expect(body.nextCursor).toBeNull();
    // Rows carry only the stored snapshot columns — no fields beyond the row
    // payload.
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...ROW_COLUMNS].sort());
    }
  });

  it("treats an empty since as the epoch, not as a 400", async () => {
    // Act
    const { status, body } = await getChanges("?since=");

    // Assert
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.customer_id)).toEqual([7101, 7102]);
  });

  it("replays only the second sync's rows after the first run's cursor", async () => {
    // Arrange — second sync stamps its rows with the run-2 timestamp.
    await sync(RUN_2_CSV, RUN_2_AT);

    // Act — reviewer path: replay with the run-1 cursor.
    const { status, body } = await getChanges(`?since=${encodeURIComponent(RUN_1_AT)}`);

    // Assert — 7101 (untouched, run-1 stamp) is excluded; the renamed 7102
    // and the new 7103 share the run-2 stamp.
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.customer_id)).toEqual([7102, 7103]);
    expect(body.rows.map((r) => r.synced_at)).toEqual([RUN_2_AT, RUN_2_AT]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns an empty page once the cursor reaches the latest sync", async () => {
    // Arrange — table state comes from the previous tests in this file (run 2
    // is the latest sync).

    // Act
    const { status, body } = await getChanges(`?since=${encodeURIComponent(RUN_2_AT)}`);

    // Assert
    expect(status).toBe(200);
    expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("caps the page at limit and resumes from the string nextCursor", async () => {
    // Act — first page of one.
    const first = await getChanges("?limit=1");

    // Assert — full page ⇒ maybe more; the cursor is the row's `synced_at`
    // timestamp string (never a primary-key integer).
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(1);
    expect(first.body.rows.map((r) => r.customer_id)).toEqual([7101]);
    expect(typeof first.body.nextCursor).toBe("string");
    expect(first.body.nextCursor).toBe(RUN_1_AT);

    // Act — resume strictly after the run-1 stamp.
    const second = await getChanges(
      `?since=${encodeURIComponent(first.body.nextCursor!)}&limit=1`
    );

    // Assert — run-1 rows are excluded by the strict `>`; the first run-2
    // row arrives, and the page is full again.
    expect(second.status).toBe(200);
    expect(second.body.rows.map((r) => r.customer_id)).toEqual([7102]);
    expect(second.body.nextCursor).toBe(RUN_2_AT);

    // Act — the tail page is short.
    const tail = await getChanges(`?since=${encodeURIComponent(RUN_2_AT)}&limit=1`);

    // Assert
    expect(tail.status).toBe(200);
    expect(tail.body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("rejects a non-ISO since and an out-of-range limit as 400", async () => {
    // Act
    const badSince = await getChanges("?since=not-a-date");
    const bigLimit = await getChanges("?limit=501");
    const zeroLimit = await getChanges("?limit=0");

    // Assert — schema rejections never reach D1; the shape is anchored
    // problem+json by the shared validation hook (wording owned elsewhere).
    for (const res of [badSince, bigLimit, zeroLimit]) {
      expect(res.status).toBe(400);
    }
  });
});
