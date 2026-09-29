import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * `GET /api/v1/data-snapshot/orphans` is wiring over
 * `getSnapshotOrphans`: an auth guard, one query-parameter parse, then
 * delegation. The SQL it delegates to is pinned in
 * `test/snapshotOrphans.test.ts`; this file pins only the layer in between —
 * that the bearer gate holds, that `sampleLimit` reaches the lib call, and
 * that out-of-range values are rejected by the schema before D1 is touched.
 *
 * The route module is fetched directly rather than through `src/app.ts`, so
 * the app-wide `/api/v1/*` gate is out of the picture and only the narrower
 * snapshot-secret check applies.
 */

/** Records every lib call. Reset in `beforeEach`. */
const orphanCalls: Array<{ db: unknown; sampleLimit: unknown }> = [];

/**
 * Plain function, not `vi.fn()`: a spy wrapping a double that rejects records
 * the settled result and turns a deliberate rejection into an unhandled
 * rejection under `@cloudflare/vitest-pool-workers`. Calls are recorded by hand.
 */
vi.mock("../src/lib/d1SnapshotSync", () => ({
  ORPHAN_SAMPLE_LIMIT_DEFAULT: 100,
  ORPHAN_SAMPLE_LIMIT_MAX: 500,
  getSnapshotOrphans: async (db: unknown, sampleLimit: unknown) => {
    orphanCalls.push({ db, sampleLimit });
    return {
      orphanAddresses: { count: 2, sampleIds: [11, 12] },
      orphanContainers: { count: 1, sampleIds: [102] }
    };
  },
  runDataSnapshotSyncChainedHttp: async () => ({
    customer: null,
    address: null,
    container: null
  })
}));

const { dataSnapshotRoutes } = await import("../src/routes/dataSnapshot");

const SECRET = "sync-secret";
const UNAUTHORIZED_TYPE = `${PROBLEM_TYPE_BASE}unauthorized`;

type ProblemBody = { type: string; title: string; status: number; detail?: string };

function makeEnv(db = {}): Env {
  return { CUSTOMER_DB: db, CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET } as unknown as Env;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

async function call(url: string, env: Env = makeEnv(), token: string = SECRET): Promise<Response> {
  return dataSnapshotRoutes.fetch(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    env,
    ctx
  );
}

beforeEach(() => {
  orphanCalls.length = 0;
});

describe("GET /api/v1/data-snapshot/orphans", () => {
  it("returns the lib report verbatim with the default sample limit", async () => {
    // Arrange
    const db = {};
    const env = makeEnv(db as unknown as D1Database);

    // Act
    const res = await call("http://test.local/api/v1/data-snapshot/orphans", env);

    // Assert — default limit 100 reaches the lib, and CUSTOMER_DB (not some
    // other binding) is what gets passed.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orphanAddresses: { count: 2, sampleIds: [11, 12] },
      orphanContainers: { count: 1, sampleIds: [102] }
    });
    expect(orphanCalls).toHaveLength(1);
    expect(orphanCalls[0].db).toBe(db);
    expect(orphanCalls[0].sampleLimit).toBe(100);
  });

  it("passes an explicit sampleLimit through to the lib call", async () => {
    // Arrange / Act
    const res = await call("http://test.local/api/v1/data-snapshot/orphans?sampleLimit=5");

    // Assert
    expect(res.status).toBe(200);
    expect(orphanCalls[0].sampleLimit).toBe(5);
  });

  it("rejects a sampleLimit above the 500 ceiling before touching D1", async () => {
    // Arrange / Act
    const res = await call("http://test.local/api/v1/data-snapshot/orphans?sampleLimit=501");

    // Assert — rejected by the schema, so the lib (and D1) is never reached.
    expect(res.status).toBe(400);
    expect(orphanCalls).toHaveLength(0);
  });

  it("rejects a sampleLimit of zero", async () => {
    // Arrange / Act — `z.int().min(1)`; zero would sample nothing while still
    // costing the count queries.
    const res = await call("http://test.local/api/v1/data-snapshot/orphans?sampleLimit=0");

    // Assert
    expect(res.status).toBe(400);
    expect(orphanCalls).toHaveLength(0);
  });

  it("rejects a non-numeric sampleLimit at the schema", async () => {
    // Arrange / Act
    const res = await call("http://test.local/api/v1/data-snapshot/orphans?sampleLimit=many");

    // Assert
    expect(res.status).toBe(400);
    expect(orphanCalls).toHaveLength(0);
  });

  it("rejects a bearer that is not the sync secret with the pinned 401 body", async () => {
    // Arrange / Act — the same detail string `test/snapshotAuth.test.ts` pins
    // for this route.
    const res = await call(
      "http://test.local/api/v1/data-snapshot/orphans",
      makeEnv(),
      "not-the-secret"
    );

    // Assert
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.title).toBe("Unauthorized");
    expect(body.detail).toBe(
      "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized."
    );
    expect(orphanCalls).toHaveLength(0);
  });
});
