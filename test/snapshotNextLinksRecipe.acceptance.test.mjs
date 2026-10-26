import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Execute the published quickstart, not a second example maintained in tests.
// Recipe interface: one <=25-line js/javascript fenced block using fetch + Link;
// top-level await is supported, TOKEN/process.env.TOKEN are synthetic, and the
// starting URL is a local ordinary snapshot list. No imports/network are needed.
const quickstart = readFileSync(new URL("../docs/CONSUMER-QUICKSTART.md", import.meta.url), "utf8");
const TOKEN = "synthetic-recipe-token";

function recipe() {
  const blocks = [...quickstart.matchAll(/^```(?:js|javascript)\s*\n([\s\S]*?)^```/gm)]
    .map((match) => match[1].trim());
  const candidates = blocks.filter((block) => /\bfetch\s*\(/.test(block) && /\blink\b/i.test(block)
    && !block.includes("/api/v1/customer-snapshot/changes"));
  assert.equal(candidates.length, 1, "quickstart needs one unambiguous runnable JavaScript follow-next recipe");
  const code = candidates[0];
  assert.ok(code.split("\n").length <= 25, "follow-next recipe must be at most 25 lines");
  return code;
}

async function execute(fetch) {
  const output = [];
  const context = vm.createContext({
    fetch, URL, URLSearchParams, Headers, Request, Response,
    TextEncoder, TextDecoder, AbortController, AbortSignal,
    TOKEN, process: { env: { TOKEN } },
    console: {
      log: (...args) => output.push(args),
      error: (...args) => output.push(args),
      warn: (...args) => output.push(args)
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`(async () => {\n${recipe()}\n})()`);
  let timer;
  try {
    await Promise.race([
      script.runInContext(context, { timeout: 1000 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("follow-next recipe did not stop")), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(!JSON.stringify(output).includes(TOKEN), "recipe must not log its credential");
}

function capture(input, init, origin) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  assert.equal(request.method, "GET", "recipe must not mutate data");
  assert.equal(request.redirect, "error", "recipe must refuse redirects before forwarding authorization");
  if (origin) {
    assert.equal(url.origin, origin, "recipe must stay on its starting synthetic origin");
  } else {
    assert.ok(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".invalid"),
      "recipe must start on a synthetic localhost or .invalid origin");
  }
  assert.match(url.pathname, /^\/api\/v1\/(?:customer|address|container)-snapshot$/);
  assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
  return url;
}

const listResponse = (cursor, link) => new Response(JSON.stringify({
  rows: [{ customer_id: cursor }], total: null, nextCursor: cursor
}), { headers: { "content-type": "application/json", ...(link ? { Link: link } : {}) } });

test("published recipe follows encoded server targets verbatim and stops on Link omission, not the JSON cursor", async () => {
  const seen = [];
  let firstPath;
  let origin;
  const suffix = "?q=synthetic%20%26%20%2B%2F%E9%9B%AA&fields=customer_id&limit=2&includeTotal=false";
  await execute(async (input, init) => {
    const url = capture(input, init, origin);
    seen.push(url.href);
    firstPath ??= url.pathname;
    origin ??= url.origin;
    assert.ok(seen.length <= 3, "Link omission must stop without another request");
    if (seen.length > 1) {
      const expected = new URL(`${firstPath}${suffix}&cursor=${seen.length === 2 ? 2 : 4}`, origin);
      assert.equal(url.pathname, expected.pathname);
      assert.equal(url.hash, "");
      assert.deepEqual([...url.searchParams].sort(), [...expected.searchParams].sort());
    }
    if (seen.length === 1) {
      return listResponse(91, `<${firstPath}${suffix}&cursor=2>; rel="next"`);
    }
    if (seen.length === 2) {
      return listResponse(92, `<${firstPath}${suffix}&cursor=4>; rel="next"`);
    }
    // The header, not a reconstructed JSON-cursor URL, determines continuation.
    return listResponse(93);
  });
  assert.equal(seen.length, 3);
});

test("published recipe refuses a synthetic redirect before fetching or consuming its target page", async () => {
  const seen = [];
  const redirectedPage = listResponse(2);
  const refusal = new TypeError("synthetic fetch refused redirect");
  await assert.rejects(execute(async (input, init) => {
    const request = new Request(input, init);
    seen.push(request.url);
    assert.equal(seen.length, 1, "redirect refusal must stop without another recipe fetch");
    const redirect = Response.redirect(new URL("?cursor=2", request.url), 302);
    // Model fetch's redirect handling without a network. Following would fetch
    // and return the target page; manual mode would expose the 302 instead.
    if (request.redirect === "error") throw refusal;
    if (request.redirect === "follow") {
      seen.push(redirect.headers.get("location"));
      return redirectedPage;
    }
    return redirect;
  }), (error) => {
    assert.equal(error, refusal, "recipe must propagate the fetch redirect refusal, not another error");
    return true;
  });
  assert.equal(seen.length, 1, "must not fetch the redirect target");
  assert.equal(redirectedPage.bodyUsed, false, "must not consume the redirect target page");
});

for (const status of [401, 500]) {
  test(`published recipe rejects HTTP ${status} before consuming a problem response or following its Link`, async () => {
    const response = new Response(JSON.stringify({
      type: "about:blank", title: status === 401 ? "Unauthorized" : "Internal Server Error", status
    }), {
      status,
      headers: {
        "content-type": "application/problem+json",
        Link: '</api/v1/customer-snapshot?cursor=2>; rel="next"'
      }
    });
    let calls = 0;
    await assert.rejects(execute(async (input, init) => {
      calls++;
      capture(input, init);
      assert.equal(calls, 1, "HTTP failure must stop without fetching the advertised continuation");
      return response;
    }), { name: "Error", message: `Snapshot read failed: ${status}` });
    assert.equal(response.bodyUsed, false, "HTTP failure must reject before reading the problem body as a page");
    assert.equal(calls, 1, "must not follow Link after HTTP failure");
  });
}

for (const target of ["https://foreign.test.invalid/steal", "//foreign.test.invalid/steal"]) {
  test(`published recipe rejects a cross-origin next target before forwarding authorization: ${target}`, async () => {
    recipe();
    let calls = 0;
    try {
      await execute(async (input, init) => {
        calls++;
        capture(input, init);
        assert.equal(calls, 1, "must reject a foreign continuation before fetch");
        return listResponse(2, `<${target}>; rel="next"`);
      });
    } catch (error) {
      // A safe refusal must explain the origin boundary, not hide a runtime
      // error/timeout. Silently stopping before fetch is also safe.
      assert.match(String(error?.message), /origin|foreign|untrusted/i);
    }
    assert.equal(calls, 1, "recipe must stop or reject before any foreign fetch");
  });
}
