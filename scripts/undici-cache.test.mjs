// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { U, turn, within } from "./fixtures/undici-installed.mjs";

const origin = "https://trusted.invalid";
function fixture(t, beforeCache = [], afterCache = []) {
  const mock = new U.MockAgent();
  mock.disableNetConnect();
  const store = new U.cacheStores.MemoryCacheStore({
    maxCount: 16, maxSize: 16384, maxEntrySize: 1024,
  });
  const client = mock.compose(...beforeCache, U.interceptors.cache({ store, type: "shared" }), ...afterCache);
  t.after(() => mock.destroy());
  let hits = 0;
  function reply(url, path, method, headers, statusCode = 200) {
    mock.get(url).intercept({ path, method }).reply(() => {
      hits++;
      return { statusCode, data: `hit-${hits}`, responseOptions: { headers } };
    }).persist();
  }
  return { mock, client, store, reply, hits: () => hits };
}
async function read(client, options = {}) {
  const response = await within(client.request({ origin, path: "/", method: "GET", ...options }));
  const text = await within(response.body.text());
  await turn(); // allow bounded stream finalization; not a time-based sleep
  return { text, headers: response.headers, statusCode: response.statusCode };
}
const fresh = { "cache-control": "public, max-age=60" };

test("C1: qualified Authorization policy cannot leak across requests", { timeout: 10000 }, async (t) => {
  for (const directive of [
    'private=" authorization"', 'no-cache="\tauthorization"', 'no-cache=authorization\t',
    'private= "authorization"', 'private ="authorization"', 'private\t=\t"authorization"',
    'private="authorization"\t, immutable', 'private="authorization" garbage',
    'private=, private="authorization"', 'no-cache= "authorization"',
    'no-cache ="authorization"', 'no-cache \t= \t"authorization"',
    'no-cache= "\tauthorization\t"\t', 'no-cache="authorization" garbage',
    'no-cache="set-cookie" garbage, no-cache="authorization"',
    'no-cache=, no-cache="authorization"',
  ]) {
    await t.test(JSON.stringify(directive), async (t) => {
      const f = fixture(t);
      f.reply(origin, "/", "GET", { "cache-control": `public, max-age=60, ${directive}` });
      assert.equal((await read(f.client, { headers: { authorization: "Bearer fixture-a" } })).text, "hit-1");
      assert.equal((await read(f.client)).text, "hit-2");
      assert.equal(f.hits(), 2);
    });
  }
});

test("C2: OWS-qualified fields are stripped only on cached replay", { timeout: 10000 }, async (t) => {
  for (const directive of [
    'no-cache= "x-secret"', 'no-cache ="x-secret"', 'no-cache \t= \t"x-secret"',
    'private= "x-secret"', 'private ="x-secret"', 'private\t=\t"x-secret"',
  ]) {
    await t.test(JSON.stringify(directive), async (t) => {
      const f = fixture(t);
      f.reply(origin, "/", "GET", { "cache-control": `public, max-age=60, ${directive}`, "x-secret": "fixture-secret" });
      const first = await read(f.client);
      const second = await read(f.client);
      assert.equal(first.headers["x-secret"], "fixture-secret");
      assert.equal(second.headers["x-secret"], undefined);
      assert.equal(first.text, "hit-1");
      assert.equal(second.text, "hit-1");
      assert.equal(f.hits(), 1);
    });
  }
});

test("C3: degenerate private is conservative and never crashes", { timeout: 10000 }, async (t) => {
  for (const directive of ['private=""', 'private=","', 'private="   "', 'private, private="hdr"']) {
    await t.test(directive, async (t) => {
      const f = fixture(t);
      // No Set-Cookie or Authorization veto may mask this parser/policy test.
      f.reply(origin, "/", "GET", { "cache-control": `public, max-age=60, ${directive}` });
      assert.equal((await read(f.client)).text, "hit-1");
      assert.equal((await read(f.client)).text, "hit-2");
      assert.equal(f.hits(), 2);
    });
  }
});

test("C4: unsafe requests do not replay and still invalidate GET", { timeout: 10000 }, async (t) => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await t.test(method, async (t) => {
      const f = fixture(t);
      f.reply(origin, "/unsafe", method, fresh, 404);
      const before = f.hits();
      const first = await read(f.client, { path: "/unsafe", method });
      const second = await read(f.client, { path: "/unsafe", method });
      assert.equal(first.statusCode, 404);
      assert.equal(second.statusCode, 404);
      assert.notEqual(first.text, second.text);
      assert.equal(f.hits() - before, 2);

      f.reply(origin, "/resource", "GET", fresh);
      f.reply(origin, "/resource", method, { "cache-control": "no-store" });
      const primed = await read(f.client, { path: "/resource" });
      assert.equal((await read(f.client, { path: "/resource" })).text, primed.text);
      const afterPrime = f.hits();
      await read(f.client, { path: "/resource", method });
      const final = await read(f.client, { path: "/resource" });
      assert.notEqual(final.text, primed.text);
      assert.equal(f.hits() - afterPrime, 2);
    });
  }
});

test("C5: shared cache refuses new and pre-existing Set-Cookie entries", { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  f.reply(origin, "/", "GET", { ...fresh, "set-cookie": "session=fixture-only" });
  const first = await read(f.client, { headers: { cookie: "user-a" } });
  const second = await read(f.client, { headers: { cookie: "user-b" } });
  assert.equal(first.text, "hit-1");
  assert.equal(second.text, "hit-2");
  assert.deepEqual(second.headers["set-cookie"], ["session=fixture-only"]);
  const privateClient = f.mock.compose(U.interceptors.cache({ store: f.store, type: "private" }));
  const privateFirst = await read(privateClient, { headers: { cookie: "user-a" } });
  const afterPrivate = f.hits();
  assert.equal((await read(privateClient, { headers: { cookie: "user-a" } })).text, privateFirst.text);
  assert.equal(f.hits(), afterPrivate); // proves a real cache entry exists
  assert.notEqual((await read(f.client, { headers: { cookie: "user-b" } })).text, privateFirst.text);
  assert.equal(f.hits(), afterPrivate + 1);
});

test("C6: redirects preserve origin isolation and same-origin caching", { timeout: 10000 }, async (t) => {
  for (const cacheOutside of [true, false]) {
    for (const crossOrigin of [true, false]) {
      await t.test(`${cacheOutside}/${crossOrigin}`, async (t) => {
        const redirect = U.interceptors.redirect({ maxRedirections: 2 });
        const f = fixture(t, cacheOutside ? [redirect] : [], cacheOutside ? [] : [redirect]);
        const targetOrigin = crossOrigin ? "https://other.invalid" : origin;
        f.mock.get(origin).intercept({ path: "/resource", method: "GET" }).reply(302, "", {
          headers: { location: `${targetOrigin}/payload` },
        });
        f.reply(targetOrigin, "/payload", "GET", fresh);
        f.mock.get(origin).intercept({ path: "/resource", method: "GET" }).reply(200, "legitimate", {
          headers: { "cache-control": "no-store" },
        });
        assert.equal((await read(f.client, { path: "/resource", headers: { cookie: "fixture-a" } })).text, "hit-1");
        const second = await read(f.client, { path: "/resource", headers: { cookie: "fixture-b" } });
        if (crossOrigin || !cacheOutside) {
          assert.equal(second.text, "legitimate");
          f.mock.assertNoPendingInterceptors();
        } else {
          assert.equal(second.text, "hit-1"); // original-key same-origin cache control
          assert.equal(f.hits(), 1);
        }
      });
    }
  }
});
