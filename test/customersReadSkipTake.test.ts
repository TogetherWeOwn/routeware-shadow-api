import { describe, expect, it } from "vitest";
import { translateSkipTakeToStartLimit } from "../src/lib/customersReadPagination";

/**
 * TOG-5936: unit coverage for the `skip`/`take` → `start`/`limit`
 * translation the `customers-read` route applies before forwarding.
 * The through-the-worker paths live in `test/customersReadPagination.test.ts`;
 * these pin the pure mapping rules (precedence, validity, passthrough).
 */

describe("translateSkipTakeToStartLimit", () => {
  it("maps skip/take onto start/limit and drops the source keys", () => {
    const out = translateSkipTakeToStartLimit(
      JSON.stringify({ skip: 200, take: 100 })
    );
    expect(out.translated).toBe(true);
    expect(JSON.parse(out.text)).toEqual({ start: 200, limit: 100 });
  });

  it("translates a lone skip or take", () => {
    expect(
      JSON.parse(translateSkipTakeToStartLimit('{"skip":10}').text)
    ).toEqual({ start: 10 });
    expect(JSON.parse(translateSkipTakeToStartLimit('{"take":25}').text)).toEqual({
      limit: 25
    });
  });

  it("maps take: 0 faithfully to limit: 0", () => {
    const out = translateSkipTakeToStartLimit('{"skip":0,"take":0}');
    expect(out.translated).toBe(true);
    expect(JSON.parse(out.text)).toEqual({ start: 0, limit: 0 });
  });

  it("lets an explicit start/limit win and drops the redundant skip/take", () => {
    const out = translateSkipTakeToStartLimit(
      JSON.stringify({ skip: 200, take: 100, start: 0, limit: 50 })
    );
    expect(out.translated).toBe(true);
    expect(JSON.parse(out.text)).toEqual({ start: 0, limit: 50 });
  });

  it("preserves every other key (filter/page/sort/group untouched)", () => {
    const out = translateSkipTakeToStartLimit(
      JSON.stringify({
        filter: [{ property: "CustomerID", operator: ">", value: 0 }],
        page: 3,
        skip: 100,
        take: 50,
        group: "[]",
        sort: '[{"property":"CustomerID","direction":"ASC"}]'
      })
    );
    expect(out.translated).toBe(true);
    expect(JSON.parse(out.text)).toEqual({
      filter: [{ property: "CustomerID", operator: ">", value: 0 }],
      page: 3,
      start: 100,
      limit: 50,
      group: "[]",
      sort: '[{"property":"CustomerID","direction":"ASC"}]'
    });
  });

  it("leaves bodies without skip/take byte-identical", () => {
    const body = JSON.stringify({
      filter: [{ property: "CustomerID", operator: ">", value: 0 }],
      page: 1,
      start: 0,
      limit: 50
    });
    const out = translateSkipTakeToStartLimit(body);
    expect(out.translated).toBe(false);
    expect(out.text).toBe(body);
  });

  it.each([
    ["string skip", '{"skip":"200","take":100}'],
    ["fractional skip", '{"skip":1.5,"take":100}'],
    ["negative skip", '{"skip":-5,"take":100}'],
    ["null take", '{"skip":200,"take":null}'],
    ["negative take", '{"skip":200,"take":-1}'],
    ["boolean take", '{"take":true}']
  ])("forwards an invalid %s unchanged instead of half-mapping", (_label, body) => {
    const out = translateSkipTakeToStartLimit(body);
    expect(out.translated).toBe(false);
    expect(out.text).toBe(body);
  });

  it.each([
    ["non-JSON form body", "skip=200&take=100"],
    ["empty string", ""],
    ["JSON array", "[1,2]"],
    ["JSON primitive", "42"],
    ["JSON null", "null"],
    ["nested-only skip", '{"outer":{"skip":1}}']
  ])("passes %s through untouched", (_label, body) => {
    const out = translateSkipTakeToStartLimit(body);
    expect(out.translated).toBe(false);
    expect(out.text).toBe(body);
  });
});
