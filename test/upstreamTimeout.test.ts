import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import { forwardToUpstream } from "../src/lib/upstreamForward";
import type { SessionState } from "../src/lib/sessionState";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  REPORT_UPSTREAM_TIMEOUT_MS,
  UpstreamTimeoutError,
  fetchWithUpstreamTimeout,
  isUpstreamTimeout,
  readReportTimeoutMs,
  readUpstreamTimeoutMs,
  upstreamTimeoutProblem
} from "../src/lib/upstreamTimeout";

/**
 * Bounded upstream timeouts (TOG-5835).
 *
 * A hung Routeware host used to hold the Worker until the 300s CPU limit
 * mid-sync. Every Routeware `fetch` now races a per-attempt timer: 15s
 * interactive, 60s report CSV. The single retry stays reserved for the login
 * redirect (provably safe) — a timeout is never retried, so worst case is 2x
 * one attempt, and the client sees 502 problem+json within budget.
 *
 * House pattern (see docs/TEST-INVARIANTS.md § "No test may reach the
 * network"): `globalThis.fetch` is stubbed and restored in `afterEach`.
 * The "hung upstream" is a never-settling promise — the timer race (not
 * abort alone) is what enforces the budget, so a non-abort-aware mock still
 * resolves to the timeout.
 */

const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";
const UPSTREAM = new URL("https://killeen.routeware.com/WebRW/Home/Index");

function freshHolder(cookie = "c=1"): { value: SessionState } {
  return {
    value: { cookieHeader: cookie, expiresAtMs: Date.now() + 600_000, refreshing: false }
  };
}

/** Fake AuthSession Durable Object stub backed by a mutable session holder. */
function makeStub(holder: { value: SessionState }): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/get")) {
        return new Response(JSON.stringify(holder.value), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("OK");
    }
  } as unknown as DurableObjectStub;
}

/** A fetch mock that never settles — the hung-upstream shape. */
function hangForever(): void {
  globalThis.fetch = vi.fn(
    (_input: unknown, _init?: RequestInit) => new Promise<Response>(() => {})
  ) as unknown as typeof fetch;
}

describe("readUpstreamTimeoutMs / readReportTimeoutMs", () => {
  it("defaults to 15s interactive / 60s report", () => {
    expect(readUpstreamTimeoutMs(undefined)).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(readUpstreamTimeoutMs({} as Env)).toBe(15_000);
    expect(readReportTimeoutMs(undefined)).toBe(REPORT_UPSTREAM_TIMEOUT_MS);
    expect(readReportTimeoutMs({} as Env)).toBe(60_000);
  });

  it("honors UPSTREAM_TIMEOUT_MS / UPSTREAM_REPORT_TIMEOUT_MS bindings", () => {
    expect(
      readUpstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: "5000" } as unknown as Env)
    ).toBe(5_000);
    expect(readUpstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: 2000 } as unknown as Env)).toBe(
      2_000
    );
    expect(
      readReportTimeoutMs({ UPSTREAM_REPORT_TIMEOUT_MS: "30000" } as unknown as Env)
    ).toBe(30_000);
  });

  it("falls back on absent/invalid overrides", () => {
    for (const bad of ["", "nope", "-5", "0", NaN, null]) {
      expect(
        readUpstreamTimeoutMs({ UPSTREAM_TIMEOUT_MS: bad } as unknown as Env)
      ).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
      expect(
        readReportTimeoutMs({ UPSTREAM_REPORT_TIMEOUT_MS: bad } as unknown as Env)
      ).toBe(REPORT_UPSTREAM_TIMEOUT_MS);
    }
  });
});

