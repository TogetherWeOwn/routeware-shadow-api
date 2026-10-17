/**
 * Shared synthetic world for the discovery downstream-transform acceptance
 * tests (TOG-25412, roadmap R9-23). One coherent fake harvest drives all
 * three render scripts:
 *
 *   route-gaps.json            -> suggest-routes.mjs        -> suggested-routes.stub.ts
 *   harvest.ndjson + route-map -> export-curl-examples.mjs  -> curl-examples.sh + out/bodies/*
 *   discovered-operations.json -> generate-harvest-docs.mjs -> HARVEST_API.md
 *
 * No live Routeware, no browser, no network. Everything below is invented;
 * upstream paths reuse real route-map shapes so the pins read like the real
 * pipeline. Consumers: test/discoveryDownstream.test.ts (vitest, lib pins)
 * and tools/api-discovery/downstream-scripts.test.mjs (node --test, script
 * pins). Paired build card [TOG-25413](/TOG/issues/TOG-25413) must never
 * edit this file.
 *
 * Notes on the shapes:
 * - Every route-map entry carries every key (undefined where absent) so the
 *   TS test sees one uniform element type; JSON.stringify drops undefined
 *   when the sandbox writes route-map.json.
 * - discovered.operations is pre-sorted by count descending, exactly as
 *   aggregate.mjs emits it (aggregate.mjs `.sort((a, b) => b.count - a.count)`);
 *   the docs script's job is to reflect that input, not to re-sort it.
 * - route-gaps missingInShadowApi is likewise count-descending, as
 *   route-gap.mjs emits it.
 */

export const ROUTE_MAP = [
  {
    method: "POST",
    upstreamPath: "/WebRW/Customer/CustomersRead",
    shadowPath: "/api/v1/routeware/customer/customers-read",
    exampleFile: undefined,
    exampleQuery: undefined,
    exampleContentType: undefined,
  },
  {
    method: "POST",
    upstreamPath: "/WebRW/Customer/CustomerTypesRead",
    shadowPath: "/api/v1/routeware/customer/customer-types-read",
    exampleFile: undefined,
    exampleQuery: undefined,
    exampleContentType: undefined,
  },
  {
    method: "POST",
    upstreamPath: "/WebRW/Customer/SaveCustomerLongForm",
    shadowPath: "/api/v1/routeware/customer/save-long-form",
    exampleFile: "examples/save-customer-long-form.post.example.urlencoded",
    exampleQuery: undefined,
    exampleContentType: "application/x-www-form-urlencoded; charset=UTF-8",
  },
  {
    method: "GET",
    upstreamPath: "/WebRW/Customer/LoadLongCustomerModal",
    shadowPath: "/api/v1/routeware/customer/load-long-modal",
    exampleFile: undefined,
    exampleQuery: "customerID=111",
    exampleContentType: undefined,
  },
  {
    method: "GET",
    upstreamPath: "/WebRW/Reports/QueryRequestIsComplete",
    shadowPath: "/api/v1/routeware/reports/query-request-is-complete",
    exampleFile: undefined,
    exampleQuery: "requestID=REPLACE_WITH_UUID",
    exampleContentType: undefined,
  },
  {
    method: "POST",
    upstreamPath: "/WebRW/Data/NoBodyOp",
    shadowPath: "/api/v1/routeware/data/no-body-op",
    exampleFile: undefined,
    exampleQuery: undefined,
    exampleContentType: undefined,
  },
  {
    method: "PUT",
    upstreamPath: "/WebRW/Customer/UpdateThing",
    shadowPath: "/api/v1/routeware/customer/update-thing",
    exampleFile: undefined,
    exampleQuery: undefined,
    exampleContentType: undefined,
  },
];

/** Example body files the sandbox lays down beside route-map.json. */
export const EXAMPLE_FILES = {
  "examples/save-customer-long-form.post.example.urlencoded":
    "CustomerID=42&Name=Ada+Lovelace\n",
};

/**
 * Raw harvest.ndjson lines. Deliberate wrinkles:
 * - CustomersRead appears twice; the LAST row must win (page 99).
 * - One malformed line must be skipped, not fatal.
 * - The modal GET row's query (customerID=999) must beat exampleQuery (111).
 */
