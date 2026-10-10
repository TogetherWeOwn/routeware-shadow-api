import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";
const CUSTOMER_HEADER = "CustomerID,CompanyName,Comments";
const ADDRESS_HEADER = "PickupAddressID,CustomerID,Address,Comments";
const CONTAINER_HEADER = "ContainerID,PickupAddressID,SerialNumber,ContainerNote";

const SPECS = [
  {
    name: "customer",
    table: "customer_snapshot",
    pk: "customer_id",
    column: "comments",
    header: CUSTOMER_HEADER,
    row: "9001,Restore Co",
    sync: syncCustomerSnapshotFromStream
  },
  {
    name: "address",
    table: "address_snapshot",
    pk: "pickup_address_id",
    column: "comments",
    header: ADDRESS_HEADER,
    row: "9001,9001,9001 Main St",
    sync: syncAddressSnapshotFromStream
  },
  {
    name: "container",
    table: "container_snapshot",
    pk: "container_id",
    column: "container_note",
    header: CONTAINER_HEADER,
    row: "9001,9001,SN-9001",
    sync: syncContainerSnapshotFromStream
  }
];

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function importCsv(name: string, csv: string): Promise<Response> {
  return exports.default.fetch(`http://test.local/api/v1/${name}-snapshot/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    },
    body: csv
  });
}

/** Lossless archive restore uses internal streaming sync, never strict HTTP import. */
describe("snapshot restore control boundary", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    // Reset only the local test binding, in reverse FK order.
    await db().batch([
      db().prepare("DELETE FROM container_snapshot"),
      db().prepare("DELETE FROM address_snapshot"),
      db().prepare("DELETE FROM customer_snapshot")
    ]);
  });

  describe.each(SPECS)("$name", (spec) => {
    it.each([
      { name: "lone CR", char: "\r" },
      { name: "vertical tab", char: "\u000b" },
      { name: "NUL", char: "\u0000" },
      { name: "NEL", char: "\u0085" }
    ])("restores $name losslessly in code while rejecting raw and exported HTTP imports", async ({ char }) => {
      // Seed parents in dependency order, exactly as an archive restore does.
      const initialOptions = { syncedAt: "2026-10-07T00:00:00.000Z" };
      await syncCustomerSnapshotFromStream(db(), stringToUint8Stream(`${CUSTOMER_HEADER}\n9001,Restore Co,`), undefined, initialOptions);
      if (spec.name === "container") {
        await syncAddressSnapshotFromStream(db(), stringToUint8Stream(`${ADDRESS_HEADER}\n9001,9001,9001 Main St,`), undefined, initialOptions);
      }
      const value = `first${char}second`;
      const csv = `${spec.header}\n${spec.row},"${value}"`;
      await spec.sync(db(), stringToUint8Stream(csv), undefined, initialOptions);
      const before = await db().prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.pk}`).all();
      expect(before.results[0]?.[spec.column]).toBe(value);

      const exported = await exports.default.fetch(`http://test.local/api/v1/${spec.name}-snapshot/export`, {
        headers: { authorization: `Bearer ${SYNC_SECRET}` }
      });
      expect(exported.status).toBe(200);
      const exportedCsv = await exported.text();
      expect(exportedCsv).toContain(value);

      // Neither archived report bytes nor our own export bypass import policy.
      for (const body of [csv, exportedCsv]) {
        const rejected = await importCsv(spec.name, body);
        expect(rejected.status).toBe(400);
        const problem = await rejected.json() as { status: number; detail: string };
        expect(problem.status).toBe(400);
        expect(problem.detail).toBe("CSV row 2 contains a disallowed control character. See docs/PROBLEMS.md#bad-request.");
        expect(JSON.stringify(problem)).not.toContain("first");
        const after = await db().prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.pk}`).all();
        expect(after.results).toEqual(before.results);
      }

      // Exercise the documented in-code restore after changing the stored value.
      await db().prepare(`UPDATE ${spec.table} SET ${spec.column} = ? WHERE ${spec.pk} = ?`)
        .bind("restore placeholder", 9001).run();
      const restored = await spec.sync(db(), stringToUint8Stream(csv), undefined, {
        reconcile: true,
        syncedAt: "2026-10-08T00:00:00.000Z"
      });
      expect(restored).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
      const row = await db().prepare(`SELECT ${spec.column} FROM ${spec.table} WHERE ${spec.pk} = ?`)
        .bind(9001).first<Record<string, unknown>>();
      expect(row?.[spec.column]).toBe(value);
    });
  });
});
