import { afterEach, describe, expect, it } from "vitest";

import { logEvent } from "../src/lib/logger";

const realConsole = {
  info: console.info,
  warn: console.warn,
  error: console.error,
};

afterEach(() => {
  console.info = realConsole.info;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
});

describe("logEvent", () => {
  it("writes one structured event at the matching severity", () => {
    const writes: Array<{ level: string; args: unknown[] }> = [];
    for (const level of ["info", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => writes.push({ level, args });
    }

    logEvent({
      level: "error",
      msg: "Upstream report timed out",
      route: "snapshot.customer",
      ms: 1500,
      outcome: "failed",
    });
    logEvent({ level: "info", msg: "Customer sync skipped", route: "snapshot.customer" });

    expect(writes).toEqual([
      {
        level: "error",
        args: [{
          level: "error",
          msg: "Upstream report timed out",
          route: "snapshot.customer",
          ms: 1500,
          outcome: "failed",
        }],
      },
      {
        level: "info",
        args: [{
          level: "info",
          msg: "Customer sync skipped",
          route: "snapshot.customer",
          ms: null,
        }],
      },
    ]);
  });

  it("drops unapproved context and strips nested snapshot fields", () => {
    let emitted: unknown;
    console.error = (...args: unknown[]) => {
      emitted = args[0];
    };

    const event = {
      level: "error",
      msg: "Snapshot sync failed",
      route: "scheduled.data-snapshot-sync",
      authorization: "not-for-logs",
      customerId: 123,
      tables: {
        customer: { upserted: 1, rowCount: 1, email: "not-for-logs" },
        address: null,
        container: null,
        credentials: "not-for-logs"
      }
    } as unknown as Parameters<typeof logEvent>[0];
    logEvent(event);

    expect(emitted).toEqual({
      level: "error",
      msg: "Snapshot sync failed",
      route: "scheduled.data-snapshot-sync",
      ms: null,
      tables: {
        customer: { upserted: 1, rowCount: 1 },
        address: null,
        container: null
      }
    });
  });
});
