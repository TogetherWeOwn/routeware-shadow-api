import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactBodyPreview,
  redactHeaders,
  redactHtmlAntiForgery,
  redactQueryObject,
  redactUrlEncoded,
  redactUrlSearch
} from "../tools/api-discovery/lib/redact";
import { normalizePath } from "../tools/api-discovery/lib/normalizePath.mjs";

describe("redactHeaders", () => {
  it("removes cookie and authorization", () => {
    const headers = new Headers({
      Accept: "application/json",
      Cookie: "secret=1",
      Authorization: "Bearer x"
    });
    expect(redactHeaders(headers)).toEqual({ accept: "application/json" });
  });
});

describe("redactUrlEncoded", () => {
  it("masks credential values but keeps other fields", () => {
    const out = redactUrlEncoded("UserName=API&Password=hunter2&CustomerID=84908");
    expect(out).toBe(`UserName=${REDACTED}&Password=${REDACTED}&CustomerID=84908`);
  });

  it("masks anti-forgery tokens", () => {
    expect(redactUrlEncoded("__RequestVerificationToken=abc123&x=1")).toBe(
      `__RequestVerificationToken=${REDACTED}&x=1`
    );
  });
});

describe("redactBodyPreview", () => {
  it("redacts urlencoded login bodies", () => {
    expect(
      redactBodyPreview("application/x-www-form-urlencoded", "UserName=API&Password=secret")
    ).toBe(`UserName=${REDACTED}&Password=${REDACTED}`);
  });

  it("redacts sensitive JSON keys", () => {
    const out = redactBodyPreview("application/json", '{"password":"p","keep":"v"}');
    expect(out).toContain(`"password":"${REDACTED}"`);
    expect(out).toContain('"keep":"v"');
  });

  it("passes through undefined", () => {
    expect(redactBodyPreview("text/html", undefined)).toBeUndefined();
  });
});

describe("redactHtmlAntiForgery", () => {
  it("masks the token input value (name-first)", () => {
    const html = '<input name="__RequestVerificationToken" type="hidden" value="tok" />';
    expect(redactHtmlAntiForgery(html)).toContain(`value="${REDACTED}"`);
    expect(redactHtmlAntiForgery(html)).not.toContain("tok");
  });
});

describe("redactQueryObject / redactUrlSearch", () => {
  it("masks sensitive query params, keeps the rest", () => {
    expect(redactQueryObject({ token: "abc", queryID: "23" })).toEqual({
      token: REDACTED,
      queryID: "23"
    });
  });

  it("redacts only the query part of a URL", () => {
    expect(redactUrlSearch("https://x/WebRW/Report?token=abc&queryID=23")).toBe(
      `https://x/WebRW/Report?token=${REDACTED}&queryID=23`
    );
  });

  it("leaves a URL without query untouched", () => {
    expect(redactUrlSearch("https://x/WebRW/Report")).toBe("https://x/WebRW/Report");
  });
});

describe("normalizePath", () => {
  it("replaces numeric segments", () => {
    expect(normalizePath("/WebRW/api/items/42/edit")).toBe(
      "/WebRW/api/items/{id}/edit"
    );
  });
});
