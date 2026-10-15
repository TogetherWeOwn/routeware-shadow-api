/// <reference types="vite/client" />

/**
 * Acceptance pins for the discovery downstream render transforms
 * (TOG-25412, roadmap R9-23): suggest-routes.mjs, export-curl-examples.mjs,
 * generate-harvest-docs.mjs. Pure-text pins only — the workers pool has no
 * node:fs/child_process, so script-level behavior (exit codes, files on
 * disk) is pinned by the sibling sandbox suite
 * tools/api-discovery/downstream-scripts.test.mjs (`node --test`).
 *
 * THE CONTRACT the paired build card implements ([TOG-25413](/TOG/issues/TOG-25413),
 * builds on this branch, never edits this file): extract the pure render
 * logic from the three scripts into tools/api-discovery/lib/ with NO
 * rendered-output change for existing inputs, exposing:
 *
 * - lib/stubNaming.mjs: `renderSuggestedRoutesStub(missing)` -> string
 *   (the whole suggested-routes.stub.ts text: header + one stubBlock per
 *   gap, capped at 40, then the "… and N more" line). stubBlock and
 *   suggestShadowPath already live there and are pinned by
 *   discoveryFreshness.test.ts.
 * - lib/curlExamples.mjs (new): the helpers export-curl-examples.mjs already
 *   has inline, with those exact names — `isJsonContentType(ct)`,
 *   `queryToSearch(query)`, `slug(method, upstreamPath)`,
 *   `findHarvestRow(harvestLines, method, upstreamPath)` (takes raw ndjson
 *   lines, skips malformed ones, LAST match wins) — plus
 *   `curlExampleForEntry(entry, harvestRow, bodyText)` ->
 *   `{ lines: string[], bodyFile: { fileName, text } | null }` where lines
 *   end with the "" separator the script appends per entry, bodyText is the
 *   caller-resolved body (harvest preview or example file, trimmed) or null,
 *   and the Content-Type precedence is harvestRow.requestContentType ??
 *   entry.exampleContentType ?? "application/json".
 *   One deliberate fix rides along: a non-GET entry renders `-X <its own
 *   method>` (today every body-carrying entry renders `-X POST`, so a PUT
 *   route-map entry generates a curl that calls the wrong method). Output
 *   for GET/POST entries — every entry in the real route-map — is
 *   byte-identical to today.
 * - lib/harvestDocs.mjs (new): `renderHarvestApiDoc(discovered, routeMap)`
 *   -> string (the whole HARVEST_API.md when discovered-operations exists;
 *   the missing-input stub stays script-level behavior).
 *
 * Each script must import its lib module (structural pins at the bottom) —
 * a lib copy the scripts don't call proves nothing.
 *
 * On current main this file fails for the right reasons: lib/curlExamples
 * and lib/harvestDocs do not exist and renderSuggestedRoutesStub is not
 * exported. Fixtures: tools/api-discovery/downstream-fixtures.mjs (shared
 * synthetic world, no live Routeware / browser / network).
 */
import { describe, expect, it } from "vitest";
import { renderSuggestedRoutesStub } from "../tools/api-discovery/lib/stubNaming.mjs";
import {
  curlExampleForEntry,
  findHarvestRow,
  isJsonContentType,
  queryToSearch,
  slug,
} from "../tools/api-discovery/lib/curlExamples.mjs";
import { renderHarvestApiDoc } from "../tools/api-discovery/lib/harvestDocs.mjs";
import {
  DISCOVERED,
  EXPECTED_STUB_TEXT,
  HARVEST_LINES,
  ROUTE_GAPS,
  ROUTE_MAP,
} from "../tools/api-discovery/downstream-fixtures.mjs";

function entry(upstreamPath: string) {
  const found = ROUTE_MAP.find((e) => e.upstreamPath === upstreamPath);
  if (!found) {
    throw new Error(`fixture route-map has no ${upstreamPath}`);
  }
  return found;
}

