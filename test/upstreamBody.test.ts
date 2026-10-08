import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { prepareSaveAddressFormBody, prepareSaveContainerFormBody } from "../src/lib/addressContainerSaveForm";
import { clearAntiForgeryTokenCache, resolveSaveCustomerLongFormToken } from "../src/lib/customerSaveAutoToken";
import { fetchGetCustomerDetailFull } from "../src/lib/detailFullSync";
import { httpLogin } from "../src/lib/httpAuth";
import { fetchReportCsvForPath } from "../src/lib/snapshot/reportFetch";
import { readUpstreamText } from "../src/lib/upstreamBody";
import { forwardToUpstream } from "../src/lib/upstreamForward";
import { fetchWithUpstreamTimeout, UpstreamTimeoutError } from "../src/lib/upstreamTimeout";

const originalFetch = globalThis.fetch;
const ORIGIN = "https://upstream.example.test";
const TOKEN = "synthetic-test-token";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const stub = {
  fetch: async () => new Response(JSON.stringify({
    cookieHeader: "synthetic=1",
    expiresAtMs: Date.now() + 600_000,
    refreshing: false
  }))
} as unknown as DurableObjectStub;
const env = {
  SHADOW_API_TOKEN: TOKEN,
  CUSTOMER_SNAPSHOT_SYNC_SECRET: TOKEN,
  CUSTOMER_SAVE_AUTO_TOKEN: "false",
  TARGET_ORIGIN: ORIGIN,
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: `${ORIGIN}/WebRW/Account/Login`,
  UPSTREAM_TIMEOUT_MS: "50",
  UPSTREAM_REPORT_TIMEOUT_MS: "50",
  AUTH_SESSION: { idFromName: () => "synthetic", get: () => stub }
} as unknown as Env;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hangingBody(prefix = "") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (prefix) c.enqueue(new TextEncoder().encode(prefix));
    },
    cancel
  });
  return {
    body,
    cancel,
    close() {
      try { controller.close(); } catch { /* Already canceled. */ }
    }
  };
}

async function withinWatchdog<T>(pending: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("buffered body exceeded 4x budget")), 200);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("bounded upstream text reads", () => {
  it.each([false, true])("cancels pending reads and aborts fetch even when source cancellation hangs (preserve=%s)", async (preserve) => {
    vi.useFakeTimers();
    const stream = hangingBody("partial private upstream text");
    let signal!: AbortSignal;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Response(stream.body, { headers: { "set-cookie": "synthetic=1" } });
    }) as typeof fetch;
    // Goes through the Set-Cookie stripping wrapper: its controller must survive.
    const response = await forwardToUpstream(new Request("http://test.local"), new URL(ORIGIN), null, null);
    expect(response.headers.has("set-cookie")).toBe(false);
    const pending = readUpstreamText(response, 50, preserve).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(51);
    expect(await pending).toBeInstanceOf(UpstreamTimeoutError);
    expect(signal.aborted).toBe(true);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it("gives body consumption a fresh budget after slow headers and preserves exact UTF-8 passthrough bytes", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(
        new ReadableStream<Uint8Array>({ start(c) { controller = c; } })
      )), 40));
    }) as typeof fetch;
    const fetching = fetchWithUpstreamTimeout(ORIGIN, {}, 50);
    await vi.advanceTimersByTimeAsync(40);
    const response = await fetching;
    const reading = readUpstreamText(response, 50, true);
    await vi.advanceTimersByTimeAsync(40);
    const bytes = new TextEncoder().encode('"café"');
    controller.enqueue(bytes.slice(0, 5));
    controller.enqueue(bytes.slice(5));
    controller.close();
    expect(await reading).toBe('"café"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(false);
  });

  it("propagates a body read error unchanged, not as a timeout", async () => {
    const reason = new Error("synthetic read failure");
    const response = new Response(new ReadableStream({ start(c) { c.error(reason); } }));
    await expect(readUpstreamText(response, 50)).rejects.toBe(reason);
  });

  it("handles an absent body without a timer", async () => {
    expect(await readUpstreamText(new Response(null, { status: 204 }), 50)).toBe("");
  });
});

const routes = [
  ["/routeware/customer/customers-read", "{}"],
  ["/routeware/customer/detail-full", "{}"],
  ["/routeware/customer/customer-types-read", "{}"],
  ["/routeware/data/app-settings-get", "{}"],
  ["/routeware/reports/query-request-is-complete", null],
  ["/routeware/customer/save-long-form", "CustomerID=5"],
  ["/routeware/address/save-address-form", "PickupAddressID=5&CustomerID=5"],
  ["/routeware/container/save-container-form", "ContainerID=5&PickupAddressID=5"],
  ["/data/customer", "CustomerID=5"],
  ["/data/address", "PickupAddressID=5&CustomerID=5"],
  ["/data/container", "ContainerID=5&PickupAddressID=5"]
] as const;

