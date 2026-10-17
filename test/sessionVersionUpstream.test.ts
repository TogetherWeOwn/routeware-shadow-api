import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { readSessionState, sessionExpiryMs, type SessionState } from "../src/lib/sessionState";
import { APP_VERSION } from "../src/lib/version";
import {
  isLoginPageResponse,
  isLoginRedirect,
  looksLikeLoginPageHtml
} from "../src/lib/loginRedirect";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithIncomingSearch,
  routewareWebRwUrlWithQueryAllowlist
} from "../src/lib/upstreamUrl";
import { applyBrowserHeaders } from "../src/lib/upstreamHeaders";

/**
 * Direct unit coverage for the small lib helpers.
 *
 * `sessionExpiryMs` transitions and the AuthSession get/set/lock/unlock cycle
 * already live in `test/authSession.do.test.ts`; the login-redirect and
 * upstream-URL happy paths live in `test/lib.test.ts`. This file covers what
 * those leave out: the `readSessionState` fetch wrapper, the `APP_VERSION`
 * wiring to `package.json`, the login-detection edge cases, URL normalization,
 * and the browser-header helper (previously only exercised indirectly through
 * `forwardToUpstream`).
 */

function sessionStub(state: SessionState, onFetch?: (url: string) => void): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      onFetch?.(url);
      return new Response(JSON.stringify(state), {
        headers: { "content-type": "application/json" }
      });
    }
  } as unknown as DurableObjectStub;
}

describe("readSessionState", () => {
  it("fetches https://auth/get and returns the parsed state", async () => {
    // Arrange
    const state: SessionState = {
      cookieHeader: ".WebRW=abc",
      expiresAtMs: 1_700_000_000_000,
      refreshing: false
    };
    const seen: string[] = [];
    const stub = sessionStub(state, (url) => seen.push(url));

    // Act
    const out = await readSessionState(stub);

    // Assert
    expect(seen).toEqual(["https://auth/get"]);
    expect(out).toEqual(state);
  });

  it("round-trips an empty (logged-out) session", async () => {
    // Arrange
    const stub = sessionStub({ cookieHeader: null, expiresAtMs: null, refreshing: false });

    // Act
    const out = await readSessionState(stub);

    // Assert
    expect(out.cookieHeader).toBeNull();
    expect(out.expiresAtMs).toBeNull();
    expect(out.refreshing).toBe(false);
  });

  it("round-trips a refreshing session", async () => {
    // Arrange
    const stub = sessionStub({ cookieHeader: "old", expiresAtMs: 42, refreshing: true });

    // Act
    const out = await readSessionState(stub);

    // Assert
    expect(out.refreshing).toBe(true);
  });
});

describe("sessionExpiryMs wiring", () => {
  it("adds the TTL to the supplied now (deterministic wiring check)", () => {
    // Arrange
    const env = { SESSION_TTL_SECONDS: 600 } as unknown as Env;

    // Act / Assert
    expect(sessionExpiryMs(env, 1_000_000)).toBe(1_600_000);
  });
});

