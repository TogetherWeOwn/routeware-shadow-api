import { describe, expect, it } from "vitest";
import {
  parseAddressIdFromSaveResponse,
  parseContainerIdFromSaveResponse,
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

  it("parseAddressIdFromSaveResponse prefers the posted id, else data.PickupAddressID", () => {
    expect(
      parseAddressIdFromSaveResponse({ PickupAddressID: "10" } as Record<string, string>, "{}")
    ).toBe(10);
    expect(
      parseAddressIdFromSaveResponse(
        { PickupAddressID: "0" } as Record<string, string>,
        '{"success":true,"data":{"PickupAddressID":77}}'
      )
    ).toBe(77);
    expect(
      parseAddressIdFromSaveResponse(
        {} as Record<string, string>,
        '{"PickupAddressID": 42, "data": null}'
      )
    ).toBe(42);
    expect(parseAddressIdFromSaveResponse({} as Record<string, string>, '{"success":true}')).toBeNull();
    expect(parseAddressIdFromSaveResponse({} as Record<string, string>, "")).toBeNull();
    expect(parseAddressIdFromSaveResponse({} as Record<string, string>, "Saved.")).toBeNull();
  });

  it("parseContainerIdFromSaveResponse prefers the posted id, else data.ContainerID", () => {
    expect(
      parseContainerIdFromSaveResponse({ ContainerID: "100" } as Record<string, string>, "{}")
    ).toBe(100);
    expect(
      parseContainerIdFromSaveResponse(
        { ContainerID: "0" } as Record<string, string>,
        '{"success":true,"data":{"ContainerID":177}}'
      )
    ).toBe(177);
    expect(
      parseContainerIdFromSaveResponse(
        {} as Record<string, string>,
        '{"ContainerID": 42, "data": null}'
      )
    ).toBe(42);
    expect(parseContainerIdFromSaveResponse({} as Record<string, string>, '{"success":true}')).toBeNull();
    expect(parseContainerIdFromSaveResponse({} as Record<string, string>, "")).toBeNull();
    expect(parseContainerIdFromSaveResponse({} as Record<string, string>, "Saved.")).toBeNull();
  });
});
