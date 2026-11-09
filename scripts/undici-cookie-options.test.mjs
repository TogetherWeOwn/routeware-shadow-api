// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { U, within } from "./fixtures/undici-installed.mjs";
import { ScriptedDispatcher, H, D, END } from "./fixtures/undici-scripted-dispatcher.mjs";

test("K1: percent-encoded cookie bytes remain encoded", () => {
  for (const [name, value] of [
    ["token", "legit%0d%0aSet-Cookie:%20evil=injected%3B%20Path%3D/"],
    ["data", "prefix%00suffix"],
  ]) {
    assert.deepEqual(U.parseCookie(`${name}=${value}`), { name, value });
  }
});

test("K2: SameSite accepts exact tokens only", () => {
  for (const [input, expected] of [["none", "None"], ["lAx", "Lax"], ["STRICT", "Strict"]]) {
    assert.deepEqual(U.parseCookie(`a=b; SameSite=${input}`), {
      name: "a", value: "b", sameSite: expected,
    });
  }
  for (const input of ["StrictLax", "NoneOfYourBusiness", "xLax"]) {
    assert.deepEqual(U.parseCookie(`a=b; SameSite=${input}`), { name: "a", value: "b" });
  }
});

test("K3: cookie attributes cannot inject extra serialized attributes", () => {
  for (const extra of [
    { domain: "example.invalid; Secure" },
    { domain: "example.invalid\r\nX-Extra: 1" },
    { path: "/; Secure" },
    { unparsed: ["extra=value; Secure"] },
    { unparsed: ["extra=value\r\nX-Extra: 1"] },
    { unparsed: ["bad name=value"] },
  ]) {
    const headers = new U.Headers();
    assert.throws(() => U.setCookie(headers, { name: "a", value: "b", ...extra }));
    assert.deepEqual(headers.getSetCookie(), []);
  }
  const headers = new U.Headers();
  U.setCookie(headers, {
    name: "a", value: "b", domain: "example.invalid", path: "/",
    unparsed: ["extra=a=b"],
  });
  assert.deepEqual(headers.getSetCookie(), ["a=b; Domain=example.invalid; Path=/; extra=a=b"]);
});

function assertOptions(captured, connect, tls, checkServerIdentity) {
  assert.notEqual(captured.connect, connect);
  assert.notEqual(captured.tls, tls);
  assert.deepEqual(captured.connect, { timeout: 100, rejectUnauthorized: true });
  assert.deepEqual(captured.tls, { servername: "before.invalid", checkServerIdentity });
}

test("O1 PARTIAL: BalancedPool child factory receives copied TLS options", async (t) => {
  const connect = { timeout: 100, rejectUnauthorized: true };
  const checkServerIdentity = () => new Error("fixture certificate rejected");
  const tls = { servername: "before.invalid", checkServerIdentity };
  let captured;
  let factories = 0;
  const pool = new U.BalancedPool([], {
    connect, tls,
    factory(origin, options) {
      factories++;
      captured = options;
      return new U.Pool(origin, options); // construct only; never dispatch
    },
  });
  t.after(() => pool.destroy());
  connect.timeout = 200;
  tls.servername = "after.invalid";
  pool.addUpstream("https://origin.invalid");
  assert.equal(factories, 1);
  assertOptions(captured, connect, tls, checkServerIdentity);
});

test("O2 PARTIAL: Agent child factory receives copied TLS options", { timeout: 5000 }, async (t) => {
  const child = new ScriptedDispatcher([[H(200, {}), D("ok"), END]]);
  const connect = { timeout: 100, rejectUnauthorized: true };
  const checkServerIdentity = () => new Error("fixture certificate rejected");
  const tls = { servername: "before.invalid", checkServerIdentity };
  let captured;
  let factories = 0;
  const agent = new U.Agent({
    connect, tls,
    factory(origin, options) {
      factories++;
      captured = options;
      assert.equal(String(origin), "https://origin.invalid");
      return child; // Agent exclusively owns this child's terminal lifecycle.
    },
  });
  t.after(() => within(agent.destroy()));
  connect.timeout = 200;
  tls.servername = "after.invalid";
  const response = await within(agent.request({ origin: "https://origin.invalid", path: "/", method: "GET" }));
  assert.equal(await within(response.body.text()), "ok");
  assert.equal(factories, 1);
  assertOptions(captured, connect, tls, checkServerIdentity);
  assert.equal(child.calls.length, 1);
  assert.equal(child.active.size, 0);
});
