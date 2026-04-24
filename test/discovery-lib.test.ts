import { describe, expect, it } from "vitest";
import { redactHeaders } from "../tools/api-discovery/lib/redact";
import { normalizePath } from "../tools/api-discovery/lib/normalizePath";

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

describe("normalizePath", () => {
  it("replaces numeric segments", () => {
    expect(normalizePath("/WebRW/api/items/42/edit")).toBe(
      "/WebRW/api/items/{id}/edit"
    );
  });
});
