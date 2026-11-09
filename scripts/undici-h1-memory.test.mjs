import assert from "node:assert/strict";
import { test } from "node:test";
import { U, within } from "./fixtures/undici-installed.mjs";
import { MemoryWire } from "./fixtures/undici-memory-wire.mjs";

function fixture(t, respond) {
  const wires = [];
  const client = new U.Client("http://body.invalid", {
    pipelining: 1,
    connect(options, callback) {
      assert.equal(options.hostname, "body.invalid");
      assert.ok(wires.length < 2, "unexpected third connection");
      const wire = new MemoryWire();
      wires.push(wire);
      wire.on("outgoing", () => respond(wire, wires.indexOf(wire)));
      queueMicrotask(() => callback(null, wire));
    },
  });
  t.after(async () => {
    for (const wire of wires) wire.destroy();
    await within(client.destroy());
    assert.ok(wires.every((wire) => wire.destroyed));
  });
  return { client, wires };
}

for (const type of ["text/plain\r\nX-Fixture: 1", "text/plain\r", "text/plain\n", "text/plain\0"]) {
  test(`B1: H1 writer refuses derived Blob type ${JSON.stringify(type)} before writing`, { timeout: 5000 }, async (t) => {
    const { client, wires } = fixture(t, () => assert.fail("invalid Blob must not write"));
    class BadType extends Blob {
      get type() { return type; }
    }
    await within(assert.rejects(
      client.request({ method: "POST", path: "/", body: new BadType(["a"]) }),
      (error) => error instanceof U.errors.InvalidArgumentError && error.code === "UND_ERR_INVALID_ARG",
    ));
    assert.equal(wires.length, 1, "must reach real connected H1 writer");
    assert.equal(wires[0].outBytes, 0);
  });
}

function response(body) {
  return `HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\n${body}`;
}

test("B1 control: normal Blob writes its derived type and exact body", { timeout: 5000 }, async (t) => {
  let responded = false;
  const { client, wires } = fixture(t, (wire) => {
    if (!responded && wire.transcript().endsWith("\r\n\r\na")) {
      responded = true;
      wire.feed(response("Y"));
    }
  });
  const result = await within(client.request({
    method: "POST", path: "/", body: new Blob(["a"], { type: "text/plain" }),
  }));
  assert.equal(await within(result.body.text()), "Y");
  assert.equal(wires.length, 1);
  const [headers, body] = wires[0].transcript().split("\r\n\r\n");
  assert.equal((headers.match(/content-type:/gi) ?? []).length, 1);
  assert.match(headers, /\r\ncontent-type: text\/plain\r\n/i);
  assert.equal(body, "a");
});

function requestCount(wire) {
  return (wire.transcript().match(/GET \/ HTTP\/1\.1\r\n/g) ?? []).length;
}

// These real H1 stream transitions do NOT prove kernel poll ordering or
// referenced-Immediate process liveness: MemoryWire ref/unref are no-ops, and
// the case deadline itself keeps the process alive. That qualification stays open.
for (const disturbance of ["buffered", "validating", "fin", "reset", "clean"]) {
  test(`I1 PARTIAL: pending H1 reuse with ${disturbance} transport`, { timeout: 5000 }, async (t) => {
    const replied = new Map();
    const disconnects = [];
    const reset = new Error("fixture peer reset");
    const { client, wires } = fixture(t, (wire, index) => {
      const requests = requestCount(wire);
      const previous = replied.get(wire) ?? 0;
      if (requests <= previous) return;
      assert.equal(requests, previous + 1);
      assert.ok(requests <= 2);
      replied.set(wire, requests);
      wire.feed(response(index === 0 && requests === 1 ? "A" : "B"));
    });
    client.on("disconnect", (_origin, _targets, error) => disconnects.push(error));
    const first = await within(client.request({ method: "GET", path: "/" }));
    assert.equal(await within(first.body.text()), "A");
    const old = wires[0];
    assert.equal(requestCount(old), 1);
    const poison = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Fixture-Poison: yes\r\n\r\n";
    if (disturbance === "buffered") old.feed(poison);
    const pending = client.request({ method: "GET", path: "/" });
    // Attach settlement immediately, before disturbing the connection.
    const settled = within(pending);
    assert.equal(requestCount(old), 1, "reuse must defer before writing GET 2");
    queueMicrotask(() => {
      if (disturbance === "validating") old.feed(poison);
      else if (disturbance === "fin") old.feed(null);
      else if (disturbance === "reset") old.destroy(reset);
    });
    const second = await settled;
    assert.equal(await within(second.body.text()), "B");
    assert.equal(second.headers["x-fixture-poison"], undefined);
    if (disturbance === "clean") {
      assert.equal(wires.length, 1);
      assert.equal(requestCount(old), 2);
    } else {
      assert.equal(wires.length, 2);
      assert.equal(requestCount(old), 1, "no GET 2 may reach poisoned/closed wire");
      assert.equal(requestCount(wires[1]), 1);
      assert.equal(old.destroyed, true);
      assert.ok(disconnects.length >= 1);
      if (disturbance === "reset") assert.ok(disconnects.includes(reset));
    }
  });
}
