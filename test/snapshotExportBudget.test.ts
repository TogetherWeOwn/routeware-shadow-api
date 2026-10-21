import { describe, expect, it } from "vitest";
import {
  ADDRESS_SNAPSHOT_EXPORT,
  CONTAINER_SNAPSHOT_EXPORT,
  CUSTOMER_SNAPSHOT_EXPORT,
  encodeSnapshotRow,
  snapshotCsvResponse,
  snapshotExportEtag,
  snapshotExportHeaderLine,
  type SnapshotExportSpec
} from "../src/lib/snapshot/export";
import customerSnapshotMd from "../CUSTOMER_SNAPSHOT.md?raw";
import problemsMd from "../docs/PROBLEMS.md?raw";

/**
 * R12-01 acceptance contract: predictable query-budget exhaustion is refused
 * BEFORE any CSV byte is promised.
 *
 * A `200` export costs two keyset passes (the ETag prepass and the body pass),
 * each `ceil(rows / pageSize) + 1` reads (the `+ 1` is the terminal empty
 * read). Production D1 allows ~1000 queries per Worker invocation, so a table
 * that cannot fit used to answer `200` and then truncate mid-stream. The
 * contract pinned here:
 *
 * 1. `src/lib/snapshot/exportBudget.ts` (new, pure, no I/O) exports the single
 *    cost calculation:
 *    - `SNAPSHOT_EXPORT_D1_QUERY_LIMIT` — conservative limit, <= 1000;
 *    - `SNAPSHOT_EXPORT_QUERY_HEADROOM` — explicit safety headroom, >= 1;
 *    - `SNAPSHOT_EXPORT_QUERY_ALLOWANCE` — `LIMIT - HEADROOM`;
 *    - `snapshotExportQueryCost(rows, pageSize)` — `2 * (ceil(rows / pageSize) + 1)`;
 *    - `snapshotExportFitsBudget(rows, pageSize)` — cost <= allowance;
 *    - `snapshotExportMaxRows(pageSize)` — the largest row count that fits;
 *    invalid inputs (negative / fractional / non-finite rows, page size < 1 or
 *    fractional) throw `RangeError`.
 * 2. `snapshotCsvResponse` (and so all three export routes) bounds its own
 *    prepass: it never issues more than `floor(allowance / 2)` reads before
 *    deciding. A table that cannot fit answers `503 application/problem+json`
 *    (type anchor `snapshot-export-query-budget`, fixed detail naming
 *    `SNAPSHOT_EXPORT_PAGE_SIZE` and CUSTOMER_SNAPSHOT.md) with no CSV headers,
 *    no ETag and no body pass.
 * 3. Admissible exports (including 304) are unchanged byte for byte.
 * 4. Controlled D1 faults keep their existing behavior: they are NOT
 *    translated into the budget problem.
 * 5. docs/PROBLEMS.md and CUSTOMER_SNAPSHOT.md document the formula, remedy
 *    and the focused check (`npm test -- test/snapshotExportBudget.test.ts`).
 *
 * Fixtures are synthetic and lazy: the fake D1 generates rows on demand, so
 * the budget boundary is exercised with page size 1 (a few hundred rows) and
 * small page multiples without allocating production-sized tables.
 */

/**
 * `exportBudget.ts` does not exist until the Builder adds it. `import.meta.glob`
 * resolves to `{}` when the file is absent, so the suite loads and every
 * budget assertion fails on a named missing export, not on a broken import.
 */
type BudgetModule = {
  SNAPSHOT_EXPORT_D1_QUERY_LIMIT: number;
  SNAPSHOT_EXPORT_QUERY_HEADROOM: number;
  SNAPSHOT_EXPORT_QUERY_ALLOWANCE: number;
  snapshotExportQueryCost(rows: number, pageSize: number): number;
  snapshotExportFitsBudget(rows: number, pageSize: number): boolean;
  snapshotExportMaxRows(pageSize: number): number;
};
const budgetModules = import.meta.glob("../src/lib/snapshot/exportBudget.ts", {
  eager: true
}) as Record<string, Partial<BudgetModule>>;
const budget: Partial<BudgetModule> = Object.values(budgetModules)[0] ?? {};

