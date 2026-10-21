import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAddressSnapshotCsv } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotCsv } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotCsv } from "../src/lib/csvCustomerSnapshot";
import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";
import { recordingDb } from "./snapshotDbFake";

/**
 * Operator-import contract, not a replacement CSV dialect or report parser.
 * The real HTTP routes and disposable test D1 are the oracle. No new production
 * export is assumed. Mutations caught: parseInt prefix/rounding acceptance,
 * last-header-wins identity mapping, null-row skipping, validation after flush,
 * a dry-run validation bypass, and reconciliation after a parse failure.
 *
 * Required identities are positive safe integers spelled with decimal digits
 * (ordinary surrounding CSV whitespace and leading zeroes remain supported).
 * Optional numbers/defaults and upstream report parsing stay tolerant. A dry run
 * validates identity syntax, not existence of hypothetical parent rows; existing
 * dangling-FK coverage owns that distinction. "Missing parent" here includes a
 * missing parent column, an empty cell, and a short record missing that cell.
 *
 * Streaming is NOT upload-atomic: a valid flushed batch may remain after a later
 * invalid record. An invalid first batch writes nothing; import never deletes.
 * Builder follow-through: document this import-only policy and partial-write
 * limitation, with a synthetic example and this focused check, in the snapshot
 * guide / PROBLEMS.md. This prerequisite changes test files only.
 */

const SECRET = "test-sync-secret";
const MARKER = "SYNTHETIC-CELL-DO-NOT-ECHO-6f12";
const BAD_CELL = `123${MARKER}`;
const PARENT = 700;
const SENTINEL = 900;
const FIRST_ID = 10001;
const BATCH_SIZE = 80; // Public streaming behavior pinned by snapshotImportForeignKey.test.ts.
const MODES = [false, true];

type Identity = { header: string; field: string; index: number };
type Spec = {
  name: string;
  table: string;
  primary: string;
  headers: string[];
  identities: Identity[];
};

const SPECS: Spec[] = [
  {
    name: "customer", table: "customer_snapshot", primary: "customer_id",
    headers: ["CustomerID", "CompanyName"],
    identities: [{ header: "CustomerID", field: "customer_id", index: 0 }]
  },
  {
    name: "address", table: "address_snapshot", primary: "pickup_address_id",
    headers: ["PickupAddressID", "CustomerID", "Address"],
    identities: [
      { header: "PickupAddressID", field: "pickup_address_id", index: 0 },
      { header: "CustomerID", field: "customer_id", index: 1 }
    ]
  },
  {
    name: "container", table: "container_snapshot", primary: "container_id",
    headers: ["ContainerID", "PickupAddressID", "ContainerNote"],
    identities: [
      { header: "ContainerID", field: "container_id", index: 0 },
      { header: "PickupAddressID", field: "pickup_address_id", index: 1 }
    ]
  }
];

const BAD_SPELLINGS = [
  { name: "numeric prefix", value: BAD_CELL },
  { name: "empty", value: "" },
  { name: "spaces only", value: "   " },
  { name: "zero", value: "0" },
  { name: "negative", value: "-1" },
  { name: "fraction", value: "123.5" },
  { name: "integer-valued fraction", value: "123.0" },
  { name: "exponent", value: "1e3" },
  { name: "hex", value: "0x7b" },
  { name: "explicit plus", value: "+123" },
  { name: "unsafe integer", value: "9007199254740992" },
  { name: "rounded unsafe integer", value: "9007199254740993" },
  { name: "non-number", value: MARKER },
  { name: "infinity", value: "Infinity" },
  { name: "non-ASCII digits", value: "１２３" }
];

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

function path(spec: Spec): string {
  return `/api/v1/${spec.name}-snapshot/import`;
}

function cells(spec: Spec, id = String(FIRST_ID)): string[] {
  return spec.name === "customer" ? [id, MARKER] : [id, String(PARENT), MARKER];
}

