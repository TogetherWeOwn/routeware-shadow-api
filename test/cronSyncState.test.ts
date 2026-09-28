import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cron last-run persistence (TOG-8883).
 *
 * The daily cron (`src/scheduled.ts`) upserts one row per table into
 * `cron_sync_state` after every run, and `GET /api/v1/readiness` reports it
 * as an advisory `cron` staleness probe. What this pins:
 *
 * 1. Schema — the table carries outcome/mode/counts/timestamps only (no
 *    column that could hold row data or error text; CONVENTIONS.md §5).
 * 2. Mapping — `success`/`unconfigured` runs record per-table
 *    `success`/`skipped`; a throwing run records `failed` with null counts.
 * 3. Staleness — fresh runs read back `stale: false`; runs older than
 *    `CRON_STALE_AFTER_MS` (or no rows at all) read back `stale: true`,
 *    without flipping the overall readiness status (advisory only).
 * 4. End to end — driving the real `scheduled()` handler advances the
 *    timestamp `checkReadiness` reports (the reviewer acceptance path).
 *
 * Real-D1 sections use the test `CUSTOMER_DB` (migrated via
 * `./d1TestMigrations`, which auto-discovers `0004_cron_sync_state.sql`);
 * the handler section uses an in-memory D1 double plus a stubbed sync so no
 * test touches the Routeware tenant. Fixtures are synthetic counts only —
 * no customer PII.
 */

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async () => ({
    customer: { upserted: 3, rowCount: 4 },
    address: null,
    container: null,
  }),
  runDataSnapshotSync: async () => ({
    customer: { upserted: 3, rowCount: 4 },
    address: null,
    container: null,
  }),
}));

import { env } from "cloudflare:workers";
import { checkReadiness, CRON_STALE_AFTER_MS } from "../src/lib/readiness";
import { readCronState, recordCronRun } from "../src/lib/cronSyncState";
import { readinessResponseSchema } from "../src/routes/meta";
import { scheduled } from "../src/scheduled";
import { ensureD1TestTables } from "./d1TestMigrations";

const db = () =>
  (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;

function makeEnv(dbValue: D1Database): Env {
  return {
    CUSTOMER_DB: dbValue,
    SNAPSHOTS: {} as unknown as R2Bucket,
    SNAPSHOTS_R2_ENABLED: "true",
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25",
  } as unknown as Env;
}

/** In-memory D1 double: SELECT 1 + cron_sync_state upsert/select. */
function fakeCronDb() {
  const rows = new Map<
    string,
    {
      table_name: string;
      outcome: string;
      mode: string;
      upserted: number | null;
      row_count: number | null;
      deleted: number | null;
      ran_at: string;
      duration_ms: number;
    }
  >();
  const dbValue = {
    prepare(_sql: string) {
      return {
        bind(...binds: unknown[]) {
          return { sql: _sql, binds };
        },
        async first<T>() {
          return { ok: 1 } as unknown as T;
        },
        async all<T>() {
          return { results: [...rows.values()] } as unknown as {
            results: T[];
          };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      for (const s of stmts) {
        const b = s.binds;
        rows.set(String(b[0]), {
          table_name: String(b[0]),
          outcome: String(b[1]),
          mode: String(b[2]),
          upserted: (b[3] as number | null) ?? null,
          row_count: (b[4] as number | null) ?? null,
          deleted: (b[5] as number | null) ?? null,
          ran_at: String(b[6]),
          duration_ms: Number(b[7]),
        });
      }
      return [];
    },
  };
  return { db: dbValue as unknown as D1Database, rows };
}

function fakeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: async () => {
      await Promise.all(pending);
    },
  };
}

const FRESH_AT = "2026-09-28T07:00:00.000Z";

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  await db().prepare("DELETE FROM cron_sync_state").run();
});

describe("cron_sync_state schema (0004)", () => {
  it("carries outcome/mode/counts/timestamps only — no PII-capable column", async () => {
    // Arrange / Act
    const info = await db()
      .prepare("PRAGMA table_info(cron_sync_state)")
      .all<{ name: string; type: string }>();

    // Assert — exact column list; nothing that could hold row data or text.
    const names = (info.results ?? []).map((c) => c.name);
    expect(names).toEqual([
      "table_name",
      "outcome",
      "mode",
      "upserted",
      "row_count",
      "deleted",
      "ran_at",
      "duration_ms",
    ]);
    expect(names).not.toContain("error");
    expect(names).not.toContain("message");
    expect(names).not.toContain("body");
    const ddl = await db()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cron_sync_state'"
      )
      .first<{ sql: string }>();
    expect(ddl?.sql).toContain("table_name TEXT PRIMARY KEY");
  });
});