describe("fetchWithUpstreamTimeout", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws UpstreamTimeoutError with the budget when the upstream hangs", async () => {
    // Arrange — the mock never settles; only the 50ms timer can end this.
    hangForever();

    // Act
    const start = Date.now();
    const error = (await fetchWithUpstreamTimeout(
      UPSTREAM.toString(),
      { method: "GET", redirect: "manual" },
      50
    ).catch((e: unknown) => e)) as Error;

    // Assert — fails fast (far under the 30s suite timeout), names the budget.
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect(isUpstreamTimeout(error)).toBe(true);
    expect((error as UpstreamTimeoutError).timeoutMs).toBe(50);
    expect(error.message).toBe("Upstream request timed out after 50ms");
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("passes through a fast upstream response untouched", async () => {
    // Arrange
    globalThis.fetch = vi.fn(
      async () => new Response("fast", { status: 200 })
    ) as unknown as typeof fetch;

    // Act
    const res = await fetchWithUpstreamTimeout(
      UPSTREAM.toString(),
      { method: "GET" },
      5_000
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fast");
  });

  it("rethrows non-timeout fetch failures verbatim", async () => {
    // Arrange — a DNS-style failure, not a hang.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    // Act
    const error = (await fetchWithUpstreamTimeout(
      UPSTREAM.toString(),
      {},
      5_000
    ).catch((e: unknown) => e)) as Error;

    // Assert — not mapped to a timeout.
    expect(error).toBeInstanceOf(TypeError);
    expect(isUpstreamTimeout(error)).toBe(false);
  });

  it("a caller abort with the timer unfired rethrows verbatim (never a 502)", async () => {
    // Arrange — the client disconnects before our timer fires; the fetch
    // rejects with the caller's abort reason.
    const caller = new AbortController();
    globalThis.fetch = vi.fn(
      async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason)
          );
        })
    ) as unknown as typeof fetch;
    const pending = fetchWithUpstreamTimeout(
      UPSTREAM.toString(),
      { signal: caller.signal },
      60_000
    );
    const errorPromise = pending.catch((e: unknown) => e);

    // Act — disconnect now; the 60s timer never fires.
    caller.abort(new Error("client disconnect"));
    const error = (await errorPromise) as Error;

    // Assert — the caller's reason survives; it must not become a timeout.
    expect(isUpstreamTimeout(error)).toBe(false);
    expect(error.message).toBe("client disconnect");
  });
});

describe("upstreamTimeoutProblem", () => {
  it("returns 502 problem+json anchored to bad-gateway, with no PII surface", async () => {
    // Act
    const res = upstreamTimeoutProblem(15_000, "/api/v1/routeware/home/index");

    // Assert
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      instance?: string;
    };
    expect(body.type).toContain("bad-gateway");
    expect(body.title).toBe("Upstream timed out");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("15000ms");
    expect(body.instance).toBe("/api/v1/routeware/home/index");
  });
});

describe("forwardToUpstream timeout", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("a hung upstream throws UpstreamTimeoutError within budget", async () => {
    // Arrange — never-settling upstream, 50ms budget.
    hangForever();
    const incoming = new Request("http://test.local/api/v1/routeware/home/index");

    // Act
    const start = Date.now();
    const error = (await forwardToUpstream(incoming, UPSTREAM, null, null, {
      timeoutMs: 50
    }).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("forwardWithSessionRetry timeout (no retry on hang)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("a hung upstream answers 502 problem+json with exactly one attempt", async () => {
    // Arrange — fresh session (no proactive refresh), hung upstream.
    const holder = freshHolder();
    const establish = vi.fn(async () => {});
    hangForever();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const env = {
      LOGIN_URL,
      UPSTREAM_TIMEOUT_MS: "50"
    } as unknown as Env;

    // Act
    const start = Date.now();
    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://test.local/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — the acceptance shape: 502 problem+json within budget, and the
    // single-retry budget untouched (the timeout is never retried — a retry
    // could double-execute a non-idempotent POST).
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toContain("bad-gateway");
    expect(body.title).toBe("Upstream timed out");
    expect(body.status).toBe(502);
    expect(establish).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("a hang on the retry attempt also answers 502 (still exactly two attempts)", async () => {
    // Arrange — first attempt is a login redirect (triggers the one retry),
    // the retry hangs.
    const holder = freshHolder("old");
    const establish = vi.fn(async () => {
      holder.value = {
        cookieHeader: "fresh",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      };
    });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: LOGIN_URL } });
      }
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const env = { LOGIN_URL, UPSTREAM_TIMEOUT_MS: "50" } as unknown as Env;

    // Act
    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://test.local/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — retry happened once for the redirect, then the hang failed fast.
    expect(res.status).toBe(502);
    expect(establish).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });
});