describe("root app buffered-body deadline", () => {
  it.each(routes)("immediate JSON headers plus a hanging body returns sanitized 502 without replay: %s", async (path, body) => {
    const stream = hangingBody("private upstream body marker");
    let signal!: AbortSignal;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Response(stream.body, { headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const response = await withinWatchdog(app.fetch(new Request(`http://test.local/api/v1${path}`, {
        method: body === null ? "GET" : "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" },
        body
      }), env, ctx));
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("problem+json");
      const problem = await response.text();
      expect(problem).toContain("Upstream timed out");
      expect(problem).toContain("50ms");
      expect(problem).not.toContain("Retry once");
      expect(problem).toContain("verify the record before resubmitting");
      expect(problem).not.toContain("private upstream body marker");
      expect(problem).not.toContain(ORIGIN);
      expect(signal.aborted).toBe(true);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  });

  it("does not swallow an HTML login-sniff timeout or replay a save", async () => {
    const stream = hangingBody('<input type="password">');
    globalThis.fetch = vi.fn(async () => new Response(stream.body, {
      headers: { "content-type": "text/html" }
    })) as typeof fetch;
    try {
      const response = await withinWatchdog(app.fetch(new Request("http://test.local/api/v1/routeware/customer/save-long-form", {
        method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "CustomerID=5"
      }), env, ctx));
      expect(response.status).toBe(502);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
    } finally { stream.close(); }
  });

  it("returns a JSON body completed below budget byte-for-byte", async () => {
    const text = '{"data":[],"success":true}';
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(text)); c.close(); }, 10); }
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const response = await app.fetch(new Request("http://test.local/api/v1/routeware/customer/customers-read", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}"
    }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("direct buffered consumers and report streaming", () => {
  it.each(["customer", "address", "container"])("bounds a direct %s token-modal body before any save", async (kind) => {
    clearAntiForgeryTokenCache();
    const stream = hangingBody();
    globalThis.fetch = vi.fn(async () => new Response(stream.body, {
      headers: { "content-type": "text/html" }
    })) as typeof fetch;
    const modalEnv = { ...env, CUSTOMER_SAVE_AUTO_TOKEN: "true" } as Env;
    const session = { cookieHeader: "synthetic=1", expiresAtMs: Date.now() + 600_000, refreshing: false };
    const incoming = new Request("http://test.local");
    const body = new TextEncoder().encode("CustomerID=5&PickupAddressID=5&ContainerID=5").buffer;
    try {
      const pending = kind === "customer"
        ? resolveSaveCustomerLongFormToken(modalEnv, session, incoming, new URL(`${ORIGIN}/WebRW/Customer/AddNewLong`), "/Customer/AddNewLong")
        : kind === "address"
          ? prepareSaveAddressFormBody(modalEnv, session, incoming, body, "application/x-www-form-urlencoded")
          : prepareSaveContainerFormBody(modalEnv, session, incoming, body, "application/x-www-form-urlencoded");
      await expect(withinWatchdog<unknown>(pending)).rejects.toBeInstanceOf(UpstreamTimeoutError);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
    } finally { stream.close(); }
  });

  it("bounds the login init-script body without attempting the login POST", async () => {
    const stream = hangingBody();
    let signal!: AbortSignal;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return fetchMock.mock.calls.length === 1
        ? new Response('<script src="/extnet-init-js/ext.axd?abcdef"></script>')
        : new Response(stream.body);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(withinWatchdog(httpLogin({ ...env, LOGIN_USERNAME: "test-user", LOGIN_PASSWORD: "test-password-not-real" })))
        .rejects.toBeInstanceOf(UpstreamTimeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(true);
    } finally { stream.close(); }
  });

  it.each(["detail", "login"])("bounds a direct %s body without replay", async (kind) => {
    const stream = hangingBody();
    globalThis.fetch = vi.fn(async () => new Response(stream.body, {
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
    try {
      const pending = kind === "detail"
        ? fetchGetCustomerDetailFull(env, stub, 5, true)
        : httpLogin({ ...env, LOGIN_USERNAME: "test-user", LOGIN_PASSWORD: "test-password-not-real" });
      await expect(withinWatchdog<unknown>(pending)).rejects.toBeInstanceOf(UpstreamTimeoutError);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
    } finally { stream.close(); }
  });

  it.each(["text/csv", "text/plain"])("leaves a long CSV download without a total-body deadline (%s)", async (contentType) => {
    const text = "id,name\n1,synthetic\n";
    let signal!: AbortSignal;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return new Response(new ReadableStream({
        start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(text)); c.close(); }, 100); }
      }), { headers: { "content-type": contentType } });
    }) as typeof fetch;
    const response = await fetchReportCsvForPath(env, "/WebRW/Reports/SyntheticCsv");
    expect(await response.text()).toBe(text);
    expect(signal.aborted).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