describe("renderSuggestedRoutesStub (suggest-routes checklist)", () => {
  it("renders the byte-exact stub for the shared gap fixture", () => {
    expect(renderSuggestedRoutesStub(ROUTE_GAPS.missingInShadowApi)).toBe(
      EXPECTED_STUB_TEXT
    );
  });

  it("renders header only for zero gaps", () => {
    const expected = [
      "/**",
      " * AUTO-GENERATED — do not import. Copy pieces into src/app.ts + route-map.json.",
      " * Upstream paths are under TARGET_BASE_PATH (default /WebRW).",
      " */",
      "",
      "/* eslint-disable */",
      "",
    ].join("\n");
    expect(renderSuggestedRoutesStub([])).toBe(expected);
  });

  it("caps at 40 blocks and counts the remainder", () => {
    const gaps = Array.from({ length: 41 }, (_, i) => ({
      method: "POST",
      upstreamPath: `/WebRW/Customer/Op${i}`,
      count: 1,
    }));
    const out = renderSuggestedRoutesStub(gaps);
    expect(out.match(/createRoute method/g)).toHaveLength(40);
    expect(out).toContain('path: "/api/v1/routeware/customer/op39"');
    expect(out).not.toContain('path: "/api/v1/routeware/customer/op40"');
    expect(out).toContain("// … and 1 more (see route-gaps.json)");
  });
});

describe("curlExamples helpers (export-curl-examples)", () => {
  it("classifies Content-Types, defaulting to JSON when absent", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/vnd.api+json")).toBe(true);
    expect(
      isJsonContentType("application/x-www-form-urlencoded; charset=UTF-8")
    ).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(true);
    expect(isJsonContentType(null)).toBe(true);
    expect(isJsonContentType("")).toBe(true);
  });

  it("builds body-file slugs from method + upstream path", () => {
    expect(slug("POST", "/WebRW/Customer/CustomersRead")).toBe(
      "POST_WebRW_Customer_CustomersRead"
    );
    expect(slug("GET", "//WebRW/Reports/QueryStatus")).toBe(
      "GET_WebRW_Reports_QueryStatus"
    );
  });

  it("serializes query objects including repeated keys", () => {
    expect(queryToSearch({ a: "1", b: ["x", "y"], d: "a b" })).toBe(
      "?a=1&b=x&b=y&d=a+b"
    );
    expect(queryToSearch({})).toBe("");
    expect(queryToSearch(null)).toBe("");
    expect(queryToSearch(undefined)).toBe("");
  });

  it("finds the LAST matching harvest row and skips malformed lines", () => {
    const row = findHarvestRow(
      HARVEST_LINES,
      "POST",
      "/WebRW/Customer/CustomersRead"
    );
    expect(row?.requestBodyPreview).toBe('{"page":99}');
    expect(
      findHarvestRow(HARVEST_LINES, "GET", "/WebRW/Customer/CustomersRead")
    ).toBeNull();
    expect(
      findHarvestRow(HARVEST_LINES, "POST", "/WebRW/Customer/NeverSeen")
    ).toBeNull();
  });
});