function need<K extends keyof BudgetModule>(name: K): BudgetModule[K] {
  const value = budget[name];
  if (value === undefined) {
    throw new Error(`src/lib/snapshot/exportBudget.ts must export ${String(name)}`);
  }
  return value as BudgetModule[K];
}

// Fixture sizing falls back to the 1000-query platform contract minus a
// 50-query headroom while the module is absent; once it exists, its values win.
const ALLOWANCE = budget.SNAPSHOT_EXPORT_QUERY_ALLOWANCE ?? 950;
const PER_PASS_CAP = Math.floor(ALLOWANCE / 2);
const fixtureMaxRows = (pageSize: number): number =>
  budget.snapshotExportMaxRows
    ? budget.snapshotExportMaxRows(pageSize)
    : (PER_PASS_CAP - 1) * pageSize;
const fixtureCost = (rows: number, pageSize: number): number =>
  budget.snapshotExportQueryCost
    ? budget.snapshotExportQueryCost(rows, pageSize)
    : 2 * (Math.ceil(rows / pageSize) + 1);

const SYNCED_AT = "2026-10-11T00:00:00.000Z";
const ROW_SENTINEL = "ROW-DATA-SENTINEL-DO-NOT-LEAK";
const D1_SENTINEL = "D1_ERROR: sentinel-internal-message token=hunter2";

type Fault = { onRead: number; message: string };

/**
 * Lazy keyset-honoring fake D1 over ids 1..total. Records every read and the
 * rows served, and can fail one numbered read with a controlled error.
 */
function lazyDb(
  total: number,
  makeRow: (id: number) => Record<string, unknown>,
  pk: string,
  fault?: Fault
) {
  const state = { reads: 0, rowsServed: 0 };
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all<T>() {
              state.reads += 1;
              if (fault && state.reads === fault.onRead) {
                throw new Error(fault.message);
              }
              if (!sql.includes(`ORDER BY ${pk}`) || sql.includes("OFFSET")) {
                throw new Error("export reads must be keyset ordered and OFFSET-free");
              }
              const limit = binds[binds.length - 1] as number;
              const after = binds.length > 1 ? (binds[0] as number) : 0;
              const count = Math.max(0, Math.min(limit, total - after));
              state.rowsServed += count;
              return {
                results: Array.from({ length: count }, (_, i) => makeRow(after + i + 1))
              } as unknown as T;
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, state };
}

const customerRow = (id: number) => ({
  customer_id: id,
  customer_type_id: null,
  company_name: `${ROW_SENTINEL} ${id}`,
  first_name: null,
  middle_initial: null,
  last_name: null,
  name_suffix: null,
  customer_number: null,
  sub_customer_number: null,
  phone1: null,
  phone2: null,
  comments: null,
  enabled: 1,
  synced_at: SYNCED_AT
});

const addressRow = (id: number) => ({
  pickup_address_id: id,
  customer_id: 1,
  route_id: null,
  address: `${ROW_SENTINEL} ${id}`,
  city: "Killeen",
  state: "TX",
  zip: "76541",
  franchise_id: null,
  comments: null,
  extras_allowed: 0,
  enabled: 1,
  driver_note: null,
  latitude: null,
  longitude: null,
  last_audit_date: null,
  synced_at: SYNCED_AT
});

const containerRow = (id: number) => ({
  container_id: id,
  pickup_address_id: 1,
  container_type_id: null,
  serial_number: `${ROW_SENTINEL} ${id}`,
  rfid: null,
  oncall: 0,
  event_code: null,
  gps_locked: 0,
  latitude: null,
  longitude: null,
  enabled: 1,
  location_address: "1 Main St",
  city: "Killeen",
  state: "TX",
  zip: "76541",
  container_note: null,
  ud_cost_share_ud: null,
  ud_enclosure_doors_ud: null,
  ud_last_compactor_inspection_ud: null,
  ud_last_enclosure_inspection_ud: null,
  ud_material_stream_ud: null,
  color: null,
  service_code_type: null,
  service_code_input: null,
  service_code: null,
  service_date: null,
  route_ids: null,
  frequency_ids: null,
  synced_at: SYNCED_AT
});

type Table = {
  name: string;
  spec: SnapshotExportSpec;
  pk: string;
  row: (id: number) => Record<string, unknown>;
};

