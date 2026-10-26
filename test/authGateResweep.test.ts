import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";

/**
 * Gap G16: auth-gate re-sweep on the newest routes.
 *
 * The last full sweep predates PRs #96-#110 and the `GET ...-snapshot/export`
 * routes. `test/authGateSweep.test.ts` already probes every
 * registered route with no/wrong tokens at the OUTER gate, and
 * `test/snapshotAuth.test.ts` pins the inner 401 body per privileged route —
 * both green. What neither pins is the privileged SET itself: a new
 * privileged route that forgot `requireSnapshotAuth` would still
 * 401 without a token (outer gate) while wrongly accepting the general API
 * token.
 *
 * This file closes that gap:
 * - the privileged inventory is derived from the live router (`app.routes`)
 *   and must equal the pinned 20 below — adding a matching route fails here
 *   until its inner gate is verified;
 * - every one of the 20 is re-probed: no token → outer 401, API token →
 *   inner 401 (wrong-token cells ride on `authGateSweep`, which sweeps all
 *   38 routes with no and bad tokens).
 *
 * Coverage map (not re-executed here): sync-secret-accepts cells live in
 * `test/snapshotCsvExport.test.ts` (exports E2E), `test/dataSnapshotRoutes.test.ts`
 * (chained sync) and `test/dualSecretMatrix.test.ts` (route-class split).
 */

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

const UNAUTHORIZED_TYPE = problemType("unauthorized");
const OUTER_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

// Fresh TEST-NET-3 octets so per-IP throttle buckets never leak state into
// (or from) authGateSweep (198.51.100.64+, 192.0.2 mirrors, .140/.141),
// dualSecretMatrix (203.0.113.22x) or the throttle suites.
const SWEEP_IP_BASE = "192.0.2.150";
let ipSeq = 0;
function freshIp(): string {
  const [a, b, c, d] = SWEEP_IP_BASE.split(".").map(Number);
  return `${a}.${b}.${c}.${(d as number) + ipSeq++}`;
}

function isPrivilegedRoute(method: string, path: string): boolean {
  if (method === "ALL" || !path.startsWith("/api/v1/")) {
    return false;
  }
  return (
    path.endsWith("/sync") ||
    path.endsWith("/import") ||
    path.endsWith("/export") ||
    path.startsWith("/api/v1/data/") ||
    // R2 archive readback carries the same sync-secret inner gate.
    path.startsWith("/api/v1/snapshots/") ||
    // D1 integrity audit: same inner gate, but no /sync|/import|/export
    // suffix, so it needs an exact match.
    (method === "GET" && path === "/api/v1/data-snapshot/orphans") ||
    // Customer-row erasure. Method-qualified: GET on the same path is the
    // outer-gate-only single-customer read; only DELETE carries the inner gate.
    (method === "DELETE" && path === "/api/v1/customer-snapshot/:customerId")
  );
}

/**
 * Pinned privileged set, `METHOD path` sorted. Any new route matching
 * `isPrivilegedRoute` must land here (and carry `requireSnapshotAuth`) or the
 * inventory test below fails.
 */
const PINNED_PRIVILEGED: string[] = [
  "DELETE /api/v1/customer-snapshot/:customerId",
  "GET /api/v1/address-snapshot/export",
  "GET /api/v1/container-snapshot/export",
  "GET /api/v1/customer-snapshot/export",
  "GET /api/v1/data-snapshot/orphans",
  "GET /api/v1/data/address",
  "GET /api/v1/data/container",
  "GET /api/v1/data/customer",
  // R2 archive readback (sync secret only). The router renders the
  // path in Hono `:param` syntax. `livePrivilegedRoutes` sorts with
  // `localeCompare`, so this GET lands with the GET group (after
  // `data/customer`, `data` < `snapshots`); probes carry a concrete table +
  // date.
  // Archived-date listing: same /snapshots/ prefix, same inner gate; the
  // shorter `:table` sorts before `:table/:date`. Probes carry a concrete
  // table (the `:date` replacement is a no-op here).
  "GET /api/v1/snapshots/:table",
  "GET /api/v1/snapshots/:table/:date",
  // Latest-pointer readback: same /snapshots/ prefix, same inner gate.
  // `localeCompare` sorts the literal `latest` after the `:date` param.
  "GET /api/v1/snapshots/:table/latest",
  "POST /api/v1/address-snapshot/import",
  "POST /api/v1/address-snapshot/sync",
  "POST /api/v1/container-snapshot/import",
  "POST /api/v1/container-snapshot/sync",
  "POST /api/v1/customer-snapshot/import",
  "POST /api/v1/customer-snapshot/sync",
  "POST /api/v1/data-snapshot/sync",
  "POST /api/v1/data/address",
  "POST /api/v1/data/container",
  "POST /api/v1/data/customer"
];

function livePrivilegedRoutes(): string[] {
  const seen = new Set<string>();
  for (const r of app.routes) {
    if (isPrivilegedRoute(r.method, r.path)) {
      seen.add(`${r.method} ${r.path}`);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

async function call(method: string, path: string, token: string | null): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("CF-Connecting-IP", freshIp());
  return exports.default.fetch(`http://test.local${path}`, { method, headers });
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

// The `GET /api/v1/data/*` routes validate `?id` via zod BEFORE the handler
// runs, so a bare path 400s before `requireSnapshotAuth` is reached. Carry
// `?id=1` (same as `test/snapshotAuth.test.ts`) so the probe exercises the
// gates, not the query validator. `instance` still echoes the bare pathname.
//
// Same for `GET /api/v1/snapshots/:table/:date`: the enum/date
// validators reject the literal `:table`/`:date` placeholders, so the probe
// carries concrete values. And the erasure route's literal `:customerId`
// 400s at param validation before the gates, so it probes with a concrete id
// (same as `test/snapshotAuth.test.ts`). `expectedInstance` is the pathname
// the 401 echoes (probe path minus query) — identical to the pinned string
// for every other entry.
function probePath(path: string): string {
  if (path.includes(":table")) {
    return path.replace(":table", "customer").replace(":date", "2026-09-27");
  }
  if (path.includes(":customerId")) {
    return path.replace(":customerId", "1");
  }
  return path.startsWith("/api/v1/data/") && !path.includes("?") ? `${path}?id=1` : path;
}

function expectedInstance(path: string): string {
  return probePath(path).split("?")[0];
}

describe("auth-gate re-sweep on newest routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No re-sweep request may reach upstream: 401s stop at the gates.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in auth-gate re-sweep");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("privileged inventory from the live router equals the pinned 20", () => {
    expect(livePrivilegedRoutes()).toEqual(PINNED_PRIVILEGED);
  });

  it.each(PINNED_PRIVILEGED)("no token hits the outer gate: %s", async (route) => {
    const [method, path] = route.split(" ") as [string, string];
    const res = await call(method, probePath(path), null);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(OUTER_DETAIL);
    expect(body.instance).toBe(expectedInstance(path));
  });

  it.each(PINNED_PRIVILEGED)("API token hits the inner check: %s", async (route) => {
    const [method, path] = route.split(" ") as [string, string];
    const res = await call(method, probePath(path), API_TOKEN);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe(expectedInstance(path));
  });
});