describe("APP_VERSION", () => {
  it("is wired to package.json#version (single source of truth)", () => {
    // Act / Assert — compares against the file, not a hardcoded string, so a
    // version bump moves the spec version with no test edit.
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it("is a non-empty dotted version string", () => {
    // Act / Assert
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isLoginRedirect edge cases", () => {
  it("returns false for a 302 to a non-login location", () => {
    // Arrange
    const response = new Response(null, {
      status: 302,
      headers: { location: "https://x/WebRW/Home/Index" }
    });

    // Act / Assert
    expect(isLoginRedirect(response)).toBe(false);
  });

  it("returns false for a 302 with no location header", () => {
    // Arrange
    const response = new Response(null, { status: 302 });

    // Act / Assert
    expect(isLoginRedirect(response)).toBe(false);
  });

  it("returns false for a 200 carrying a login path (status gate comes first)", () => {
    // Arrange
    const response = new Response(null, {
      status: 200,
      headers: { location: "https://x/WebRW/Account/Login" }
    });

    // Act / Assert
    expect(isLoginRedirect(response)).toBe(false);
  });

  it("matches case-sensitively on the known login path shapes only", () => {
    // Arrange — lowercase variants are not the Routeware login shape.
    const response = new Response(null, {
      status: 302,
      headers: { location: "https://x/webrw/account/login" }
    });

    // Act / Assert
    expect(isLoginRedirect(response)).toBe(false);
  });
});

describe("looksLikeLoginPageHtml edge cases", () => {
  it("matches a name=Password field plus the login path", () => {
    // Act / Assert
    expect(
      looksLikeLoginPageHtml(
        '<form action="/WebRW/Account/Login"><input name="Password" /></form>'
      )
    ).toBe(true);
  });

  it("matches type=password case-insensitively", () => {
    // Act / Assert
    expect(
      looksLikeLoginPageHtml(
        '<form action="/Account/Login"><INPUT TYPE="PASSWORD" /></form>'
      )
    ).toBe(true);
  });

  it("matches a password field plus the UserName + anti-forgery pair", () => {
    // Act / Assert
    expect(
      looksLikeLoginPageHtml(
        '<input type="password" name="pw" />UserName<input name="__RequestVerificationToken" />'
      )
    ).toBe(true);
  });

  it("rejects a password field with unrelated content (no login path, no pair)", () => {
    // Act / Assert — e.g. a change-password form on an authenticated page.
    expect(
      looksLikeLoginPageHtml(
        '<form action="/WebRW/Settings/Profile"><input type="password" name="newPw" /></form>'
      )
    ).toBe(false);
  });

  it("rejects an empty body", () => {
    // Act / Assert
    expect(looksLikeLoginPageHtml("")).toBe(false);
  });
});

describe("isLoginPageResponse edge cases", () => {
  it("returns false for a non-200 without reading the body", async () => {
    // Arrange
    const response = new Response("anything", { status: 500 });

    // Act / Assert
    expect(await isLoginPageResponse(response)).toBe(false);
  });

  it("returns false for octet-stream 200s without reading the body", async () => {
    // Arrange
    const response = new Response('<input type="password" />/Account/Login', {
      status: 200,
      headers: { "content-type": "application/octet-stream" }
    });

    // Act / Assert
    expect(await isLoginPageResponse(response)).toBe(false);
  });

  it("returns false for a 200 HTML page without login structure", async () => {
    // Arrange
    const response = new Response("<html><body>Report ready</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });

    // Act / Assert
    expect(await isLoginPageResponse(response)).toBe(false);
  });

  it("detects a login page when the content type carries a charset suffix", async () => {
    // Arrange
    const response = new Response(
      '<form action="/WebRW/Account/Login"><input name="Password" type="password" /></form>',
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    );

    // Act / Assert
    expect(await isLoginPageResponse(response)).toBe(true);
  });

  it("returns false when the body cannot be read (never throws, never logs PII)", async () => {
    // Arrange — a minimal stand-in whose clone throws, as a severed body would.
    const unreadable = {
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      clone: () => {
        throw new Error("body used");
      }
    } as unknown as Response;

    // Act / Assert
    expect(await isLoginPageResponse(unreadable)).toBe(false);
  });
});

describe("routewareWebRwUrl normalization", () => {
  it("strips a trailing slash from the base path", () => {
    // Act
    const url = routewareWebRwUrl("https://example.com", "/WebRW/", "/Home/Index");

    // Assert
    expect(url.href).toBe("https://example.com/WebRW/Home/Index");
  });

  it("adds a leading slash to a bare resource path", () => {
    // Act
    const url = routewareWebRwUrl("https://example.com", "/WebRW", "Home/Index");

    // Assert
    expect(url.href).toBe("https://example.com/WebRW/Home/Index");
  });

  it("handles trailing-slash base plus bare resource together", () => {
    // Act
    const url = routewareWebRwUrl("https://example.com", "/WebRW/", "Home/Index");

    // Assert
    expect(url.href).toBe("https://example.com/WebRW/Home/Index");
  });
});

describe("routewareWebRwUrlWithIncomingSearch edge cases", () => {
  it("clears the query when the incoming request has none", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/api/v1/routeware/home/index");

    // Act
    const url = routewareWebRwUrlWithIncomingSearch(
      "https://example.com",
      "/WebRW",
      "/Home/Index",
      incoming
    );

    // Assert
    expect(url.search).toBe("");
  });

  it("copies encoded query values verbatim", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/q?name=a%20b&filter=x%26y");

    // Act
    const url = routewareWebRwUrlWithIncomingSearch(
      "https://example.com",
      "/WebRW",
      "/Home/Index",
      incoming
    );

    // Assert
    expect(url.searchParams.get("name")).toBe("a b");
    expect(url.searchParams.get("filter")).toBe("x&y");
  });
});

describe("routewareWebRwUrlWithQueryAllowlist edge cases", () => {
  it("emits params in allowlist order, not incoming order", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/q?b=2&a=1");

    // Act
    const url = routewareWebRwUrlWithQueryAllowlist(
      "https://example.com",
      "/WebRW",
      "/Reports/QueryRequestIsComplete",
      incoming,
      ["a", "b"]
    );

    // Assert
    expect(url.search).toBe("?a=1&b=2");
  });

  it("matches allowlist names case-sensitively", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/q?requestid=lower&requestID=exact");

    // Act
    const url = routewareWebRwUrlWithQueryAllowlist(
      "https://example.com",
      "/WebRW",
      "/Reports/QueryRequestIsComplete",
      incoming,
      ["requestID"]
    );

    // Assert
    expect(url.searchParams.getAll("requestID")).toEqual(["exact"]);
    expect(url.searchParams.has("requestid")).toBe(false);
  });

  it("emits no query for an empty allowlist even when the client sends params", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/q?a=1&b=2");

    // Act
    const url = routewareWebRwUrlWithQueryAllowlist(
      "https://example.com",
      "/WebRW",
      "/Home/Index",
      incoming,
      []
    );

    // Assert
    expect(url.search).toBe("");
  });

  it("keeps encoded allowlisted values intact", () => {
    // Arrange
    const incoming = new Request("https://shadow.test/q?requestID=a%20b");

    // Act
    const url = routewareWebRwUrlWithQueryAllowlist(
      "https://example.com",
      "/WebRW",
      "/Reports/QueryRequestIsComplete",
      incoming,
      ["requestID"]
    );

    // Assert
    expect(url.searchParams.get("requestID")).toBe("a b");
  });
});

