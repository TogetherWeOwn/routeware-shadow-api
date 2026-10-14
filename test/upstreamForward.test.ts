import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardToUpstream } from "../src/lib/upstreamForward";
import type { SessionState } from "../src/lib/sessionState";

/**
 * Regression tests for the security invariants in
 * `docs/CONVENTIONS.md` § 4 that `forwardToUpstream` enforces:
 * upstream `Set-Cookie` containment, session-cookie containment, and the
 * non-spoofable `X-Routeware-Shadow-Internal` marker.
 */

const UPSTREAM_URL = new URL("https://killeen.routeware.com/WebRW/Home/Index");

type CapturedCall = { url: string; headers: Headers; method: string };

/** Stubs global fetch and records what the Worker sent upstream. */
function stubUpstream(response: Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        headers: new Headers(init?.headers ?? {}),
        method: init?.method ?? "GET"
      });
      return response;
    }
  ) as typeof fetch;
  return calls;
}

function session(cookieHeader: string): SessionState {
  return { cookieHeader, expiresAtMs: Date.now() + 60_000, refreshing: false };
}

describe("forwardToUpstream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("upstream Set-Cookie containment", () => {
    it("strips Set-Cookie from the upstream response before returning it to the client", async () => {
      // Arrange
      stubUpstream(
        new Response("upstream-body", {
          status: 200,
          headers: {
            "set-cookie": ".WebRW=super-secret-session; Path=/; HttpOnly",
            "content-type": "text/plain"
          }
        })
      );
      const incoming = new Request("http://test.local/api/v1/routeware/home/index");

      // Act
      const response = await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.has("set-cookie")).toBe(false);
    });

    it("preserves status, body and non-cookie headers while stripping Set-Cookie", async () => {
      // Arrange
      stubUpstream(
        new Response("upstream-body", {
          status: 201,
          statusText: "Created",
          headers: {
            "set-cookie": ".WebRW=leaky",
            "content-type": "text/plain",
            "x-upstream-marker": "kept"
          }
        })
      );
      const incoming = new Request("http://test.local/api/v1/routeware/home/index");

      // Act
      const response = await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("upstream-body");
      expect(response.headers.get("x-upstream-marker")).toBe("kept");
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("returns the upstream response unchanged when it carries no Set-Cookie", async () => {
      // Arrange
      stubUpstream(
        new Response("plain", { status: 200, headers: { "content-type": "text/plain" } })
      );
      const incoming = new Request("http://test.local/api/v1/routeware/home/index");

      // Act
      const response = await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("plain");
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  });

  describe("session cookie containment", () => {
    it("sends the stored session cookie upstream", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index");

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, session(".WebRW=stored"), null);

      // Assert
      expect(calls[0]?.headers.get("Cookie")).toBe(".WebRW=stored");
    });

    it("never forwards a client-supplied Cookie header upstream", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: { cookie: ".WebRW=client-forged-session" }
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(calls[0]?.headers.get("Cookie")).toBeNull();
    });

    it("does not let a client Cookie header override the stored session", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: { cookie: ".WebRW=client-forged-session" }
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, session(".WebRW=stored"), null);

      // Assert
      expect(calls[0]?.headers.get("Cookie")).toBe(".WebRW=stored");
    });
  });

  describe("X-Routeware-Shadow-Internal marker", () => {
    it("never copies the internal marker from client input", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: { "x-routeware-shadow-internal": "anti-forgery-modal" }
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(calls[0]?.headers.get("X-Routeware-Shadow-Internal")).toBeNull();
    });

    it("sets the internal marker only when a trusted caller passes it in options", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index");

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, null, null, {
        internalMarker: "anti-forgery-modal"
      });

      // Assert
      expect(calls[0]?.headers.get("X-Routeware-Shadow-Internal")).toBe("anti-forgery-modal");
    });
  });

  describe("client header pass-through allowlist", () => {
    it("forwards only content-type, accept and referer from the incoming request", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          referer: "https://killeen.routeware.com/WebRW/",
          authorization: "Bearer client-token-must-not-leak",
          "x-forwarded-for": "10.0.0.1"
        },
        body: "{}"
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      const sent = calls[0]?.headers;
      expect(sent?.get("content-type")).toBe("application/json");
      expect(sent?.get("accept")).toBe("application/json");
      expect(sent?.get("referer")).toBe("https://killeen.routeware.com/WebRW/");
      expect(sent?.get("authorization")).toBeNull();
      expect(sent?.get("x-forwarded-for")).toBeNull();
    });
  });

  describe("client bearer token containment (TOG-19131)", () => {
    it("never forwards the client bearer token or client Cookie upstream", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: {
          authorization: "Bearer client-token-must-not-leak",
          cookie: ".WebRW=client-forged-session"
        }
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, null, null);

      // Assert
      expect(calls[0]?.headers.get("Authorization")).toBeNull();
      expect(calls[0]?.headers.get("Cookie")).toBeNull();
    });

    it("still sends the stored DO session cookie while dropping the client bearer token", async () => {
      // Arrange
      const calls = stubUpstream(new Response("ok"));
      const incoming = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: {
          authorization: "Bearer client-token-must-not-leak",
          cookie: ".WebRW=client-forged-session"
        }
      });

      // Act
      await forwardToUpstream(incoming, UPSTREAM_URL, session(".WebRW=stored"), null);

      // Assert
      expect(calls[0]?.headers.get("Authorization")).toBeNull();
      expect(calls[0]?.headers.get("Cookie")).toBe(".WebRW=stored");
    });
  });
});
