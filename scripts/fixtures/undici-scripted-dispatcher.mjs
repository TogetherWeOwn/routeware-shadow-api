// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { U, requireUndici } from "./undici-installed.mjs";
const WrapHandler = requireUndici("./lib/handler/wrap-handler.js");

export class ScriptedDispatcher extends U.Dispatcher {
  constructor(plans) {
    super();
    assert.ok(plans.length <= 2);
    assert.ok(plans.every((plan) => plan.length <= 4));
    this.plans = plans;
    this.calls = [];
    this.active = new Set();
  }
  dispatch(options, handler) {
    const index = this.calls.length;
    this.calls.push(options);
    const h = WrapHandler.wrap(handler);
    const plan = this.plans[index];
    let cursor = 0;
    let done = false;
    const finish = () => { done = true; this.active.delete(controller); };
    const fail = (error) => { if (!done) { finish(); h.onResponseError(controller, error); } };
    const controller = {
      paused: false, aborted: false, reason: null,
      pause() { this.paused = true; },
      resume() { this.paused = false; queueMicrotask(pump); },
      abort(reason) { this.aborted = true; this.reason = reason; queueMicrotask(() => fail(reason)); },
    };
    const pump = () => {
      if (done || controller.aborted || controller.paused) return;
      try {
        assert.ok(plan, "unexpected extra dispatch");
        while (!done && !controller.aborted && !controller.paused && cursor < plan.length) {
          const frame = plan[cursor++];
          if (frame.kind === "headers") h.onResponseStart(controller, frame.status, frame.headers, "Fixture");
          else if (frame.kind === "data") h.onResponseData(controller, Buffer.from(frame.data));
          else if (frame.kind === "error") fail(frame.error);
          else if (frame.kind === "end") { h.onResponseEnd(controller, {}); finish(); }
          else throw new Error("unknown scripted event");
        }
      } catch (error) { fail(error); }
    };
    this.active.add(controller);
    queueMicrotask(() => {
      try { h.onRequestStart(controller, null); } catch (error) { fail(error); return; }
      pump();
    });
    return true;
  }
  async close() { assert.equal(this.active.size, 0); }
  async destroy(reason = new Error("fixture cleanup")) {
    for (const controller of [...this.active]) controller.abort(reason);
  }
}
export const H = (status, headers) => ({ kind: "headers", status, headers });
export const D = (data) => ({ kind: "data", data });
export const E = () => ({ kind: "error", error: new U.errors.SocketError("other side closed", null) });
export const END = { kind: "end" };
