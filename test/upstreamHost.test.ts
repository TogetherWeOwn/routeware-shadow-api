import { describe, expect, it } from "vitest";
import { UPSTREAM_HOST, isUpstreamUrl } from "./upstreamHost";

describe("isUpstreamUrl", () => {
  it("matches the exact upstream host", () => {
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}/WebRW/Home/Index`)).toBe(true);
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}/Reports/QueryRequestIsComplete`)).toBe(true);
  });

  it("does not false-trip when the host is merely mentioned in query or path", () => {
    expect(isUpstreamUrl(`https://evil.example/?u=https://${UPSTREAM_HOST}/`)).toBe(false);
    expect(isUpstreamUrl(`https://evil.example/${UPSTREAM_HOST}`)).toBe(false);
  });

  it("does not false-trip on lookalike suffix or sibling domains", () => {
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}.evil.example/WebRW/`)).toBe(false);
    expect(isUpstreamUrl("https://evil-killeen.routeware.com/WebRW/")).toBe(false);
  });

  it("cannot be evaded by hostname case variants", () => {
    expect(isUpstreamUrl("https://KILLEEN.ROUTEWARE.COM/WebRW/Home/Index")).toBe(true);
  });

  it("matches the trailing-dot FQDN form of the upstream host", () => {
    // A trailing dot is the same DNS name (FQDN root label); the URL parser
    // keeps it — including for the %2e-encoded form — so the tripwire must
    // canonicalize it away instead of missing the fetch.
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}./WebRW/Home/Index`)).toBe(true);
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}%2e/WebRW/Home/Index`)).toBe(true);
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}%2E/WebRW/Home/Index`)).toBe(true);
    expect(isUpstreamUrl(`https://${UPSTREAM_HOST}/WebRW/Home/Index`, `${UPSTREAM_HOST}.`)).toBe(true);
  });

  it("returns false for unparseable input instead of throwing", () => {
    expect(isUpstreamUrl("not a url")).toBe(false);
    expect(isUpstreamUrl("")).toBe(false);
  });
});
