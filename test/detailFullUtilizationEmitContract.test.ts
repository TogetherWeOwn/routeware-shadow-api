import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-25212 emit-contract pin (builder companion, non-acceptance file).
 *
 * `test/detailFullOpBudgetUtilization.test.ts` is the Test Author's
 * acceptance file and stays untouched. This file pins the other half of its
 * contract: every failure/refusal path emits ZERO utilization lines.
 *
 * Kills the three surviving mutants on the reviewed head: logEvent moved to
 * (a) before the first upsert, (b) before `reconcileCustomerChildren`, (c)
 * after `const invalidations` but before the cache-budget throw — each would
 * emit a line for a failed/refused run, the opposite of the documented
 * "one line per successful run, no line on refusal" behaviour.
 */

const calls: {
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = { customers: [], addresses: [], containers: [] };

const faults = { failCustomerUpsert: false, failReconcile: false };
const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=utilization-contract",
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
  reconcileCustomerChildren: async () => {
    if (faults.failReconcile) throw new Error("reconcile boom");
    return { addressIds: [], containerIds: [] };
  }
}));

vi.mock("../src/lib/d1SnapshotSync", () => ({
  upsertCustomerSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    if (faults.failCustomerUpsert) throw new Error("customer upsert boom");
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
  faults.failCustomerUpsert = false;
  faults.failReconcile = false;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

describe("detail-full utilization emit contract (failure paths emit no line)", () => {
  it("emits no line when the customer upsert throws", async () => {
    behavior.responses = [() => json(smallGraph())];
    faults.failCustomerUpsert = true;
    const collected = captureConsole();

    await expect(syncCustomerDetailFullToD1(env, sessionStub, 5)).rejects.toThrow(
      "customer upsert boom"
    );
    expect(findUtilizationLines(collected)).toHaveLength(0);
  });

  it("emits no line when child reconciliation throws", async () => {
    behavior.responses = [() => json(smallGraph())];
    faults.failReconcile = true;
    const collected = captureConsole();

    await expect(syncCustomerDetailFullToD1(env, sessionStub, 5)).rejects.toThrow(
      "reconcile boom"
    );
    // Writes happened, but the run did not succeed — still no line.
    expect(calls.customers).toHaveLength(1);
    expect(findUtilizationLines(collected)).toHaveLength(0);
  });

  it("emits no line and writes nothing over the cache-invalidation budget", async () => {
    // 1 address + 950 containers: 952 invalidations > 950 cap, but only
    // ~22 D1 ops, so the cache guard (not the D1 guard) refuses the run.
    behavior.responses = [() => json(containerGraph(950))];
    const collected = captureConsole();

    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("cache invalidations");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
    expect(findUtilizationLines(collected)).toHaveLength(0);
    expect(DETAIL_FULL_MAX_CACHE_INVALIDATIONS).toBe(950);
  });

  it("emits no line and writes nothing over the D1 op budget", async () => {
    // 44,851 containers on one address is 901 D1 ops: one container batch
    // past the 900-op budget (mirrors the acceptance over-budget graph, but
    // asserts the zero-line half the acceptance file does not pin).
    behavior.responses = [() => json(containerGraph(44_851))];
    const collected = captureConsole();

    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
    expect(findUtilizationLines(collected)).toHaveLength(0);
    expect(DETAIL_FULL_MAX_D1_OPS).toBe(900);
  });
});
