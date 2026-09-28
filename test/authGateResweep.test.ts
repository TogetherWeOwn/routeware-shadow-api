import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";

/**
 * TOG-8386 (gap G16): auth-gate re-sweep on the newest routes.
 *
 * The last full sweep predates PRs #96-#110 and the `GET ...-snapshot/export`
 * routes (TOG-8361). `test/authGateSweep.test.ts` already probes every
 * registered route with no/wrong tokens at the OUTER gate, and
 * `test/snapshotAuth.test.ts` pins the inner 401 body per privileged route —
 * both green. What neither pins is the privileged SET itself: a new
 * sync/import/export/data route that forgot `requireSnapshotAuth` would still
 * 401 without a token (outer gate) while wrongly accepting the general API
 * token.
 *
 * This file closes that gap:
 * - the privileged inventory is derived from the live router (`app.routes`)
 *   and must equal the pinned 16 below — adding a matching route fails here
 *   until its inner gate is verified;
 * - every one of the 16 is re-probed: no token → outer 401, API token →
 *   inner 401 (wrong-token cells ride on `authGateSweep`, which sweeps all
 *   37 routes with no and bad tokens).
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
    path.startsWith("/api/v1/data/")
  );
}

/**
 * Pinned privileged set, `METHOD path` sorted. Any new sync/import/export/data
 * route must land here (and carry `requireSnapshotAuth`) or the inventory
 * test below fails.
 */
const PINNED_PRIVILEGED: string[] = [
  "GET /api/v1/address-snapshot/export",
  "GET /api/v1/container-snapshot/export",
  "GET /api/v1/customer-snapshot/export",
  "GET /api/v1/data/address",
  "GET /api/v1/data/container",
  "GET /api/v1/data/customer",
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
function probePath(path: string): string {
  return path.startsWith("/api/v1/data/") && !path.includes("?") ? `${path}?id=1` : path;
}

describe("auth-gate re-sweep on newest routes (TOG-8386)", () => {
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

  it("privileged inventory from the live router equals the pinned 16", () => {
    expect(livePrivilegedRoutes()).toEqual(PINNED_PRIVILEGED);
  });

  it.each(PINNED_PRIVILEGED)("no token hits the outer gate: %s", async (route) => {
    const [method, path] = route.split(" ") as [string, string];
    const res = await call(method, probePath(path), null);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(OUTER_DETAIL);
    expect(body.instance).toBe(path);
  });

  it.each(PINNED_PRIVILEGED)("API token hits the inner check: %s", async (route) => {
    const [method, path] = route.split(" ") as [string, string];
    const res = await call(method, probePath(path), API_TOKEN);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(INNER_DETAIL);
    expect(body.instance).toBe(path);
  });
});
