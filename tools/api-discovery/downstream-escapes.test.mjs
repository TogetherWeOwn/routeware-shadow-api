/**
 * Builder-owned pins for the escaping and body-file guard behavior in
 * lib/curlExamples.mjs and lib/harvestDocs.mjs. These complement (and do
 * not edit) the paired acceptance suites downstream-scripts.test.mjs and
 * test/discoveryDownstream.test.ts: they pin inputs those fixtures do not
 * carry — shell-active characters in a recorded Content-Type, a backslash
 * in pathWithQuery, and a GET entry handed a body preview.
 *
 * Run: `node --test tools/api-discovery/downstream-escapes.test.mjs`
 * (wired into `npm run test:probe`). Synthetic inputs only; the one bash
 * invocation runs the generated curl line against a stub `curl` shell
 * function, so nothing touches the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { curlExampleForEntry } from "./lib/curlExamples.mjs";
import { renderHarvestApiDoc } from "./lib/harvestDocs.mjs";
import { ROUTE_MAP } from "./downstream-fixtures.mjs";

function entry(upstreamPath) {
  const found = ROUTE_MAP.find((e) => e.upstreamPath === upstreamPath);
  assert.ok(found, `fixture route-map has no ${upstreamPath}`);
  return found;
}

test("Content-Type escape covers quote, backslash, $ and backtick", () => {
  const evil = 'application/json; x="a\\b" $(echo PWNED >&2) `echo PWNED2 >&2`';
  const out = curlExampleForEntry(
    entry("/WebRW/Customer/CustomersRead"),
    { requestContentType: evil },
    '{"page":1}'
  );
  const headerLine = out.lines.find((l) => l.includes("Content-Type:"));
  assert.ok(headerLine, "expected a Content-Type header line");
  assert.equal(
    headerLine,
    '  -H "Content-Type: application/json; x=\\"a\\\\b\\" \\$(echo PWNED >&2) \\`echo PWNED2 >&2\\`" \\'
  );
});

test("generated curl line does not execute a hostile Content-Type", () => {
  const evil = "application/json; x=$(echo PWNED >&2)";
  const out = curlExampleForEntry(
    entry("/WebRW/Customer/CustomersRead"),
    { requestContentType: evil },
    '{"page":1}'
  );
  const script = [
    'curl() { printf "%s\\n" "$@"; }',
    "BASE=http://example.invalid",
    "DIR=/nonexistent",
    ...out.lines.filter((l) => l && !l.startsWith("#")),
  ].join("\n");
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  // Command substitution would print PWNED to stderr; escaped, the text
  // reaches the stub curl as inert argument data on stdout instead.
  assert.ok(!run.stderr.includes("PWNED"), `stderr executed: ${run.stderr}`);
  assert.ok(run.stdout.includes("Content-Type: application/json; x=$(echo PWNED >&2)"));
});

test("GET entry with a body preview emits no body file or data flag", () => {
  const out = curlExampleForEntry(
    entry("/WebRW/Reports/QueryRequestIsComplete"),
    null,
    '{"x":1}'
  );
  assert.equal(out.bodyFile, null);
  assert.ok(!out.lines.some((l) => l.includes("--data-binary")));
});

test("pathWithQuery backslash escape is literal in the code span (pinned)", () => {
  const doc = renderHarvestApiDoc(
    {
      generatedAt: "2026-01-01T00:00:00.000Z",
      sourceFile: "out/harvest.ndjson",
      lineCount: 1,
      operations: [
        {
          method: "GET",
          pathname: "/WebRW/A/B",
          count: 1,
          resourceTypes: ["xhr"],
          samples: [
            {
              ts: "2026-01-01T00:00:00.000Z",
              pathWithQuery: "/WebRW/A/B?f=a\\b|c",
              query: {},
            },
          ],
        },
      ],
    },
    ROUTE_MAP
  );
  assert.ok(doc.includes("- **pathWithQuery:** `/WebRW/A/B?f=a\\\\b\\|c`"));
});
