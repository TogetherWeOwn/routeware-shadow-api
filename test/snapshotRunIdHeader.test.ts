import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `x-run-id` forwarding at the snapshot sync routes (TOG-19134, round 2).
 *
 * The chained orchestrator sends the run on the `x-run-id` header; each
 * route must hand a UUID-validated value into its runner (so the
 * sub-invocation's skip and R2-archive lines share the run) and drop
 * anything else. The runners are mocked to record their opts; the route
 * modules are real.
 */

type RecordedCall = { route: string; opts: unknown };

const calls: RecordedCall[] = [];

vi.mock("../src/lib/d1SnapshotSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/d1SnapshotSync")>()),
  runCustomerSnapshotSync: async (_env: unknown, opts: unknown) => {
    calls.push({ route: "customer", opts });
    return null;
  },
  runAddressSnapshotSync: async (_env: unknown, opts: unknown) => {
    calls.push({ route: "address", opts });
    return null;
  },
  runContainerSnapshotSync: async (_env: unknown, opts: unknown) => {
    calls.push({ route: "container", opts });
    return null;
  },
  runDataSnapshotSyncChainedHttp: async (
    _origin: string,
    _env: unknown,
    opts: unknown
  ) => {
    calls.push({ route: "combined", opts });
    return { customer: null, address: null, container: null };
  }
}));

const { customerSnapshotRoutes } = await import(
  "../src/routes/customerSnapshot"
);
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { containerSnapshotRoutes } = await import(
  "../src/routes/containerSnapshot"
);
const { dataSnapshotRoutes } = await import("../src/routes/dataSnapshot");

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";
const SECRET = "sync-secret";

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function makeEnv(): Env {
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    CUSTOMER_REPORT_EXPORT_PATH: "https://reports.example.test/customer.csv",
    ADDRESS_REPORT_EXPORT_PATH: "https://reports.example.test/address.csv",
    CONTAINER_REPORT_EXPORT_PATH: "https://reports.example.test/container.csv"
  } as unknown as Env;
}

async function post(
  routes: {
    fetch: (
      req: Request,
      env: Env,
      ctx: ExecutionContext
    ) => Response | Promise<Response>;
  },
  path: string,
  runIdHeader: string | null
): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${SECRET}`);
  if (runIdHeader !== null) {
    headers.set("x-run-id", runIdHeader);
  }
  return routes.fetch(
    new Request(`https://api.example.test${path}`, { method: "POST", headers }),
    makeEnv(),
    ctx
  );
}

beforeEach(() => {
  calls.length = 0;
});

describe("per-table sync routes forward x-run-id", () => {
  const cases = [
    {
      name: "customer",
      routes: () => customerSnapshotRoutes,
      path: "/api/v1/customer-snapshot/sync"
    },
    {
      name: "address",
      routes: () => addressSnapshotRoutes,
      path: "/api/v1/address-snapshot/sync"
    },
    {
      name: "container",
      routes: () => containerSnapshotRoutes,
      path: "/api/v1/container-snapshot/sync"
    }
  ] as const;

  for (const { name, routes, path } of cases) {
    it(`${name}: forwards a valid x-run-id into the runner`, async () => {
      // Act
      const res = await post(routes(), path, RUN_ID);

      // Assert
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        route: name,
        opts: { dryRun: false, runId: RUN_ID }
      });
    });

    it(`${name}: drops a malformed x-run-id and still syncs`, async () => {
      // Act — attacker text must never reach the logs or fail the sync.
      const res = await post(routes(), path, `${RUN_ID}; rm -rf /`);

      // Assert
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ route: name });
      expect(calls[0].opts).toEqual({ dryRun: false });
    });

    it(`${name}: runs unchanged without the header`, async () => {
      // Act
      const res = await post(routes(), path, null);

      // Assert
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].opts).toEqual({ dryRun: false });
    });
  }
});

describe("combined sync route forwards x-run-id", () => {
  it("forwards a valid x-run-id into the chained runner", async () => {
    // Act
    const res = await post(dataSnapshotRoutes, "/api/v1/data-snapshot/sync", RUN_ID);

    // Assert
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      route: "combined",
      opts: { dryRun: false, runId: RUN_ID }
    });
  });

  it("drops a malformed x-run-id and still syncs", async () => {
    // Act
    const res = await post(
      dataSnapshotRoutes,
      "/api/v1/data-snapshot/sync",
      "not-a-uuid"
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ dryRun: false });
  });
});
