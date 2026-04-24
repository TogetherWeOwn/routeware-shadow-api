import { describe, expect, it } from "vitest";
import {
  extractRequestIdFromText,
  parseQueryRequestIsCompleteResponse
} from "../src/lib/routewareQueryReportCsv";

describe("routewareQueryReportCsv", () => {
  it("extractRequestIdFromText prefers JSON requestID", () => {
    const id = "bc5ffc64-a44d-477a-9aac-192f5166e987";
    expect(
      extractRequestIdFromText(`{ "requestID": "${id}", "x": 1 }`)
    ).toBe(id);
  });

  it("extractRequestIdFromText finds query string", () => {
    const id = "67e4c9c6-cc44-4ee0-a51b-3b05f4e9b8ca";
    expect(extractRequestIdFromText(`requestID=${id}`)).toBe(id);
  });

  it("parseQueryRequestIsCompleteResponse handles plain true/false", () => {
    expect(parseQueryRequestIsCompleteResponse("true")).toBe(true);
    expect(parseQueryRequestIsCompleteResponse("false")).toBe(false);
  });

  it("parseQueryRequestIsCompleteResponse handles .NET d wrapper", () => {
    expect(parseQueryRequestIsCompleteResponse('{"d":true}')).toBe(true);
  });
});