const TABLES: Table[] = [
  { name: "customer", spec: CUSTOMER_SNAPSHOT_EXPORT, pk: "customer_id", row: customerRow },
  { name: "address", spec: ADDRESS_SNAPSHOT_EXPORT, pk: "pickup_address_id", row: addressRow },
  { name: "container", spec: CONTAINER_SNAPSHOT_EXPORT, pk: "container_id", row: containerRow }
];

const PAGE_SIZES = [1, 2, 7, 50, 500, 1000, 5000];

function expectedCsv(table: Table, rows: number): string {
  const lines = [snapshotExportHeaderLine(table.spec)];
  for (let id = 1; id <= rows; id += 1) {
    lines.push(encodeSnapshotRow(table.spec, table.row(id)));
  }
  return `${lines.join("\n")}\n`;
}

async function expectBudgetProblem(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(res.headers.get("content-type")).not.toContain("text/csv");
  expect(res.headers.get("content-disposition")).toBeNull();
  expect(res.headers.get("etag")).toBeNull();
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body.status).toBe(503);
  expect(String(body.type)).toMatch(/PROBLEMS\.md#snapshot-export-query-budget$/);
  expect(typeof body.title).toBe("string");
  expect(String(body.title).length).toBeGreaterThan(0);
  expect(String(body.detail)).toContain("SNAPSHOT_EXPORT_PAGE_SIZE");
  expect(String(body.detail)).toContain("CUSTOMER_SNAPSHOT.md");
  return { text, body };
}

