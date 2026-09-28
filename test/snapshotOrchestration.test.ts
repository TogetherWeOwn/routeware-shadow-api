import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/snapshot/orchestration.ts` is the cron's control flow, and it was at
 * 4.1%.
 *
 * The load-bearing part is `getDataSnapshotPlan`. D1 does not enforce the
 * declared foreign keys (`address.customer_id`, `container.pickup_address_id`)
 * and a streamed sync spans many `db.batch` calls rather than one transaction,
 * so referential integrity rests entirely on import order plus these guards.
 * Syncing addresses without customers, or containers without addresses, writes
 * orphan rows that no constraint rejects — and because each report reconciles,
 * the orphans then survive until someone notices the bundle reads are wrong.
 *
 * The second target is error attribution: a failure in any of the three steps
 * must be re-thrown tagged with which step failed and with `cause` intact, or a
 * scheduled-run failure is a bare D1 message with no indication of which table.
 */

type SyncCall = { table: string; batchSize: number; reconcile: boolean | undefined };

const calls: {
  syncs: SyncCall[];
  byQueryId: string[];
  byPath: string[];
  archived: string[];
  fetches: Array<{ url: string; authorization: string | undefined }>;
} = { syncs: [], byQueryId: [], byPath: [], archived: [], fetches: [] };

const behavior: {
  bodyless: boolean;
  syncError: string | null;
  /** When set, only this table's stream sync throws (TOG-6546). */
  syncErrorTable: string | null;
  httpResponses: Map<string, { status: number; body: string }>;
} = { bodyless: false, syncError: null, syncErrorTable: null, httpResponses: new Map() };

function reportResponse(): Response {
  return new Response(behavior.bodyless ? null : "CustomerID\n1,,Acme", { status: 200 });
}

vi.mock("../src/lib/snapshot/reportFetch", () => ({
  fetchReportCsvForPath: async (_env: unknown, path: string) => {
    calls.byPath.push(path);
    return reportResponse();
  }
}));

vi.mock("../src/lib/routewareQueryReportCsv", () => ({
  fetchReportCsvByQueryId: async (_env: unknown, queryId: string) => {
    calls.byQueryId.push(queryId);
    return reportResponse();
  }
}));

vi.mock("../src/lib/r2SnapshotArchive", () => ({
  // The chained path's `syncJsonToResult` validates `r2` through the real
  // guard — keep it live so the mock reports a stored outcome, not a crash.
  isR2ArchiveDetail: (v: unknown): v is { status: string } =>
    typeof v === "object" && v !== null && (v as { status?: unknown }).status === "stored",
  archiveReportCsvToR2AfterD1: async (
    _env: unknown,
    kind: string,
    body: ReadableStream<Uint8Array>,
    run: (s: ReadableStream<Uint8Array>) => Promise<unknown>,
    onArchive?: (detail: { status: string }) => void
  ) => {
    calls.archived.push(kind);
    // Mirror the real helper's TOG-6549 contract: the callback fires on every
    // path, so the orchestration stamps `r2` onto the counts. A stored marker
    // here keeps these tests on the D1 assertions they were written for.
    onArchive?.({ status: "stored" });
    // `return await`, not `return`: returning the inner promise makes this
    // frame adopt it, and workerd reports the intermediate rejected promise as
    // unhandled even though runDataSnapshotSync catches the one it awaits.
    return await run(body);
  }
}));

/** Records which table, batch size and reconcile flag each stream sync got. */
function recordSync(table: string) {
  return async (
    _db: unknown,
    _body: unknown,
    batchSize: number,
    options: { reconcile?: boolean } = {}
  ) => {
    calls.syncs.push({ table, batchSize, reconcile: options.reconcile });
    if (behavior.syncError && (behavior.syncErrorTable === null || behavior.syncErrorTable === table)) {
      throw new Error(behavior.syncError);
    }
    return { upserted: 3, rowCount: 3, deleted: 0 };
  };
}

vi.mock("../src/lib/snapshot/streamSync", () => ({
  STREAM_BATCH_CUST: 80,
  STREAM_BATCH_ADDR: 80,
  STREAM_BATCH_CONT: 40,
  syncCustomerSnapshotFromStream: recordSync("customer"),
  syncAddressSnapshotFromStream: recordSync("address"),
  syncContainerSnapshotFromStream: recordSync("container")
}));

const {
  getDataSnapshotPlan,
  runAddressSnapshotSync,
  runCustomerSnapshotSync,
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp
} = await import("../src/lib/snapshot/orchestration");

/** Only the snapshot-relevant config; everything else is irrelevant here. */
function envWith(config: Record<string, string>): Env {
  return { CUSTOMER_DB: {} as unknown as D1Database, ...config } as unknown as Env;
}

const ALL_CONFIGURED = {
  CUSTOMER_REPORT_QUERY_ID: "23",
  ADDRESS_REPORT_QUERY_ID: "24",
  CONTAINER_REPORT_QUERY_ID: "25"
};

const realConsoleLog = console.log;

beforeEach(() => {
  calls.syncs = [];
  calls.byQueryId = [];
  calls.byPath = [];
  calls.archived = [];
  calls.fetches = [];
  behavior.bodyless = false;
  behavior.syncError = null;
  behavior.syncErrorTable = null;
  behavior.httpResponses = new Map();
  console.log = () => {};
});

afterEach(() => {
  console.log = realConsoleLog;
  vi.unstubAllGlobals();
});

describe("getDataSnapshotPlan enforces import order", () => {
  it("runs all three when all three are configured", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(envWith(ALL_CONFIGURED));

    // Assert
    expect(plan).toEqual({ runCustomer: true, runAddress: true, runContainer: true });
  });

  it("runs nothing when nothing is configured", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(envWith({}));

    // Assert
    expect(plan).toEqual({ runCustomer: false, runAddress: false, runContainer: false });
  });

  it("refuses to sync addresses when customers are not configured", () => {
    // Arrange / Act — D1 does not enforce address.customer_id, so this would
    // write addresses pointing at customers that were never imported.
    const plan = getDataSnapshotPlan(envWith({ ADDRESS_REPORT_QUERY_ID: "24" }));

    // Assert
    expect(plan.runAddress).toBe(false);
  });

  it("refuses to sync containers when addresses are not configured", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(
      envWith({ CUSTOMER_REPORT_QUERY_ID: "23", CONTAINER_REPORT_QUERY_ID: "25" })
    );

    // Assert
    expect(plan).toEqual({ runCustomer: true, runAddress: false, runContainer: false });
  });

  it("refuses to sync containers when customers are not configured", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(
      envWith({ ADDRESS_REPORT_QUERY_ID: "24", CONTAINER_REPORT_QUERY_ID: "25" })
    );

    // Assert
    expect(plan.runContainer).toBe(false);
  });

  it("accepts an export path as an alternative to a query id", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(
      envWith({
        CUSTOMER_REPORT_EXPORT_PATH: "/Reports/Customer.csv",
        ADDRESS_REPORT_EXPORT_PATH: "/Reports/Address.csv",
        CONTAINER_REPORT_EXPORT_PATH: "/Reports/Container.csv"
      })
    );

    // Assert
    expect(plan).toEqual({ runCustomer: true, runAddress: true, runContainer: true });
  });

  it("treats whitespace-only configuration as unset", () => {
    // Arrange / Act
    const plan = getDataSnapshotPlan(
      envWith({ CUSTOMER_REPORT_QUERY_ID: "   ", CUSTOMER_REPORT_EXPORT_PATH: "  " })
    );

    // Assert
    expect(plan.runCustomer).toBe(false);
  });
});

describe("runCustomerSnapshotSync", () => {
  it("returns null without fetching when neither path nor query id is set", async () => {
    // Arrange / Act
    const result = await runCustomerSnapshotSync(envWith({}));

    // Assert
    expect(result).toBeNull();
    expect(calls.byQueryId).toEqual([]);
    expect(calls.byPath).toEqual([]);
  });

  it("prefers the query id over the export path", async () => {
    // Arrange / Act
    await runCustomerSnapshotSync(
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_REPORT_EXPORT_PATH: "/Reports/Customer.csv"
      })
    );

    // Assert
    expect(calls.byQueryId).toEqual(["23"]);
    expect(calls.byPath).toEqual([]);
  });

  it("falls back to the export path when there is no query id", async () => {
    // Arrange / Act
    await runCustomerSnapshotSync(
      envWith({ CUSTOMER_REPORT_EXPORT_PATH: "/Reports/Customer.csv" })
    );

    // Assert
    expect(calls.byPath).toEqual(["/Reports/Customer.csv"]);
  });

  it("archives to R2 and reconciles, using the customer batch size", async () => {
    // Arrange / Act — reconcile must be on for a report sync so upstream
    // deletions propagate.
    const result = await runCustomerSnapshotSync(envWith({ CUSTOMER_REPORT_QUERY_ID: "23" }));

    // Assert
    expect(calls.archived).toEqual(["customer"]);
    expect(calls.syncs).toEqual([{ table: "customer", batchSize: 80, reconcile: true }]);
    expect(result).toEqual({ upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } });
  });

  it("stamps the R2 archive outcome onto the counts (TOG-6549)", async () => {
    // Arrange / Act — the mock archive reports stored, so the counts carry it.
    const result = await runCustomerSnapshotSync(envWith({ CUSTOMER_REPORT_QUERY_ID: "23" }));

    // Assert — only the status travels (message/key are log strings, not counts).
    expect(result).toMatchObject({ r2: { status: "stored" } });
  });

  it("throws when the report response carries no body", async () => {
    // Arrange
    behavior.bodyless = true;

    // Act
    const error = (await runCustomerSnapshotSync(
      envWith({ CUSTOMER_REPORT_QUERY_ID: "23" })
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("Report response has no body");
  });

  it("reconciles the address table with its own batch size", async () => {
    // Arrange / Act
    await runAddressSnapshotSync(envWith({ ADDRESS_REPORT_QUERY_ID: "24" }));

    // Assert
    expect(calls.syncs).toEqual([{ table: "address", batchSize: 80, reconcile: true }]);
  });
});

describe("runDataSnapshotSync", () => {
  it("runs all three in customer, address, container order", async () => {
    // Arrange / Act — the order is the referential-integrity guarantee.
    const result = await runDataSnapshotSync(envWith(ALL_CONFIGURED));

    // Assert
    expect(calls.syncs.map((s) => s.table)).toEqual(["customer", "address", "container"]);
    expect(result).toEqual({
      customer: { upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } },
      address: { upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } },
      container: { upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } }
    });
  });

  it("returns nulls for the steps the plan skipped", async () => {
    // Arrange / Act
    const result = await runDataSnapshotSync(envWith({ CUSTOMER_REPORT_QUERY_ID: "23" }));

    // Assert
    expect(result.address).toBeNull();
    expect(result.container).toBeNull();
    expect(calls.syncs.map((s) => s.table)).toEqual(["customer"]);
  });

  it("tags a failure with the step that failed and keeps the cause", async () => {
    // Arrange — without the tag, a scheduled-run failure is a bare D1 message
    // with no indication of which table was being written.
    behavior.syncError = "D1_ERROR: database is locked";

    // Act
    const error = (await runDataSnapshotSync(envWith(ALL_CONFIGURED)).catch(
      (e: unknown) => e
    )) as Error & { cause?: unknown };

    // Assert
    expect(error.message).toBe("[customer snapshot] D1_ERROR: database is locked");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("carries the partial results and failed table on the thrown error (TOG-6546)", async () => {
    // Arrange — the acceptance case: container fails after customer and
    // address succeeded. Both tables were attempted (three sync calls) and
    // the error keeps the two successes. Only counts travel — never row data.
    const { PartialDataSnapshotSyncError } = await import(
      "../src/lib/snapshot/orchestration"
    );
    behavior.syncError = "D1_ERROR: database is locked";
    behavior.syncErrorTable = "container";

    // Act
    const error = (await runDataSnapshotSync(envWith(ALL_CONFIGURED)).catch(
      (e: unknown) => e
    )) as InstanceType<typeof PartialDataSnapshotSyncError> & { cause?: unknown };

    // Assert
    expect(calls.syncs.map((s) => s.table)).toEqual(["customer", "address", "container"]);
    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    expect(error.failedTable).toBe("container");
    expect(error.partial).toEqual({
      customer: { upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } },
      address: { upserted: 3, rowCount: 3, deleted: 0, r2: { status: "stored" } },
      container: null,
    });
    expect(error.message).toBe("[container snapshot] D1_ERROR: database is locked");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("stops before the later steps when an earlier one fails", async () => {
    // Arrange — continuing past a failed customer import would write addresses
    // against a half-written customer table.
    behavior.syncError = "boom";

    // Act
    await runDataSnapshotSync(envWith(ALL_CONFIGURED)).catch(() => undefined);

    // Assert
    expect(calls.syncs.map((s) => s.table)).toEqual(["customer"]);
  });
});

describe("runDataSnapshotSyncChainedHttp", () => {
  function stubFetch(): void {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.fetches.push({ url: String(url), authorization: headers.authorization });
      const configured = behavior.httpResponses.get(new URL(String(url)).pathname);
      const { status, body } = configured ?? {
        status: 200,
        body: JSON.stringify({ upserted: 3, rowCount: 3 })
      };
      return new Response(body, { status });
    });
  }

  it("refuses to run without the sync secret", async () => {
    // Arrange / Act
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith(ALL_CONFIGURED)
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("CUSTOMER_SNAPSHOT_SYNC_SECRET is not set");
  });

  it("posts each configured table to its own sync route with the bearer token", async () => {
    // Arrange — separate subrequests so D1's per-invocation op limit applies
    // per table rather than to the whole job.
    stubFetch();

    // Act
    await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({ ...ALL_CONFIGURED, CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret" })
    );

    // Assert
    expect(calls.fetches.map((f) => f.url)).toEqual([
      "https://api.example.test/api/v1/customer-snapshot/sync",
      "https://api.example.test/api/v1/address-snapshot/sync",
      "https://api.example.test/api/v1/container-snapshot/sync"
    ]);
    expect(new Set(calls.fetches.map((f) => f.authorization))).toEqual(
      new Set(["Bearer test-secret"])
    );
  });

  it("strips a trailing slash from the public base url", async () => {
    // Arrange — otherwise every path becomes a double slash.
    stubFetch();

    // Act
    await runDataSnapshotSyncChainedHttp(
      "https://api.example.test/",
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
      })
    );

    // Assert
    expect(calls.fetches[0].url).toBe("https://api.example.test/api/v1/customer-snapshot/sync");
  });

  it("reports a skipped table as null rather than zero counts", async () => {
    // Arrange — zeros would look like a successful empty sync.
    stubFetch();
    behavior.httpResponses.set("/api/v1/customer-snapshot/sync", {
      status: 200,
      body: JSON.stringify({ upserted: 0, rowCount: 0, skipped: true })
    });

    // Act
    const result = await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
      })
    );

    // Assert
    expect(result.customer).toBeNull();
  });

  it("throws with the step, status and truncated body when a subrequest fails", async () => {
    // Arrange
    stubFetch();
    behavior.httpResponses.set("/api/v1/customer-snapshot/sync", {
      status: 500,
      body: "X".repeat(2000)
    });

    // Act
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
      })
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe(
      `[chained customer] POST /api/v1/customer-snapshot/sync → 500: ${"X".repeat(1200)}`
    );
  });

  it("carries succeeded tables on the error when a later subrequest fails (TOG-6546)", async () => {
    // Arrange — container subrequest fails after customer/address succeeded.
    stubFetch();
    const { PartialDataSnapshotSyncError } = await import(
      "../src/lib/snapshot/orchestration"
    );
    behavior.httpResponses.set("/api/v1/container-snapshot/sync", {
      status: 500,
      body: "D1 limit",
    });

    // Act
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({ ...ALL_CONFIGURED, CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret" })
    ).catch((e: unknown) => e)) as InstanceType<typeof PartialDataSnapshotSyncError>;

    // Assert — all three attempted, the two successes kept, failed table named.
    expect(calls.fetches.map((f) => f.url)).toEqual([
      "https://api.example.test/api/v1/customer-snapshot/sync",
      "https://api.example.test/api/v1/address-snapshot/sync",
      "https://api.example.test/api/v1/container-snapshot/sync",
    ]);
    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    expect(error.failedTable).toBe("container");
    expect(error.partial.customer).toEqual({ upserted: 3, rowCount: 3 });
    expect(error.partial.address).toEqual({ upserted: 3, rowCount: 3 });
    expect(error.partial.container).toBeNull();
  });

  it("does not post the tables the plan skipped", async () => {
    // Arrange — address configured but customer is not, so the FK guard applies
    // to the chained path too.
    stubFetch();

    // Act
    const result = await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({ ADDRESS_REPORT_QUERY_ID: "24", CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret" })
    );

    // Assert
    expect(calls.fetches).toEqual([]);
    expect(result).toEqual({ customer: null, address: null, container: null });
  });

  it("fails fast with a tagged timeout when a subrequest hangs (TOG-6547)", async () => {
    // Arrange — the customer subrequest never settles (hung table). Before the
    // bound it held the cron invocation to the platform timeout, starving the
    // tables behind it with only `durationMs` as signal.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.fetches.push({ url: String(url), authorization: headers.authorization });
      return new Promise<Response>(() => {});
    });
    const { PartialDataSnapshotSyncError } = await import(
      "../src/lib/snapshot/orchestration"
    );

    // Act
    const start = Date.now();
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret",
        CHAINED_SYNC_TIMEOUT_MS: "50"
      })
    ).catch((e: unknown) => e)) as InstanceType<typeof PartialDataSnapshotSyncError>;

    // Assert — bounded (far under the 30s suite timeout), tagged with the
    // table, attributed to it, and the later tables never attempted.
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    expect(error.failedTable).toBe("customer");
    expect(error.message).toBe(
      "[chained customer] POST /api/v1/customer-snapshot/sync timed out after 50ms"
    );
    expect(error.partial).toEqual({ customer: null, address: null, container: null });
    expect(calls.fetches.map((f) => f.url)).toEqual([
      "https://api.example.test/api/v1/customer-snapshot/sync"
    ]);
  });

  it("tags a fast subrequest network failure without mapping it to a timeout (TOG-6547)", async () => {
    // Arrange — the customer subrequest fails fast with a DNS-style error,
    // not a hang: it must surface tagged with the table, never mapped to a
    // timeout, and the bearer-gate 401/429 path (`!resp.ok`) is untouched.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.fetches.push({ url: String(url), authorization: headers.authorization });
      throw new TypeError("fetch failed");
    });
    const { PartialDataSnapshotSyncError } = await import(
      "../src/lib/snapshot/orchestration"
    );

    // Act
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      envWith({
        CUSTOMER_REPORT_QUERY_ID: "23",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
      })
    ).catch((e: unknown) => e)) as InstanceType<typeof PartialDataSnapshotSyncError>;

    // Assert — rethrown verbatim out of `post()`, tagged by the outer handler.
    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    expect(error.failedTable).toBe("customer");
    expect(error.message).toBe("[chained customer] fetch failed");
  });
});

describe("readChainedSyncTimeoutMs (TOG-6547)", () => {
  it("defaults to 180s and honors the CHAINED_SYNC_TIMEOUT_MS binding", async () => {
    // Arrange / Act
    const { DEFAULT_CHAINED_SYNC_TIMEOUT_MS, readChainedSyncTimeoutMs } = await import(
      "../src/lib/upstreamTimeout"
    );

    // Assert — 180s clears the 60s report budget with headroom while staying
    // well inside the 300s platform CPU limit.
    expect(DEFAULT_CHAINED_SYNC_TIMEOUT_MS).toBe(180_000);
    expect(readChainedSyncTimeoutMs({} as Env)).toBe(180_000);
    expect(
      readChainedSyncTimeoutMs({ CHAINED_SYNC_TIMEOUT_MS: "5000" } as unknown as Env)
    ).toBe(5_000);
  });

  it("falls back on absent/invalid overrides", async () => {
    // Arrange / Act
    const { readChainedSyncTimeoutMs } = await import("../src/lib/upstreamTimeout");

    // Assert
    for (const bad of ["", "nope", "-5", "0"]) {
      expect(
        readChainedSyncTimeoutMs({ CHAINED_SYNC_TIMEOUT_MS: bad } as unknown as Env)
      ).toBe(180_000);
    }
  });
});
