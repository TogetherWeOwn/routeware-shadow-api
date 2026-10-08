import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import type { SessionState } from "../src/lib/sessionState";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import * as customerTokens from "../src/lib/customerSaveAutoToken";

// Post-save D1 synchronization is covered separately; this suite traces forwarding.
vi.mock("../src/lib/detailFullSync", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/detailFullSync")>(),
  syncCustomerDetailFullToD1: async () => ({ addressIds: [], containerIds: [] })
}));

const login = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock("../src/lib/establishSession", () => ({
  isInvalidAuthModeError: () => false,
  establishSession: async (_env: Env, stub: DurableObjectStub) => {
    login.calls += 1;
    if (login.fail) {
      throw new Error("Synthetic login unavailable");
    }
    await stub.fetch("https://auth/set", {
      method: "POST",
      body: JSON.stringify({
        cookieHeader: "session=FAKE-FRESH",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      })
    });
  }
}));

const forms = [
  {
    path: "/api/v1/routeware/customer/save-long-form",
    modal: "/WebRW/Customer/AddNewLong",
    save: "/WebRW/Customer/SaveCustomerLongForm",
    body: "CustomerID=0&Enabled=true"
  },
  {
    path: "/api/v1/routeware/address/save-address-form",
    modal: "/WebRW/PickupAddress/CreateBlankAddress",
    save: "/WebRW/PickupAddress/SaveAddressForm",
    body: "PickupAddressID=0&CustomerID=1"
  },
  {
    path: "/api/v1/routeware/container/save-container-form",
    modal: "/WebRW/Container/CreateBlankContainer",
    save: "/WebRW/Container/SaveContainerForm",
    body: "ContainerID=0&PickupAddressID=1&CustomerID=1"
  }
];

function loginResponse(shape: "redirect" | "html" | "fragment"): Response {
  if (shape === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: "https://upstream.test/WebRW/Account/Login" }
    });
  }
  if (shape === "fragment") {
    return new Response('<form action="/WebRW/Account/Login"><input type="password" /></form>', {
      headers: { "content-type": "text/html" }
    });
  }
  // A login form also carries an anti-forgery token, but it is NOT a save token.
  return new Response(
    '<html><form action="/WebRW/Account/Login"><input name="UserName" />' +
      '<input name="Password" type="password" />' +
      '<input name="__RequestVerificationToken" value="FAKE-LOGIN-TOKEN" /></form></html>',
    { headers: { "content-type": "text/html" } }
  );
}