function csv(spec: Spec, rows: string[][], headers = spec.headers): string {
  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

async function request(spec: Spec, body: string, dryRun: boolean): Promise<Response> {
  // The app's test bindings are synthetic and pinned by vitest.config.ts.
  // Do not fetch any secret or use an upstream/production endpoint.
  return exports.default.fetch(`http://test.local${path(spec)}?dryRun=${dryRun}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "text/csv"
    },
    body
  });
}

async function stored(spec: Spec): Promise<Record<string, unknown>[]> {
  const result = await db().prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.primary}`).all();
  return result.results as Record<string, unknown>[];
}

async function problem(res: Response, spec: Spec, field: string, row: number) {
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  const raw = await res.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  expect(body).toMatchObject({ title: "Bad Request", status: 400 });
  expect(body.type).toMatch(/#bad-request$/);
  // Identifiers and correction are public contract, representation is not:
  // detail text or structured extensions may carry them; no invented API export.
  expect(raw).toContain(spec.table);
  expect(raw).toContain(field);
  expect(raw).toMatch(new RegExp(`(?:row[\\s\" :]+${row}\\b)`, "i"));
  expect(raw).toMatch(/(?:fix|correct|use|provide|remove|supply|ensure)\b/i);
  expect(raw).toMatch(/retry/i);
  for (const forbidden of [
    MARKER, BAD_CELL, SECRET, "D1_ERROR", "9007199254740992", "9007199254740993",
    "123.5", "123.0", "1e3", "0x7b", "+123", "-1", "Infinity", "１２３"
  ]) {
    expect(raw).not.toContain(forbidden);
  }
  return body;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected network request in identity acceptance test");
  }));
  // Only the workerd pool's disposable local database; no remote migration.
  await db().prepare("DELETE FROM container_snapshot").run();
  await db().prepare("DELETE FROM address_snapshot").run();
  await db().prepare("DELETE FROM customer_snapshot").run();
  for (const id of [1, 123, PARENT, SENTINEL, Number.MAX_SAFE_INTEGER]) {
    await db().prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic seed', 1, '2000-01-01T00:00:00.000Z')"
    ).bind(id).run();
  }
  for (const id of [1, 123, PARENT, SENTINEL, Number.MAX_SAFE_INTEGER]) {
    await db().prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2000-01-01T00:00:00.000Z')"
    ).bind(id, PARENT).run();
  }
  await db().prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, 1, '2000-01-01T00:00:00.000Z')"
  ).bind(SENTINEL, PARENT).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(SPECS)("$name operator identity contract", (spec) => {
  describe.each(spec.identities)("$field", (identity) => {
    it.each(BAD_SPELLINGS.flatMap((spelling) => MODES.map((dryRun) => ({ ...spelling, dryRun }))))(
      "rejects $name before first-batch writes (dryRun=$dryRun)", async ({ value, dryRun }) => {
        const bad = cells(spec);
        bad[identity.index] = value;
        // A following valid record prevents the old null-row skip from hiding
        // behind the existing 'no data rows' rejection.
        const body = csv(spec, [bad, cells(spec, "10002")]);
        const before = await stored(spec);
        const res = await request(spec, body, dryRun);
        await problem(res, spec, identity.field, 2);
        expect(await stored(spec)).toEqual(before);
      }
    );

    it.each(MODES)("requires its header before any writes (dryRun=%s)", async (dryRun) => {
      const headers = spec.headers.filter((_, i) => i !== identity.index);
      const row = cells(spec).filter((_, i) => i !== identity.index);
      const before = await stored(spec);
      const res = await request(spec, csv(spec, [row], headers), dryRun);
      await problem(res, spec, identity.field, 1);
      expect(await stored(spec)).toEqual(before);
    });

    it.each(["exact", "case", "trimmed", "quoted"].flatMap((variant) => MODES.map((dryRun) => ({ variant, dryRun }))))(
      "rejects $variant duplicate identity columns, even equal cells (dryRun=$dryRun)", async ({ variant, dryRun }) => {
        const duplicate = variant === "case" ? identity.header.toLowerCase()
          : variant === "trimmed" ? ` ${identity.header} `
          : variant === "quoted" ? `"${identity.header}"` : identity.header;
        const row = cells(spec);
        row.push(row[identity.index]!);
        const body = csv(spec, [row], [...spec.headers, duplicate]);
        const before = await stored(spec);
        const res = await request(spec, body, dryRun);
        await problem(res, spec, identity.field, 1);
        expect(await stored(spec)).toEqual(before);
      }
    );

    it("uses stable value-free diagnostics and correction for different bad cells", async () => {
      const first = cells(spec);
      const second = cells(spec);
      first[identity.index] = BAD_CELL;
      second[identity.index] = `456${MARKER}`;
      const a = await problem(await request(spec, csv(spec, [first]), true), spec, identity.field, 2);
      const b = await problem(await request(spec, csv(spec, [second]), false), spec, identity.field, 2);
      expect(b).toEqual(a);
    });

    it.each(["1", "9007199254740991", "000123", " 123 "])("accepts whole-decimal boundary %j without changing identity", async (value) => {
      const row = cells(spec);
      row[identity.index] = value;
      const body = csv(spec, [row]);
      const before = await stored(spec);
      const dry = await request(spec, body, true);
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ rowCount: 1, upserted: 1, deleted: 0 });
      expect(await stored(spec)).toEqual(before);
      const real = await request(spec, body, false);
      expect(real.status).toBe(200);
      expect(await real.json()).toMatchObject({ rowCount: 1, upserted: 1, deleted: 0 });
      const id = Number(row[0]);
      const saved = await db().prepare(`SELECT * FROM ${spec.table} WHERE ${spec.primary} = ?`).bind(id).first();
      expect(saved).toMatchObject({ [identity.field]: Number(value) });
    });
  });

  it.each(MODES)("does not silently skip a short record missing required identities (dryRun=%s)", async (dryRun) => {
    const short = spec.name === "customer" ? `,${MARKER}` : "10001";
    const body = [spec.headers.join(","), short, cells(spec, "10002").join(",")].join("\n");
    const before = await stored(spec);
    const missing = spec.identities.at(-1)!;
    await problem(await request(spec, body, dryRun), spec, missing.field, 2);
    expect(await stored(spec)).toEqual(before);
  });

  it.each(spec.identities)("validates $field in the whole first batch before writing any of it", async (identity) => {
    const rows = Array.from({ length: BATCH_SIZE - 1 }, (_, i) => cells(spec, String(FIRST_ID + i)));
    const bad = cells(spec, "20000");
    bad[identity.index] = BAD_CELL;
    const before = await stored(spec);
    const res = await request(spec, csv(spec, [...rows, bad]), false);
    // Assert state independently of the error status: no prefix rows may land.
    expect(await stored(spec)).toEqual(before);
    await problem(res, spec, identity.field, BATCH_SIZE + 1);
  });

  it.each(spec.identities.flatMap((identity) => MODES.map((dryRun) => ({ identity, dryRun }))))(
    "rejects late $identity.field without deleting old rows or writing rejected/tail records (dryRun=$dryRun)", async ({ identity, dryRun }) => {
      const rows = Array.from({ length: BATCH_SIZE }, (_, i) => cells(spec, String(FIRST_ID + i)));
      const before = await stored(spec);
      const bad = cells(spec, "20000");
      bad[identity.index] = BAD_CELL;
      const res = await request(spec, csv(spec, [...rows, bad, cells(spec, "20001")]), dryRun);
      const after = await stored(spec);
      for (const original of before) expect(after).toContainEqual(original);
      const added = after.filter((row) => !before.some((old) => old[spec.primary] === row[spec.primary]));
      expect(added.map((row) => row[spec.primary])).toEqual(dryRun ? [] : Array.from({ length: 80 }, (_, i) => 10001 + i));
      await problem(res, spec, identity.field, 82);
    }
  );

  it("reports logical record numbers, not physical lines inside a quoted cell", async () => {
    const first = cells(spec);
    first[first.length - 1] = '"synthetic first line\nsynthetic second line"';
    const before = await stored(spec);
    const res = await request(spec, csv(spec, [first, cells(spec, BAD_CELL)]), false);
    await problem(res, spec, spec.primary, 3);
    expect(await stored(spec)).toEqual(before);
  });

  it.each(["case", "BOM", "quoted"])("preserves %s headers, optional omissions and blank records", async (variant) => {
    const headers = spec.headers.map((h) => variant === "quoted" ? `"${h}"` : h.toLowerCase());
    const body = `${variant === "BOM" ? "﻿" : ""}${headers.join(",")}\r\n\r\n   \r\n${cells(spec).join(",")}\r\n\r\n`;
    const dry = await request(spec, body, true);
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(await dry.json()).toEqual({ rowCount: 1, upserted: 1, deleted: 0 });
    const real = await request(spec, body, false);
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual({ rowCount: 1, upserted: 1, deleted: 0 });
    const row = await db().prepare(`SELECT * FROM ${spec.table} WHERE ${spec.primary} = ?`).bind(FIRST_ID).first();
    expect(row).toMatchObject({ enabled: 1 });
  });

  it("does not broaden identity validation to optional numbers or unrelated duplicate headers", async () => {
    const optional = spec.name === "customer" ? ["CustomerTypeID", "customer_type_id"]
      : spec.name === "address" ? ["RouteID", "route_id"] : ["ContainerTypeID", "container_type_id"];
    const headers = [...spec.headers, optional[0]!, "Unused", "Unused"];
    const body = csv(spec, [[...cells(spec), "7junk", "a", "b"]], headers);
    const before = await stored(spec);
    const dry = await request(spec, body, true);
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(await stored(spec)).toEqual(before);
    const real = await request(spec, body, false);
    expect(real.status, await real.clone().text()).toBe(200);
    const saved = await db().prepare(`SELECT * FROM ${spec.table} WHERE ${spec.primary} = ?`).bind(FIRST_ID).first();
    expect(saved).toMatchObject({ [optional[1]!]: 7, enabled: 1 });
  });

  it("keeps spreadsheet-safe export/import round trips", async () => {
    const row = cells(spec);
    row[row.length - 1] = '"=1+1, synthetic ""quote"""';
    expect((await request(spec, csv(spec, [row]), false)).status).toBe(200);
    const exportPath = `/api/v1/${spec.name}-snapshot/export`;
    const exported = await exports.default.fetch(`http://test.local${exportPath}`, {
      headers: { authorization: "Bearer test-sync-secret" }
    });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    const before = await stored(spec);
    expect((await request(spec, text, true)).status).toBe(200);
    expect(await stored(spec)).toEqual(before);
    expect((await request(spec, text, false)).status).toBe(200);
    const saved = (await stored(spec)).find((r) => r[spec.primary] === FIRST_ID);
    const column = spec.name === "customer" ? "company_name" : spec.name === "address" ? "address" : "container_note";
    expect(saved?.[column]).toBe('=1+1, synthetic "quote"');
  });
});

