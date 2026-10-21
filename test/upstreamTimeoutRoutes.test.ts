/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { fetchGetCustomerDetailFull } from "../src/lib/detailFullSync";
import {
  clearAntiForgeryTokenCache,
  resolveSaveCustomerLongFormToken
} from "../src/lib/customerSaveAutoToken";
import { prepareSaveAddressFormBody } from "../src/lib/addressContainerSaveForm";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import type { SessionState } from "../src/lib/sessionState";
import { UpstreamTimeoutError } from "../src/lib/upstreamTimeout";
import { routewareRoutes } from "../src/routes/routeware";

/**
 * Per-route upstream timeout wiring.
 *
 * Gap G3: `src/lib/upstreamTimeout.ts` existed and the central forwarders
 * (`forwardToUpstream`, `forwardWithSessionRetry`) raced every Routeware fetch
 * against a timer — but four direct `forwardToUpstream` callers passed no
 * `timeoutMs`, silently ignoring the per-deploy `UPSTREAM_TIMEOUT_MS`
 * override and falling back to the 15s default: the sessionless login-page
 * probe, `fetchGetCustomerDetailFull`, and the two anti-forgery modal direct
 * paths (customer long-form, address/container). They now pass
 * `readUpstreamTimeoutMs(env)`.
 *
 * Behavior pins (hung upstream = never-settling mock, tiny override budget):
 * each fixed path throws `UpstreamTimeoutError` carrying the OVERRIDE budget
 * (not the 15s default) far inside the suite timeout — proving the override
 * is honored, not just that some timer exists. The elapsed assertion is the
 * load-bearing one: with the default 15s budget these would take 15s, well
 * past the 5s ceiling.
 *
 * Wiring pins (source scan, same `?raw` pattern as
 * `test/problemsAnchorCoverage.test.ts` — the suite runs inside the workers
 * pool with no `node:fs`): every direct `forwardToUpstream` call passes an
 * explicit `timeoutMs`, the retry helper owns the interactive override, the
 * login helper passes a budget on all three fetches, and no bare `fetch(`
 * reaches Routeware outside `fetchWithUpstreamTimeout`.
 *
 * House pattern (see docs/TEST-INVARIANTS.md § "No test may reach the
 * network"): `globalThis.fetch` is stubbed and restored in `afterEach`.
 */

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;
const FOREIGN_ORIGIN = "https://app.example.com";

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function freshSession(cookie = "c=1"): SessionState {
  return {
    cookieHeader: cookie,
    expiresAtMs: Date.now() + 600_000,
    refreshing: false
  };
}

/** A fetch mock that never settles — the hung-upstream shape. */
function hangForever(): void {
  globalThis.fetch = vi.fn(
    (_input: unknown, _init?: RequestInit) => new Promise<Response>(() => {})
  ) as unknown as typeof fetch;
}

/** Fake AuthSession DO stub serving one fixed session. */
function fakeSessionStub(session: SessionState): DurableObjectStub {
  return {
    fetch: async () =>
      new Response(JSON.stringify(session), {
        headers: { "content-type": "application/json" }
      })
  } as unknown as DurableObjectStub;
}