describe("snapshot export query-budget calculation (pure)", () => {
  it("keeps a conservative limit with explicit headroom inside the platform contract", () => {
    expect(need("SNAPSHOT_EXPORT_D1_QUERY_LIMIT")).toBeLessThanOrEqual(1000);
    expect(Number.isInteger(need("SNAPSHOT_EXPORT_QUERY_HEADROOM"))).toBe(true);
    expect(need("SNAPSHOT_EXPORT_QUERY_HEADROOM")).toBeGreaterThanOrEqual(1);
    expect(need("SNAPSHOT_EXPORT_QUERY_ALLOWANCE")).toBe(
      need("SNAPSHOT_EXPORT_D1_QUERY_LIMIT") - need("SNAPSHOT_EXPORT_QUERY_HEADROOM")
    );
    expect(need("SNAPSHOT_EXPORT_QUERY_ALLOWANCE")).toBeGreaterThan(0);
  });

  it.each([
    // [rows, pageSize, cost]: two passes of ceil(rows / pageSize) + 1 reads.
    [0, 1000, 2],
    [1, 1000, 4],
    [999, 1000, 4],
    [1000, 1000, 4],
    [1001, 1000, 6],
    [2000, 1000, 6],
    [3, 1, 8],
    [388_735, 1000, 780],
    [388_735, 500, 1558]
  ])("costs %i rows at page size %i as %i queries", (rows, pageSize, cost) => {
    expect(need("snapshotExportQueryCost")(rows, pageSize)).toBe(cost);
  });

  it("admits the measured production tables at the default and refuses the documented 500-row case", () => {
    expect(need("snapshotExportFitsBudget")(109_894, 1000)).toBe(true);
    expect(need("snapshotExportFitsBudget")(111_620, 1000)).toBe(true);
    expect(need("snapshotExportFitsBudget")(388_735, 1000)).toBe(true);
    expect(need("snapshotExportFitsBudget")(388_735, 500)).toBe(false);
  });

  it("admits an empty table at every supported page size", () => {
    for (const pageSize of PAGE_SIZES) {
      expect(need("snapshotExportFitsBudget")(0, pageSize)).toBe(true);
    }
  });

  it.each(PAGE_SIZES)("flips from fit to no-fit exactly at a page boundary (page size %i)", (pageSize) => {
    const max = need("snapshotExportMaxRows")(pageSize);
    // The largest admissible table is an exact page multiple: its last full
    // page is followed by one terminal empty read.
    expect(max % pageSize).toBe(0);
    expect(max).toBeGreaterThan(0);
    expect(need("snapshotExportQueryCost")(max, pageSize)).toBeLessThanOrEqual(
      need("SNAPSHOT_EXPORT_QUERY_ALLOWANCE")
    );
    expect(need("snapshotExportFitsBudget")(max, pageSize)).toBe(true);
    expect(need("snapshotExportFitsBudget")(max - 1, pageSize)).toBe(true);
    expect(need("snapshotExportFitsBudget")(max + 1, pageSize)).toBe(false);
    expect(need("snapshotExportQueryCost")(max + 1, pageSize)).toBeGreaterThan(
      need("SNAPSHOT_EXPORT_QUERY_ALLOWANCE")
    );
    expect(need("snapshotExportFitsBudget")(max + pageSize, pageSize)).toBe(false);
  });

  it("agrees with its own cost function for every row count around the page-1 boundary", () => {
    const max = need("snapshotExportMaxRows")(1);
    for (let rows = Math.max(0, max - 3); rows <= max + 3; rows += 1) {
      expect(need("snapshotExportFitsBudget")(rows, 1)).toBe(
        need("snapshotExportQueryCost")(rows, 1) <= need("SNAPSHOT_EXPORT_QUERY_ALLOWANCE")
      );
    }
  });

  it.each([
    [-1, 1000],
    [1.5, 1000],
    [Number.NaN, 1000],
    [Number.POSITIVE_INFINITY, 1000],
    [10, 0],
    [10, -5],
    [10, 2.5],
    [10, Number.NaN]
  ])("rejects invalid input (rows=%s, pageSize=%s) with RangeError", (rows, pageSize) => {
    expect(() => need("snapshotExportQueryCost")(rows, pageSize)).toThrow(RangeError);
    expect(() => need("snapshotExportFitsBudget")(rows, pageSize)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid page size %s for max rows", (pageSize) => {
    expect(() => need("snapshotExportMaxRows")(pageSize)).toThrow(RangeError);
  });
});

describe.each(TABLES)("$name export: budget admission before the CSV starts", (table) => {
  it("serves the largest admissible table (exact page multiple) byte-identically in exactly the formula's reads", async () => {
    const pageSize = 1;
    const rows = fixtureMaxRows(pageSize);
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, null, pageSize);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${table.spec.filename}"`
    );
    const text = await res.text();
    expect(text).toBe(expectedCsv(table, rows));
    expect(res.headers.get("etag")).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    expect(state.reads).toBe(fixtureCost(rows, pageSize));
    expect(state.reads).toBeLessThanOrEqual(ALLOWANCE);
  });

  it("refuses one row past the boundary with 503 before any CSV body exists", async () => {
    const pageSize = 1;
    const rows = fixtureMaxRows(pageSize) + 1;
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, null, pageSize);
    const readsAtResponse = state.reads;
    await expectBudgetProblem(res);

    // No body pass: the read count is frozen once the response exists.
    await Promise.resolve();
    expect(state.reads).toBe(readsAtResponse);
    expect(readsAtResponse).toBeLessThanOrEqual(PER_PASS_CAP);
  });

  it.each([2, 7])("flips at an exact page multiple (page size %i) and not before", async (pageSize) => {
    const max = fixtureMaxRows(pageSize);

    const fits = lazyDb(max, table.row, table.pk);
    const ok = await snapshotCsvResponse(fits.db, table.spec, null, pageSize);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(expectedCsv(table, max));
    expect(fits.state.reads).toBe(fixtureCost(max, pageSize));

    const partial = lazyDb(max - 1, table.row, table.pk);
    const partialRes = await snapshotCsvResponse(partial.db, table.spec, null, pageSize);
    expect(partialRes.status).toBe(200);
    await partialRes.text();

    const full = lazyDb(max + pageSize, table.row, table.pk);
    await expectBudgetProblem(await snapshotCsvResponse(full.db, table.spec, null, pageSize));
    const onePast = lazyDb(max + 1, table.row, table.pk);
    await expectBudgetProblem(await snapshotCsvResponse(onePast.db, table.spec, null, pageSize));
  });

  it("answers an empty table with the header alone in two reads", async () => {
    const { db, state } = lazyDb(0, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, null, 1000);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${snapshotExportHeaderLine(table.spec)}\n`);
    expect(state.reads).toBe(fixtureCost(0, 1000));
    expect(state.reads).toBe(2);
  });

  it("bounds the prepass itself on an oversized table: capped reads, capped rows, no unbounded hash walk", async () => {
    const pageSize = 1;
    const rows = PER_PASS_CAP * 100;
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, null, pageSize);
    await expectBudgetProblem(res);

    expect(state.reads).toBeLessThanOrEqual(PER_PASS_CAP);
    expect(state.rowsServed).toBeLessThanOrEqual(PER_PASS_CAP * pageSize);
    expect(state.rowsServed).toBeLessThan(rows);
  });

  it("refuses the documented 500-row page against a 388,735-row table within the prepass cap", async () => {
    const rows = 388_735;
    const pageSize = 500;
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, null, pageSize);
    await expectBudgetProblem(res);

    expect(state.reads).toBeLessThanOrEqual(PER_PASS_CAP);
    expect(state.rowsServed).toBeLessThanOrEqual(PER_PASS_CAP * pageSize);
  }, 30_000);

  it("refuses an oversized table regardless of If-None-Match, since no ETag can be proven in budget", async () => {
    const pageSize = 1;
    const rows = fixtureMaxRows(pageSize) + 1;
    for (const header of ["*", '"fnv64-0000000000000000"']) {
      const { db, state } = lazyDb(rows, table.row, table.pk);
      const res = await snapshotCsvResponse(db, table.spec, header, pageSize);
      await expectBudgetProblem(res);
      expect(state.reads).toBeLessThanOrEqual(PER_PASS_CAP);
    }
  });

  it("keeps the admissible 304 path: one pass, empty body, ETag only", async () => {
    const pageSize = 2;
    const rows = 9;
    const etag = await snapshotExportEtag(
      lazyDb(rows, table.row, table.pk).db, table.spec, pageSize
    );
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await snapshotCsvResponse(db, table.spec, etag, pageSize);

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
    expect(state.reads).toBe(Math.ceil(rows / pageSize) + 1);
  });

  it("keeps the ETag of an admitted export equal to the standalone content hash", async () => {
    const pageSize = 3;
    const rows = 10;
    const standalone = await snapshotExportEtag(
      lazyDb(rows, table.row, table.pk).db, table.spec, pageSize
    );

    const res = await snapshotCsvResponse(
      lazyDb(rows, table.row, table.pk).db, table.spec, null, pageSize
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(standalone);
    expect(await res.text()).toBe(expectedCsv(table, rows));
  });
});

describe("budget problem body", () => {
  it("is fixed and leaks no row data, config values, SQL, D1 text or credentials", async () => {
    const pageSize = 1;
    const bodies: string[] = [];
    for (const table of TABLES) {
      for (const extra of [1, 5 * PER_PASS_CAP]) {
        const rows = fixtureMaxRows(pageSize) + extra;
        const { db } = lazyDb(rows, table.row, table.pk);
        const res = await snapshotCsvResponse(db, table.spec, null, pageSize);
        const { text } = await expectBudgetProblem(res);
        bodies.push(text);
        expect(text).not.toContain(ROW_SENTINEL);
        expect(text).not.toMatch(/customer_snapshot|address_snapshot|container_snapshot/);
        expect(text).not.toMatch(/SELECT|LIMIT|ORDER BY/);
        expect(text).not.toMatch(/D1_ERROR|Bearer|authorization/i);
      }
    }
    // Stable across tables and sizes: the same bytes every time.
    expect(new Set(bodies).size).toBe(1);
  });
});

describe.each(TABLES)("$name export route wiring", (table) => {
  const routeFor = async () => {
    switch (table.name) {
      case "customer":
        return (await import("../src/routes/customerSnapshot")).customerSnapshotRoutes;
      case "address":
        return (await import("../src/routes/addressSnapshot")).addressSnapshotRoutes;
      default:
        return (await import("../src/routes/containerSnapshot")).containerSnapshotRoutes;
    }
  };
  const SECRET = "test-sync-secret";
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  const call = async (db: D1Database, pageSize: string, token: string | null = SECRET) => {
    const routes = await routeFor();
    const headers = new Headers();
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return routes.fetch(
      new Request(`http://test.local/api/v1/${table.name}-snapshot/export`, { headers }),
      {
        CUSTOMER_DB: db,
        CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
        SNAPSHOT_EXPORT_PAGE_SIZE: pageSize
      } as unknown as Env,
      ctx
    );
  };

  it("answers the route with the shared 503 problem when the configured page size cannot fit the table", async () => {
    const rows = fixtureMaxRows(1) + 1;
    const { db, state } = lazyDb(rows, table.row, table.pk);

    const res = await call(db, "1");

    const { text } = await expectBudgetProblem(res);
    expect(text).not.toContain(SECRET);
    expect(state.reads).toBeLessThanOrEqual(PER_PASS_CAP);
  });

  it("still serves the same table once the configured page size makes it fit", async () => {
    const rows = fixtureMaxRows(1) + 1;
    const { db } = lazyDb(rows, table.row, table.pk);

    const res = await call(db, "2");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedCsv(table, rows));
  });

  it("checks authorization before any budget work", async () => {
    const { db, state } = lazyDb(fixtureMaxRows(1) + 1, table.row, table.pk);

    const res = await call(db, "1", null);

    expect(res.status).toBe(401);
    expect(state.reads).toBe(0);
  });
});

