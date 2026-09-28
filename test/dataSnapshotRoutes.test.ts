import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * Dedicated route tests for `src/routes/dataSnapshot.ts` (TOG-7387).
 *
 * The route is thin — an auth guard, a secret-configured guard, then
 * delegation to `runDataSnapshotSyncChainedHttp` — but three nearby files
 * each pin only one side of it, leaving the route's own contract uncovered:
 *
 * - `test/snapshotAuth.test.ts` pins the 401 *body* through the full app;
 * - `test/dataRoutes.test.ts` pins the chain *origin* derivation and verbatim
 *   passthrough with a mocked chain;
 * - `test/syncSummaryContract.test.ts` pins the combined *summary shape*
 *   end to end through real D1 and real subrequests.
 *
 * What nothing pinned is this route's full auth matrix (no bearer, wrong
 * bearer, API token vs sync secret, unset/blank secret) and its response
 * shapes (per-table `{upserted, rowCount} | null`, nulls preserved, failures
 * surfaced rather than swallowed) at the route level. That is what this file
 * owns.
 *
 * The route module is fetched directly rather than through `src/app.ts`, so
 * the app-wide `/api/v1/*` gate is out of the picture and only the narrower
 * snapshot-secret check applies — except where a test sets both secrets to
 * prove the inner check rejects the outer gate's API token.
 */

type RecordedCall = { origin: string; env: unknown };

const calls: RecordedCall[] = [];
const behavior: {
  result: unknown;
  error: unknown | null;
} = {
  result: {
    customer: { upserted: 2, rowCount: 2 },
    address: { upserted: 2, rowCount: 2 },
    container: { upserted: 2, rowCount: 2 }
  },
  error: null
};

/**
 * Plain function, not `vi.fn()`: a spy wrapping a double that rejects records
 * the settled result and turns a deliberate rejection into an unhandled
 * rejection under `@cloudflare/vitest-pool-workers`. Calls are recorded by
 * hand, and the throwing path is driven by `behavior.error`.
 */
vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (origin: string, env: unknown) => {
    if (behavior.error) {
      throw behavior.error;
    }
    calls.push({ origin, env });
    return behavior.result;
  }
}));

const { dataSnapshotRoutes } = await import("../src/routes/dataSnapshot");

const SECRET = "sync-secret";
const API_TOKEN = "api-token";
const UNAUTHORIZED_TYPE = `${PROBLEM_TYPE_BASE}unauthorized`;
const MISCONFIGURED_TYPE = `${PROBLEM_TYPE_BASE}misconfigured`;

type ProblemBody = { type: string; title: string; status: number; detail?: string };

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    ...overrides
  } as unknown as Env;
}

async function post(
  url: string,
  env: Env,
  token: string | null = SECRET
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return dataSnapshotRoutes.fetch(
    new Request(url, { method: "POST", headers }),
    env,
    ctx
  );
}

beforeEach(() => {
  calls.length = 0;
  behavior.error = null;
  behavior.result = {
    customer: { upserted: 2, rowCount: 2 },
    address: { upserted: 2, rowCount: 2 },
    container: { upserted: 2, rowCount: 2 }
  };
});