describe("fixed paths honor UPSTREAM_TIMEOUT_MS on a hang", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAntiForgeryTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("login-page probe aborts on the override budget, not the 15s default", async () => {
    // Arrange — hung upstream, 50ms override (default would take 15s).
    hangForever();
    const env = { LOGIN_URL, UPSTREAM_TIMEOUT_MS: "50" } as unknown as Env;

    // Act — the route module has no `onError`, so Hono's default handler
    // converts the throw into a 500 (production `app.onError` maps it to
    // 502 — pinned in `test/upstreamTimeout.test.ts` via the retry helper).
    const start = Date.now();
    const res = await routewareRoutes.fetch(
      new Request("http://test.local/api/v1/routeware/account/login-page"),
      env,
      ctx
    );
    const elapsed = Date.now() - start;

    // Assert — answered fast, not after the 15s default: the elapsed
    // assertion is the load-bearing pin (pre-fix this takes 15s).
    expect(res.status).toBe(500);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("fetchGetCustomerDetailFull aborts on the override budget", async () => {
    // Arrange — hung upstream, 60ms override.
    hangForever();
    const env = {
      TARGET_ORIGIN: ORIGIN,
      TARGET_BASE_PATH: BASE,
      LOGIN_URL,
      UPSTREAM_TIMEOUT_MS: "60"
    } as unknown as Env;

    // Act
    const start = Date.now();
    const error = (await fetchGetCustomerDetailFull(
      env,
      fakeSessionStub(freshSession()),
      5,
      true
    ).catch((e: unknown) => e)) as Error;

    // Assert — throws before any login retry is even considered.
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect((error as UpstreamTimeoutError).timeoutMs).toBe(60);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("address modal direct path aborts on the override budget, single attempt", async () => {
    // Arrange — urlencoded create body with no token forces the modal GET;
    // no retry context, so the direct `forwardToUpstream` path runs.
    hangForever();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const env = {
      TARGET_ORIGIN: ORIGIN,
      TARGET_BASE_PATH: BASE,
      CUSTOMER_SAVE_AUTO_TOKEN: "true",
      UPSTREAM_TIMEOUT_MS: "55"
    } as unknown as Env;
    const body = new TextEncoder().encode("PickupAddressID=0&CustomerID=5").buffer;
    const incoming = new Request("http://test.local/api/v1/routeware/address/save-address-form");

    // Act
    const start = Date.now();
    const error = (await prepareSaveAddressFormBody(
      env,
      freshSession("addr-modal"),
      incoming,
      body,
      "application/x-www-form-urlencoded"
    ).catch((e: unknown) => e)) as Error;

    // Assert — override budget, exactly one upstream attempt.
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect((error as UpstreamTimeoutError).timeoutMs).toBe(55);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("customer modal direct path aborts on the override budget, single attempt", async () => {
    // Arrange — no retry context, so the direct `forwardToUpstream` path runs.
    hangForever();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const env = {
      TARGET_ORIGIN: ORIGIN,
      TARGET_BASE_PATH: BASE,
      CUSTOMER_SAVE_AUTO_TOKEN: "true",
      UPSTREAM_TIMEOUT_MS: "55"
    } as unknown as Env;
    const incoming = new Request("http://test.local/api/v1/routeware/customer/save-long-form");
    const modalUrl = new URL(`${ORIGIN}${BASE}/Customer/AddNewLong`);

    // Act
    const start = Date.now();
    const error = (await resolveSaveCustomerLongFormToken(
      env,
      freshSession("cust-modal"),
      incoming,
      modalUrl,
      "/Customer/AddNewLong"
    ).catch((e: unknown) => e)) as Error;

    // Assert — override budget, exactly one upstream attempt.
    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect((error as UpstreamTimeoutError).timeoutMs).toBe(55);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

/**
 * Synthetic env for direct `app.fetch` calls to the sessionless login-page
 * probe: drives the full route → direct forward → onError path with a hung
 * upstream. The probe never touches the session lock; the AUTH_SESSION stub
 * only serves the bearer gate's throttle-clear and the middleware's
 * sessionStub placeholder.
 */
function timeoutAppEnv(): Env {
  const stub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/throttle/clear" || path === "/throttle/failure") {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (path === "/get") {
        return Response.json({ cookieHeader: null, expiresAtMs: null, refreshing: false });
      }
      return new Response("Not Found", { status: 404 });
    }
  };
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (_id: string) => stub
  };
  return {
    LOGIN_URL,
    UPSTREAM_TIMEOUT_MS: "50",
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    SHADOW_API_TOKEN: "test-api-token",
    AUTH_SESSION
  } as unknown as Env;
}

describe("app onError 502 on login-page timeout (direct-forwarder backstop)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps a hung login-page probe to 502 with API posture via withCors", async () => {
    // Arrange — hung upstream, 50ms override (default would take 15s).
    hangForever();
    const req = new Request("http://test.local/api/v1/routeware/account/login-page", {
      headers: {
        authorization: "Bearer test-api-token",
        Origin: FOREIGN_ORIGIN
      }
    });

    // Act — via app.fetch so app.onError (not Hono's default) maps the
    // UpstreamTimeoutError throw from the direct forwardToUpstream caller.
    const start = Date.now();
    const res = await app.fetch(req, timeoutAppEnv(), ctx);
    const elapsed = Date.now() - start;

    // Assert — 502 problem+json naming the override budget (branch proof),
    // plus the full API posture via the onError withCors branch — otherwise
    // a browser sees a CORS error instead of the real 502.
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expect(res.headers.get("vary")).toMatch(/origin/i);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
    };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
    expect(body.title).toBe("Upstream timed out");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("50ms");
    expect(elapsed).toBeLessThan(5_000);
  });
});

// Same ?raw-bundling pattern as problemsAnchorCoverage.test.ts: the suite runs
// inside the workers pool (no node:fs), so repo text is read through Vite.
const srcModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

/** Raw spans of `name(` calls with balanced parens (strings/comments skipped). */
function callSpans(text: string, name: string): string[] {
  const spans: string[] = [];
  const needle = `${name}(`;
  let i = 0;
  while (true) {
    const start = text.indexOf(needle, i);
    if (start === -1) {
      break;
    }
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const prefix = text.slice(lineStart, start).trim();
    if (
      prefix.startsWith("import ") ||
      prefix.startsWith("//") ||
      prefix.startsWith("*") ||
      prefix.endsWith("function")
    ) {
      i = start + needle.length;
      continue;
    }
    let depth = 0;
    let inStr: string | null = null;
    let j = start + needle.length - 1;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (ch === inStr && text[j - 1] !== "\\") {
          inStr = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "/" && text[j + 1] === "/") {
        const nl = text.indexOf("\n", j);
        j = nl === -1 ? text.length : nl;
        continue;
      }
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    spans.push(text.slice(start, j + 1));
    i = j + 1;
  }
  return spans;
}

describe("source wiring: every upstream fetch takes the timeout signal", () => {
  it("every direct forwardToUpstream call passes an explicit timeoutMs", () => {
    // Arrange — the two forwarders own the budget themselves:
    // `forwardWithSessionRetry` builds it from `readUpstreamTimeoutMs(env)`
    // (asserted below); `upstreamForward` applies the default when no
    // explicit budget arrives.
    const owners = new Set([
      "../src/lib/forwardWithSessionRetry.ts",
      "../src/lib/upstreamForward.ts"
    ]);

    // Act
    const missing: string[] = [];
    for (const [path, text] of Object.entries(srcModules)) {
      if (owners.has(path)) {
        continue;
      }
      for (const span of callSpans(text, "forwardToUpstream")) {
        if (!span.includes("timeoutMs")) {
          missing.push(`${path}: ${span.slice(0, 80)}…`);
        }
      }
    }

    // Assert — a direct caller without `timeoutMs` silently drops the
    // per-deploy override (the gap class).
    expect(missing).toEqual([]);
  });

  it("forwardWithSessionRetry owns the interactive override for every retry path", () => {
    // Arrange
    const text = srcModules["../src/lib/forwardWithSessionRetry.ts"] ?? "";

    // Act / Assert — the budget is read once from env and threaded into both
    // the first attempt and the login-redirect retry via `forwardOpts`.
    expect(text).toContain("readUpstreamTimeoutMs");
    expect(text).toContain("timeoutMs");
  });

  it("httpAuth passes a budget on all three login fetches", () => {
    // Arrange
    const text = srcModules["../src/lib/httpAuth.ts"] ?? "";

    // Act
    const spans = callSpans(text, "fetchWithUpstreamTimeout");

    // Assert — login-page GET, Ext.NET init GET, login POST.
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span).toContain("timeoutMs");
    }
  });

  it("no bare fetch reaches Routeware outside fetchWithUpstreamTimeout", () => {
    // Arrange — sanctioned bare fetches: the timer's own abortable fetch
    // (`upstreamTimeout.ts`) and the Worker-to-Worker chained self-fetch to
    // its own public URL (`snapshot/orchestration.ts`, not a Routeware host).
    const allowed = new Set([
      "../src/lib/upstreamTimeout.ts",
      "../src/lib/snapshot/orchestration.ts"
    ]);

    // Act
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(srcModules)) {
      if (allowed.has(path)) {
        continue;
      }
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          /async\s+fetch\s*\(/.test(line)
        ) {
          return;
        }
        if (/(?<![\w$.])fetch\s*\(/.test(line)) {
          offenders.push(`${path}:${idx + 1}: ${trimmed.slice(0, 80)}`);
        }
      });
    }

    // Assert
    expect(offenders).toEqual([]);
  });
});
