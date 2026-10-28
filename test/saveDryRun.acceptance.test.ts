import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R21-02 acceptance: `?dryRun=true` validation for entity saves.
 *
 * Contract (from TOG-38651; Builder TOG-38652 builds on this branch):
 *
 * - `?dryRun=true` on all three `POST /api/v1/data/*` saves runs admission,
 *   the stored-cookie presence check and the anti-forgery preparation that
 *   applies to that request — it does not validate upstream form/business
 *   rules or prove a stored cookie is currently authenticated. It persists
 *   nothing and keeps authorization identical (Kubernetes dry-run precedent).
 * - Strict `dryRun`-only query validation: only `dryRun=true|false` passes;
 *   unknown keys, typos, empty values and repeats are 400s.
 * - Dry-pass envelope (HTTP 200): `{ ok: true, dryRun: true,
 *   routewareStatus: null, <posted ids>, upstreamBytes: 0,
 *   localSync: { done: false, code: "not_attempted" } }`. Posted ids are parsed
 *   from the submitted form only (positive or null) — never from an upstream
 *   response (there is none) and never via the container D1 owner fallback.
 *   No submitted fields and no upstream body are echoed (exact key set).
 * - Zero effects on dry-pass: zero upstream POST (save or login), zero D1
 *   writes, zero invalidations, zero `syncCustomerDetailFullToD1` calls, zero
 *   `establishSession` calls. Prep GETs (anti-forgery modal fetches) may run
 *   on the token-preparation path — they are reads, and dry-fail parity
 *   proves prep ran there. Supplied-token and disabled-auto-token requests
 *   skip that GET, and the customer path may reuse its cached token.
 * - No-session dry fails closed 503 `application/problem+json` (never a login
 *   POST, never `establishSession`). Empty-body 400 precedes the session check
 *   (same order as live).
 * - Validation-failure parity: empty-body 400, missing-parent 400 and
 *   prep-error 502 are byte-comparable to the live path (same status, type,
 *   title and detail prefix).
 * - Live-path preservation: absent or `?dryRun=false` runs the real write
 *   (upstream POST 1, sync 1, D1 write 1 via the sync double, invalidation
 *   >=1, `routewareStatus: 200`, `upstreamBytes > 0`, `localSync.done: true`,
 *   never `dryRun: true`).
 * - Auth precedence: outer 401s (missing/wrong/read-token-on-POST) precede any
 *   query validation; inner 401 (API token, not the sync secret) precedes
 *   unknown-key 400s but FOLLOWS invalid-value 400s (validator-first for known
 *   keys, manual unknown-key check after `requireSnapshotAuth` — the TOG-38577
 *   precedent; a zod `.strict()` would invert the unknown-key order and fail).
 * - OpenAPI: the three POST ops publish the shared `dryRun` enum query param.
 *
 * Harness: `app.fetch` with synthetic Env (fake D1, stubbed `globalThis.fetch`
 * for upstream, configurable session stub). Unexpected origins/paths throw, so
 * unexpected network fails the test. `detailFullSync` and `entityDataCache`
 * are mocked to count effects (the sync double records one synthetic D1 write
 * so live/dry are distinguishable via the D1 spy; the real sync performs D1
 * writes). `establishSession` is mocked to count calls and simulate the login
 * POST it would issue, so "never a login POST" is observable at the network
 * spy even though the real HTTP login never runs.
 *
 * RED baseline (pre-implementation head `ad3873ee`, source baseline
 * `4cdc0db1`): dry-pass envelope, unknown-key 400s, invalid-value 400s,
 * API-token+invalid-value 400, no-session 503s and OpenAPI param assertions
 * FAIL (the flag is ignored and the live write runs); empty-body/missing-
 * parent/prep-error parity, live preservation and outer/inner 401 controls
 * PASS (dry currently IS live). The Builder turns the RED set GREEN without
 * breaking the controls.
 *
 * Owned by the Test Author (TOG-38651). The Builder (TOG-38652) must not edit
 * this file.
 */

const ORIGIN = "https://upstream.test";
const SYNC_SECRET = "synthetic-dry-run-sync-secret";
const API_TOKEN = "synthetic-dry-run-api-token";
const READ_TOKEN = "synthetic-dry-run-read-token";
const BAD_REQUEST =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const BAD_GATEWAY =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway";
const TOKEN_HTML =
  '<html><body><form><input name="__RequestVerificationToken" value="FAKE-TOKEN" /></form></body></html>';