export const HARVEST_LINES = [
  JSON.stringify({
    ts: "2026-10-15T01:00:00.000Z",
    method: "POST",
    pathname: "/WebRW/Customer/CustomersRead",
    query: {},
    requestContentType: "application/json; charset=utf-8",
    requestBodyPreview: '{"page":1}',
  }),
  "this is not json{",
  JSON.stringify({
    ts: "2026-10-15T01:01:00.000Z",
    method: "POST",
    pathname: "/WebRW/Customer/CustomerTypesRead",
    query: {},
    requestContentType: "application/x-www-form-urlencoded; charset=UTF-8",
    requestBodyPreview: "EnabledOnly=true",
  }),
  JSON.stringify({
    ts: "2026-10-15T01:02:00.000Z",
    method: "GET",
    pathname: "/WebRW/Customer/LoadLongCustomerModal",
    query: { customerID: "999", tab: "a b" },
  }),
  JSON.stringify({
    ts: "2026-10-15T01:03:00.000Z",
    method: "PUT",
    pathname: "/WebRW/Customer/UpdateThing",
    query: {},
    requestContentType: "application/json",
    requestBodyPreview: '{"v":2}',
  }),
  JSON.stringify({
    ts: "2026-10-15T01:04:00.000Z",
    method: "POST",
    pathname: "/WebRW/Customer/CustomersRead",
    query: {},
    requestContentType: "application/json; charset=utf-8",
    requestBodyPreview: '{"page":99}',
  }),
];

/** route-gaps.json content (missingInShadowApi, count-descending). */
export const ROUTE_GAPS = {
  missingInShadowApi: [
    { method: "POST", upstreamPath: "/WebRW/Customer/PhantomRead", count: 5 },
    { method: "GET", upstreamPath: "/WebRW/Reports/QueryStatus", count: 2 },
  ],
  staleInRouteMap: [],
};

/**
 * Byte-exact expected suggested-routes.stub.ts for ROUTE_GAPS above,
 * captured from the real script on main (lines joined with "\n", no
 * trailing newline beyond the final stub block's blank line).
 */
export const EXPECTED_STUB_TEXT = [
  "/**",
  " * AUTO-GENERATED — do not import. Copy pieces into src/app.ts + route-map.json.",
  " * Upstream paths are under TARGET_BASE_PATH (default /WebRW).",
  " */",
  "",
  "/* eslint-disable */",
  "",
  "// 5x  POST /WebRW/Customer/PhantomRead",
  '// → add route-map: shadowPath "/api/v1/routeware/customer/phantom-read" (adjust naming)',
  '// → createRoute method: "post", path: "/api/v1/routeware/customer/phantom-read"',
  "",
  "// 2x  GET /WebRW/Reports/QueryStatus",
  '// → add route-map: shadowPath "/api/v1/routeware/reports/query-status" (adjust naming)',
  '// → createRoute method: "get", path: "/api/v1/routeware/reports/query-status"',
  "",
].join("\n");

/** discovered-operations.json content (operations count-descending). */
export const DISCOVERED = {
  generatedAt: "2026-10-15T00:00:00.000Z",
  sourceFile: "out/harvest.ndjson",
  lineCount: 16,
  operations: [
    {
      key: "POST /WebRW/Customer/CustomersRead",
      method: "POST",
      pathname: "/WebRW/Customer/CustomersRead",
      normalizedPath: "/WebRW/Customer/CustomersRead",
      count: 9,
      resourceTypes: ["xhr"],
      samples: [
        {
          ts: "2026-10-15T01:00:00.000Z",
          resourceType: "xhr",
          // The pipe must be escaped in the rendered markdown.
          pathWithQuery: "/WebRW/Customer/CustomersRead?x=1|2",
          frameUrl: null,
          query: { x: "1|2" },
          requestContentType: "application/json; charset=utf-8",
          requestHeaderNames: ["content-type", "x-requested-with"],
          requestBodyTopLevelKeys: ["page"],
          responseStatus: 200,
          responseContentType: "application/json",
          responseHeaderNames: ["content-type"],
          responseBodyTopLevelKeys: ["rows"],
          requestBodyPreview: '{"page":99}',
          responseBodyPreview: '{"rows":[]}',
        },
      ],
    },
    {
      key: "POST /WebRW/Customer/PhantomRead",
      method: "POST",
      pathname: "/WebRW/Customer/PhantomRead",
      normalizedPath: "/WebRW/Customer/PhantomRead",
      count: 5,
      resourceTypes: ["xhr"],
      samples: [],
    },
    {
      key: "GET /WebRW/Customer/LoadLongCustomerModal",
      method: "GET",
      pathname: "/WebRW/Customer/LoadLongCustomerModal",
      normalizedPath: "/WebRW/Customer/LoadLongCustomerModal",
      count: 2,
      resourceTypes: ["document"],
      samples: [],
    },
  ],
};
