import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardPassthrough } from "../src/lib/forwardPassthrough";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import { UpstreamTimeoutError } from "../src/lib/upstreamTimeout";
import { ConcurrentRefreshTimeoutError } from "../src/lib/sessionRefreshLock";

const env = { LOGIN_URL: "https://upstream.invalid/WebRW/Account/Login" } as unknown as Env;
const stub = {
  fetch: async () => Response.json({
    cookieHeader: "synthetic-cookie",
    expiresAtMs: Date.now() + 600_000,
    refreshing: false
  })
} as unknown as DurableObjectStub;
const incoming = new Request("http://test.local/api/v1/routeware/home/index");
const upstream = new URL("https://upstream.invalid/WebRW/Home/Index");

describe("passthrough boundary compatibility", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("leaves internal consumers' raw error diagnostics intact", async () => {
    globalThis.fetch = vi.fn(async () => new Response("synthetic upstream diagnostics", {
      status: 503,
      statusText: "Synthetic status",
      headers: { "content-type": "text/plain", "x-upstream-debug": "synthetic" }
    })) as typeof fetch;
    const establish = vi.fn(async () => {});
    const response = await forwardWithSessionRetry(env, stub, incoming, upstream, null, establish);
    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Synthetic status");
    expect(response.headers.get("x-upstream-debug")).toBe("synthetic");
    expect(await response.text()).toBe("synthetic upstream diagnostics");
    expect(establish).not.toHaveBeenCalled();
  });

  it.each([404, 410])("keeps sanitized HTTP %i errors out of caches", async (status) => {
    globalThis.fetch = vi.fn(async () => new Response("synthetic upstream diagnostics", {
      status,
      headers: { "cache-control": "no-store, private" }
    })) as typeof fetch;
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, async () => {});
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ title: "Upstream request failed", status });
  });

  it("keeps the local timeout problem and never retries it", async () => {
    const fetchMock = vi.fn(async () => { throw new UpstreamTimeoutError(15); });
    globalThis.fetch = fetchMock as typeof fetch;
    const establish = vi.fn(async () => {});
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, establish);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      title: "Upstream timed out",
      status: 502,
      detail: expect.stringContaining("15ms")
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(establish).not.toHaveBeenCalled();
  });

  it("keeps the local session-refresh problem rather than replacing it", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: env.LOGIN_URL }
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    const establish = vi.fn(async () => { throw new ConcurrentRefreshTimeoutError(90); });
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, establish);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ title: "Session refresh timed out", status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(establish).toHaveBeenCalledTimes(1);
  });

  it("returns the retry's login redirect without another login", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: env.LOGIN_URL }
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    const establish = vi.fn(async () => {});
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, establish);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(env.LOGIN_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(establish).toHaveBeenCalledTimes(1);
  });

  it("still returns the local problem if discarding the error stream rejects", async () => {
    const cancel = vi.fn(async () => { throw new Error("synthetic cancellation failure"); });
    const stream = new ReadableStream({ cancel });
    globalThis.fetch = vi.fn(async () => new Response(stream, { status: 503 })) as typeof fetch;
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, async () => {});
    expect(await response.json()).toMatchObject({ title: "Upstream request failed", status: 503 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the discarded error stream without reading it to completion", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    globalThis.fetch = vi.fn(async () => new Response(stream, { status: 503 })) as typeof fetch;
    const response = await forwardPassthrough(env, stub, incoming, upstream, null, async () => {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ title: "Upstream request failed", status: 503 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
