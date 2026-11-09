import assert from "node:assert/strict";
import { Duplex } from "node:stream";

// Transport bytes only: the installed Client retains its serializer and parser.
export class MemoryWire extends Duplex {
  constructor() {
    super({ allowHalfOpen: false, highWaterMark: 16384 });
    this.sent = [];
    this.inBytes = 0;
    this.outBytes = 0;
    this.on("error", () => {}); // expected reset/cleanup errors are observed by Client
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    const copy = Buffer.from(chunk);
    this.outBytes += copy.length;
    if (this.outBytes > 131072) {
      callback(new Error("memory wire outbound bound"));
      return;
    }
    this.sent.push(copy);
    callback();
    queueMicrotask(() => {
      if (!this.destroyed) this.emit("outgoing");
    });
  }
  feed(value) {
    assert.equal(this.destroyed, false, "cannot feed a closed memory wire");
    if (value === null) return this.push(null);
    const copy = Buffer.from(value);
    this.inBytes += copy.length;
    assert.ok(this.inBytes <= 131072, "memory wire inbound bound");
    return this.push(copy);
  }
  transcript() { return Buffer.concat(this.sent).toString("latin1"); }
  ref() { return this; }
  unref() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
}
