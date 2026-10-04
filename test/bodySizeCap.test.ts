import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_BUFFERED_BODY_BYTES,
  bufferedBodyTooLargeProblem,
  isSnapshotImportPath,
  readBoundedBody
} from "../src/lib/bodyLimit";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Body size cap + trailing-slash import keeps streaming exemption.
 *
 * `src/app.ts` used to buffer every non-GET body with an unbounded
 * `arrayBuffer()`, and the snapshot-import streaming exemption was an exact
 * `endsWith("/...-snapshot/import")` match — so `/import/` or case variants
 * buffered a full export in the isolate before 404ing, and any oversized
 * buffered POST risked OOM. Now the middleware rejects buffered bodies over
 * `MAX_BUFFERED_BODY_BYTES` with 413 (truthful `Content-Length` fails fast,
 * otherwise a bounded reader stops at the cap), while import paths —
 * including trailing-slash and case variants — still stream.
 *
 * Driven through the real app + real test D1 (migrated via
 * ./d1TestMigrations), like test/snapshotImportEdges.test.ts. No test here may
 * reach the network: the 413s fire before any upstream fetch (the fetch stub
 * throws to prove it), and imports never fetch upstream.
 *
 * Small buffered POSTs are not re-proven here: the existing suite (saves,
 * customers-read, detail-full) already drives KB-scale bodies through the
 * middleware on every run. Fixtures are synthetic (`Cap Co`, fixed strings) —
 * no PII, no secrets, no customer data.
 */

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

// Verbatim literals, never problemType() output: recomputing the expected
// value with the function under test would let a base-URL change pass
// silently.
const TOO_LARGE = `${PROBLEM_TYPE_BASE}payload-too-large`;
const NOT_FOUND = `${PROBLEM_TYPE_BASE}not-found`;
const UNAUTHORIZED = `${PROBLEM_TYPE_BASE}unauthorized`;

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** No test in this file may reach upstream: throw instead of hitting net. */
function stubNoUpstream(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected upstream fetch in body-size-cap test");
  }) as typeof fetch;
}

function upstreamCalls(): number {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock?.calls?.length ?? 0;
}

async function callApp(
  path: string,
  init: RequestInit = {},
  token: string | null = API_TOKEN
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

describe("buffered body cap (middleware)", () => {
  it("rejects an oversized buffered body with 413 without touching upstream", async () => {
    // Arrange — 1 byte over the cap, with an honest Content-Length.
    stubNoUpstream();
    const big = "x".repeat(MAX_BUFFERED_BODY_BYTES + 1);

    // Act — a buffered route (forwards upstream), so a missing cap would
    // hold the whole body before the (throwing) upstream fetch.
    const res = await callApp("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: big,
      headers: { "content-type": "application/json" }
    });

    // Assert — 413, anchored type, byte counts but never body bytes.
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(TOO_LARGE);
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
    expect(body.detail).toContain(String(MAX_BUFFERED_BODY_BYTES));
    expect(body.instance).toBe("/api/v1/routeware/customer/customers-read");
    expect(JSON.stringify(body).length).toBeLessThan(1024);
    expect(upstreamCalls()).toBe(0);
  });

  it("rejects a chunked oversized body with 413 (no Content-Length)", async () => {
    // Arrange — a stream with no declared length, so the Content-Length
    // fast path cannot fire and the bounded reader must stop the body.
    stubNoUpstream();
    let sent = 0;
    const total = MAX_BUFFERED_BODY_BYTES + 1;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(65536, total - sent);
        controller.enqueue(new Uint8Array(n));
        sent += n;
      }
    });

    // Act
    const res = await callApp(
      "/api/v1/routeware/customer/customers-read",
      {
        method: "POST",
        body: stream as BodyInit,
        headers: { "content-type": "application/json" },
        duplex: "half"
      } as RequestInit
    );

    // Assert
    expect(res.status).toBe(413);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(TOO_LARGE);
    expect(body.status).toBe(413);
    expect(upstreamCalls()).toBe(0);
  });

  it("still rejects before buffering when the bearer gate fails (401, not 413)", async () => {
    // Arrange — oversized body, no token. The auth gate runs before the
    // body middleware, so this is a 401 even though the body is huge.
    stubNoUpstream();
    const big = "x".repeat(MAX_BUFFERED_BODY_BYTES + 1);

    // Act
    const res = await callApp(
      "/api/v1/routeware/customer/customers-read",
      {
        method: "POST",
        body: big,
        headers: { "content-type": "application/json" }
      },
      null
    );

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED);
    expect(upstreamCalls()).toBe(0);
  });
});

