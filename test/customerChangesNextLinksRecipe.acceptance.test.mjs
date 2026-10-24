import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Focused command: node --test test/customerChangesNextLinksRecipe.acceptance.test.mjs
// Execute the published recipe, not a test-maintained imitation. Builder: add one
// <=25-line js/javascript fenced block to CONSUMER-QUICKSTART.md that starts on
// the synthetic /api/v1/customer-snapshot/changes path, uses fetch + Link, and
// takes TOKEN (or process.env.TOKEN) from the supplied synthetic context. Keep
// the existing ordinary-list recipe intact; this feed has a different cursor.
const quickstart = readFileSync(new URL("../docs/CONSUMER-QUICKSTART.md", import.meta.url), "utf8");
const PATH = "/api/v1/customer-snapshot/changes";
const TOKEN = "synthetic-composite-recipe-token";

function recipe() {
  const candidates = [...quickstart.matchAll(/^```(?:js|javascript)\s*\n([\s\S]*?)^```/gm)]
    .map((match) => match[1].trim())
    .filter((code) => /\bfetch\s*\(/.test(code) && /\blink\b/i.test(code) && code.includes(PATH));
  assert.equal(candidates.length, 1, "quickstart needs one runnable customer-changes follow-next recipe");
  assert.ok(candidates[0].split("\n").length <= 25, "changes follow-next recipe must be <=25 lines");
  return candidates[0];
}

async function execute(code, fetch) {
  const output = [];
  const context = vm.createContext({
    fetch, URL, URLSearchParams, Headers, Request, Response,
    TextEncoder, TextDecoder, AbortController, AbortSignal,
    TOKEN, process: { env: { TOKEN } },
    console: {
      log: (...args) => output.push(args), warn: (...args) => output.push(args),
      error: (...args) => output.push(args)
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  let timer;
  try {
    await Promise.race([
      script.runInContext(context, { timeout: 1000 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("changes recipe did not stop")), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
    assert.ok(!JSON.stringify(output).includes(TOKEN), "recipe must never log its credential");
  }
}

function capture(input, init, origin) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.equal(request.method, "GET", "recipe must be read-only");
  assert.equal(request.redirect, "manual", "refuse automatic credential-bearing redirects");
  assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(url.pathname, PATH, "only the fixed customer-changes endpoint is allowed");
  assert.equal(url.username, "", "must not send URL credentials");
  assert.equal(url.password, "", "must not send URL credentials");
  if (origin) assert.equal(url.origin, origin, "must not forward authorization to a foreign origin");
  else assert.ok(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".invalid"),
    "recipe must start at a synthetic localhost or .invalid origin");
  return url;
}

const jsonPage = (link) => new Response(JSON.stringify({
  rows: [{ customer_id: 999 }], total: 1,
  // Deliberately NOT the advertised URL's cursor. Only Link drives traversal.
  nextCursor: { since: "2026-09-01T00:00:00.999Z", since_id: 999 }
}), { headers: { "content-type": "application/json", ...(link ? { Link: link } : {}) } });

test("published changes recipe follows encoded targets verbatim, never reconstructs JSON cursors, and stops on omission", async () => {
  const code = recipe();
  const seen = [];
  const responses = [];
  let origin;
  const targets = [
    `${PATH}?since=2026-09-01T00%3A00%3A00.100Z&since_id=9207&limit=2`,
    `${PATH}?since=2026-09-02T00%3A00%3A00.000Z&since_id=9208&limit=2`
  ];
  await execute(code, async (input, init) => {
    const url = capture(input, init, origin);
    origin ??= url.origin;
    seen.push(url.href);
    assert.ok(seen.length <= 3, "Link omission must stop without another request");
    if (seen.length > 1) assert.equal(url.href, new URL(targets[seen.length - 2], origin).href);
    const response = jsonPage(seen.length <= 2 ? `<${targets[seen.length - 1]}>; rel="next"` : undefined);
    responses.push(response);
    return response;
  });
  assert.equal(seen.length, 3, "must follow both server-supplied links");
  assert.ok(responses.every((response) => response.bodyUsed), "successful pages must actually be consumed");
});

for (const status of [301, 302, 303, 307, 308, 400, 401, 500]) {
  test(`published changes recipe rejects HTTP ${status} before JSON parsing or another fetch`, async () => {
    // Extract before assert.rejects: a missing recipe must never masquerade as
    // successful rejection of a malicious response.
    const code = recipe();
    const response = new Response(JSON.stringify({ status, title: "Synthetic non-page" }), {
      status, headers: {
        "content-type": "application/problem+json",
        location: "https://redirect-target.invalid/credential-sink",
        Link: `<${PATH}?since=2026-09-01T00%3A00%3A00.100Z&since_id=9207&limit=2>; rel="next"`
      }
    });
    let calls = 0;
    let error;
    try {
      await execute(code, async (input, init) => {
        capture(input, init);
        calls++;
        assert.equal(calls, 1, "must not follow either Location or Link on a non-2xx response");
        return response;
      });
    } catch (caught) { error = caught; }
    assert.ok(error, "non-2xx must reject, not silently parse a problem response as a page");
    assert.match(String(error.message), new RegExp(String(status)), "HTTP refusal must name the status");
    assert.equal(response.bodyUsed, false, "must reject before JSON parsing");
    assert.equal(calls, 1, "must not fetch the redirect or error Link target");
  });
}

for (const [label, makeTarget] of [
  ["foreign absolute origin", () => "https://foreign.invalid/api/v1/customer-snapshot/changes?limit=1"],
  ["foreign scheme-relative origin", () => "//foreign.invalid/api/v1/customer-snapshot/changes?limit=1"],
  ["ordinary snapshot path", () => "/api/v1/customer-snapshot?limit=1"],
  ["unrelated privileged path", () => "/api/v1/data-snapshot/sync"],
  ["child path", () => `${PATH}/export`],
  ["same-origin URL credentials", (origin) => {
    const target = new URL(PATH, origin);
    target.username = "synthetic-user";
    target.password = "synthetic-password";
    return target.href;
  }]
]) {
  test(`published changes recipe refuses ${label} before forwarding its token`, async () => {
    const code = recipe();
    let calls = 0;
    let error;
    try {
      await execute(code, async (input, init) => {
        calls++;
        assert.equal(calls, 1, "must refuse an unsafe next target before the second fetch");
        const url = capture(input, init);
        return jsonPage(`<${makeTarget(url.origin)}>; rel="next"`);
      });
    } catch (caught) { error = caught; }
    if (error) assert.match(String(error.message), /origin|path|next|untrusted|credential/i,
      "refusal must name the boundary, not be an unrelated runtime error");
    assert.equal(calls, 1, "must stop or reject before forwarding authorization");
  });
}
