import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/customerSaveAutoToken.ts` — the server-side anti-forgery token cache
 * for `SaveCustomerLongForm` (TOG-5815).
 *
 * Without the cache, every save with a missing/placeholder
 * `__RequestVerificationToken` pays a modal-HTML GET. These tests pin the three
 * behaviours the cache must have: one modal GET serves N saves for the same
 * session + modal; a rotated session (the `forwardWithSessionRetry` recovery
 * path) misses the old entry and refetches instead of replaying a token minted
 * for the dead session; and TTL expiry / `forceRefresh` evict entries.
 *
 * `upstreamForward` is mocked and the modal GETs are counted; the URL builder
 * and body merging are the real ones.
 */

const calls: { urls: string[] } = { urls: [] };
let tokenSeq = 0;

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records each call's settled
  // result, which turns any deliberate rejection into an unhandled rejection
  // under @cloudflare/vitest-pool-workers.
  forwardToUpstream: async (_incoming: Request, upstreamUrl: URL) => {
    calls.urls.push(upstreamUrl.toString());
    tokenSeq += 1;
    return new Response(
      `<form><input name="__RequestVerificationToken" value="TOKEN-${tokenSeq}" /></form>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  }
}));

const {
  clearAntiForgeryTokenCache,
  evictAntiForgeryTokenCacheByToken,
  evictAntiForgeryTokenCacheForBody,
  prepareSaveCustomerLongFormBody,
  resolveSaveCustomerLongFormToken
} = await import("../src/lib/customerSaveAutoToken");

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const URLENCODED = "application/x-www-form-urlencoded";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function makeEnv(ttlSeconds?: string): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    CUSTOMER_SAVE_AUTO_TOKEN: "true",
    ...(ttlSeconds !== undefined
      ? { CUSTOMER_SAVE_AUTO_TOKEN_TTL_SECONDS: ttlSeconds }
      : {})
  } as unknown as Env;
}

function makeSession(cookie: string | null = "ASP.NET_SessionId=abc123") {
  return { cookieHeader: cookie, expiresAtMs: null, refreshing: false };
}

