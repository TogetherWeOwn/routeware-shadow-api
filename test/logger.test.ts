import { afterEach, describe, expect, it } from "vitest";

import { errorKind, logEvent } from "../src/lib/logger";
import { SnapshotForeignKeyError } from "../src/lib/snapshot/upsert";

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
      customerEmail: "not-for-logs",
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

  it.each([[], "tables-string", 42, null])(
    "omits tables that is not a record: %p",
    (tables) => {
      let emitted: unknown;
      console.info = (...args: unknown[]) => {
        emitted = args[0];
      };

      logEvent({
        level: "info",
        msg: "Sync done",
        route: "snapshot.customer",
        tables: tables as unknown as Parameters<typeof logEvent>[0]["tables"],
      });

      expect(emitted).toEqual({
        level: "info",
        msg: "Sync done",
        route: "snapshot.customer",
        ms: null,
      });
    }
  );

  it("omits empty tables and tables with no known table keys", () => {
    for (const tables of [{}, { credentials: "not-for-logs" }]) {
      let emitted: unknown;
      console.info = (...args: unknown[]) => {
        emitted = args[0];
      };

      logEvent({
        level: "info",
        msg: "Sync done",
        route: "snapshot.customer",
        tables: tables as unknown as Parameters<typeof logEvent>[0]["tables"],
      });

      expect(emitted).toEqual({
        level: "info",
        msg: "Sync done",
        route: "snapshot.customer",
        ms: null,
      });
    }
  });

  it("keeps null table counts as null", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: null,
        address: { upserted: 2, rowCount: 3 },
        container: null,
      },
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: null,
        address: { upserted: 2, rowCount: 3 },
        container: null,
      },
    });
  });

  it.each([
    ["not-a-record string", "oops"],
    ["not-a-record number", 42],
    ["not-a-record array", [1]],
    ["not-a-record object without counts", { customerId: 1 }],
    ["negative upserted", { upserted: -1, rowCount: 1 }],
    ["NaN upserted", { upserted: Number.NaN, rowCount: 1 }],
    ["Infinity upserted", { upserted: Number.POSITIVE_INFINITY, rowCount: 1 }],
    ["string upserted", { upserted: "1", rowCount: 1 }],
    ["missing upserted", { rowCount: 1 }],
    ["negative rowCount", { upserted: 1, rowCount: -2 }],
    ["NaN rowCount", { upserted: 1, rowCount: Number.NaN }],
    ["Infinity rowCount", { upserted: 1, rowCount: Number.NEGATIVE_INFINITY }],
    ["string rowCount", { upserted: 1, rowCount: "1" }],
    ["missing rowCount", { upserted: 1 }],
  ])("omits malformed customer counts (%s) while keeping a valid sibling", (_label, malformed) => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: malformed,
        address: { upserted: 2, rowCount: 3 },
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        address: { upserted: 2, rowCount: 3 },
      },
    });
  });

  it("omits the tables field when every table is malformed", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: { upserted: -1, rowCount: 1 },
        address: "oops",
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
    });
  });

  it.each([
    ["zero", 0, true],
    ["positive", 5, true],
    ["negative", -1, false],
    ["NaN", Number.NaN, false],
    ["Infinity", Number.POSITIVE_INFINITY, false],
    ["string", "2", false],
    ["null", null, false],
  ])("keeps deleted=%s only when it is a finite count of 0 or more", (_label, deleted, kept) => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: { upserted: 1, rowCount: 2, deleted },
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: kept
          ? { upserted: 1, rowCount: 2, deleted }
          : { upserted: 1, rowCount: 2 },
      },
    });
  });

  it.each([
    ["unknown status string", { status: "archived", reason: "x", key: "k" }],
    ["missing status", { reason: "x", key: "k" }],
    ["non-string status", { status: 42, reason: "x", key: "k" }],
    ["non-record string", "stored"],
    ["non-record number", 42],
    ["non-record array", [{ status: "stored" }]],
    ["non-record null", null],
  ])("drops r2 detail %s while keeping the counts", (_label, r2) => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: { upserted: 1, rowCount: 2, r2 },
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: { upserted: 1, rowCount: 2 },
      },
    });
  });

  it("keeps a valid r2 detail with string reason and key", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: {
          upserted: 1,
          rowCount: 2,
          r2: { status: "stored", reason: "archived", key: "history/customer.csv" },
        },
        address: null,
        container: null,
      },
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: {
          upserted: 1,
          rowCount: 2,
          r2: { status: "stored", reason: "archived", key: "history/customer.csv" },
        },
        address: null,
        container: null,
      },
    });
  });

  it.each([
    ["numeric reason", { status: "failed", reason: 42, key: "history/customer.csv" }, { status: "failed", key: "history/customer.csv" }],
    ["null reason", { status: "failed", reason: null, key: "history/customer.csv" }, { status: "failed", key: "history/customer.csv" }],
    ["object key", { status: "failed", reason: "timeout", key: { bucket: "b" } }, { status: "failed", reason: "timeout" }],
    ["numeric key", { status: "failed", reason: "timeout", key: 7 }, { status: "failed", reason: "timeout" }],
    ["both non-string", { status: "disabled", reason: 1, key: ["k"] }, { status: "disabled" }],
  ])("keeps r2 reason/key only when they are strings: %s", (_label, r2, expectedR2) => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: { upserted: 1, rowCount: 2, r2 },
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: { upserted: 1, rowCount: 2, r2: expectedR2 },
      },
    });
  });

  it("never emits unknown keys inside a table record", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      tables: {
        customer: {
          upserted: 1,
          rowCount: 2,
          customerId: 123,
          email: "not-for-logs",
          credentials: "not-for-logs",
        },
      } as unknown as Parameters<typeof logEvent>[0]["tables"],
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      tables: {
        customer: { upserted: 1, rowCount: 2 },
      },
    });
  });

  it("drops allowlisted context fields that hold objects, arrays or non-finite numbers", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      outcome: { nested: "object" },
      summary: ["array"],
      method: ["GET"],
      hits: Number.NaN,
      misses: Number.POSITIVE_INFINITY,
      durationMs: Number.NEGATIVE_INFINITY,
      timeoutMs: Number.NaN,
      status: { code: 200 },
      d1LimitRisk: ["true"],
    } as unknown as Parameters<typeof logEvent>[0]);

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
    });
  });

  it("keeps safe scalar context fields including booleans, null ms and finite numbers", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: 12,
      outcome: "ok",
      d1LimitRisk: true,
      hits: 3,
      misses: 0,
      summary: null as unknown as string,
      status: 200,
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: 12,
      outcome: "ok",
      d1LimitRisk: true,
      hits: 3,
      misses: 0,
      summary: null,
      status: 200,
    });
  });

  it("skips allowlisted fields that are explicitly undefined", () => {
    let emitted: unknown;
    console.info = (...args: unknown[]) => {
      emitted = args[0];
    };

    logEvent({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      summary: undefined,
      outcome: "ok",
    });

    expect(emitted).toEqual({
      level: "info",
      msg: "Sync done",
      route: "snapshot.customer",
      ms: null,
      outcome: "ok",
    });
  });
});

describe("errorKind", () => {
  it("returns the error's name, never its message", () => {
    expect(errorKind(new TypeError("upstream body <html>secret</html>"))).toBe("TypeError");
  });

  it("reports the innermost cause's class for wrapped errors", () => {
    expect(errorKind(new Error("outer", { cause: new RangeError("inner") }))).toBe("RangeError");
  });

  it("returns unknown for values that are not errors", () => {
    expect(errorKind("raw string with secret")).toBe("unknown");
    expect(errorKind(null)).toBe("unknown");
  });

  it("keeps a named repo error class that wraps a generic database error", () => {
    const fkError = new SnapshotForeignKeyError(
      {
        table: "address_snapshot",
        column: "customer_id",
        parentTable: "customer_snapshot",
        missingKeys: [7],
        rowOffset: 0
      },
      { cause: new Error("D1_ERROR: FOREIGN KEY constraint failed") }
    );
    expect(errorKind(fkError)).toBe("SnapshotForeignKeyError");
  });

  it("stops on a cyclic cause chain", () => {
    const looped = new Error("loop");
    looped.cause = looped;
    expect(errorKind(looped)).toBe("Error");
  });
});