describe("curlExampleForEntry (Content-Type handling)", () => {
  it("renders a JSON POST with .json body file and JSON Accept", () => {
    const row = findHarvestRow(
      HARVEST_LINES,
      "POST",
      "/WebRW/Customer/CustomersRead"
    );
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/CustomersRead"),
      row,
      '{"page":99}'
    );
    expect(out.bodyFile).toEqual({
      fileName: "POST_WebRW_Customer_CustomersRead.json",
      text: '{"page":99}',
    });
    expect(out.lines).toEqual([
      "# POST /WebRW/Customer/CustomersRead → /api/v1/routeware/customer/customers-read",
      'curl -sS -X POST "$BASE/api/v1/routeware/customer/customers-read" \\',
      '  -H "Content-Type: application/json; charset=utf-8" \\',
      '  -H "Accept: application/json, text/javascript, */*; q=0.01" \\',
      '  -H "X-Requested-With: XMLHttpRequest" \\',
      '  --data-binary "@$DIR/bodies/POST_WebRW_Customer_CustomersRead.json"',
      "",
    ]);
  });

  it("renders a form-urlencoded POST with .body file and */* Accept", () => {
    const row = findHarvestRow(
      HARVEST_LINES,
      "POST",
      "/WebRW/Customer/CustomerTypesRead"
    );
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/CustomerTypesRead"),
      row,
      "EnabledOnly=true"
    );
    expect(out.bodyFile).toEqual({
      fileName: "POST_WebRW_Customer_CustomerTypesRead.body",
      text: "EnabledOnly=true",
    });
    expect(out.lines).toContain(
      '  -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" \\'
    );
    expect(out.lines).toContain('  -H "Accept: */*" \\');
    expect(out.lines).toContain(
      '  --data-binary "@$DIR/bodies/POST_WebRW_Customer_CustomerTypesRead.body"'
    );
  });

  it("falls back to the route-map exampleContentType without a harvest row", () => {
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/SaveCustomerLongForm"),
      null,
      "CustomerID=42&Name=Ada+Lovelace"
    );
    expect(out.bodyFile?.fileName).toBe(
      "POST_WebRW_Customer_SaveCustomerLongForm.body"
    );
    expect(out.lines).toContain(
      '  -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" \\'
    );
    expect(out.lines).toContain('  -H "Accept: */*" \\');
  });

  it("lets the harvest Content-Type beat the route-map exampleContentType", () => {
    const row = {
      method: "POST",
      pathname: "/WebRW/Customer/SaveCustomerLongForm",
      requestContentType: "application/json",
      requestBodyPreview: '{"x":1}',
    };
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/SaveCustomerLongForm"),
      row,
      '{"x":1}'
    );
    expect(out.bodyFile?.fileName).toBe(
      "POST_WebRW_Customer_SaveCustomerLongForm.json"
    );
    expect(out.lines).toContain('  -H "Content-Type: application/json" \\');
  });

  it("defaults Content-Type to application/json when nothing declares one", () => {
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/CustomersRead"),
      null,
      '{"page":1}'
    );
    expect(out.bodyFile?.fileName).toBe(
      "POST_WebRW_Customer_CustomersRead.json"
    );
    expect(out.lines).toContain('  -H "Content-Type: application/json" \\');
  });

  it("preserves a non-POST method instead of rendering -X POST", () => {
    const row = findHarvestRow(
      HARVEST_LINES,
      "PUT",
      "/WebRW/Customer/UpdateThing"
    );
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/UpdateThing"),
      row,
      '{"v":2}'
    );
    expect(out.lines).toContain(
      'curl -sS -X PUT "$BASE/api/v1/routeware/customer/update-thing" \\'
    );
    expect(out.bodyFile?.fileName).toBe("PUT_WebRW_Customer_UpdateThing.json");
  });

  it("renders GET with the harvest query, beating exampleQuery", () => {
    const row = findHarvestRow(
      HARVEST_LINES,
      "GET",
      "/WebRW/Customer/LoadLongCustomerModal"
    );
    const out = curlExampleForEntry(
      entry("/WebRW/Customer/LoadLongCustomerModal"),
      row,
      null
    );
    expect(out.bodyFile).toBeNull();
    expect(out.lines).toEqual([
      "# GET /WebRW/Customer/LoadLongCustomerModal → /api/v1/routeware/customer/load-long-modal",
      'curl -sS "$BASE/api/v1/routeware/customer/load-long-modal?customerID=999&tab=a+b" -H "Accept: */*" -H "X-Requested-With: XMLHttpRequest"',
      "",
    ]);
  });

  it("renders GET with exampleQuery when there is no harvest query", () => {
    const out = curlExampleForEntry(
      entry("/WebRW/Reports/QueryRequestIsComplete"),
      null,
      null
    );
    expect(out.lines).toContain(
      'curl -sS "$BASE/api/v1/routeware/reports/query-request-is-complete?requestID=REPLACE_WITH_UUID" -H "Accept: */*" -H "X-Requested-With: XMLHttpRequest"'
    );
    const emptyQueryRow = {
      method: "GET",
      pathname: "/WebRW/Reports/QueryRequestIsComplete",
      query: {},
    };
    const out2 = curlExampleForEntry(
      entry("/WebRW/Reports/QueryRequestIsComplete"),
      emptyQueryRow,
      null
    );
    expect(out2.lines).toEqual(out.lines);
  });

  it("emits the no-body comment and no body file when no body exists", () => {
    const out = curlExampleForEntry(entry("/WebRW/Data/NoBodyOp"), null, null);
    expect(out.bodyFile).toBeNull();
    expect(out.lines).toEqual([
      "# POST /WebRW/Data/NoBodyOp → /api/v1/routeware/data/no-body-op",
      "# (no body: add exampleFile to route-map or re-record with updated recorder)",
      "",
    ]);
  });
});

