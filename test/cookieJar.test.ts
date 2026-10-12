import { describe, expect, it } from "vitest";
import {
  cookieHeaderForUrl,
  cookieHeaderFrom,
  defaultCookiePath,
  domainMatches,
  fromBrowserCookies,
  mergeSetCookies,
  parseSetCookie,
  pathMatches,
  type CookieJar,
  type StoredCookie
} from "../src/lib/cookieJar";

/**
 * Scoped session cookie jar (TOG-6529).
 *
 * The old jar kept only `name=value`, so a Path- or Domain-scoped (or
 * already expired) upstream cookie was replayed to every upstream path.
 * These tests pin the fix: expired cookies are dropped, and scoped cookies
 * are sent only in scope. Fixtures are `FAKE-…` literals — no PII, no
 * secrets (CONVENTIONS.md §§ 4–5).
 */

const NOW = 1_800_000_000_000;
const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";

function cookie(overrides: Partial<StoredCookie> & { name: string }): StoredCookie {
  return {
    value: "FAKE",
    domain: "killeen.routeware.com",
    hostOnly: true,
    path: "/",
    expiresAtMs: null,
    secure: false,
    ...overrides
  };
}

/** A Response carrying the given Set-Cookie headers (undici getSetCookie). */
function setCookieResponse(headers: string[]): Response {
  const h = new Headers();
  for (const value of headers) {
    h.append("set-cookie", value);
  }
  return new Response("ok", { status: 200, headers: h });
}

describe("defaultCookiePath", () => {
  it("returns / for the root and bare paths", () => {
    expect(defaultCookiePath("/")).toBe("/");
    expect(defaultCookiePath("/WebRW")).toBe("/");
    expect(defaultCookiePath("")).toBe("/");
  });

  it("returns the directory of a deeper path", () => {
    expect(defaultCookiePath("/WebRW/Account/Login")).toBe("/WebRW/Account");
  });
});

describe("parseSetCookie", () => {
  it("keeps a plain session cookie with request defaults", () => {
    const parsed = parseSetCookie(".WebRW=FAKE-SESSION", LOGIN_URL, NOW);
    expect(parsed).toEqual({
      kind: "set",
      cookie: {
        name: ".WebRW",
        value: "FAKE-SESSION",
        domain: "killeen.routeware.com",
        hostOnly: true,
        path: "/WebRW/Account",
        expiresAtMs: null,
        secure: false
      }
    });
  });

  it("honors explicit Path, Domain, Max-Age and Secure", () => {
    const parsed = parseSetCookie(
      "scoped=FAKE; Path=/WebRW/Reports; Domain=routeware.com; Max-Age=3600; Secure",
      "https://killeen.routeware.com/WebRW/Reports/Run",
      NOW
    );
    expect(parsed).toEqual({
      kind: "set",
      cookie: {
        name: "scoped",
        value: "FAKE",
        domain: "routeware.com",
        hostOnly: false,
        path: "/WebRW/Reports",
        expiresAtMs: NOW + 3600 * 1000,
        secure: true
      }
    });
  });

  it("turns an already-past Expires into a delete marker", () => {
    const parsed = parseSetCookie(
      "gone=FAKE; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      LOGIN_URL,
      NOW
    );
    expect(parsed?.kind).toBe("delete");
  });

  it("turns Max-Age<=0 into a delete marker", () => {
    expect(parseSetCookie("gone=FAKE; Max-Age=0", LOGIN_URL, NOW)?.kind).toBe("delete");
  });

  it("returns null when there is no usable name=value pair", () => {
    expect(parseSetCookie("not-a-cookie", LOGIN_URL, NOW)).toBeNull();
    expect(parseSetCookie("=noname", LOGIN_URL, NOW)).toBeNull();
  });
});

describe("mergeSetCookies", () => {
  it("replaces same-name cookies scoped to different paths separately", () => {
    // Arrange — same name set for two paths (the old record-jar collapsed these).
    const jar: CookieJar = [];
    mergeSetCookies(
      jar,
      setCookieResponse(["dup=FAKE-A; Path=/WebRW/A", "dup=FAKE-B; Path=/WebRW/B"]),
      LOGIN_URL,
      NOW
    );

    // Assert — both entries survive, keyed by (name, domain, path).
    expect(jar).toHaveLength(2);
    expect(jar.map((c) => c.value).sort()).toEqual(["FAKE-A", "FAKE-B"]);
  });

  it("drops an expired cookie instead of storing a dead entry", () => {
    // Arrange — a live cookie then an upstream logout expiring it.
    const jar: CookieJar = [];
    mergeSetCookies(jar, setCookieResponse([".WebRW=FAKE-LIVE; Path=/"]), LOGIN_URL, NOW);
    expect(jar).toHaveLength(1);

    // Act — upstream expires the cookie (Max-Age=0, same scope).
    mergeSetCookies(jar, setCookieResponse([".WebRW=gone; Path=/; Max-Age=0"]), LOGIN_URL, NOW);

    // Assert
    expect(jar).toHaveLength(0);
  });

  it("ignores responses without getSetCookie", () => {
    const jar: CookieJar = [];
    mergeSetCookies(jar, new Response("ok"), LOGIN_URL, NOW);
    expect(jar).toHaveLength(0);
  });
});

