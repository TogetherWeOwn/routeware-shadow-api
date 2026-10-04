import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieHeaderFrom,
  establishSessionViaHttp,
  httpLogin,
  mergeSetCookies
} from "../src/lib/httpAuth";

/**
 * TOG-9207 — upstream cookie-jar scoping audit.
 *
 * 1. Stale-cookie eviction: an upstream sign-out/rotation `Set-Cookie` with an
 *    already-fired expiry (`Expires` in the past, `Max-Age<=0`) deletes the
 *    name from the jar instead of lingering as an empty `Name=` pair. The
 *    acceptance proof is the login-rotation test: a stale name present after
 *    the login-page GET disappears from the jar once the login POST deletes
 *    it.
 * 2. Jar never logged: the login-failure throw carries cookie *names* (fixed
 *    identifiers) but never values, and a successful `httpLogin` emits no
 *    console output at all.
 *
 * Cookie values below are `FAKE-…` literals (house pattern, cf. piiScrub).
 */

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;

function env(): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    LOGIN_URL,
    LOGIN_USERNAME: "fake-user",
    LOGIN_PASSWORD: "fake-pass"
  } as unknown as Env;
}

function jarResponse(
  body: string,
  status: number,
  setCookies: string[],
  contentType = "text/html"
): Response {
  const headers = new Headers({ "content-type": contentType });
  for (const sc of setCookies) {
    headers.append("set-cookie", sc);
  }
  return new Response(body, { status, headers });
}

const LOGIN_HTML =
  '<html><body><form><input name="__RequestVerificationToken" ' +
  'type="hidden" value="FAKE-TOKEN" /></form></body></html>';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("mergeSetCookies expiry eviction (TOG-9207)", () => {
  it("evicts a name deleted via past Expires while keeping siblings", () => {
    // Arrange — a jar holding a pre-login anti-forgery cookie plus a stale name.
    const jar: Record<string, string> = {
      "pre-login": "FAKE-PRE",
      STALE: "FAKE-OLD-STALE"
    };
    const res = jarResponse("", 200, [
      "STALE=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly",
      ".WebRW=FAKE-FRESH; Path=/; HttpOnly"
    ]);

    // Act
    mergeSetCookies(jar, res);

    // Assert — the deleted name is gone, the sibling and the fresh cookie stay.
    expect(jar).not.toHaveProperty("STALE");
    expect(jar["pre-login"]).toBe("FAKE-PRE");
    expect(jar[".WebRW"]).toBe("FAKE-FRESH");
    expect(cookieHeaderFrom(jar)).not.toContain("STALE");
  });

  it("evicts a name deleted via Max-Age=0 while keeping siblings", () => {
    // Arrange
    const jar: Record<string, string> = { KEEP: "FAKE-KEEP", GONE: "FAKE-OLD" };
    const res = jarResponse("", 200, ["GONE=bye; Max-Age=0; Path=/"]);

    // Act
    mergeSetCookies(jar, res);

    // Assert
    expect(jar).toEqual({ KEEP: "FAKE-KEEP" });
  });

  it("stores a bare empty value with no expiry signal (no silent eviction)", () => {
    // Arrange — an empty value alone is data, not a deletion (RFC 6265 §5.3:
    // only an explicit expiry removes). Evicting it would drop a cookie the
    // server still considers live.
    const jar: Record<string, string> = {};
    const res = jarResponse("", 200, ["EMPTY=; Path=/"]);

    // Act
    mergeSetCookies(jar, res);

    // Assert
    expect(jar["EMPTY"]).toBe("");
  });

  it("ignores attribute-only garbage without storing it", () => {
    // Arrange
    const jar: Record<string, string> = { KEEP: "FAKE-KEEP" };
    const res = jarResponse("", 200, ["HttpOnly", "=noname; Path=/"]);

    // Act
    mergeSetCookies(jar, res);

    // Assert — nothing stored, nothing crashed.
    expect(jar).toEqual({ KEEP: "FAKE-KEEP" });
  });
});

describe("login rotation evicts the stale cookie (TOG-9207 acceptance)", () => {
  it("a stale cookie name disappears from the jar on login rotation", async () => {
    // Arrange — page GET sets a stale name; the login POST rotates the session
    // and deletes the stale name with a past-Expiry Set-Cookie. Answered by
    // call order (login flow is exactly: page GET, then login POST).
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jarResponse(LOGIN_HTML, 200, [
          "STALE=FAKE-OLD-STALE; Path=/; HttpOnly",
          ".AspNetCore.Antiforgery=FAKE-PRE; Path=/"
        ]);
      }
      return jarResponse("", 200, [
        ".WebRW=FAKE-FRESH-WEBRW; Path=/; HttpOnly",
        "RCCApi=FAKE-FRESH-RCC; Path=/; Secure; HttpOnly",
        "RCCApiRefresh=FAKE-FRESH-REFRESH; Path=/; Secure; HttpOnly",
        "STALE=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly"
      ]);
    }) as unknown as typeof fetch;

    // Act
    const result = await httpLogin(env());

    // Assert — login succeeded on the rotated cookies and the stale name is
    // gone from both the jar object and the replayed Cookie header.
    expect(result.ok).toBe(true);
    expect(result.jar).not.toHaveProperty("STALE");
    expect(result.jar[".WebRW"]).toBe("FAKE-FRESH-WEBRW");
    expect(cookieHeaderFrom(result.jar)).not.toContain("STALE");
    expect(cookieHeaderFrom(result.jar)).toContain(".WebRW=FAKE-FRESH-WEBRW");
  });
});

describe("jar values never reach logs or errors (TOG-9207)", () => {
  it("a successful login emits no console output", async () => {
    // Arrange
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Page GET first (anti-forgery cookie), then the login POST with the
    // full session trio — answered by call order as in the rotation test.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      const cookies =
        calls === 1
          ? [".AspNetCore.Antiforgery=FAKE-PRE; Path=/"]
          : [
              ".WebRW=FAKE-W; Path=/; HttpOnly",
              "RCCApi=FAKE-R; Path=/; Secure",
              "RCCApiRefresh=FAKE-RR; Path=/; Secure"
            ];
      return jarResponse(LOGIN_HTML, 200, cookies);
    }) as unknown as typeof fetch;

    // Act
    await httpLogin(env());

    // Assert — nothing logged, so no jar dump is possible on this path.
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("the login-failure throw names cookies but never their values", async () => {
    // Arrange — the login POST answers without the session trio, so
    // establishSessionViaHttp throws the names-only diagnostic.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jarResponse(LOGIN_HTML, 200, [
          ".AspNetCore.Antiforgery=FAKE-PRE; Path=/"
        ]);
      }
      return jarResponse("", 200, [".WebRW=FAKE-SECRET-VALUE; Path=/; HttpOnly"]);
    }) as unknown as typeof fetch;
    const stub = {} as unknown as DurableObjectStub;

    // Act
    const failure = await establishSessionViaHttp(env(), stub).catch((e: unknown) => e);

    // Assert — the fixed identifier names the cookie for diagnosis…
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(".WebRW");
    // …but no value byte survives (the grep -i cookie equivalent: names only).
    expect((failure as Error).message).not.toContain("FAKE-SECRET-VALUE");
    expect((failure as Error).message).not.toContain("FAKE-PRE");
  });
});