describe("applyBrowserHeaders", () => {
  const ORIGIN = "https://killeen.routeware.com";

  function headersWithPresets(): Headers {
    const headers = new Headers();
    headers.set("User-Agent", "shadow-api/1.0");
    headers.set("Authorization", "Bearer keep-me");
    return headers;
  }

  it("sets the full browser-mimicry header set", () => {
    // Arrange
    const headers = new Headers();

    // Act
    applyBrowserHeaders(headers, ORIGIN);

    // Assert
    expect(headers.get("User-Agent")).toContain("Chrome/121");
    expect(headers.get("Accept")).toBe("*/*");
    expect(headers.get("Accept-Language")).toBe("en-US,en;q=0.9");
    expect(headers.get("Accept-Encoding")).toBe("gzip, deflate, br");
    expect(headers.get("Cache-Control")).toBe("no-cache");
    expect(headers.get("Pragma")).toBe("no-cache");
    expect(headers.get("Sec-CH-UA")).toContain("Chromium");
    expect(headers.get("Sec-CH-UA-Mobile")).toBe("?0");
    expect(headers.get("Sec-CH-UA-Platform")).toBe('"Windows"');
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
  });

  it("derives Referer and Origin from the upstream origin", () => {
    // Arrange
    const headers = new Headers();

    // Act
    applyBrowserHeaders(headers, ORIGIN);

    // Assert
    expect(headers.get("Referer")).toBe(`${ORIGIN}/WebRW/`);
    expect(headers.get("Origin")).toBe(ORIGIN);
  });

  it("overwrites pre-existing spoofed headers but preserves unrelated ones", () => {
    // Arrange
    const headers = headersWithPresets();

    // Act
    applyBrowserHeaders(headers, ORIGIN);

    // Assert — the caller's User-Agent is replaced, other headers survive.
    expect(headers.get("User-Agent")).toContain("Chrome/121");
    expect(headers.get("Authorization")).toBe("Bearer keep-me");
  });

  it("tracks the origin it is given (no hardcoded host)", () => {
    // Arrange
    const headers = new Headers();
    const other = "https://other.routeware.com";

    // Act
    applyBrowserHeaders(headers, other);

    // Assert
    expect(headers.get("Referer")).toBe(`${other}/WebRW/`);
    expect(headers.get("Origin")).toBe(other);
  });
});
