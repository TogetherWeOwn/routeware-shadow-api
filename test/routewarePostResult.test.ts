import { describe, expect, it } from "vitest";
import {
  parseCustomerIdFromSaveResponse,
  routewarePostLooksSuccessful
} from "../src/lib/routewarePostResult";

describe("routewarePostResult", () => {
  it("routewarePostLooksSuccessful for 200 JSON", () => {
    expect(routewarePostLooksSuccessful(200, '{"success":true}')).toBe(true);
    expect(routewarePostLooksSuccessful(200, '{"Success":false}')).toBe(false);
    expect(routewarePostLooksSuccessful(500, "{}")).toBe(false);
  });

  it("parseCustomerIdFromSaveResponse", () => {
    expect(
      parseCustomerIdFromSaveResponse({ CustomerID: "99" } as Record<string, string>, "{}")
    ).toBe(99);
    expect(
      parseCustomerIdFromSaveResponse(
        {} as Record<string, string>,
        '{"CustomerID": 42, "data": null}'
      )
    ).toBe(42);
  });
});