describe("renderHarvestApiDoc (generate-harvest-docs)", () => {
  const doc = renderHarvestApiDoc(DISCOVERED, ROUTE_MAP);

  it("reflects the discovered provenance line", () => {
    expect(doc).toContain("# Routeware WebRW — harvested traffic");
    expect(doc).toContain(
      "Generated **2026-10-15T00:00:00.000Z** from `out/harvest.ndjson` (16 lines)."
    );
  });

  it("reflects every operation row in input order, mapped or flagged", () => {
    const rowCustomers =
      "| 9 | POST | `/WebRW/Customer/CustomersRead` | `/api/v1/routeware/customer/customers-read` |";
    const rowPhantom =
      "| 5 | POST | `/WebRW/Customer/PhantomRead` | `— *add route* —` |";
    const rowModal =
      "| 2 | GET | `/WebRW/Customer/LoadLongCustomerModal` | `/api/v1/routeware/customer/load-long-modal` |";
    for (const row of [rowCustomers, rowPhantom, rowModal]) {
      expect(doc).toContain(row);
    }
    expect(doc.indexOf(rowCustomers)).toBeLessThan(doc.indexOf(rowPhantom));
    expect(doc.indexOf(rowPhantom)).toBeLessThan(doc.indexOf(rowModal));
  });

  it("renders sample detail for operations that carry samples", () => {
    expect(doc).toContain(
      "### POST `/WebRW/Customer/CustomersRead` (9 calls)"
    );
    expect(doc).toContain("Resource types: **xhr**");
    expect(doc).toContain("#### Sample 1 (2026-10-15T01:00:00.000Z)");
    expect(doc).toContain(
      "- **requestContentType:** application/json; charset=utf-8"
    );
    expect(doc).toContain("- **request JSON top-level keys:** page");
    expect(doc).toContain("- **responseStatus:** 200");
    expect(doc).toContain("- **response JSON top-level keys:** rows");
    expect(doc).toContain('```json\n{"page":99}\n```');
    expect(doc).toContain('{"rows":[]}');
  });

  it("escapes pipes in pathWithQuery and skips sample sections when empty", () => {
    expect(doc).toContain(
      "- **pathWithQuery:** `/WebRW/Customer/CustomersRead?x=1\\|2`"
    );
    expect(doc).not.toContain("### POST `/WebRW/Customer/PhantomRead`");
    expect(doc).not.toContain(
      "### GET `/WebRW/Customer/LoadLongCustomerModal`"
    );
  });

  it("changes with the input (no hard-coded operations)", () => {
    const other = renderHarvestApiDoc(
      {
        generatedAt: "2026-10-16T00:00:00.000Z",
        sourceFile: "out/other.ndjson",
        lineCount: 3,
        operations: [
          {
            method: "DELETE",
            pathname: "/WebRW/Customer/Gone",
            count: 3,
            resourceTypes: ["fetch"],
            samples: [],
          },
        ],
      },
      []
    );
    expect(other).toContain(
      "Generated **2026-10-16T00:00:00.000Z** from `out/other.ndjson` (3 lines)."
    );
    expect(other).toContain(
      "| 3 | DELETE | `/WebRW/Customer/Gone` | `— *add route* —` |"
    );
    expect(other).not.toContain("CustomersRead");
  });

  it("renders an empty table when there are no operations", () => {
    const empty = renderHarvestApiDoc(
      { generatedAt: "2026-10-15T00:00:00.000Z", operations: [] },
      ROUTE_MAP
    );
    expect(empty).toContain("## Operations (by frequency)");
    expect(empty).not.toContain("/WebRW/Customer/CustomersRead`");
  });
});

// Same ?raw pattern as discoveryFreshness.test.ts: prove the scripts
// actually call the extracted lib functions instead of keeping inline
// copies the pins above cannot see.
const scriptModules = import.meta.glob("../tools/api-discovery/*.mjs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("scripts render through the lib modules", () => {
  it("suggest-routes.mjs imports renderSuggestedRoutesStub", () => {
    const src = scriptModules["../tools/api-discovery/suggest-routes.mjs"];
    expect(src).toBeTypeOf("string");
    expect(src).toMatch(
      /import\s*\{[^}]*renderSuggestedRoutesStub[^}]*\}\s*from\s*"\.\/lib\/stubNaming\.mjs"/
    );
  });

  it("export-curl-examples.mjs imports from lib/curlExamples.mjs", () => {
    const src =
      scriptModules["../tools/api-discovery/export-curl-examples.mjs"];
    expect(src).toBeTypeOf("string");
    expect(src).toMatch(
      /import\s*\{[^}]*curlExampleForEntry[^}]*\}\s*from\s*"\.\/lib\/curlExamples\.mjs"/
    );
  });

  it("generate-harvest-docs.mjs imports renderHarvestApiDoc", () => {
    const src =
      scriptModules["../tools/api-discovery/generate-harvest-docs.mjs"];
    expect(src).toBeTypeOf("string");
    expect(src).toMatch(
      /import\s*\{[^}]*renderHarvestApiDoc[^}]*\}\s*from\s*"\.\/lib\/harvestDocs\.mjs"/
    );
  });
});
