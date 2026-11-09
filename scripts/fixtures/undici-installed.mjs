// Adapted from nodejs/undici@7507102a675b082a71437f0a00681e537875556c (MIT).
// Copyright (c) Matteo Collina and Undici contributors.
// License: scripts/fixtures/UNDICI-LICENSE.
import assert from "node:assert/strict";
import { after, mock } from "node:test";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);
let attemptedIO = 0;
const deny = () => {
  attemptedIO++;
  throw new Error("Undici regression attempted forbidden network I/O");
};
const net = localRequire("node:net");
const tls = localRequire("node:tls");
const dns = localRequire("node:dns");
const dgram = localRequire("node:dgram");
for (const [object, keys] of [
  [net, ["connect", "createConnection", "createServer"]],
  [net.Socket.prototype, ["connect"]],
  [net.Server.prototype, ["listen"]],
  [tls, ["connect", "createServer"]],
  [dns, ["lookup", "resolve"]],
  [dns.promises, ["lookup", "resolve"]],
  [dgram, ["createSocket"]],
  [localRequire("node:http"), ["request", "get", "createServer"]],
  [localRequire("node:https"), ["request", "get", "createServer"]],
  [globalThis, ["fetch"]],
]) {
  for (const key of keys) mock.method(object, key, deny);
}
after(() => {
  try {
    assert.equal(attemptedIO, 0, "caught I/O attempts must still fail");
  } finally {
    mock.restoreAll();
  }
});

const miniflareRequire = createRequire(
  createRequire(import.meta.url).resolve("miniflare/package.json"),
);
export const undiciPackagePath = miniflareRequire.resolve("undici/package.json");
export const requireUndici = createRequire(undiciPackagePath);
export const U = requireUndici("./index.js");
export const turn = () => new Promise((resolve) => setImmediate(resolve));

export async function within(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("body settlement deadline")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