describe("POST /api/v1/data-snapshot/sync auth matrix", () => {
  it("rejects a missing bearer with the inner 401 body and never runs the chain", async () => {
    // Arrange / Act — no Authorization header at all.
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv(), null);

    // Assert — envelope pinned once here (type/title/status); the exact
    // `detail` wording is owned by snapshotAuth.test.ts (canonical since
    // main PR #85), so this file asserts only type + status + chain silence
    // and stays green across wording normalizations.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.title).toBe("Unauthorized");
    expect(body.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects a wrong bearer without running the chain", async () => {
    // Arrange / Act
    const res = await post(
      "http://test.local/api/v1/data-snapshot/sync",
      makeEnv(),
      "not-the-secret"
    );

    // Assert
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects the API token when both secrets are set: the inner check needs the sync secret", async () => {
    // Arrange — the outer gate would accept this token; at the route module
    // level only the inner check runs, and it must say no. (Through the full
    // app this is the 401 snapshotAuth.test.ts pins for this path.)
    const env = makeEnv({ SHADOW_API_TOKEN: API_TOKEN });

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", env, API_TOKEN);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(calls).toHaveLength(0);
  });

  it("accepts the sync secret when both secrets are set and runs the chain once", async () => {
    // Arrange
    const env = makeEnv({ SHADOW_API_TOKEN: API_TOKEN });

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", env, SECRET);

    // Assert — exactly one chained run: the per-table fan-out lives inside
    // the orchestration, not the route.
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe("http://test.local");
    expect(calls[0].env).toBe(env);
  });

  it("answers 401, not 503, when the secret is unset: the auth guard runs first", async () => {
    // Arrange — no sync secret configured at all. The `requireSnapshotSecret`
    // 503 below is unreachable while auth runs first (no bearer can match an
    // unset secret); pinning 401 documents that guard order so a future
    // reorder cannot silently turn unauthenticated calls into 503s.
    const env = makeEnv({ CUSTOMER_SNAPSHOT_SYNC_SECRET: undefined });

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", env, SECRET);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.type).not.toBe(MISCONFIGURED_TYPE);
    expect(calls).toHaveLength(0);
  });

  it("treats a whitespace-only secret as unset", async () => {
    // Arrange — a blank secret in wrangler vars must fail closed, matching the
    // whitespace handling in `getDataSnapshotPlan` and the per-table syncs.
    const env = makeEnv({ CUSTOMER_SNAPSHOT_SYNC_SECRET: "   " });

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", env, SECRET);

    // Assert
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/v1/data-snapshot/sync response shapes", () => {
  it("returns each table's {upserted, rowCount} verbatim as JSON", async () => {
    // Arrange / Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv());

    // Assert — exact body plus exact key sets: a `deleted` count leaking from
    // the per-table syncs would break the combined-summary contract pinned
    // end to end in syncSummaryContract.test.ts.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      customer: Record<string, number>;
      address: Record<string, number>;
      container: Record<string, number>;
    };
    expect(body).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
    expect(Object.keys(body.customer).sort()).toEqual(["rowCount", "upserted"]);
    expect(Object.keys(body.address).sort()).toEqual(["rowCount", "upserted"]);
    expect(Object.keys(body.container).sort()).toEqual(["rowCount", "upserted"]);
  });

  it("strips deleted counts from the chained result: the combined shape stays {upserted, rowCount} (TOG-7391)", async () => {
    // Arrange — the chain now carries per-table `deleted` for the cron line;
    // the combined route must not leak it (shape pinned end to end in
    // syncSummaryContract.test.ts).
    behavior.result = {
      customer: { upserted: 2, rowCount: 2, deleted: 1 },
      address: { upserted: 2, rowCount: 2, deleted: 2 },
      container: { upserted: 2, rowCount: 2, deleted: 0 }
    };

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv());

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
  });

  it("preserves an all-null result: unconfigured tables are null, not zero-row successes", async () => {
    // Arrange — no report source configured upstream: the chain ran, every
    // table was skipped.
    behavior.result = { customer: null, address: null, container: null };

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv());

    // Assert — zeros would read as "synced successfully, upstream is empty"
    // and mask a misconfiguration.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customer: null, address: null, container: null });
  });

  it("preserves a mixed result with the skipped table as null", async () => {
    // Arrange
    behavior.result = {
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 1, rowCount: 1 },
      container: null
    };

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv());

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 1, rowCount: 1 },
      container: null
    });
  });

  it("surfaces a chained failure instead of answering 200", async () => {
    // Arrange — a per-table subrequest failed inside the chain (step, status
    // and truncated body, per the orchestration contract). The route installs
    // no error mapping of its own: Hono catches the rejection and answers
    // 500, and the full app's onError wraps it as `internal` problem+json.
    behavior.error = new Error(
      "[chained customer] POST /api/v1/customer-snapshot/sync → 500: boom"
    );

    // Act
    const res = await post("http://test.local/api/v1/data-snapshot/sync", makeEnv());

    // Assert — must not resolve as a partial 200 with whatever ran so far;
    // the error propagates instead of being swallowed into a 200 body.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/v1/data-snapshot/sync wiring", () => {
  it("keeps the request port in the chain origin and drops the path", async () => {
    // Arrange — local `wrangler dev` serves on a port; dropping it would point
    // the chain at port 80, and keeping the path would 404 every subrequest.
    // Act
    const res = await post(
      "http://test.local:8787/api/v1/data-snapshot/sync",
      makeEnv()
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe("http://test.local:8787");
  });

  it("answers GET with 404 without running the chain: sync is POST-only", async () => {
    // Arrange / Act — a GET must never trigger a mutating chained sync.
    const res = await dataSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/data-snapshot/sync", {
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      makeEnv(),
      ctx
    );

    // Assert
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