function body(raw: string): ArrayBuffer {
  return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

function decode(buffer: ArrayBuffer | null): string {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

function request(): Request {
  return new Request("http://internal/save", { method: "POST" });
}

beforeEach(() => {
  calls.urls = [];
  tokenSeq = 0;
  // The cache is a module-level Map that outlives a single test.
  clearAntiForgeryTokenCache();
});

describe("anti-forgery token cache", () => {
  it("serves N saves from one modal GET (cache hit)", async () => {
    // Arrange
    const env = makeEnv();
    const session = makeSession();
    const raw = "CustomerID=5&Enabled=true";

    // Act — three saves with a missing token on the same session.
    const first = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);
    const second = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);
    const third = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);

    // Assert — one modal GET, and every save carries that same token.
    expect(calls.urls).toHaveLength(1);
    expect(decode(first)).toContain("__RequestVerificationToken=TOKEN-1");
    expect(decode(second)).toContain("__RequestVerificationToken=TOKEN-1");
    expect(decode(third)).toContain("__RequestVerificationToken=TOKEN-1");
  });

  it("refetches after the default TTL expires", async () => {
    // Arrange
    const env = makeEnv();
    const session = makeSession();
    const raw = "CustomerID=5&Enabled=true";

    // Act — two saves inside the 5-minute window share one GET; a save past
    // the window refetches.
    await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, { nowMs: 1_000_000 });
    await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, {
      nowMs: 1_000_000 + DEFAULT_TTL_MS - 1
    });
    expect(calls.urls).toHaveLength(1);
    const third = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, {
      nowMs: 1_000_000 + DEFAULT_TTL_MS + 1
    });

    // Assert
    expect(calls.urls).toHaveLength(2);
    expect(decode(third)).toContain("__RequestVerificationToken=TOKEN-2");
  });

  it("honours CUSTOMER_SAVE_AUTO_TOKEN_TTL_SECONDS", async () => {
    // Arrange — a 60-second TTL instead of the 5-minute default.
    const env = makeEnv("60");
    const session = makeSession();
    const raw = "Enabled=true";

    // Act
    await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, { nowMs: 0 });
    await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, { nowMs: 61_000 });

    // Assert
    expect(calls.urls).toHaveLength(2);
    expect(calls.urls[0]).toContain("/Customer/AddNewLong");
  });

  it("keys the cache by session: a rotated session refetches (stale-token retry path)", async () => {
    // Arrange — `forwardWithSessionRetry` re-establishes the Routeware session
    // after a login redirect, so the next save runs under a new cookie. A
    // token minted for the dead session must not be replayed.
    const env = makeEnv();
    const raw = "CustomerID=5&Enabled=true";

    // Act
    const first = await prepareSaveCustomerLongFormBody(
      env,
      makeSession("ASP.NET_SessionId=old"),
      request(),
      body(raw),
      URLENCODED
    );
    const second = await prepareSaveCustomerLongFormBody(
      env,
      makeSession("ASP.NET_SessionId=fresh"),
      request(),
      body(raw),
      URLENCODED
    );

    // Assert — the new session misses the old entry and fetches its own token.
    expect(calls.urls).toHaveLength(2);
    expect(decode(first)).toContain("__RequestVerificationToken=TOKEN-1");
    expect(decode(second)).toContain("__RequestVerificationToken=TOKEN-2");
  });

  it("keys create and edit modals separately", async () => {
    // Arrange — the edit token is bound to a customer record; serving it to a
    // create (or vice versa) posts a token from the wrong modal.
    const env = makeEnv();
    const session = makeSession();

    // Act
    await prepareSaveCustomerLongFormBody(env, session, request(), body("Enabled=true"), URLENCODED);
    await prepareSaveCustomerLongFormBody(
      env,
      session,
      request(),
      body("CustomerID=7&Enabled=true"),
      URLENCODED
    );

    // Assert
    expect(calls.urls).toHaveLength(2);
    expect(calls.urls[0]).toContain("/Customer/AddNewLong");
    expect(calls.urls[1]).toContain("LoadLongCustomerModal?customerID=7");
  });

  it("forceRefresh skips a fresh entry (stale-token recovery)", async () => {
    // Arrange
    const env = makeEnv();
    const session = makeSession();
    const raw = "CustomerID=5&Enabled=true";

    // Act
    const first = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);
    const second = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED, {
      forceRefresh: true
    });

    // Assert
    expect(calls.urls).toHaveLength(2);
    expect(decode(first)).toContain("__RequestVerificationToken=TOKEN-1");
    expect(decode(second)).toContain("__RequestVerificationToken=TOKEN-2");
  });

  it("evicts a rejected token by value across sessions (TOG-8149)", async () => {
    // Arrange — the same upstream token value cached under two session keys
    // (the modal-heal shape: `resolveSaveCustomerLongFormToken` stores under
    // the fresh session while the route still holds the stale one, so a
    // session-keyed evict from the route would miss).
    const env = makeEnv();
    const raw = "Enabled=true";
    await prepareSaveCustomerLongFormBody(env, makeSession("ASP.NET_SessionId=a"), request(), body(raw), URLENCODED);
    tokenSeq = 0; // force the next modal GET to mint the same value
    const second = await prepareSaveCustomerLongFormBody(env, makeSession("ASP.NET_SessionId=b"), request(), body(raw), URLENCODED);
    expect(decode(second)).toContain("__RequestVerificationToken=TOKEN-1");
    expect(calls.urls).toHaveLength(2);

    // Act — upstream rejects the save: drop every entry holding that token.
    expect(evictAntiForgeryTokenCacheByToken("TOKEN-1")).toBe(true);

    // Assert — both entries are gone: the next save pays a modal GET instead
    // of replaying the known-rejected token.
    const third = await prepareSaveCustomerLongFormBody(env, makeSession("ASP.NET_SessionId=a"), request(), body(raw), URLENCODED);
    expect(calls.urls).toHaveLength(3);
    expect(decode(third)).toContain("__RequestVerificationToken=TOKEN-2");
    expect(evictAntiForgeryTokenCacheByToken("TOKEN-never-cached")).toBe(false);
  });

  it("evicts from a forwarded save body and never throws (TOG-8149)", async () => {
    // Arrange
    const env = makeEnv();
    const session = makeSession();
    const raw = "CustomerID=5&Enabled=true";
    const prepared = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);
    expect(calls.urls).toHaveLength(1);

    // Act — the save-side silent-failure branch hands over the forwarded body.
    expect(evictAntiForgeryTokenCacheForBody(prepared)).toBe(true);

    // Assert — the next token-less save refetches via one modal GET.
    const next = await prepareSaveCustomerLongFormBody(env, session, request(), body(raw), URLENCODED);
    expect(calls.urls).toHaveLength(2);
    expect(decode(next)).toContain("__RequestVerificationToken=TOKEN-2");

    // Degenerate bodies evict nothing and never throw (a silent-failure branch
    // must stay a 502, never become a 500).
    expect(evictAntiForgeryTokenCacheForBody(null)).toBe(false);
    expect(evictAntiForgeryTokenCacheForBody(new ArrayBuffer(0))).toBe(false);
    expect(evictAntiForgeryTokenCacheForBody(body("CustomerID=5"))).toBe(false);
    expect(evictAntiForgeryTokenCacheForBody(body("CustomerID=%ZZ"))).toBe(false);
  });

  it("resolveSaveCustomerLongFormToken returns the cached token without a fetch", async () => {
    // Arrange
    const env = makeEnv();
    const session = makeSession();
    const modalUrl = new URL(`${ORIGIN}${BASE}/Customer/AddNewLong`);

    // Act
    const first = await resolveSaveCustomerLongFormToken(
      env,
      session,
      request(),
      modalUrl,
      "/Customer/AddNewLong"
    );
    const second = await resolveSaveCustomerLongFormToken(
      env,
      session,
      request(),
      modalUrl,
      "/Customer/AddNewLong"
    );

    // Assert
    expect(first).toBe("TOKEN-1");
    expect(second).toBe("TOKEN-1");
    expect(calls.urls).toHaveLength(1);
  });
});
