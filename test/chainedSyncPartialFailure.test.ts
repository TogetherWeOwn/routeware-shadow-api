import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chained-sync partial-failure contract (TOG-9211, round-4 gap QA3).
 *
 * Combined `POST /api/v1/data-snapshot/sync` chains three per-table
 * subrequests (customer → address → container). When one table's subrequest
 * answers 500 with an upstream HTML body, two properties must hold:
 *
 * 1. **Shape**: the combined answer is a 500, never a partial 200 carrying
 *    per-table counts — a partial 200 would read as success. The body is the
 *    generic `internal` problem+json: no per-table keys, zero upstream bytes.
 * 2. **No body leak**: no byte of the upstream HTML body reaches the response
 *    or any log line (`APP ERROR`, cron `failed` line). Fixed by TOG-9205
 *    (R4-04): `post()` in `src/lib/snapshot/orchestration.ts` used to embed a
 *    1200-char slice of the subrequest body in the thrown error, and both log
 *    lines printed it verbatim. This file is the reappearance tripwire: if
 *    upstream bytes ever return to either surface, the probe below goes red.
 *
 * Non-goals (owned elsewhere): exact `detail` wording and any future
 * fixed-shape fields (table/step/status) belong to TOG-9205, so this file
 * asserts the stable subset only. Per-table counts for *completed* tables on
 * the cron `failed` line belong to TOG-6546 (partial progress) — pinned here
 * are only the pieces stable across both: the failed/unattempted tables stay
 * null and the step tag survives.
 *
 * Hermetic like `test/syncSummaryContract.test.ts`: the real app against the
 * real test `CUSTOMER_DB` (migrated via `./d1TestMigrations`); only
 * `src/lib/httpAuth` is mocked and `globalThis.fetch` is stubbed (CSV for
 * report downloads, 500 + HTML for the address subrequest, chained
 * subrequests forwarded back into the app, anything else loud).
 */

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=partial-failure-probe-session", Date.now() + 60_000);
  })
}));

import { env, exports } from "cloudflare:workers";
import { scheduled } from "../src/scheduled";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";
const ADDRESS_QID = "24";

/** Unique token standing in for upstream HTML bytes; must appear nowhere else. */
const UPSTREAM_HTML_MARKER = "CHAINED-SYNC-PROBE-TOG-9211";

/**
 * Upstream HTML error page for the failing table. Kept well under the
 * 1200-char slice `post()` embeds pre-fix, so the whole body rides the error
 * when the leak is present — the probe cannot pass by truncation luck. The
 * marker appears twice (head + body) so a fix that strips only tags still trips.
 */
const UPSTREAM_HTML_BODY = [
  "<html><head><title>Upstream explosion</title></head><body>",
  `<h1>Upstream explosion ${UPSTREAM_HTML_MARKER}</h1>`,
  "<p>The report host answered the sync poll with its maintenance page ",
  `(${UPSTREAM_HTML_MARKER}); retry the export path after the window.</p>`,
  "</body></html>"
].join("");

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

/** Chained-subrequest URLs the runner attempted, in order. */
const requested: string[] = [];

const captured: { logs: string[]; errors: string[]; warns: string[] } = {
  logs: [],
  errors: [],
  warns: []
};

function allCaptured(): string {
  return [...captured.logs, ...captured.errors, ...captured.warns].join("\n");
}

async function postCombinedSync(): Promise<{ status: number; raw: string }> {
  const resp = await exports.default.fetch("http://test.local/api/v1/data-snapshot/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${SYNC_SECRET}` }
  });
  return { status: resp.status, raw: await resp.text() };
}

async function runCronChained(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  const cronEnv = {
    ...(env as unknown as Record<string, unknown>),
    SHADOW_API_PUBLIC_BASE: "http://test.local"
  } as unknown as Env;
  const controller = {
    cron: "0 7 * * *",
    scheduledTime: Date.parse("2026-09-28T07:00:00.000Z")
  } as ScheduledController;
  await scheduled(controller, cronEnv, ctx);
  await Promise.all(pending);
}