it.each([
  { sync: syncCustomerSnapshotFromStream, body: "CustomerID,CompanyName\n123junk,synthetic" },
  { sync: syncAddressSnapshotFromStream, body: "PickupAddressID,CustomerID\n234junk,123junk" },
  { sync: syncContainerSnapshotFromStream, body: "ContainerID,PickupAddressID\n345junk,234junk" }
])("keeps tolerant report-stream sync outside the operator policy ($body)", async ({ sync, body }) => {
  const recorded = recordingDb({ allResults: [{ customer_id: 123, pickup_address_id: 234 }] });
  const result = await sync(recorded.db, stringToUint8Stream(body), 80);
  expect(result).toEqual({ rowCount: 1, upserted: 1, deleted: 0 });
  expect(recorded.batches.flat().length).toBeGreaterThan(0);
});

it("retains tolerant upstream report identity parsing (not an operator import)", () => {
  expect(parseCustomerSnapshotCsv(`CustomerID,CompanyName\n123junk,synthetic`).rows[0]).toMatchObject({ customerId: 123 });
  expect(parseAddressSnapshotCsv("PickupAddressID,CustomerID\n234junk,123junk").rows[0]).toMatchObject({ pickupAddressId: 234, customerId: 123 });
  expect(parseContainerSnapshotCsv("ContainerID,PickupAddressID\n345junk,234junk").rows[0]).toMatchObject({ containerId: 345, pickupAddressId: 234 });
});
