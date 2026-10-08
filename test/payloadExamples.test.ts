import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCustomerSnapshotCsv } from "../src/lib/csvCustomerSnapshot";
import { parseAddressSnapshotCsv } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotCsv } from "../src/lib/csvContainerSnapshot";
import {
  customerBindings, customerMultiInsertSql,
  addressBindings, addressMultiInsertSql,
  containerBindings, containerMultiInsertSql
} from "../src/lib/snapshot/tableSql";
import {
  CUSTOMER_SNAPSHOT_EXPORT, ADDRESS_SNAPSHOT_EXPORT, CONTAINER_SNAPSHOT_EXPORT,
  encodeSnapshotRow, snapshotExportHeaderLine
} from "../src/lib/snapshot/export";
import {
  customerRowExample, customerExportExample,
  addressRowExample, addressExportExample,
  containerRowExample, containerExportExample
} from "../src/routes/payloadExamples";
import { ensureD1TestTables } from "./d1TestMigrations";

const CASES = [
  { spec: CUSTOMER_SNAPSHOT_EXPORT, fixture: customerRowExample, csv: customerExportExample },
  { spec: ADDRESS_SNAPSHOT_EXPORT, fixture: addressRowExample, csv: addressExportExample },
  { spec: CONTAINER_SNAPSHOT_EXPORT, fixture: containerRowExample, csv: containerExportExample }
];

// Real migrated test D1 catches normalization and TEXT-affinity mismatches that
// permissive OpenAPI response schemas cannot detect. Never touches upstream.
describe("synthetic OpenAPI rows match stored snapshot values", () => {
  const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;

  beforeAll(async () => {
    await ensureD1TestTables(db);
    const customers = parseCustomerSnapshotCsv(customerExportExample).rows;
    const addresses = parseAddressSnapshotCsv(addressExportExample).rows;
    const containers = parseContainerSnapshotCsv(containerExportExample).rows;
    expect(customers).toHaveLength(1);
    expect(addresses).toHaveLength(1);
    expect(containers).toHaveLength(1);
    // Insert in FK order, exactly as the real import path does.
    await db.prepare(customerMultiInsertSql(1))
      .bind(...customerBindings(customers[0], customerRowExample.synced_at)).run();
    await db.prepare(addressMultiInsertSql(1))
      .bind(...addressBindings(addresses[0], addressRowExample.synced_at)).run();
    await db.prepare(containerMultiInsertSql(1))
      .bind(...containerBindings(containers[0], containerRowExample.synced_at)).run();
  });

  it.each(CASES)("$spec.table response fixture equals its stored row", async ({ spec, fixture }) => {
    const row = fixture as Record<string, unknown>;
    const stored = await db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.pk} = ?`)
      .bind(row[spec.pk]).first();
    expect(stored).toEqual(fixture);
  });

  it.each(CASES)("$spec.table CSV example matches the production serializer", ({ spec, fixture, csv }) => {
    expect(csv).toBe(
      snapshotExportHeaderLine(spec) + "\n" + encodeSnapshotRow(spec, fixture) + "\n"
    );
  });
});