function failedCronLine(): Record<string, unknown> {
  const line = captured.errors.find((s) => s.startsWith("data-snapshot-sync "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("data-snapshot-sync ".length)) as Record<string, unknown>;
}

async function rowCount(table: string): Promise<number> {
  const row = await db()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

describe("chained-sync partial failure (address 500s with HTML)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    await db().prepare("DELETE FROM container_snapshot").run();
    await db().prepare("DELETE FROM address_snapshot").run();
    await db().prepare("DELETE FROM customer_snapshot").run();
    await db().prepare("DELETE FROM cron_sync_state").run();
    requested.length = 0;
    captured.logs = [];
    captured.errors = [];
    captured.warns = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      captured.logs.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      captured.errors.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      captured.warns.push(a.map(String).join(" "));
    });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      // Chained per-table subrequests go back into this same Worker (origin
      // http://test.local). The address table answers 500 with an upstream
      // HTML body; every other table runs its real handler end to end.
      if (url.startsWith("http://test.local/api/v1/")) {
        requested.push(url);
        if (url.endsWith("/address-snapshot/sync")) {
          return new Response(UPSTREAM_HTML_BODY, {
            status: 500,
            headers: { "content-type": "text/html" }
          });
        }
        return exports.default.fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers as HeadersInit | undefined
        });
      }
      if (url.includes("/Reports/QueryRequestIsComplete")) {
        return new Response("true", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/Reports/QueryExecuteDownload")) {
        const qid = new URL(url).searchParams.get("queryID") ?? "";
        if (qid !== ADDRESS_QID && qid !== "23" && qid !== "25") {
          throw new Error(`Unexpected report queryID in test: ${qid}`);
        }
        return new Response(CUSTOMER_CSV, {
          status: 200,
          headers: { "content-type": "text/csv" }
        });
      }
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("answers 500 internal problem+json, never a partial 200 with per-table counts", async () => {
    // Arrange / Act — customer syncs for real, then address 500s.
    const res = await postCombinedSync();

    // Assert — a failure is a failure: the combined shape carries no
    // per-table keys at all (neither counts nor nulls-with-200), so no
    // client can mistake it for "customer synced, rest pending". Exact
    // `detail` wording is NOT pinned here — TOG-9205 owns the future
    // fixed-shape body (table/step/status) — only the stable subset below.
    expect(res.status).toBe(500);
    const body = JSON.parse(res.raw) as Record<string, unknown>;
    expect(body.type).toBe(
      "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#internal"
    );
    expect(body.title).toBe("Internal Server Error");
    expect(body.status).toBe(500);
    expect(typeof body.detail).toBe("string");
    expect(body).not.toHaveProperty("customer");
    expect(body).not.toHaveProperty("address");
    expect(body).not.toHaveProperty("container");
    // The response surface is already clean pre-fix (onError never echoes);
    // this is the dormant half of the regression tripwire — if body bytes
    // ever reappear here, this test goes red.
    expect(res.raw).not.toContain(UPSTREAM_HTML_MARKER);

    // Assert — partial progress is real and ordered: customer rows from this
    // run are present, address wrote nothing, and the container subrequest
    // was never attempted (the runner stops at the first failure).
    expect(await rowCount("customer_snapshot")).toBe(2);
    expect(await rowCount("address_snapshot")).toBe(0);
    expect(await rowCount("container_snapshot")).toBe(0);
    expect(requested).toContain("http://test.local/api/v1/customer-snapshot/sync");
    expect(requested).toContain("http://test.local/api/v1/address-snapshot/sync");
    expect(requested.some((u) => u.endsWith("/container-snapshot/sync"))).toBe(false);
  });

  it("cron records a failed run with the step tag and never attempts later tables", async () => {
    // Arrange / Act — same partial failure through the chained cron path.
    await runCronChained();

    // Assert — outcome is failed (never success/unconfigured), the error
    // names the failed step for triage, and the unattempted table stays
    // null. Completed-table counts are NOT pinned here — TOG-6546 (partial
    // progress) owns that evolution; pinning all-null would collide with it.
    const line = failedCronLine();
    expect(line.outcome).toBe("failed");
    expect(String(line.error)).toContain("[chained address]");
    expect((line.tables as Record<string, unknown>).container).toBeNull();
    expect(requested.some((u) => u.endsWith("/container-snapshot/sync"))).toBe(false);
  });

  it("zero upstream bytes reach the response or any log line", async () => {
    // Arrange / Act — both failure surfaces: the combined HTTP route (whose
    // throw lands in the `APP ERROR` log) and the chained cron path (whose
    // throw lands in the `failed` line's `error` field).
    const res = await postCombinedSync();
    await runCronChained();

    // Assert — TOG-9205 (R4-04/B1): `post()` in orchestration.ts carries
    // table/step/status only, zero subrequest body bytes. The response half
    // already passed pre-fix (onError never echoes); both halves now double
    // as the reappearance tripwire — if body bytes ever return to either
    // surface, this test goes red.
    expect(res.raw).not.toContain(UPSTREAM_HTML_MARKER);
    expect(allCaptured()).not.toContain(UPSTREAM_HTML_MARKER);
  });
});
