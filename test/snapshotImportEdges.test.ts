import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { stringToUint8Stream } from "../src/lib/csvStream";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import {
  SnapshotTooLargeError,
  isSnapshotTooLarge,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";
import { recordingDb } from "./snapshotDbFake";

/**
 * Snapshot import edge cases.
 *
 * POST /api/v1/{customer,address,container}-snapshot/import must:
 * - reject an empty-string body, a header-only CSV and a malformed CSV with
 *   400 problem+json (never a silent 200 zeros, never a 500);
 * - reject an oversized payload with 413 problem+json before touching D1;
 * - never wipe the table on a rejected import (import never reconciles);
 * - never echo the submitted bytes (PII) in an error body.
 *
 * Driven through the real app + real test D1 (migrated via
 * ./d1TestMigrations), like test/snapshotSyncE2E.test.ts. No test here may
 * reach the network: import never fetches upstream.
 */

const SYNC_SECRET = "test-sync-secret";
const BAD_REQUEST = `${PROBLEM_TYPE_BASE}bad-request`;
const TOO_LARGE = `${PROBLEM_TYPE_BASE}payload-too-large`;
const UNSUPPORTED_MEDIA_TYPE = `${PROBLEM_TYPE_BASE}unsupported-media-type`;

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

const HTML_LOGIN_PAGE = "<!DOCTYPE html>\n<html><body>Sign in</body></html>";
const PII_PROBE = "PII-PROBE-UNIQUE-999-ACME-555-0100";

type Spec = {
  name: string;
  base: string;
  table: string;
  pk: string;
  header: string;
  row: string;
};

const SPECS: Spec[] = [
  {
    name: "customer",
    base: "/api/v1/customer-snapshot/import",
    table: "customer_snapshot",
    pk: "customer_id",
    header: CUSTOMER_HEADER,
    row: "9001,,Edge Co,,,,,,,,,,true"
  },
  {
    name: "address",
    base: "/api/v1/address-snapshot/import",
    table: "address_snapshot",
    pk: "pickup_address_id",
    header: ADDRESS_HEADER,
    row: "9001,9001,,9001 Main St,Killeen,TX,76541,,,false,true,,,,"
  },
  {
    name: "container",
    base: "/api/v1/container-snapshot/import",
    table: "container_snapshot",
    pk: "container_id",
    header: CONTAINER_HEADER,
    row: "9001,9001,,SN-9001,,false,,false,,,true,9001 Main St,Killeen,TX,76541,"
  }
];

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function postImport(
  path: string,
  body: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv",
      ...extraHeaders
    },
    body
  });
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
};

/**
 * The live wire shape of a bodyless POST. `curl -X POST` with no
 * `Content-Length`/`Transfer-Encoding` arrives as an empty non-null stream,
 * never the `null` body the unit harness builds — so the `!body` guard alone
 * cannot be the only pin. Both shapes must 400, never a silent 200 zeros.
 */
function postImportBodyless(path: string): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    }
  });
}

function postImportEmptyStream(path: string): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    },
    body: new ReadableStream({
      start(c) {
        c.close();
      }
    }),
    duplex: "half"
  } as RequestInit);
}

