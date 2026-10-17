import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The 07:00 thunder-herd regression pin.
 *
 * The three chained cron invocations (customer → address → container) share
 * one AuthSession DO (`idFromName("primary")`) and expire together, so on
 * expiry all three observe a login redirect and race to re-authenticate.
 * Both cron entry points — `fetchReportCsvForPath`
 * (`src/lib/snapshot/reportFetch.ts`) and `fetchReportCsvByQueryId`
 * (`src/lib/routewareQueryReportCsv.ts`) — re-login through `establishSession`,
 * which serializes on the DO refresh lock (`/lock`, `src/authSession.do.ts`).
 * This test expires the session across three concurrent syncs (stubbed) and
 * counts exactly one upstream login and one `/set`.
 *
 * Only `src/lib/httpAuth` is mocked (per `test/establishSession.test.ts`: the
 * login is stubbed but publishes through the REAL `storeSession`, so the
 * lock wiring is exercised, not reimplemented). The fetch mock serves CSV
 * only for the two report shapes and returns the silent-expiry signal (302 →
 * `/Account/Login`) for the stale cookie, so no test can reach the network.
 */

const counters = vi.hoisted(() => ({ httpLogins: 0, sets: 0 }));

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    counters.httpLogins += 1;
    // Hold the login briefly so all three first-wave forwards land (and
    // observe the redirect) before the fresh session is published.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=fresh", Date.now() + 600_000, lockToken);
  })
}));

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => {
    throw new Error("browser login must not run during the http-mode thunder-herd test");
  })
}));

const { fetchReportCsvForPath } = await import("../src/lib/snapshot/reportFetch");
const { fetchReportCsvByQueryId } = await import("../src/lib/routewareQueryReportCsv");

const LOGIN_URL = "https://killeen.example.test/WebRW/Account/Login";
const CSV = "id,name\n1,Acme\n";

/** Must match LOCK_TTL_MS in src/authSession.do.ts. */
const LOCK_TTL_MS = 120_000;

type LockState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
  lockedAt: number | null;
  lockToken: string | null;
};

/**
 * Durable Object stub fake implementing the real /lock, /takeover, /unlock,
 * /set, /get semantics, including the LOCK_TTL_MS stale-lock expiry and the
 * lock-token owner check — matching `AuthSession` (same shape as
 * `test/establishSession.test.ts`).
 */
function fakeStub(state: LockState): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw).pathname;
      if (path === "/lock" || path === "/takeover") {
        const now = Date.now();
        const heldAndFresh =
          state.refreshing === true &&
          typeof state.lockedAt === "number" &&
          now - state.lockedAt < LOCK_TTL_MS;
        if (heldAndFresh) {
          return new Response("LOCKED", { status: 423 });
        }
        state.refreshing = true;
        state.lockedAt = now;
        state.lockToken = `synthetic-lock-token-${now}`;
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock") {
        if (state.refreshing === true) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { lockToken?: unknown };
          if (typeof state.lockToken !== "string" || body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        state.refreshing = false;
        state.lockedAt = null;
        state.lockToken = null;
        return new Response("OK");
      }
      if (path === "/set") {
        counters.sets += 1;
        const body = JSON.parse(String(init?.body)) as {
          cookieHeader: string;
          expiresAtMs: number;
          lockToken?: unknown;
        };
        state.cookieHeader = body.cookieHeader;
        state.expiresAtMs = body.expiresAtMs;
        if (state.refreshing !== true || body.lockToken === state.lockToken) {
          state.refreshing = false;
          state.lockedAt = null;
          state.lockToken = null;
        }
        return new Response("OK");
      }
      if (path === "/get") {
        return Response.json({
          cookieHeader: state.cookieHeader,
          expiresAtMs: state.expiresAtMs,
          refreshing: state.refreshing
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

function makeEnv(stub: DurableObjectStub): Env {
  return {
    TARGET_ORIGIN: "https://killeen.example.test",
    TARGET_BASE_PATH: "/WebRW",
    LOGIN_URL,
    AUTH_MODE: "http",
    AUTH_SESSION: {
      idFromName: () => ({}) as unknown as DurableObjectId,
      get: () => stub
    }
  } as unknown as Env;
}

describe("cron login thunder-herd", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    // The query-id leg polls QueryRequestIsComplete before its
    // download. The poll answers "true" on a fresh session — stale still 302s
    // so the query-id leg joins the herd instead of bypassing it.
    const isPoll = String(url).includes("QueryRequestIsComplete");
    if (cookie.includes(".WebRW=fresh")) {
      return new Response(isPoll ? "true" : CSV, {
        status: 200,
        headers: { "content-type": isPoll ? "application/json" : "text/csv" }
      });
    }
    return new Response("", { status: 302, headers: { location: LOGIN_URL } });
  });

  beforeEach(() => {
    counters.httpLogins = 0;
    counters.sets = 0;
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("three concurrent expired-session syncs drive exactly one login", async () => {
    // Arrange — one shared "primary" session, now expired, as the 07:00 cron
    // leaves it: all three chained invocations will see a login redirect.
    const state: LockState = {
      cookieHeader: ".WebRW=stale",
      expiresAtMs: Date.now() - 1_000,
      refreshing: false,
      lockedAt: null,
      lockToken: null
    };
    const env = makeEnv(fakeStub(state));

    // Act — the three chained steps race: two path exports and one query-ID
    // export, covering both cron entry points in one storm.
    const results = await Promise.all([
      fetchReportCsvForPath(env, "/WebRW/Reports/Customer.csv"),
      fetchReportCsvForPath(env, "/WebRW/Reports/Address.csv"),
      fetchReportCsvByQueryId(env, "23")
    ]);

    // Assert — the refresh lock collapsed the storm into a single upstream
    // login and a single /set; every step retried exactly once (3 stale
    // forwards + 4 fresh forwards — the query-id leg's extra forward is its
    // completion poll) and all three landed 200 with CSV.
    expect(counters.httpLogins).toBe(1);
    expect(counters.sets).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(state.cookieHeader).toBe(".WebRW=fresh");
    for (const res of results) {
      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toBe(CSV);
    }
  });
});