type Work = {
  upstreamSaves: string[];
  upstreamModals: string[];
  upstreamModalCookies: string[];
  loginPosts: number;
  detailFetches: number;
  syncs: number[];
  invalidations: Array<Record<string, unknown>>;
  d1Writes: string[];
  d1Reads: number;
  establishCalls: number;
};

const work: Work = {
  upstreamSaves: [],
  upstreamModals: [],
  upstreamModalCookies: [],
  loginPosts: 0,
  detailFetches: 0,
  syncs: [],
  invalidations: [],
  d1Writes: [],
  d1Reads: 0,
  establishCalls: 0
};

const upstreamBehavior = {
  modalStatus: 200,
  modalNoToken: false,
  modalLoginChallenge: false,
  saveStatus: 200,
  saveBody: '{"success":true}',
  challengeCookieless: false
};

const sessionBehavior: { mode: "valid" | "none" } = { mode: "valid" };
const preparationBehavior: { autoTokenEnabled: boolean } = { autoTokenEnabled: true };

const MODAL_PATHS = new Set([
  "/WebRW/Customer/AddNewLong",
  "/WebRW/Customer/LoadLongCustomerModal",
  "/WebRW/PickupAddress/CreateBlankAddress",
  "/WebRW/PickupAddress/LoadAddressModal",
  "/WebRW/Container/CreateBlankContainer",
  "/WebRW/Container/LoadContainerModal"
]);
const SAVE_PATHS = new Set([
  "/WebRW/Customer/SaveCustomerLongForm",
  "/WebRW/PickupAddress/SaveAddressForm",
  "/WebRW/Container/SaveContainerForm"
]);

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    invalidateCustomerGraph: async (params: unknown) => {
      work.invalidations.push({ type: "graph-legacy", params });
    },
    invalidateCustomerGraphWithRetry: async (params: unknown, maxAttempts?: number) => {
      work.invalidations.push({ type: "graph", params, maxAttempts });
    },
    invalidateDataEntity: async (kind: string, id: number) => {
      work.invalidations.push({ type: "entity", kind, id });
    }
  };
});

vi.mock("../src/lib/detailFullSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/detailFullSync")>();
  return {
    ...actual,
    syncCustomerDetailFullToD1: async (env: Env, _stub: unknown, customerId: number) => {
      work.syncs.push(customerId);
      // The real sync upserts D1 rows; the double records one synthetic write
      // so the D1 spy distinguishes live (1) from dry (0).
      await env.CUSTOMER_DB.prepare(
        "INSERT INTO customer_snapshot (customer_id) VALUES (?)"
      )
        .bind(customerId)
        .run();
      return { addressIds: [10], containerIds: [100] };
    }
  };
});

vi.mock("../src/lib/establishSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/establishSession")>();
  return {
    ...actual,
    establishSession: async () => {
      work.establishCalls += 1;
      // Simulate the login POST the real establish would issue so the
      // "never a login POST" guarantee is observable at the network spy.
      await fetch(`${ORIGIN}/WebRW/Account/Login`, {
        method: "POST",
        body: "UserName=synthetic&Password=synthetic"
      });
      throw new Error("login attempted (mocked establishSession)");
    }
  };
});

const { default: app } = await import("../src/app");
const { clearAntiForgeryTokenCache } = await import("../src/lib/customerSaveAutoToken");

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      const isWrite = /^\s*(INSERT|UPDATE|DELETE|UPSERT|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              work.d1Reads += 1;
              // Container owner fallback: `SELECT customer_id FROM
              // address_snapshot WHERE pickup_address_id = ?`.
              if (sql.includes("FROM address_snapshot") && sql.includes("customer_id")) {
                return args[0] === 10 ? { customer_id: 5 } : null;
              }
              return null;
            },
            async all() {
              work.d1Reads += 1;
              return { results: [] };
            },
            async run() {
              if (isWrite) {
                work.d1Writes.push(sql);
              } else {
                work.d1Reads += 1;
              }
              return { success: true };
            }
          };
        }
      };
    },
    batch: async (stmts: unknown[]) => {
      work.d1Writes.push(`BATCH x${stmts.length}`);
      return stmts.map(() => ({ success: true }));
    }
  } as unknown as D1Database;
}