describe.each(forms)("single-session modal + save: $path", (form) => {
  const originalFetch = globalThis.fetch;
  let session: SessionState;
  let testEnv: Env;
  let sessionStub: DurableObjectStub;
  let reads: number;
  let blocked: boolean;
  let calls: Array<{ hop: "modal" | "save"; cookie: string; token: string | null }>;
  let rotateAfterModal: boolean;
  let rejectedHop: "modal" | "save" | null;
  let rejectionShape: "redirect" | "html" | "fragment";
  let rejectEveryAttempt: boolean;
  let saveStatus: number;
  let hangOnSave: boolean;

  beforeEach(() => {
    if ("clearAntiForgeryTokenCache" in customerTokens && typeof customerTokens.clearAntiForgeryTokenCache === "function") {
      customerTokens.clearAntiForgeryTokenCache();
    }
    login.calls = 0;
    login.fail = false;
    reads = 0;
    blocked = false;
    calls = [];
    rotateAfterModal = false;
    rejectedHop = null;
    rejectionShape = "redirect";
    rejectEveryAttempt = false;
    saveStatus = 200;
    hangOnSave = false;
    session = {
      cookieHeader: "session=FAKE-OLD",
      expiresAtMs: Date.now() + 600_000,
      refreshing: false
    };
    const stub = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        if (path === "/get") {
          reads += 1;
          return Response.json(session);
        }
        if (path === "/set") {
          session = JSON.parse(String(init?.body)) as SessionState;
          return new Response("OK");
        }
        if (path === "/throttle/failure" || path === "/throttle/clear") {
          return Response.json({ blocked, retryAfterSec: blocked ? 60 : 0 });
        }
        throw new Error(`Unexpected session operation: ${path}`);
      }
    };
    sessionStub = stub as unknown as DurableObjectStub;
    testEnv = {
      SHADOW_API_TOKEN: "test-api-token",
      TARGET_ORIGIN: "https://upstream.test",
      TARGET_BASE_PATH: "/WebRW",
      LOGIN_URL: "https://upstream.test/WebRW/Account/Login",
      SESSION_TTL_SECONDS: 1800,
      CUSTOMER_SAVE_AUTO_TOKEN: "true",
      AUTH_SESSION: { idFromName: (name: string) => name, get: () => stub }
    } as unknown as Env;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      const cookie = headers.get("cookie") ?? "";
      const hop = url.pathname === form.modal ? "modal" : url.pathname === form.save ? "save" : null;
      if (url.origin !== "https://upstream.test" || !hop) {
        throw new Error(`Unexpected upstream operation: ${url.pathname}`);
      }
      const token = hop === "save"
        ? new URLSearchParams(new TextDecoder().decode(init?.body as ArrayBuffer)).get("__RequestVerificationToken")
        : null;
      calls.push({ hop, cookie, token });
      expect(headers.get("X-Routeware-Shadow-Internal")).toBe(hop === "modal" ? "anti-forgery-modal" : null);
      if (hop === rejectedHop && (rejectEveryAttempt || cookie === "session=FAKE-OLD")) {
        return loginResponse(rejectionShape);
      }
      if (hop === "modal") {
        if (rotateAfterModal) {
          session = { ...session, cookieHeader: "session=FAKE-ROTATED" };
        }
        return new Response(`<input name="__RequestVerificationToken" value="FAKE-TOKEN-${cookie}" />`, {
          headers: { "content-type": "text/html" }
        });
      }
      if (hangOnSave) {
        return new Promise<Response>(() => {});
      }
      if (saveStatus !== 200) {
        return new Response("FAKE-UPSTREAM-ERROR", {
          status: saveStatus,
          headers: { "retry-after": "7", "x-upstream-debug": "FAKE-UPSTREAM-ERROR" }
        });
      }
      const matchesSession = token === `FAKE-TOKEN-${cookie}`;
      return new Response(matchesSession ? '{"success":true}' : "<html>Save rejected</html>", {
        headers: { "content-type": matchesSession ? "application/json" : "text/html" }
      });
    }) as typeof fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  function save(authorization = "Bearer test-api-token", body = form.body): Promise<Response> {
    return Promise.resolve(app.fetch(new Request(`http://test.local${form.path}`, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body
    }), testEnv));
  }

  it("pins the modal session even when another request rotates the DO before save", async () => {
    rotateAfterModal = true;
    const response = await save();
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { hop: "modal", cookie: "session=FAKE-OLD", token: null },
      { hop: "save", cookie: "session=FAKE-OLD", token: "FAKE-TOKEN-session=FAKE-OLD" }
    ]);
    expect(reads).toBe(1);
    expect(login.calls).toBe(0);
  });

  it("refreshes an expiring session before fetching its modal token", async () => {
    session.expiresAtMs = Date.now() - 1;
    const response = await save();
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.cookie)).toEqual(["session=FAKE-FRESH", "session=FAKE-FRESH"]);
    expect(login.calls).toBe(1);
  });

  it.each(["redirect", "html"] as const)("re-prepares the original form after a save %s login rejection", async (shape) => {
    rejectedHop = "save";
    rejectionShape = shape;
    const response = await save();
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { hop: "modal", cookie: "session=FAKE-OLD", token: null },
      { hop: "save", cookie: "session=FAKE-OLD", token: "FAKE-TOKEN-session=FAKE-OLD" },
      { hop: "modal", cookie: "session=FAKE-FRESH", token: null },
      { hop: "save", cookie: "session=FAKE-FRESH", token: "FAKE-TOKEN-session=FAKE-FRESH" }
    ]);
    expect(login.calls).toBe(1);
  });

  it.each(["redirect", "html"] as const)("heals a modal %s login rejection before sending any save", async (shape) => {
    rejectedHop = "modal";
    rejectionShape = shape;
    const response = await save();
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { hop: "modal", cookie: "session=FAKE-OLD", token: null },
      { hop: "modal", cookie: "session=FAKE-FRESH", token: null },
      { hop: "save", cookie: "session=FAKE-FRESH", token: "FAKE-TOKEN-session=FAKE-FRESH" }
    ]);
    expect(login.calls).toBe(1);
  });

  it("fails closed when the modal retry also returns a login page", async () => {
    rejectedHop = "modal";
    rejectionShape = "html";
    rejectEveryAttempt = true;
    const response = await save();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(calls.map((call) => call.hop)).toEqual(["modal", "modal"]);
    expect(login.calls).toBe(1);
  });

  it("keeps modal recovery login failures on the preparation 502 path", async () => {
    rejectedHop = "modal";
    login.fail = true;
    const response = await save();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(calls.map((call) => call.hop)).toEqual(["modal"]);
    expect(login.calls).toBe(1);
  });

  it("keeps proactive preparation login failures on the 502 path", async () => {
    session.expiresAtMs = Date.now() - 1;
    login.fail = true;
    const response = await save();
    expect(response.status).toBe(502);
    expect(calls).toEqual([]);
    expect(login.calls).toBe(1);
  });

  it.each(["InvalidAuthModeError", "MissingSetCookieCapabilityError", "LoginPageUnavailableError"])(
    "preserves %s for the application-level status mapping", async (name) => {
      session.expiresAtMs = Date.now() - 1;
      const error = new Error("Synthetic configuration failure");
      error.name = name;
      const original = new TextEncoder().encode(form.body).buffer;
      await expect(forwardWithSessionRetry(
        testEnv, sessionStub, new Request(`http://test.local${form.path}`, { method: "POST" }),
        new URL(`https://upstream.test${form.save}`), original,
        async () => { throw error; },
        { prepareBody: async (_session, body) => body }
      )).rejects.toBe(error);
      expect(calls).toEqual([]);
    }
  );

  it("does not report a retried login fragment as a successful save", async () => {
    rejectedHop = "save";
    rejectionShape = "fragment";
    rejectEveryAttempt = true;
    const response = await save();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(calls.map((call) => call.hop)).toEqual(["modal", "save", "modal", "save"]);
    expect(login.calls).toBe(1);
  });

  if (!form.path.includes("/customer/")) {
    it("validates missing create parents before any session or login operation", async () => {
      session.expiresAtMs = Date.now() - 1;
      login.fail = true;
      const body = form.path.includes("/address/") ? "PickupAddressID=0" : "ContainerID=0";
      const response = await save("Bearer test-api-token", body);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(calls).toEqual([]);
      expect(reads).toBe(0);
      expect(login.calls).toBe(0);
    });
  }

  it.each([401, 429, 503])("contains upstream %i without refresh or retry", async (status) => {
    saveStatus = status;
    const response = await save();
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-upstream-debug")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { type: string };
    expect(body.type).toMatch(/#upstream-error$/);
    expect(JSON.stringify(body)).not.toContain("FAKE-UPSTREAM-ERROR");
    expect(calls).toEqual([
      { hop: "modal", cookie: "session=FAKE-OLD", token: null },
      { hop: "save", cookie: "session=FAKE-OLD", token: "FAKE-TOKEN-session=FAKE-OLD" }
    ]);
    expect(login.calls).toBe(0);
  });

  it.each([401, 429, 503])("contains upstream %i after re-preparing on the fresh session", async (status) => {
    saveStatus = status;
    rejectedHop = "save";
    rotateAfterModal = true;
    const response = await save();
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-upstream-debug")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { type: string };
    expect(body.type).toMatch(/#upstream-error$/);
    expect(JSON.stringify(body)).not.toContain("FAKE-UPSTREAM-ERROR");
    expect(calls).toEqual([
      { hop: "modal", cookie: "session=FAKE-OLD", token: null },
      { hop: "save", cookie: "session=FAKE-OLD", token: "FAKE-TOKEN-session=FAKE-OLD" },
      { hop: "modal", cookie: "session=FAKE-FRESH", token: null },
      { hop: "save", cookie: "session=FAKE-FRESH", token: "FAKE-TOKEN-session=FAKE-FRESH" }
    ]);
    expect(login.calls).toBe(1);
  });

  it("never replays a timed-out save", async () => {
    testEnv = { ...testEnv, UPSTREAM_TIMEOUT_MS: "25" } as Env;
    hangOnSave = true;
    const response = await save();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(calls.map((call) => call.hop)).toEqual(["modal", "save"]);
    expect(login.calls).toBe(0);
  });

  it.each([false, true])("keeps the bearer gate ahead of token/session reads (blocked=%s)", async (throttled) => {
    blocked = throttled;
    const response = await save("Bearer FAKE-WRONG");
    expect(response.status).toBe(throttled ? 429 : 401);
    expect(calls).toEqual([]);
    expect(reads).toBe(0);
    expect(login.calls).toBe(0);
  });
});