describe("domainMatches / pathMatches", () => {
  it("host-only cookies match only the exact host", () => {
    const c = cookie({ name: "h", hostOnly: true });
    expect(domainMatches(c, "killeen.routeware.com")).toBe(true);
    expect(domainMatches(c, "sub.killeen.routeware.com")).toBe(false);
  });

  it("domain cookies match subdomains but not lookalikes", () => {
    const c = cookie({ name: "d", domain: "routeware.com", hostOnly: false });
    expect(domainMatches(c, "routeware.com")).toBe(true);
    expect(domainMatches(c, "killeen.routeware.com")).toBe(true);
    expect(domainMatches(c, "notrouteware.com")).toBe(false);
    expect(domainMatches(c, "")).toBe(false);
  });

  it("path matching requires a directory boundary", () => {
    expect(pathMatches("/WebRW", "/WebRW/Home")).toBe(true);
    expect(pathMatches("/WebRW", "/WebRW")).toBe(true);
    expect(pathMatches("/WebRW", "/WebRWOther")).toBe(false);
    expect(pathMatches("/WebRW/", "/WebRW/Home")).toBe(true);
  });
});

describe("cookieHeaderForUrl", () => {
  const jar: CookieJar = [
    cookie({ name: "root", value: "FAKE-ROOT", path: "/" }),
    cookie({ name: "scoped", value: "FAKE-PATH", path: "/WebRW/Reports" }),
    cookie({ name: "expired", value: "FAKE-DEAD", path: "/", expiresAtMs: NOW - 1 }),
    cookie({ name: "future", value: "FAKE-LIVE", path: "/", expiresAtMs: NOW + 600_000 }),
    cookie({ name: "other", value: "FAKE-OTHER", domain: "other.example.com", path: "/" }),
    cookie({ name: "tls", value: "FAKE-TLS", path: "/", secure: true })
  ];

  it("sends only in-scope, unexpired cookies for the URL", () => {
    const header = cookieHeaderForUrl(jar, "https://killeen.routeware.com/WebRW/Home/Index", NOW);
    expect(header).toContain("root=FAKE-ROOT");
    expect(header).toContain("future=FAKE-LIVE");
    expect(header).toContain("tls=FAKE-TLS");
    expect(header).not.toContain("scoped=");
    expect(header).not.toContain("expired=");
    expect(header).not.toContain("other=");
  });

  it("sends a path-scoped cookie only under its path", () => {
    const inScope = cookieHeaderForUrl(
      jar,
      "https://killeen.routeware.com/WebRW/Reports/Run",
      NOW
    );
    expect(inScope).toContain("scoped=FAKE-PATH");
  });

  it("returns empty when nothing is in scope, and drops Secure over http", () => {
    // Only the secure cookie would match on a non-WebRW path — over http it must not.
    const onlyTls: CookieJar = [cookie({ name: "tls", value: "FAKE-TLS", path: "/", secure: true })];
    expect(cookieHeaderForUrl(onlyTls, "http://killeen.routeware.com/", NOW)).toBe("");
    expect(cookieHeaderForUrl(jar, "https://other.example.com/", NOW)).toContain("other=FAKE-OTHER");
    expect(cookieHeaderForUrl(jar, "not a url", NOW)).toBe("");
  });
});

describe("fromBrowserCookies", () => {
  it("converts puppeteer-shape cookies, dropping domainless entries", () => {
    const jar = fromBrowserCookies([
      { name: ".WebRW", value: "FAKE-A", domain: "killeen.routeware.com", path: "/", session: true },
      { name: "wide", value: "FAKE-B", domain: ".routeware.com", path: "/", expires: 1_900_000_000 },
      { name: "orphan", value: "FAKE-C" }
    ]);
    expect(jar).toHaveLength(2);
    expect(jar[0]).toMatchObject({ domain: "killeen.routeware.com", hostOnly: true, expiresAtMs: null });
    expect(jar[1]).toMatchObject({ domain: "routeware.com", hostOnly: false, expiresAtMs: 1_900_000_000_000 });
  });
});

describe("cookieHeaderFrom", () => {
  it("joins only the unexpired cookies (legacy unscoped fallback)", () => {
    const jar: CookieJar = [
      cookie({ name: "a", value: "FAKE-A" }),
      cookie({ name: "b", value: "FAKE-B", expiresAtMs: NOW - 1 })
    ];
    expect(cookieHeaderFrom(jar, NOW)).toBe("a=FAKE-A");
  });
});
