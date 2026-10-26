import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Roadmap R9-04, test-author half: `syncCustomerDetailFullToD1`
 * must emit one structured JSON utilization line per run carrying the
 * customer id, address/container counts, computed D1 ops vs
 * `DETAIL_FULL_MAX_D1_OPS`, and cache invalidations vs cap — plus keep the
 * fail-closed over-budget throw.
 *
 * Test-only: no `src/` changes. This suite is RED on current `main` — the
 * success path emits no utilization line — and the Builder card implements
 * the line on this card's branch without editing this file.
 *
 * Canonical contract the Builder implements (field names are exact):
 * - `customerId`: the synced customer id
 * - `addressCount` / `containerCount`: graph shape that was synced
 * - `d1Ops`: `detailFullD1Ops(addressCount, containerCount)` for the run
 * - `d1OpsBudget`: `DETAIL_FULL_MAX_D1_OPS`
 * - `cacheInvalidations`: `detailFullCacheInvalidations(addressCount, containerCount)`
 * - `cacheInvalidationBudget`: `DETAIL_FULL_MAX_CACHE_INVALIDATIONS`
 * The line may travel as a structured object passed to any console method
 * (the `logEvent` shape: `console[level](record)`) or as a JSON string; the
 * finder below accepts either, keyed on the fields above rather than on a
 * particular `msg`/`route` string, so the Builder keeps wording freedom.
 */

const calls: {
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = { customers: [], addresses: [], containers: [] };

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=utilization",
    expiresAtMs: null,
    refreshing: false
  })
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => {}
}));

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async () => {
    const next = behavior.responses.shift();
    return next ? next() : new Response("{}", { status: 200 });
  }
}));

vi.mock("../src/lib/snapshot/upsert", () => ({
  reconcileCustomerChildren: async () => ({ addressIds: [], containerIds: [] })
}));

vi.mock("../src/lib/d1SnapshotSync", () => ({
  upsertCustomerSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.customers.push(rows);
    return { upserted: rows.length };
  },
  upsertAddressSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.addresses.push(rows);
    return { upserted: rows.length };
  },
  upsertContainerSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.containers.push(rows);
    return { upserted: rows.length };
  }
}));

const {
  DETAIL_FULL_MAX_CACHE_INVALIDATIONS,
  DETAIL_FULL_MAX_D1_OPS,
  detailFullCacheInvalidations,
  detailFullD1Ops,
  syncCustomerDetailFullToD1
} = await import("../src/lib/detailFullSync");

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  CUSTOMER_DB: {} as unknown as D1Database
} as unknown as Env;

const sessionStub = {} as unknown as DurableObjectStub;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** 3 addresses; the first carries 2 containers. */
function smallGraph() {
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Util Co", Enabled: true },
    data: [
      {
        PickupAddressID: 1001,
        CustomerID: 5,
        Containers: [
          { ContainerID: 2001, PickupAddressID: 1001 },
          { ContainerID: 2002, PickupAddressID: 1001 }
        ]
      },
      { PickupAddressID: 1002, CustomerID: 5 },
      { PickupAddressID: 1003, CustomerID: 5 }
    ]
  };
}

/** One address carrying `n` containers. */
function containerGraph(n: number) {
  const containers: Array<Record<string, unknown>> = [];
  for (let k = 1; k <= n; k += 1) {
    containers.push({ ContainerID: k, PickupAddressID: 1001 });
  }
  return {
    currentCustomer: { CustomerID: 5 },
    data: [{ PickupAddressID: 1001, CustomerID: 5, Containers: containers }]
  };
}

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
let spies: ConsoleSpy[] = [];

/** Collect every argument passed to the console methods the logger uses. */
function captureConsole(): unknown[][] {
  const collected: unknown[][] = [];
  for (const method of ["info", "log", "warn", "error"] as const) {
    const spy = vi
      .spyOn(console, method)
      .mockImplementation((...args: unknown[]) => {
        collected.push(args);
      });
    spies.push(spy);
  }
  return collected;
}

/** A utilization-line candidate: object record or JSON string carrying the contract fields. */
function asRecord(arg: unknown): Record<string, unknown> | null {
  if (typeof arg === "string") {
    try {
      const parsed: unknown = JSON.parse(arg);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
    return arg as Record<string, unknown>;
  }
  return null;
}

function findUtilizationLines(collected: unknown[][]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const args of collected) {
    for (const arg of args) {
      const rec = asRecord(arg);
      if (
        rec !== null &&
        typeof rec.customerId === "number" &&
        typeof rec.addressCount === "number" &&
        typeof rec.containerCount === "number" &&
        typeof rec.d1Ops === "number" &&
        typeof rec.d1OpsBudget === "number" &&
        typeof rec.cacheInvalidations === "number" &&
        typeof rec.cacheInvalidationBudget === "number"
      ) {
        out.push(rec);
      }
    }
  }
  return out;
}

beforeEach(() => {
  calls.customers = [];
  calls.addresses = [];
  calls.containers = [];
  behavior.responses = [];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

describe("detail-full D1 op-budget utilization logging", () => {
  it("emits one structured JSON utilization line per successful run", async () => {
    // Arrange — 3 addresses + 2 containers: 3 D1 ops, 6 invalidations.
    behavior.responses = [() => json(smallGraph())];
    const collected = captureConsole();

    // Act — the sync itself succeeds; only the utilization line is missing.
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert — prove the run was healthy first, so a failure below can only
    // mean the missing line, not a fixture error.
    expect(result.addressIds).toHaveLength(3);
    expect(result.containerIds).toHaveLength(2);
    expect(calls.customers).toHaveLength(1);
    expect(calls.addresses.flat()).toHaveLength(3);
    expect(calls.containers.flat()).toHaveLength(2);

    const lines = findUtilizationLines(collected);
    expect(lines).toHaveLength(1);
    expect(lines[0].customerId).toBe(5);
    expect(lines[0].addressCount).toBe(3);
    expect(lines[0].containerCount).toBe(2);
    expect(lines[0].d1Ops).toBe(detailFullD1Ops(3, 2));
    expect(lines[0].d1OpsBudget).toBe(DETAIL_FULL_MAX_D1_OPS);
    expect(lines[0].cacheInvalidations).toBe(detailFullCacheInvalidations(3, 2));
    expect(lines[0].cacheInvalidationBudget).toBe(DETAIL_FULL_MAX_CACHE_INVALIDATIONS);
    expect(lines[0].d1Ops as number).toBeLessThanOrEqual(
      lines[0].d1OpsBudget as number
    );
    expect(lines[0].cacheInvalidations as number).toBeLessThanOrEqual(
      lines[0].cacheInvalidationBudget as number
    );
  });

  it("still throws fail-closed over the D1 op budget without writing", async () => {
    // Arrange — 44,851 containers on one address is 901 D1 ops: one container
    // batch past the 900-op budget.
    behavior.responses = [() => json(containerGraph(44_851))];
    captureConsole();

    // Act — the budget is checked before the first upsert, so D1 keeps the
    // last good snapshot instead of a truncated one.
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("901 D1 ops");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });
});
