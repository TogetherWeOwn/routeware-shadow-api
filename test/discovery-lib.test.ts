import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactBodyPreview,
  redactHeaders,
  redactHtmlAntiForgery,
  redactJsonPreview,
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

describe("redactJsonPreview", () => {
  it("masks non-string scalar values (number/boolean/null)", () => {
    const out = redactJsonPreview('{"token":12345,"secret":true,"password":null,"keep":7}');
    expect(out).toContain(`"token":"${REDACTED}"`);
    expect(out).toContain(`"secret":"${REDACTED}"`);
    expect(out).toContain(`"password":"${REDACTED}"`);
    expect(out).toContain('"keep":7');
  });

  it("masks save-form PII keys", () => {
    const out = redactJsonPreview(
      '{"FirstName":"Jane","LastName":"Doe","Phone1":"555-1","Phone2":"555-2","CompanyName":"ExampleCo","Comments":"hi","keep":"v"}'
    );
    for (const k of ["FirstName", "LastName", "Phone1", "Phone2", "CompanyName", "Comments"]) {
      expect(out).toContain(`"${k}":"${REDACTED}"`);
    }
    expect(out).toContain('"keep":"v"');
  });
});

describe("redactBodyPreview fallback content types", () => {
  it("redacts urlencoded-shaped bodies with text/plain", () => {
    expect(
      redactBodyPreview("text/plain", "UserName=API&Password=secret&x=1")
    ).toBe(`UserName=${REDACTED}&Password=${REDACTED}&x=1`);
  });

  it("redacts urlencoded-shaped bodies with missing content type", () => {
    expect(
      redactBodyPreview(undefined, "FirstName=Jane&CustomerID=5")
    ).toBe(`FirstName=${REDACTED}&CustomerID=5`);
  });

  it("redacts JSON-shaped bodies with a missing content type", () => {
    const out = redactBodyPreview(undefined, '{"password":"p","keep":"v"}');
    expect(out).toContain(`"password":"${REDACTED}"`);
    expect(out).toContain('"keep":"v"');
  });

  it("still strips anti-forgery tokens from HTML bodies", () => {
    const html = '<input name="__RequestVerificationToken" type="hidden" value="tok" />';
    const out = redactBodyPreview("text/html; charset=utf-8", html);
    expect(out).toContain(`value="${REDACTED}"`);
    expect(out).not.toContain("tok");
  });

  it("leaves plain prose untouched", () => {
    expect(redactBodyPreview("text/plain", "hello world")).toBe("hello world");
  });
});