describe("trailing-slash import keeps the streaming exemption", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("streams a multi-MB CSV through `/import/` with 200 (would 413 if buffered)", async () => {
    // Arrange — ~2 MB of valid rows: over the 1 MiB buffered cap but far
    // under the 50 MB import streaming cap. `?dryRun=true` validates and
    // counts without writing D1, so this stays fast.
    stubNoUpstream();
    const rows: string[] = [];
    let id = 958001;
    let size = CUSTOMER_HEADER.length + 1;
    while (size <= 2 * 1024 * 1024) {
      const row = `${id},,Cap Co ${id},,,,,,,,,,true`;
      rows.push(row);
      size += row.length + 1;
      id += 1;
    }
    expect(size).toBeGreaterThan(MAX_BUFFERED_BODY_BYTES);

    // Act
    const res = await callApp(
      "/api/v1/customer-snapshot/import/?dryRun=true",
      {
        method: "POST",
        body: [CUSTOMER_HEADER, ...rows].join("\n"),
        headers: { "content-type": "text/csv" }
      },
      SYNC_SECRET
    );

    // Assert — 200 with the full row count: the middleware streamed (a
    // buffered 2 MB body would have 413d) and the handler parsed it all.
    expect(res.status).toBe(200);
    const out = (await res.json()) as { upserted: number; rowCount: number };
    expect(out.rowCount).toBe(rows.length);
    expect(upstreamCalls()).toBe(0);
  });

  it("writes through `/import/` like the canonical path", async () => {
    // Arrange
    stubNoUpstream();
    const csv =
      `${CUSTOMER_HEADER}\n` +
      "958101,,Slash Co,,,,,,,,,,true\n" +
      "958102,,Slash Co,,,,,,,,,,true";

    // Act
    const res = await callApp(
      "/api/v1/customer-snapshot/import/",
      { method: "POST", body: csv, headers: { "content-type": "text/csv" } },
      SYNC_SECRET
    );

    // Assert — real write, then prove the rows landed in D1.
    expect(res.status).toBe(200);
    const out = (await res.json()) as { upserted: number; rowCount: number };
    expect(out.rowCount).toBe(2);
    const count = await db()
      .prepare(
        "SELECT COUNT(*) as n FROM customer_snapshot WHERE customer_id IN (958101, 958102)"
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
    expect(upstreamCalls()).toBe(0);
  });

  it("rejects a declared-oversized `/import/` body with the import 413", async () => {
    // Arrange — small body, huge declared Content-Length: the alias route
    // runs the same import size guard as the canonical path.
    stubNoUpstream();

    // Act
    const res = await callApp(
      "/api/v1/customer-snapshot/import/",
      {
        method: "POST",
        body: `${CUSTOMER_HEADER}\n958103,,Slash Co,,,,,,,,,,true`,
        headers: {
          "content-type": "text/csv",
          "content-length": String(100 * 1024 * 1024)
        }
      },
      SYNC_SECRET
    );

    // Assert
    expect(res.status).toBe(413);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(TOO_LARGE);
    expect(body.status).toBe(413);
    expect(upstreamCalls()).toBe(0);
  });

  it("exempts a case-variant import path from buffering (404, not 413)", async () => {
    // Arrange — an oversized body to `/IMPORT`: no route matches (paths are
    // case-sensitive), but the middleware must still stream past it instead
    // of buffering the full export just to 404.
    stubNoUpstream();
    const big = "x".repeat(MAX_BUFFERED_BODY_BYTES + 1);

    // Act
    const res = await callApp(
      "/api/v1/customer-snapshot/IMPORT",
      {
        method: "POST",
        body: big,
        headers: { "content-type": "text/csv" }
      },
      SYNC_SECRET
    );

    // Assert — 404 from the router, proving the 413 cap never saw the body.
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(NOT_FOUND);
    expect(upstreamCalls()).toBe(0);
  });
});

describe("isSnapshotImportPath", () => {
  it.each([
    "/api/v1/customer-snapshot/import",
    "/api/v1/address-snapshot/import",
    "/api/v1/container-snapshot/import"
  ])("matches the canonical path %s", (path) => {
    expect(isSnapshotImportPath(path)).toBe(true);
  });

  it.each([
    "/api/v1/customer-snapshot/import/",
    "/api/v1/address-snapshot/import///",
    "/api/v1/customer-snapshot/IMPORT",
    "/api/v1/address-snapshot/Import/",
    "/api/v1/container-snapshot/ImPoRt/"
  ])("exempts the streaming variant %s", (path) => {
    expect(isSnapshotImportPath(path)).toBe(true);
  });

  it.each([
    "/api/v1/customer-snapshot/imports",
    "/api/v1/customer-snapshot/imported",
    "/api/v1/customer-snapshot/sync",
    "/api/v1/routeware/customer/save-long-form",
    "/api/v1/health",
    "/api/v1/data/customer"
  ])("does not exempt the buffered route %s", (path) => {
    expect(isSnapshotImportPath(path)).toBe(false);
  });
});

describe("readBoundedBody", () => {
  function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const n = Math.min(3, totalBytes - sent);
        const chunk = new Uint8Array(n).fill(7);
        controller.enqueue(chunk);
        sent += n;
      }
    });
  }

  function requestWithBody(totalBytes: number): Request {
    return new Request("http://test.local/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: streamOf(totalBytes) as BodyInit,
      duplex: "half"
    } as RequestInit);
  }

  it("concatenates a small body byte-identical", async () => {
    const out = await readBoundedBody(requestWithBody(9), 16);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.buffer.byteLength).toBe(9);
      expect(Array.from(new Uint8Array(out.buffer))).toEqual(new Array(9).fill(7));
    }
  });

  it("accepts a body of exactly maxBytes", async () => {
    const out = await readBoundedBody(requestWithBody(8), 8);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.buffer.byteLength).toBe(8);
    }
  });

  it("rejects maxBytes + 1 with the observed count and no buffer", async () => {
    const out = await readBoundedBody(requestWithBody(9), 8);
    expect(out).toEqual({ ok: false, receivedBytes: 9 });
  });

  it("reads a missing body as empty without failing", async () => {
    const out = await readBoundedBody(
      new Request("http://test.local/api/v1/health", { method: "POST" }),
      8
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.buffer.byteLength).toBe(0);
    }
  });
});

describe("bufferedBodyTooLargeProblem", () => {
  it("is a 413 payload-too-large naming the limit, never the body", async () => {
    const probe = `marker-${"q".repeat(50)}`;
    const res = bufferedBodyTooLargeProblem(1048577, "/api/v1/x");
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(TOO_LARGE);
    expect(body.title).toBe("Payload Too Large");
    expect(body.status).toBe(413);
    expect(body.detail).toContain(String(MAX_BUFFERED_BODY_BYTES));
    expect(body.instance).toBe("/api/v1/x");
    expect(JSON.stringify(body)).not.toContain(probe);
  });
});
