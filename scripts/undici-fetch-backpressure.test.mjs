// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { U, requireUndici, turn, within } from "./fixtures/undici-installed.mjs";
const { ByteParser } = requireUndici("./lib/web/websocket/receiver.js");
const { states } = requireUndici("./lib/web/websocket/constants.js");

class EncodingDispatcher extends U.Dispatcher {
  constructor(count, earlyClose = false) {
    super(); this.count = count; this.earlyClose = earlyClose; this.aborts = 0;
  }
  dispatch(_options, handler) {
    let aborted = false;
    handler.onConnect((reason) => {
      if (aborted) return; // match HTTP/1's re-entrant terminal abort contract
      aborted = true;
      this.aborts++;
      handler.onError(reason);
    }, null);
    handler.onHeaders(200, [
      Buffer.from("content-encoding"), Buffer.from(Array(this.count).fill("gzip").join(", ")),
    ], () => {}, "OK");
    if (aborted) {
      if (this.earlyClose) setImmediate(() => handler.onError(new U.errors.SocketError("early close", null)));
      return true;
    }
    let body = Buffer.from("ok");
    for (let i = 0; i < this.count; i++) body = gzipSync(body);
    handler.onData(body);
    handler.onComplete([]);
    return true;
  }
  async close() {}
  async destroy() {}
}

test("F1: encoding limit rejects six layers including early close", { timeout: 5000 }, async () => {
  const allowed = new EncodingDispatcher(5);
  const response = await within(U.fetch("https://encoding.invalid/", { dispatcher: allowed }));
  assert.equal(await within(response.text()), "ok");
  assert.equal(allowed.aborts, 0);
  for (const earlyClose of [false, true]) {
    const blocked = new EncodingDispatcher(6, earlyClose);
    await assert.rejects(within(U.fetch("https://encoding.invalid/", { dispatcher: blocked })), (error) => {
      assert.match(error.cause?.message ?? "", /content-encoding/);
      return true;
    });
    await turn(); // the early-close callback must not cause an uncaught exception
    assert.equal(blocked.aborts, 1);
  }
});

function socketStub(blocked) {
  const socket = new EventEmitter();
  socket.pongWrites = 0;
  socket.blocked = blocked;
  socket.writableNeedDrain = false;
  socket.write = () => {
    socket.pongWrites++;
    if (socket.blocked) { socket.writableNeedDrain = true; return false; }
    return true;
  };
  socket.drain = () => { socket.writableNeedDrain = false; socket.emit("drain"); };
  return socket;
}
function parserFor(t, socket) {
  const parser = new ByteParser({ readyState: states.OPEN, socket, closeState: new Set(), onPing() {} });
  t.after(() => parser.destroy());
  return parser;
}
const fourPings = Buffer.from([0x89, 0, 0x89, 0, 0x89, 0, 0x89, 0]);

test("W1: PONG backpressure pauses and resumes a bounded batch", { timeout: 5000 }, async (t) => {
  const socket = socketStub(true);
  const parser = parserFor(t, socket);
  parser.write(fourPings);
  await turn();
  assert.equal(socket.pongWrites, 1);
  socket.blocked = false;
  socket.drain();
  await turn();
  assert.equal(socket.pongWrites, 4);
});

test("W1: destroyed parser does not resume PONG writes", { timeout: 5000 }, async (t) => {
  const socket = socketStub(true);
  const parser = parserFor(t, socket);
  parser.write(fourPings);
  await turn();
  assert.equal(socket.pongWrites, 1);
  parser.destroy();
  socket.blocked = false;
  socket.drain();
  await turn();
  assert.equal(socket.pongWrites, 1);
});

test("W1 control: writable receiver emits one PONG per PING", { timeout: 5000 }, async (t) => {
  const socket = socketStub(false);
  parserFor(t, socket).write(fourPings);
  await turn();
  assert.equal(socket.pongWrites, 4);
});