function appEnv(): Env {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/get") {
        if (sessionBehavior.mode === "none") {
          return Response.json({ cookieHeader: null, expiresAtMs: null, refreshing: false });
        }
        return Response.json({
          cookieHeader: "session=FAKE",
          expiresAtMs: Date.now() + 600_000,
          refreshing: false
        });
      }
      if (url.pathname === "/throttle/failure") {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (url.pathname === "/throttle/clear") {
        return new Response("OK");
      }
      throw new Error(`Unexpected AUTH_SESSION call in saveDryRun acceptance test: ${url.pathname}`);
    }
  };
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: "/WebRW",
    LOGIN_URL: `${ORIGIN}/WebRW/Account/Login`,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    SHADOW_API_TOKEN: API_TOKEN,
    SHADOW_API_READ_TOKEN: READ_TOKEN,
    OPENAPI_DOCS_ENABLED: "true",
    CUSTOMER_SAVE_AUTO_TOKEN: preparationBehavior.autoTokenEnabled ? "true" : "false",
    SESSION_TTL_SECONDS: "3600",
    CUSTOMER_DB: fakeDb(),
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => stub }
  } as unknown as Env;
}

async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = new URL(
    req ? req.url : typeof input === "string" ? input : input instanceof URL ? input.href : String(input)
  );
  if (url.origin !== ORIGIN) {
    throw new Error(`Unexpected network in saveDryRun acceptance test: ${url.origin}${url.pathname}`);
  }
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? req?.headers);
  const hasSession = (headers.get("cookie") ?? "").includes("session=FAKE");

  if (SAVE_PATHS.has(url.pathname)) {
    work.upstreamSaves.push(`${method} ${url.pathname}`);
    if (upstreamBehavior.challengeCookieless && !hasSession) {
      return new Response("login", {
        status: 302,
        headers: { location: "/WebRW/Account/Login?returnUrl=%2F" }
      });
    }
    return new Response(upstreamBehavior.saveBody, {
      status: upstreamBehavior.saveStatus,
      headers: { "content-type": "application/json" }
    });
  }
  if (MODAL_PATHS.has(url.pathname)) {
    work.upstreamModals.push(`${method} ${url.pathname}`);
    work.upstreamModalCookies.push(headers.get("cookie") ?? "");
    if (
      (upstreamBehavior.modalLoginChallenge && method === "GET") ||
      (upstreamBehavior.challengeCookieless && !hasSession)
    ) {
      return new Response("login", {
        status: 302,
        headers: { location: "/WebRW/Account/Login?returnUrl=%2F" }
      });
    }
    if (upstreamBehavior.modalStatus !== 200) {
      return new Response("modal boom", { status: upstreamBehavior.modalStatus });
    }
    if (upstreamBehavior.modalNoToken) {
      return new Response("<html><body>no token here</body></html>", {
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(TOKEN_HTML, { headers: { "content-type": "text/html" } });
  }
  if (url.pathname === "/WebRW/Account/Login") {
    if (method === "POST") {
      work.loginPosts += 1;
      return new Response("login ok", { status: 200 });
    }
    return new Response("<html><body>login page</body></html>", {
      headers: { "content-type": "text/html" }
    });
  }
  if (url.pathname === "/WebRW/Customer/GetCustomerDetailFull") {
    // The sync is mocked, so a detail fetch is always unexpected — count it
    // (the tests assert zero) and return a canned graph so the failure is an
    // assertion, not an exception.
    work.detailFetches += 1;
    return Response.json({
      currentCustomer: { CustomerID: 5, CompanyName: "Synthetic Co" },
      data: []
    });
  }
  throw new Error(`Unexpected upstream path in saveDryRun acceptance test: ${method} ${url.pathname}`);
}

function resetWork(): void {
  work.upstreamSaves.length = 0;
  work.upstreamModals.length = 0;
  work.upstreamModalCookies.length = 0;
  work.loginPosts = 0;
  work.detailFetches = 0;
  work.syncs.length = 0;
  work.invalidations.length = 0;
  work.d1Writes.length = 0;
  work.d1Reads = 0;
  work.establishCalls = 0;
  upstreamBehavior.modalStatus = 200;
  upstreamBehavior.modalNoToken = false;
  upstreamBehavior.modalLoginChallenge = false;
  upstreamBehavior.saveStatus = 200;
  upstreamBehavior.saveBody = '{"success":true}';
  upstreamBehavior.challengeCookieless = false;
  sessionBehavior.mode = "valid";
  preparationBehavior.autoTokenEnabled = true;
}

beforeEach(() => {
  resetWork();
  clearAntiForgeryTokenCache();
  vi.stubGlobal("fetch", fakeUpstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type EntityKind = "customer" | "address" | "container";

const UPDATE_BODIES: Record<EntityKind, string> = {
  customer: "CustomerID=5&CompanyName=Synthetic+Co&Enabled=true",
  address: "PickupAddressID=10&CustomerID=5&Address=1+Synthetic+Way",
  container: "ContainerID=100&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-100"
};

const CREATE_BODIES: Record<EntityKind, string> = {
  customer: "CustomerID=0&CompanyName=New+Co&Enabled=true",
  address: "PickupAddressID=0&CustomerID=5&Address=1+New+Way",
  container: "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=NEW-1"
};

async function postSave(
  kind: EntityKind,
  query: string,
  body: string,
  auth: string | null = `Bearer ${SYNC_SECRET}`
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (auth !== null) {
    headers.set("authorization", auth);
  }
  return await app.fetch(
    new Request(`https://synthetic.example.test/api/v1/data/${kind}${query}`, {
      method: "POST",
      headers,
      body
    }),
    appEnv(),
    ctx
  );
}

function expectZeroEffects(): void {
  expect(work.upstreamSaves).toEqual([]);
  expect(work.loginPosts).toBe(0);
  expect(work.establishCalls).toBe(0);
  expect(work.syncs).toEqual([]);
  expect(work.d1Writes).toEqual([]);
  expect(work.invalidations).toEqual([]);
  expect(work.detailFetches).toBe(0);
}

function expectLiveEffects(): void {
  expect(work.upstreamSaves).toHaveLength(1);
  expect(work.loginPosts).toBe(0);
  expect(work.establishCalls).toBe(0);
  expect(work.syncs).toHaveLength(1);
  expect(work.d1Writes).toHaveLength(1);
  expect(work.invalidations.length).toBeGreaterThanOrEqual(1);
  expect(work.detailFetches).toBe(0);
}

type DryEnvelope = Record<string, unknown>;

function expectDryEnvelopeKeys(kind: EntityKind, body: DryEnvelope): void {
  const expected =
    kind === "customer"
      ? ["customerId", "dryRun", "localSync", "ok", "routewareStatus", "upstreamBytes"]
      : kind === "address"
        ? ["customerId", "dryRun", "localSync", "ok", "pickupAddressId", "routewareStatus", "upstreamBytes"]
        : [
            "containerId",
            "customerId",
            "dryRun",
            "localSync",
            "ok",
            "pickupAddressId",
            "routewareStatus",
            "upstreamBytes"
          ];
  expect(Object.keys(body).sort()).toEqual(expected);
  // Never echo submitted fields or the upstream body.
  const raw = JSON.stringify(body);
  expect(raw).not.toContain("Synthetic");
  expect(raw).not.toContain("FAKE-TOKEN");
  expect(raw).not.toContain("success");
}

describe("save dry-run: dry-pass envelope and zero effects", () => {
  it("customer update dry-runs with posted ids and zero effects", async () => {
    const res = await postSave("customer", "?dryRun=true", UPDATE_BODIES.customer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: 5,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectDryEnvelopeKeys("customer", body);
    expectZeroEffects();
    // Prep ran (token-less body fetched the modal) but no save POST followed.
    expect(work.upstreamModals.length).toBeGreaterThanOrEqual(1);
  });

  it("address update dry-runs with posted ids and zero effects", async () => {
    const res = await postSave("address", "?dryRun=true", UPDATE_BODIES.address);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: 5,
      pickupAddressId: 10,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectDryEnvelopeKeys("address", body);
    expectZeroEffects();
    expect(work.upstreamModals.length).toBeGreaterThanOrEqual(1);
  });

  it("container update dry-runs with posted ids and zero effects", async () => {
    const res = await postSave("container", "?dryRun=true", UPDATE_BODIES.container);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: 5,
      pickupAddressId: 10,
      containerId: 100,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectDryEnvelopeKeys("container", body);
    expectZeroEffects();
    expect(work.upstreamModals.length).toBeGreaterThanOrEqual(1);
  });

  it("customer create dry-runs with null id (no upstream to resolve from) and zero effects", async () => {
    const res = await postSave("customer", "?dryRun=true", CREATE_BODIES.customer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: null,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectZeroEffects();
  });

  it("address create dry-runs with null address id and zero effects", async () => {
    const res = await postSave("address", "?dryRun=true", CREATE_BODIES.address);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: 5,
      pickupAddressId: null,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectZeroEffects();
  });

  it("container create dry-runs with null container id and zero effects", async () => {
    const res = await postSave("container", "?dryRun=true", CREATE_BODIES.container);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body).toEqual({
      ok: true,
      dryRun: true,
      routewareStatus: null,
      customerId: 5,
      pickupAddressId: 10,
      containerId: null,
      upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    });
    expectZeroEffects();
  });

  it("dry-run with an explicit client token skips the modal yet still saves nothing", async () => {
    const res = await postSave(
      "customer",
      "?dryRun=true",
      `__RequestVerificationToken=CLIENT-TOKEN&${UPDATE_BODIES.customer}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.dryRun).toBe(true);
    expect(body.routewareStatus).toBeNull();
    expect(body.upstreamBytes).toBe(0);
    expectZeroEffects();
    expect(work.upstreamModals).toEqual([]);
  });

  it.each(["address", "container"] as const)(
    "%s dry-run with an explicit client token skips the modal yet still saves nothing",
    async (kind) => {
      const res = await postSave(
        kind,
        "?dryRun=true",
        `__RequestVerificationToken=CLIENT-TOKEN&${UPDATE_BODIES[kind]}`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as DryEnvelope;
      expect(body.dryRun).toBe(true);
      expect(body.routewareStatus).toBeNull();
      expect(body.upstreamBytes).toBe(0);
      expectZeroEffects();
      expect(work.upstreamModals).toEqual([]);
    }
  );

  it.each(["customer", "address", "container"] as const)(
    "%s dry-run with auto-token disabled skips the modal yet still saves nothing",
    async (kind) => {
      preparationBehavior.autoTokenEnabled = false;
      const res = await postSave(kind, "?dryRun=true", UPDATE_BODIES[kind]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DryEnvelope;
      expect(body.dryRun).toBe(true);
      expect(body.routewareStatus).toBeNull();
      expect(body.upstreamBytes).toBe(0);
      expectZeroEffects();
      expect(work.upstreamModals).toEqual([]);
    }
  );

  // A supplied token takes no upstream trip at all: even with the modal
  // set to challenge the stored cookie and a body carrying only an id
  // plus an unknown business field, the local dry pass succeeds. That is
  // the executable proof that this branch proves neither a currently
  // authenticated session nor complete upstream business validation.
  const minimalExplicitBodies: Record<EntityKind, string> = {
    customer: "__RequestVerificationToken=CLIENT-TOKEN&CustomerID=5&UnknownBusinessField=synthetic",
    address: "__RequestVerificationToken=CLIENT-TOKEN&PickupAddressID=10&UnknownBusinessField=synthetic",
    container: "__RequestVerificationToken=CLIENT-TOKEN&ContainerID=100&UnknownBusinessField=synthetic"
  };
  it.each(["customer", "address", "container"] as const)(
    "%s explicit-token dry pass contacts no upstream, so it validates no upstream session or business rules",
    async (kind) => {
      upstreamBehavior.modalLoginChallenge = true;
      const res = await postSave(kind, "?dryRun=true", minimalExplicitBodies[kind]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DryEnvelope;
      expect(body.dryRun).toBe(true);
      expect(body.ok).toBe(true);
      expect(body.routewareStatus).toBeNull();
      expectZeroEffects();
      expect(work.upstreamModals).toEqual([]);
    }
  );

  it("customer token preparation may reuse its cached token instead of a second modal GET", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await postSave("customer", "?dryRun=true", UPDATE_BODIES.customer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DryEnvelope;
      expect(body.dryRun).toBe(true);
    }
    expectZeroEffects();
    expect(work.upstreamModals).toHaveLength(1);
  });

  it("dry-run twice issues no save POSTs either time (non-idempotent create stays safe)", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await postSave("customer", "?dryRun=true", CREATE_BODIES.customer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DryEnvelope;
      expect(body.dryRun).toBe(true);
    }
    expectZeroEffects();
  });
});

describe("save dry-run: strict dryRun-only query validation", () => {
  const kinds: EntityKind[] = ["customer", "address", "container"];

  it.each(kinds)("POST /api/v1/data/%s rejects an unknown query key with 400 and zero effects", async (kind) => {
    const res = await postSave(kind, "?foo=bar", UPDATE_BODIES[kind]);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { type: string; status: number; title: string; detail: string };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expect(body.title).toBe("Bad Request");
    expectZeroEffects();
    expect(work.upstreamModals).toEqual([]);
  });

  it.each(kinds)(
    "POST /api/v1/data/%s rejects dryRun mixed with an unknown key",
    async (kind) => {
      const res = await postSave(kind, "?dryRun=true&foo=bar", UPDATE_BODIES[kind]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type: string; status: number };
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
      expectZeroEffects();
    }
  );

  it.each(kinds)("POST /api/v1/data/%s rejects a lowercase dryrun typo", async (kind) => {
    const res = await postSave(kind, "?dryrun=true", UPDATE_BODIES[kind]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expectZeroEffects();
  });

  const invalidValues = ["maybe", "1", "True", "TRUE", "", "null"];
  it.each(kinds)("POST /api/v1/data/%s rejects invalid dryRun values", async (kind) => {
    for (const value of invalidValues) {
      resetWork();
      clearAntiForgeryTokenCache();
      const res = await postSave(kind, `?dryRun=${value}`, UPDATE_BODIES[kind]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type: string; status: number };
      expect(body.type).toBe(BAD_REQUEST);
      expect(body.status).toBe(400);
      expectZeroEffects();
    }
  });

  it.each(kinds)("POST /api/v1/data/%s rejects repeated dryRun keys", async (kind) => {
    const res = await postSave(kind, "?dryRun=true&dryRun=false", UPDATE_BODIES[kind]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expectZeroEffects();
  });
});

describe("save dry-run: validation-failure parity with the live path", () => {
  const kinds: EntityKind[] = ["customer", "address", "container"];

  it.each(kinds)("empty body is 400 on the dry path for %s, same as live", async (kind) => {
    const dry = await postSave(kind, "?dryRun=true", "");
    expect(dry.status).toBe(400);
    const dryBody = (await dry.json()) as { type: string; status: number; detail: string };
    expect(dryBody.type).toBe(BAD_REQUEST);
    expect(dryBody.status).toBe(400);
    expectZeroEffects();

    resetWork();
    clearAntiForgeryTokenCache();
    const live = await postSave(kind, "", "");
    expect(live.status).toBe(400);
    const liveBody = (await live.json()) as { type: string; status: number; detail: string };
    expect(liveBody.type).toBe(dryBody.type);
    expect(liveBody.detail).toBe(dryBody.detail);
  });

  it("new address without CustomerID is 400 on dry and live alike", async () => {
    const dry = await postSave("address", "?dryRun=true", "PickupAddressID=0&Address=1+New+Way");
    expect(dry.status).toBe(400);
    const dryBody = (await dry.json()) as { type: string; status: number; detail: string };
    expect(dryBody.type).toBe(BAD_REQUEST);
    expect(dryBody.detail).toContain("New address requires CustomerID in POST body");
    expectZeroEffects();

    resetWork();
    clearAntiForgeryTokenCache();
    const live = await postSave("address", "", "PickupAddressID=0&Address=1+New+Way");
    expect(live.status).toBe(400);
    const liveBody = (await live.json()) as { type: string; detail: string };
    expect(liveBody.detail).toBe(dryBody.detail);
  });

  it("new container without PickupAddressID is 400 on dry and live alike", async () => {
    const dry = await postSave("container", "?dryRun=true", "ContainerID=0&SerialNumber=NEW-1");
    expect(dry.status).toBe(400);
    const dryBody = (await dry.json()) as { type: string; status: number; detail: string };
    expect(dryBody.type).toBe(BAD_REQUEST);
    expect(dryBody.detail).toContain("New container requires PickupAddressID in POST body");
    expectZeroEffects();

    resetWork();
    clearAntiForgeryTokenCache();
    const live = await postSave("container", "", "ContainerID=0&SerialNumber=NEW-1");
    expect(live.status).toBe(400);
    const liveBody = (await live.json()) as { type: string; detail: string };
    expect(liveBody.detail).toBe(dryBody.detail);
  });

  it.each(kinds)("modal 500 is 502 on dry and live alike for %s", async (kind) => {
    upstreamBehavior.modalStatus = 500;
    const dry = await postSave(kind, "?dryRun=true", UPDATE_BODIES[kind]);
    expect(dry.status).toBe(502);
    const dryBody = (await dry.json()) as { type: string; status: number; detail: string };
    expect(dryBody.type).toBe(BAD_GATEWAY);
    expect(dryBody.status).toBe(502);
    expect(work.upstreamSaves).toEqual([]);
    expect(work.syncs).toEqual([]);
    expect(work.d1Writes).toEqual([]);
    expect(work.invalidations).toEqual([]);
    expect(work.upstreamModals.length).toBeGreaterThanOrEqual(1);

    resetWork();
    clearAntiForgeryTokenCache();
    upstreamBehavior.modalStatus = 500;
    const live = await postSave(kind, "", UPDATE_BODIES[kind]);
    expect(live.status).toBe(502);
    const liveBody = (await live.json()) as { type: string; detail: string };
    expect(liveBody.type).toBe(dryBody.type);
    expect(liveBody.detail).toBe(dryBody.detail);
  });

  it.each(kinds)("modal HTML without a token is 502 on dry and live alike for %s", async (kind) => {
    upstreamBehavior.modalNoToken = true;
    const dry = await postSave(kind, "?dryRun=true", UPDATE_BODIES[kind]);
    expect(dry.status).toBe(502);
    const dryBody = (await dry.json()) as { type: string; detail: string };
    expect(dryBody.type).toBe(BAD_GATEWAY);
    expect(work.upstreamSaves).toEqual([]);

    resetWork();
    clearAntiForgeryTokenCache();
    upstreamBehavior.modalNoToken = true;
    const live = await postSave(kind, "", UPDATE_BODIES[kind]);
    expect(live.status).toBe(502);
    const liveBody = (await live.json()) as { type: string; detail: string };
    expect(liveBody.detail).toBe(dryBody.detail);
  });
});

describe("save dry-run: no-session fail-closed 503", () => {
  const kinds: EntityKind[] = ["customer", "address", "container"];

  it.each(kinds)("%s dry with no session is 503 and never logs in", async (kind) => {
    sessionBehavior.mode = "none";
    upstreamBehavior.challengeCookieless = true;
    const res = await postSave(kind, "?dryRun=true", UPDATE_BODIES[kind]);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      instance: string;
    };
    expect(body.status).toBe(503);
    expect(body.title).toBe("Service Unavailable");
    expect(body.type).toContain("docs/PROBLEMS.md#");
    expect(body.detail).toMatch(/session/i);
    expect(body.instance).toBe(`/api/v1/data/${kind}`);
    expectZeroEffects();
  });

  it("empty body stays 400 even without a session (validation precedes the session check)", async () => {
    sessionBehavior.mode = "none";
    upstreamBehavior.challengeCookieless = true;
    const res = await postSave("customer", "?dryRun=true", "");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expectZeroEffects();
  });
});

describe("save dry-run: mid-prep session expiry never logs in", () => {
  const cases: Array<[EntityKind, string]> = [
    ["customer", "GET /WebRW/Customer/LoadLongCustomerModal"],
    ["address", "GET /WebRW/PickupAddress/LoadAddressModal"],
    ["container", "GET /WebRW/Container/LoadContainerModal"]
  ];

  it.each(cases)("%s dry fails closed when a stored cookie is challenged by the modal", async (kind, modal) => {
    sessionBehavior.mode = "valid";
    upstreamBehavior.modalLoginChallenge = true;

    // No client token: prep must fetch the modal with the stored cookie.
    const res = await postSave(kind, "?dryRun=true", UPDATE_BODIES[kind]);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe(BAD_GATEWAY);
    expect(body.status).toBe(502);
    expect(work.upstreamModals).toEqual([modal]);
    expect(work.upstreamModalCookies).toEqual(["session=FAKE"]);
    expectZeroEffects();
  });
});

describe("save dry-run: live-path preservation", () => {
  const kinds: EntityKind[] = ["customer", "address", "container"];

  it.each(kinds)("POST /api/v1/data/%s without a query still writes for real", async (kind) => {
    const res = await postSave(kind, "", UPDATE_BODIES[kind]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.ok).toBe(true);
    expect(body.dryRun).not.toBe(true);
    expect(body.routewareStatus).toBe(200);
    expect(body.upstreamBytes as number).toBeGreaterThan(0);
    expect(body.localSync).toMatchObject({ done: true });
    expectLiveEffects();
  });

  it.each(kinds)("POST /api/v1/data/%s?dryRun=false writes for real", async (kind) => {
    const res = await postSave(kind, "?dryRun=false", UPDATE_BODIES[kind]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.ok).toBe(true);
    expect(body.dryRun).not.toBe(true);
    expect(body.routewareStatus).toBe(200);
    expect(body.upstreamBytes as number).toBeGreaterThan(0);
    expect(body.localSync).toMatchObject({ done: true });
    expectLiveEffects();
  });

  it("live customer update resolves ids and syncs the canned graph", async () => {
    const res = await postSave("customer", "", UPDATE_BODIES.customer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.customerId).toBe(5);
    expect(body.localSync).toEqual({
      done: true,
      customerId: 5,
      addressIds: [10],
      containerIds: [100]
    });
  });

  it("live address update carries both posted ids", async () => {
    const res = await postSave("address", "", UPDATE_BODIES.address);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(10);
  });

  it("live container update carries all three posted ids", async () => {
    const res = await postSave("container", "", UPDATE_BODIES.container);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DryEnvelope;
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(10);
    expect(body.containerId).toBe(100);
  });
});

describe("save dry-run: auth precedence", () => {
  it("missing auth with ?dryRun=true is the outer 401", async () => {
    const res = await postSave("customer", "?dryRun=true", UPDATE_BODIES.customer, null);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("SHADOW_API_TOKEN");
    expectZeroEffects();
  });

  it("wrong bearer with ?dryRun=true is 401", async () => {
    const res = await postSave("customer", "?dryRun=true", UPDATE_BODIES.customer, "Bearer wrong");
    expect(res.status).toBe(401);
    expectZeroEffects();
  });

  it("API token (not the sync secret) with ?dryRun=true is the inner 401", async () => {
    const res = await postSave(
      "customer",
      "?dryRun=true",
      UPDATE_BODIES.customer,
      `Bearer ${API_TOKEN}`
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("CUSTOMER_SNAPSHOT_SYNC_SECRET");
    expectZeroEffects();
  });

  it("read token on a POST dry-run is 401", async () => {
    const res = await postSave(
      "customer",
      "?dryRun=true",
      UPDATE_BODIES.customer,
      `Bearer ${READ_TOKEN}`
    );
    expect(res.status).toBe(401);
    expectZeroEffects();
  });

  it("API token with an invalid dryRun value is validator-first 400 (not the inner 401)", async () => {
    const res = await postSave(
      "customer",
      "?dryRun=maybe",
      UPDATE_BODIES.customer,
      `Bearer ${API_TOKEN}`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expectZeroEffects();
  });

  it("API token with an unknown query key stays the inner 401 (unknown keys check after auth)", async () => {
    const res = await postSave(
      "customer",
      "?bogus=1",
      UPDATE_BODIES.customer,
      `Bearer ${API_TOKEN}`
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("CUSTOMER_SNAPSHOT_SYNC_SECRET");
    expectZeroEffects();
  });

  it("missing auth with an unknown query key is still the outer 401", async () => {
    const res = await postSave("address", "?bogus=1", UPDATE_BODIES.address, null);
    expect(res.status).toBe(401);
    expectZeroEffects();
  });
});

describe("save dry-run: OpenAPI contract", () => {
  it("the three POST saves publish the shared dryRun enum query param", async () => {
    const res = await app.fetch(
      new Request("https://synthetic.example.test/openapi.json"),
      appEnv(),
      ctx
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { parameters?: Array<Record<string, unknown>> }>>;
    };
    for (const kind of ["customer", "address", "container"] as const) {
      const op = doc.paths[`/api/v1/data/${kind}`]?.post;
      expect(op).toBeDefined();
      const params = op?.parameters ?? [];
      const dryRun = params.find((p) => p["name"] === "dryRun");
      expect(dryRun).toBeDefined();
      expect(dryRun?.["in"]).toBe("query");
      expect(dryRun?.["required"]).toBe(false);
      const schema = dryRun?.["schema"] as Record<string, unknown> | undefined;
      expect(schema?.["enum"]).toEqual(["true", "false"]);
    }
  });
});