describe("controlled D1 faults keep their existing behavior", () => {
  const table = TABLES[0]!;

  it.each([
    D1_SENTINEL,
    "D1_ERROR: Too many API requests by single worker invocation."
  ])("propagates a prepass failure (%s) instead of reporting a budget problem", async (message) => {
    const { db } = lazyDb(5, table.row, table.pk, { onRead: 1, message });

    await expect(snapshotCsvResponse(db, table.spec, null, 2)).rejects.toThrow(message);
  });

  it("propagates a mid-prepass failure on a table that would also be oversized, below the cap", async () => {
    const rows = fixtureMaxRows(1) + 50;
    const { db, state } = lazyDb(rows, table.row, table.pk, { onRead: 3, message: D1_SENTINEL });

    await expect(snapshotCsvResponse(db, table.spec, null, 1)).rejects.toThrow(D1_SENTINEL);
    expect(state.reads).toBe(3);
  });

  it("still starts a 200 and errors the stream when D1 fails after an admissible prepass", async () => {
    const pageSize = 2;
    const rows = 7;
    const prepassReads = Math.ceil(rows / pageSize) + 1;
    const { db } = lazyDb(rows, table.row, table.pk, {
      onRead: prepassReads + 2,
      message: D1_SENTINEL
    });

    const res = await snapshotCsvResponse(db, table.spec, null, pageSize);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const reader = res.body!.getReader();
    let streamError: unknown;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      streamError = error;
    }
    expect(String(streamError)).toContain(D1_SENTINEL);
  });

  it("does not turn a D1 failure into the fixed budget body", async () => {
    const { db } = lazyDb(3, table.row, table.pk, { onRead: 2, message: D1_SENTINEL });

    const outcome = await snapshotCsvResponse(db, table.spec, null, 1).then(
      (res) => ({ res }),
      (error: unknown) => ({ error })
    );

    expect("error" in outcome).toBe(true);
  });
});