describe("recordCronRun / readCronState round-trip", () => {
  it("maps success runs per table (synced → success, unconfigured → skipped)", async () => {
    // Arrange / Act
    await recordCronRun(db(), {
      outcome: "success",
      mode: "chained-http",
      tables: {
        customer: { upserted: 3, rowCount: 4, deleted: 1 },
        address: null,
        container: { upserted: 7, rowCount: 8 },
      },
      ranAt: FRESH_AT,
      durationMs: 1200,
    });

    // Assert
    const rows = await readCronState(db());
    expect(rows).toHaveLength(3);
    const byTable = Object.fromEntries((rows ?? []).map((r) => [r.tableName, r]));
    expect(byTable.customer).toMatchObject({
      outcome: "success",
      upserted: 3,
      rowCount: 4,
      deleted: 1,
      ranAt: FRESH_AT,
    });
    expect(byTable.address).toMatchObject({
      outcome: "skipped",
      upserted: null,
      rowCount: null,
      deleted: null,
      ranAt: FRESH_AT,
    });
    expect(byTable.container).toMatchObject({ outcome: "success", deleted: null });
  });

  it("records failed runs with null counts and persists no error text", async () => {
    // Arrange — the handler records `failed` when the sync throws; the throw
    // message goes to the log line only, never to D1.
    const thrown = "[customer snapshot] D1_ERROR: database is locked";

    // Act
    await recordCronRun(db(), {
      outcome: "failed",
      mode: "single-invocation",
      tables: { customer: null, address: null, container: null },
      ranAt: FRESH_AT,
      durationMs: 50,
    });

    // Assert
    const rows = await readCronState(db());
    expect(rows).toHaveLength(3);
    for (const r of rows ?? []) {
      expect(r.outcome).toBe("failed");
      expect(r.upserted).toBeNull();
      expect(r.rowCount).toBeNull();
      expect(r.deleted).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toContain(thrown);
    expect(JSON.stringify(rows)).not.toContain("database is locked");
  });

  it("returns null when the binding is missing (readiness reports never-ran)", async () => {
    // Arrange / Act / Assert — the unit-test envs that drive the handler
    // without a database must not throw.
    await expect(
      recordCronRun(undefined, {
        outcome: "success",
        mode: "chained-http",
        tables: { customer: null, address: null, container: null },
        ranAt: FRESH_AT,
        durationMs: 1,
      })
    ).resolves.toBe("skipped");
    await expect(readCronState(undefined)).resolves.toBeNull();
  });
});

describe("readiness cron staleness", () => {
  it("reports fresh runs with per-table outcome + timestamp (schema-valid)", async () => {
    // Arrange
    await recordCronRun(db(), {
      outcome: "success",
      mode: "chained-http",
      tables: {
        customer: { upserted: 3, rowCount: 4 },
        address: null,
        container: null,
      },
      ranAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 900,
    });

    // Act
    const { report, httpStatus } = await checkReadiness(makeEnv(db()));

    // Assert
    expect(httpStatus).toBe(200);
    expect(report.status).toBe("ok");
    expect(report.checks.cron).toMatchObject({ ok: true, stale: false });
    expect(report.checks.cron.lastRunAt).not.toBeNull();
    expect(report.checks.cron.tables.customer).toMatchObject({ outcome: "success" });
    expect(report.checks.cron.tables.address).toMatchObject({ outcome: "skipped" });
    expect(readinessResponseSchema.safeParse(report).success).toBe(true);
  });

  it("marks runs older than 48h stale without flipping overall status", async () => {
    // Arrange — two missed daily firings page; the probe itself stays advisory.
    expect(CRON_STALE_AFTER_MS).toBe(48 * 60 * 60 * 1000);
    await recordCronRun(db(), {
      outcome: "success",
      mode: "chained-http",
      tables: {
        customer: { upserted: 3, rowCount: 4 },
        address: null,
        container: null,
      },
      ranAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      durationMs: 900,
    });

    // Act
    const { report, httpStatus } = await checkReadiness(makeEnv(db()));

    // Assert — cron is stale/!ok, but D1+R2+config still carry the deploy gate.
    expect(report.checks.cron).toMatchObject({ ok: false, stale: true });
    expect(report.checks.cron.detail).toContain("48h");
    expect(report.checks.cron.tables.customer).not.toBeNull();
    expect(httpStatus).toBe(200);
    expect(report.status).toBe("ok");
    expect(readinessResponseSchema.safeParse(report).success).toBe(true);
  });

  it("reports never-ran when the table is empty (stale, null timestamp)", async () => {
    // Arrange — beforeEach wiped the table; no run recorded yet.

    // Act
    const { report, httpStatus } = await checkReadiness(makeEnv(db()));

    // Assert
    expect(report.checks.cron).toMatchObject({
      ok: false,
      stale: true,
      lastRunAt: null,
      tables: { customer: null, address: null, container: null },
    });
    expect(httpStatus).toBe(200);
    expect(report.status).toBe("ok");
    expect(readinessResponseSchema.safeParse(report).success).toBe(true);
  });
});

describe("scheduled() → readiness acceptance path", () => {
  it("a local scheduled run advances the timestamp readiness reports", async () => {
    // Arrange — stubbed sync (mocked above), in-memory D1, silenced console.
    const { db: fakeDb } = fakeCronDb();
    const envValue = {
      ...(makeEnv(fakeDb) as unknown as Record<string, unknown>),
      SHADOW_API_PUBLIC_BASE: "https://api.example.test",
    } as unknown as Env;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // Act — reviewer path: fire the cron trigger, then read readiness.
      const { ctx, settled } = fakeCtx();
      await scheduled(
        { cron: "0 7 * * *", scheduledTime: Date.parse("2026-09-28T07:00:00.000Z") } as ScheduledController,
        envValue,
        ctx
      );
      await settled();
      const { report } = await checkReadiness(makeEnv(fakeDb));

      // Assert — the run persisted three rows and readiness is fresh.
      const rows = await readCronState(fakeDb);
      expect(rows).toHaveLength(3);
      expect(report.checks.cron.stale).toBe(false);
      expect(report.checks.cron.ok).toBe(true);
      expect(report.checks.cron.lastRunAt).not.toBeNull();
      expect(report.checks.cron.tables.customer).toMatchObject({
        outcome: "success",
        upserted: 3,
        rowCount: 4,
      });
      expect(report.checks.cron.tables.address?.outcome).toBe("skipped");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });
});
