import { describe, expect, it } from "vitest";
import {
  apiAccessToken,
  bearerMatches,
  isApiAuthorized,
  timingSafeEqualStr
} from "../src/lib/auth";

function reqWith(auth?: string): { header: (n: string) => string | undefined } {
  return {
    header: (n: string) => (n.toLowerCase() === "authorization" ? auth : undefined)
  };
}

describe("timingSafeEqualStr", () => {
  it("is true for equal strings", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
  });
  it("is false for different content or length", () => {
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("x", "")).toBe(false);
  });
});

describe("bearerMatches", () => {
  it("matches a correct token (scheme case-insensitive)", () => {
    expect(bearerMatches(reqWith("Bearer s3cret"), "s3cret")).toBe(true);
    expect(bearerMatches(reqWith("bearer s3cret"), "s3cret")).toBe(true);
  });
  it("rejects trailing garbage after the token", () => {
    // Unanchored `/^Bearer\s+(\S+)/i` parsed `Bearer <valid> junk` as `<valid>`,
    // so the gate (prefix) and audit/redaction (full header) disagreed.
    expect(bearerMatches(reqWith("Bearer s3cret junk"), "s3cret")).toBe(false);
    expect(bearerMatches(reqWith("Bearer s3cret  junk"), "s3cret")).toBe(false);
    expect(bearerMatches(reqWith("Bearer s3cret\tjunk"), "s3cret")).toBe(false);
    const env = { CUSTOMER_SNAPSHOT_SYNC_SECRET: "sync" } as unknown as Env;
    expect(isApiAuthorized(env, reqWith("Bearer sync junk"))).toBe(false);
    expect(isApiAuthorized(env, reqWith("Bearer sync"))).toBe(true);
  });
  it("rejects wrong/missing tokens and empty expected", () => {
    expect(bearerMatches(reqWith("Bearer nope"), "s3cret")).toBe(false);
    expect(bearerMatches(reqWith(undefined), "s3cret")).toBe(false);
    expect(bearerMatches(reqWith("Basic s3cret"), "s3cret")).toBe(false);
    expect(bearerMatches(reqWith("Bearer s3cret"), "")).toBe(false);
    expect(bearerMatches(reqWith("Bearer s3cret"), undefined)).toBe(false);
  });
});

describe("apiAccessToken / isApiAuthorized", () => {
  const base = { CUSTOMER_SNAPSHOT_SYNC_SECRET: "sync" } as unknown as Env;

  it("prefers SHADOW_API_TOKEN, falls back to the sync secret", () => {
    expect(apiAccessToken({ ...base, SHADOW_API_TOKEN: "api" } as unknown as Env)).toBe("api");
    expect(apiAccessToken(base)).toBe("sync");
  });

  it("authorizes either the api token or the sync secret", () => {
    const env = { ...base, SHADOW_API_TOKEN: "api" } as unknown as Env;
    expect(isApiAuthorized(env, reqWith("Bearer api"))).toBe(true);
    expect(isApiAuthorized(env, reqWith("Bearer sync"))).toBe(true);
    expect(isApiAuthorized(env, reqWith("Bearer nope"))).toBe(false);
    expect(isApiAuthorized(env, reqWith(undefined))).toBe(false);
  });
});

/**
 * Invariant (`docs/CONVENTIONS.md` § 4, `wrangler.toml`): a Worker
 * with no token configured must fail CLOSED — 401 on every `/api/v1/*` route —
 * rather than trusting an absent or blank secret. Guards against a regression
 * that reads "no expected token" as "no check required".
 */
describe("fail-closed when no secret is configured", () => {
  const unconfigured = [
    { label: "both unset", env: {} },
    {
      label: "both empty strings",
      env: { SHADOW_API_TOKEN: "", CUSTOMER_SNAPSHOT_SYNC_SECRET: "" }
    },
    {
      label: "both whitespace only",
      env: { SHADOW_API_TOKEN: "   ", CUSTOMER_SNAPSHOT_SYNC_SECRET: "\t" }
    }
  ];

  it.each(unconfigured)("apiAccessToken is undefined when $label", ({ env }) => {
    expect(apiAccessToken(env as unknown as Env)).toBeUndefined();
  });

  it.each(unconfigured)("rejects every request when $label", ({ env }) => {
    const e = env as unknown as Env;
    expect(isApiAuthorized(e, reqWith(undefined))).toBe(false);
    expect(isApiAuthorized(e, reqWith("Bearer anything"))).toBe(false);
    expect(isApiAuthorized(e, reqWith("Bearer "))).toBe(false);
    expect(isApiAuthorized(e, reqWith("Bearer undefined"))).toBe(false);
  });

  it("does not treat an empty bearer token as matching an unset secret", () => {
    expect(bearerMatches(reqWith("Bearer "), "")).toBe(false);
    expect(bearerMatches(reqWith(""), "")).toBe(false);
    expect(bearerMatches(reqWith("Bearer "), undefined)).toBe(false);
  });
});
