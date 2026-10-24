import { describe, expect, it } from "vitest";
import { parseAddressIdFromSaveResponse, parseContainerIdFromSaveResponse } from "../src/lib/routewarePostResult";

/**
 * Independent ID-boundary pins. Only address/container parsers are in scope;
 * these tests neither import nor change the customer parser's contract.
 *
 * Breaks caught: Number()/parseInt() coercion admits booleans, fractional or
 * unsafe IDs, and non-digit strings; an invalid nested candidate can hide a
 * valid top-level one; a camelCase form field can masquerade as an update ID.
 */
const invalidIds = [
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "fraction", value: 1.5 },
  { label: "unsafe integer", value: 9007199254740992 },
  { label: "zero", value: 0 },
  { label: "negative", value: -1 },
  { label: "empty string", value: "" },
  { label: "whitespace string", value: " " },
  { label: "non-digit string", value: "not-an-id" },
  { label: "trailing junk", value: "77x" },
  { label: "fraction string", value: "1.5" },
  { label: "unsafe integer string", value: "9007199254740992" },
  { label: "hex string", value: "0x4d" },
  { label: "exponent string", value: "7.7e1" },
  { label: "signed string", value: "+77" },
  { label: "negative string", value: "-1" },
  { label: "zero string", value: "0" },
  { label: "padded string", value: " 77 " },
  { label: "array", value: [77] },
  { label: "object", value: { id: 77 } },
  { label: "null", value: null }
] as const;

for (const spec of [
  {
    entity: "address",
    parse: parseAddressIdFromSaveResponse,
    canonical: "PickupAddressID",
    alias: "pickupAddressID",
    postedId: "10",
    createdId: 77
  },
  {
    entity: "container",
    parse: parseContainerIdFromSaveResponse,
    canonical: "ContainerID",
    alias: "containerID",
    postedId: "100",
    createdId: 177
  }
] as const) {
  describe(`${spec.entity} save ID parser review regressions`, () => {
    for (const key of [spec.canonical, spec.alias]) {
      for (const location of ["nested", "top-level"] as const) {
        function wire(value: unknown): string {
          const candidate = { [key]: value };
          return JSON.stringify(location === "nested" ? { success: true, data: candidate } : { success: true, ...candidate });
        }

        it.each([
          { label: "positive integer", value: spec.createdId, want: spec.createdId },
          { label: "decimal digits", value: String(spec.createdId), want: spec.createdId },
          { label: "leading-zero decimal digits", value: `000${spec.createdId}`, want: spec.createdId },
          { label: "largest safe integer", value: 9007199254740991, want: 9007199254740991 },
          { label: "largest safe decimal string", value: "9007199254740991", want: 9007199254740991 }
        ])(`accepts ${location} ${key}: $label`, ({ value, want }) => {
          expect(spec.parse({}, wire(value))).toBe(want);
        });

        it.each(invalidIds)(`rejects ${location} ${key}: $label`, ({ value }) => {
          expect(spec.parse({}, wire(value))).toBeNull();
        });
      }
    }

    it.each(invalidIds)("invalid nested candidate ($label) does not mask a valid top-level ID", ({ value }) => {
      expect(spec.parse({}, JSON.stringify({
        data: { [spec.canonical]: value },
        [spec.canonical]: spec.createdId
      }))).toBe(spec.createdId);
      expect(spec.parse({}, JSON.stringify({
        data: { [spec.alias]: value },
        [spec.canonical]: String(spec.createdId)
      }))).toBe(spec.createdId);
      expect(spec.parse({}, JSON.stringify({
        data: { [spec.canonical]: value },
        [spec.alias]: spec.createdId
      }))).toBe(spec.createdId);
    });

    it.each([
      "", "not JSON", "{", "null", "true", "false", "77", '"77"', "[]",
      '[{"PickupAddressID":77,"ContainerID":177}]', '{"data":null}', '{"data":true}', '{"data":[]}'
    ])("returns null without throwing for malformed/non-object/no-ID JSON: %s", (text) => {
      let result: number | null | undefined;
      expect(() => { result = spec.parse({}, text); }).not.toThrow();
      expect(result).toBeNull();
    });

    it("keeps a valid nested ID ahead of a conflicting valid top-level ID", () => {
      expect(spec.parse({}, JSON.stringify({
        data: { [spec.canonical]: spec.createdId },
        [spec.canonical]: spec.createdId + 1
      }))).toBe(spec.createdId);
    });

    it("keeps PascalCase posted updates ahead of upstream JSON", () => {
      expect(spec.parse({ [spec.canonical]: spec.postedId }, JSON.stringify({
        data: { [spec.canonical]: spec.createdId }
      }))).toBe(Number(spec.postedId));
    });

    it("ignores camelCase posted IDs and uses upstream JSON instead", () => {
      expect(spec.parse({ [spec.alias]: spec.postedId }, JSON.stringify({
        data: { [spec.canonical]: spec.createdId }
      }))).toBe(spec.createdId);
    });

    it("does not echo a camelCase posted ID when upstream has no ID", () => {
      expect(spec.parse({ [spec.alias]: spec.postedId }, '{"success":true}')).toBeNull();
    });
  });
}
