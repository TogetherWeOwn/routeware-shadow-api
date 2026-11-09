// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { U, within } from "./fixtures/undici-installed.mjs";
import { ScriptedDispatcher, H, D, E, END } from "./fixtures/undici-scripted-dispatcher.mjs";

async function responseFor(t, plans) {
  const base = new ScriptedDispatcher(plans);
  t.after(() => base.destroy());
  const client = base.compose(U.interceptors.retry({
    maxRetries: 1,
    retry(error, { state }, done) {
      queueMicrotask(() => done(error.code === "UND_ERR_SOCKET" && state.counter <= 2 ? null : error));
    },
  }));
  const response = await within(client.request({ origin: "https://fixture.invalid", path: "/", method: "GET" }));
  return { base, response };
}
const initial = () => [H(200, { "content-length": "5", etag: '"v1"' }), D("use"), E()];

test("R0: valid range resume still returns one complete body", { timeout: 5000 }, async (t) => {
  const { base, response } = await responseFor(t, [initial(), [
    H(206, { "content-length": "2", "content-range": "bytes 3-4/5", etag: '"v1"' }), D("r1"), END,
  ]]);
  assert.equal(response.statusCode, 200);
  assert.equal(await within(response.body.text()), "user1");
  assert.equal(base.calls.length, 2);
  assert.equal(base.calls[1].headers.range, "bytes=3-4");
  assert.equal(base.calls[1].headers["if-match"], '"v1"');
  await base.close();
});

test("R1: mismatched resumed Content-Length errors original body", { timeout: 5000 }, async (t) => {
  const { base, response } = await responseFor(t, [initial(), [
    H(206, { "content-length": "3", "content-range": "bytes 3-4/5", etag: '"v1"' }), D("r1x"), END,
  ]]);
  assert.equal(response.statusCode, 200);
  await assert.rejects(within(response.body.text()), { code: "UND_ERR_REQ_RETRY", message: "Content-Length mismatch" });
  assert.equal(base.calls.length, 2);
  await base.close();
});

test("R2: unusable initial 206 range must not resume", { timeout: 5000 }, async (t) => {
  const { base, response } = await responseFor(t, [[
    H(206, { "content-length": "2", "content-range": "bytes 0-999" }), D("1"), E(),
  ]]);
  assert.equal(response.statusCode, 206);
  await assert.rejects(within(response.body.text()), { code: "UND_ERR_SOCKET", message: "other side closed" });
  assert.equal(base.calls.length, 1);
  await base.close();
});

test("R3: partial error response cannot expand its exposed end", { timeout: 5000 }, async (t) => {
  const { base, response } = await responseFor(t, [
    [H(404, { "content-length": "2" }), D("1"), E()],
    [H(206, { "content-length": "4", "content-range": "bytes 1-4/5" }), D("2345"), END],
  ]);
  assert.equal(response.statusCode, 404);
  await assert.rejects(within(response.body.text()), { code: "UND_ERR_REQ_RETRY", message: "Content-Range mismatch" });
  assert.equal(base.calls.length, 2);
  assert.equal(base.calls[1].headers.range, "bytes=1-1");
  await base.close();
});

test("R4: failed resume settles the original body instead of replacing it", { timeout: 5000 }, async (t) => {
  const { base, response } = await responseFor(t, [initial(), [
    H(404, { "content-length": "2" }), D("no"), END,
  ]]);
  const originalBody = response.body;
  assert.equal(response.statusCode, 200);
  await assert.rejects(within(originalBody.text()), { code: "UND_ERR_REQ_RETRY" });
  assert.equal(response.body, originalBody);
  assert.equal(base.calls.length, 2);
  await base.close();
});

test("D1: dump never completes an oversized unknown-length response", () => {
  for (const overflow of [false, true]) {
    let intercepted;
    let ended = 0;
    let errors = 0;
    const sink = {
      onRequestStart() {}, onResponseStart() {},
      onResponseEnd() { ended++; },
      onResponseError(_controller, error) { assert.equal(error.code, "UND_ERR_ABORTED"); errors++; },
    };
    const dispatch = U.interceptors.dump({ maxSize: 4 })((_options, handler) => { intercepted = handler; return true; });
    dispatch({ method: "GET" }, sink);
    const controller = { abort() {}, pause() {}, resume() {} };
    intercepted.onRequestStart(controller, null);
    intercepted.onResponseStart(controller, 200, { "transfer-encoding": "chunked" }, "OK");
    intercepted.onResponseData(controller, Buffer.from("ab"));
    intercepted.onResponseData(controller, Buffer.from("cd"));
    if (overflow) {
      let thrown;
      try { intercepted.onResponseData(controller, Buffer.from("e")); } catch (error) { thrown = error; }
      assert.equal(thrown?.code, "UND_ERR_ABORTED");
      assert.match(thrown.message, /Response size \(5\) larger than maxSize \(4\)/);
      intercepted.onResponseError(controller, thrown); // transport's terminal-error contract
      assert.equal(ended, 0);
      assert.equal(errors, 1);
    } else {
      intercepted.onResponseEnd(controller, {});
      assert.equal(ended, 1);
      assert.equal(errors, 0);
    }
  }
});