function expectDocHas(doc: string, needle: string): void {
  expect(doc.includes(needle), `documentation must contain: ${needle}`).toBe(true);
}

describe("budget contract is documented", () => {
  it("registers the problem type in docs/PROBLEMS.md with status, remedy and detail", () => {
    expectDocHas(problemsMd, '<a name="snapshot-export-query-budget"></a>');
    expect(/`snapshot-export-query-budget`\s*\|\s*503/.test(problemsMd), "PROBLEMS.md table row with status 503").toBe(true);
    const section = problemsMd.slice(problemsMd.indexOf("snapshot-export-query-budget"));
    expectDocHas(section, "SNAPSHOT_EXPORT_PAGE_SIZE");
    expectDocHas(section, "CUSTOMER_SNAPSHOT.md");
    expectDocHas(section, "test/snapshotExportBudget.test.ts");
  });

  it("documents the cost formula, headroom, a synthetic example and the focused check", () => {
    const start = customerSnapshotMd.indexOf("### CSV export page sizing");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = customerSnapshotMd.slice(start);
    expectDocHas(section, "2 * (ceil(N / pageSize) + 1)");
    expectDocHas(section.toLowerCase(), "headroom");
    expectDocHas(section, String(ALLOWANCE));
    expectDocHas(section, "snapshot-export-query-budget");
    expectDocHas(section, "503");
    expectDocHas(section, "1,558");
    expectDocHas(section, "npm test -- test/snapshotExportBudget.test.ts");
    // The old unguarded promise ("body would truncate mid-stream after the 200")
    // must not survive as the described behavior of an oversized table.
    expect(section).not.toMatch(/body would truncate mid-stream after the\s+200 is sent/);
  });
});