describe("snapshot import edges", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  describe.each(SPECS)("$name import", (spec) => {
    it.each([
      "application/json",
      "text/plain",
      "text/html",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=test",
      "text/csv-invalid",
      ""
    ])("rejects Content-Type %j with 415 problem+json", async (contentType) => {
      const res = await postImport(spec.base, JSON.stringify({ rows: PII_PROBE }), {
        "content-type": contentType
      });

      expect(res.status).toBe(415);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const body = await res.json();
      expect(body).toMatchObject({
        type: UNSUPPORTED_MEDIA_TYPE,
        title: "Unsupported Media Type",
        status: 415,
        instance: spec.base
      });
      expect(JSON.stringify(body)).not.toContain(PII_PROBE);
    });

    it("rejects a missing Content-Type even for valid CSV without changing D1", async () => {
      const before = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${spec.table}`)
        .first<{ n: number }>();
      const res = await exports.default.fetch(`http://test.local${spec.base}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SYNC_SECRET}` },
        // Bytes do not cause Fetch to auto-add text/plain like a string does.
        body: new TextEncoder().encode(`${spec.header}
${spec.row}`)
      });

      expect(res.status).toBe(415);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const after = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${spec.table}`)
        .first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
    });

    it.each([
      "text/csv",
      "Text/CSV; charset=utf-8",
      "application/octet-stream",
      "Application/Octet-Stream; charset=utf-8"
    ])("imports valid CSV with Content-Type %j", async (contentType) => {
      // Seed the FK chain required by address/container imports.
      await db().prepare(
        "INSERT OR REPLACE INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (9001, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      await db().prepare(
        "INSERT OR REPLACE INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (9001, 9001, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      const res = await postImport(spec.base, `${spec.header}
${spec.row}`, {
        "content-type": contentType
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ rowCount: 1, upserted: 1, deleted: 0 });
      expect(await db().prepare(
        `SELECT ${spec.pk} FROM ${spec.table} WHERE ${spec.pk} = 9001`
      ).first()).not.toBeNull();
    });

    it("checks snapshot authentication before Content-Type", async () => {
      const res = await postImport(spec.base, "{}", {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json"
      });
      expect(res.status).toBe(401);
    });

    it("rejects an empty-string body with 400, not a silent 200 zeros", async () => {
      // Act
      const res = await postImport(spec.base, "");

      // Assert
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
    });

    it("rejects a bodyless POST with 400, not a silent 200 zeros", async () => {
      // Act — no body key at all: the null-body half of the pair,
      // answered by the handler's empty-body guard before any D1 write.
      const res = await postImportBodyless(spec.base);

      // Assert
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
    });

    it("rejects an empty-stream POST with 400, not a silent 200 zeros", async () => {
      // Act — an empty non-null stream: the live wire shape of `curl -X POST`
      // with no Content-Length/Transfer-Encoding. The guard lets it
      // through, so the import's requireDataRows rejection must 400 it.
      const res = await postImportEmptyStream(spec.base);

      // Assert
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
    });

    it("rejects a header-only CSV with 400, not a silent 200 zeros", async () => {
      // Act
      const res = await postImport(spec.base, spec.header);

      // Assert
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
    });

    it("rejects a malformed body with 400 problem+json, never a 500 and never echoing PII", async () => {
      // Arrange — an HTML login page (the upstream silent-failure shape) with a
      // distinctive PII-like marker smuggled in: the error must not echo it.
      const malformed = `${HTML_LOGIN_PAGE}\n${PII_PROBE}`;

      // Act
      const res = await postImport(spec.base, malformed);

      // Assert — 400, problem+json, and the raw bytes appear nowhere.
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(PII_PROBE);
      expect(raw).not.toContain("Sign in");
    });

    it.each([
      { name: "NUL", char: "\u0000" },
      { name: "vertical tab", char: "\u000b" },
      { name: "lone CR", char: "\r" },
      { name: "form feed", char: "\u000c" },
      { name: "DEL", char: "\u007f" },
      { name: "C1", char: "\u0085" }
    ])("rejects $name cell content with a PII-free row number and no D1 write", async ({ char }) => {
      const before = await db().prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.pk}`).all();
      const cells = spec.row.split(",");
      cells[spec.name === "customer" ? 2 : 3] = `"${PII_PROBE}${char}"`;

      const res = await postImport(spec.base, `${spec.header}\n${cells.join(",")}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
      expect(body.detail).toBe("CSV row 2 contains a disallowed control character. See docs/PROBLEMS.md#bad-request.");
      expect(JSON.stringify(body)).not.toContain(PII_PROBE);
      const after = await db().prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.pk}`).all();
      expect(after.results).toEqual(before.results);
    });

    it.each([
      { name: "header", row: 1 },
      { name: "unused column", row: 2 }
    ])("rejects controls in the $name", async ({ row }) => {
      const csv = row === 1
        ? `${spec.header},Unused\u0000\n${spec.row}`
        : `${spec.header},Unused\n${spec.row},\u0000`;
      const res = await postImport(spec.base, csv);
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.detail).toContain(`CSV row ${row} contains`);
    });

    it("rejects a control-only whitespace record instead of silently skipping it", async () => {
      const res = await postImport(spec.base, `${spec.header}\n\u000b\n${spec.row}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.detail).toContain("CSV row 2 contains");
    });

    it("leaves the table untouched when the import is rejected", async () => {
      // Arrange — seed one live row directly.
      const seed =
        spec.name === "customer"
          ? `INSERT OR REPLACE INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9001, 'Edge Co', 1, '2026-09-27T00:00:00.000Z')`
          : spec.name === "address"
            ? `INSERT OR REPLACE INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (9001, 9001, '9001 Main St', 1, '2026-09-27T00:00:00.000Z')`
            : `INSERT OR REPLACE INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (9001, 9001, 'SN-9001', 1, '2026-09-27T00:00:00.000Z')`;
      await db().prepare(seed).run();
      const before = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${spec.table}`)
        .first<{ n: number }>();

      // Act — a malformed import that must be rejected.
      const res = await postImport(spec.base, "not,a,valid,header\n1,2,3");

      // Assert — rejected, and the row count is unchanged.
      expect(res.status).toBe(400);
      const after = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${spec.table}`)
        .first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
      const seedRow = await db()
        .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = 9001`)
        .first<Record<string, unknown>>();
      expect(seedRow).not.toBeNull();
    });

    it("rejects a declared oversized payload with 413 before touching D1", async () => {
      // Arrange — a small body carrying a huge declared Content-Length: the
      // route must fail fast on the declaration without reading the stream.
      // (The streaming byte counter covers a lying declaration; pinned at the
      // unit level by the small-limit test below.)

      // Act
      const res = await postImport(spec.base, `${spec.header}\n${spec.row}`, {
        "content-length": String(100 * 1024 * 1024)
      });

      // Assert
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(TOO_LARGE);
      expect(body.status).toBe(413);
    });
  });

  it("accepts a valid single-row customer import with 200 (control)", async () => {
    // Arrange / Act — the happy path still succeeds after the edge guards.
    const res = await postImport(
      "/api/v1/customer-snapshot/import",
      `${CUSTOMER_HEADER}\n9002,,Control Co,,,,,,,,,,true`
    );

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upserted: number; rowCount: number };
    expect(body.rowCount).toBe(1);
    expect(body.upserted).toBe(1);
  });

  describe("streaming byte cap (unit)", () => {
    it("rejects a huge actual body under a lying Content-Length without touching D1", async () => {
      // Arrange — 20 × ~2 KB rows under a 1 KB cap: the cap trips on the first
      // chunk, before any batch flushes. The header fail-fast above never sees
      // this (no declared length reaches the sync function), so this pins the
      // streaming counter that covers a lying declaration.
      const { db, batches } = recordingDb();
      const bigRow = `1,,${"x".repeat(2000)},,,,,,,,,,true`;
      const csv = [CUSTOMER_HEADER, ...Array.from({ length: 20 }, () => bigRow)].join("\n");

      // Act
      const error = await syncCustomerSnapshotFromStream(
        db,
        stringToUint8Stream(csv),
        80,
        { requireDataRows: true, maxBytes: 1024 }
      ).catch((e: unknown) => e);

      // Assert — the stream read guard wraps the cap error as `cause`, and no
      // D1 batch ever flushed.
      expect(isSnapshotTooLarge(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(SnapshotTooLargeError);
      expect(batches).toEqual([]);
    });

    it("lets a body under the cap through (control)", async () => {
      // Arrange
      const { db } = recordingDb();

      // Act
      const result = await syncCustomerSnapshotFromStream(
        db,
        stringToUint8Stream(`${CUSTOMER_HEADER}\n9002,,Control Co,,,,,,,,,,true`),
        80,
        { requireDataRows: true, maxBytes: 1024 * 1024 }
      );

      // Assert
      expect(result).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    });
  });
});
