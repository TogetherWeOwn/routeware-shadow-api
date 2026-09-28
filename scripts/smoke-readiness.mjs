#!/usr/bin/env node
/**
 * Post-deploy smoke check (TOG-5816).
 *
 * Usage:
 *   SHADOW_API_BASE=https://<worker-host> SHADOW_API_TOKEN=<token> node scripts/smoke-readiness.mjs
 *
 * Hits the public liveness probe first (no auth), then the authenticated
 * readiness probe, and prints per-dependency status. Exits 0 only when the
 * Worker is up AND every readiness check passes; exits 1 otherwise (including
 * when a dependency is degraded — that is the signal to investigate the
 * deploy, not to roll forward).
 *
 * Never prints the token. Safe to run against staging/dev; no writes.
 */

const base = (process.env.SHADOW_API_BASE ?? "").replace(/\/$/, "");
const token = process.env.SHADOW_API_TOKEN ?? process.env.CUSTOMER_SNAPSHOT_SYNC_SECRET ?? "";

if (!base) {
  console.error("Missing SHADOW_API_BASE (e.g. https://routeware-shadow-api.<account>.workers.dev)");
  process.exit(2);
}
if (!token) {
  console.error("Missing SHADOW_API_TOKEN (or CUSTOMER_SNAPSHOT_SYNC_SECRET fallback)");
  process.exit(2);
}

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

let failed = false;

// 1. Liveness — public, must be 200 {"status":"ok"}.
const health = await get("/api/v1/health");
if (health.res.status !== 200 || health.body?.status !== "ok") {
  console.error(`FAIL liveness: GET /api/v1/health -> ${health.res.status}`);
  failed = true;
} else {
  console.log("PASS liveness: GET /api/v1/health -> 200 ok");
}

// 2. Readiness without a token must 401 (gate is up).
const unauth = await get("/api/v1/readiness");
if (unauth.res.status !== 401) {
  console.error(`FAIL auth gate: unauthenticated readiness -> ${unauth.res.status} (expected 401)`);
  failed = true;
} else {
  console.log("PASS auth gate: unauthenticated readiness -> 401");
}

// 3. Authenticated readiness — per-dependency status.
const ready = await get("/api/v1/readiness", { authorization: `Bearer ${token}` });
const checks = ready.body?.checks;
console.log(`readiness: HTTP ${ready.res.status} status=${ready.body?.status ?? "unknown"}`);
for (const name of ["d1", "r2", "config"]) {
  const c = checks?.[name];
  if (!c) {
    console.log(`  ${name}: MISSING from response`);
    failed = true;
    continue;
  }
  const flag = name === "config"
    ? `customer=${c.customer} address=${c.address} container=${c.container}`
    : name === "r2"
      ? `bound=${c.bound} enabled=${c.enabled}`
      : "";
  console.log(`  ${name}: ${c.ok ? "ok" : "NOT OK"} ${flag}${c.detail ? ` — ${c.detail}` : ""}`.trimEnd());
  if (!c.ok) failed = true;
}

// 4. Cron staleness — advisory only (TOG-8883). The probe never flips the
// overall status, so it must never fail this gate: a never-yet-run staging
// Worker is deployable. Printed for the operator, not gated on.
const cron = checks?.cron;
if (!cron) {
  console.log("  cron: MISSING from response (older deploy?)");
} else {
  const perTable = ["customer", "address", "container"]
    .map((t) => `${t}=${cron.tables?.[t]?.outcome ?? "none"}@${cron.tables?.[t]?.ranAt ?? "?"}`)
    .join(" ");
  console.log(
    `  cron: ${cron.stale ? "STALE (advisory)" : "fresh"} lastRunAt=${cron.lastRunAt ?? "none"} ${perTable}${cron.detail ? ` — ${cron.detail}` : ""}`.trimEnd()
  );
}

if (ready.res.status !== 200 || ready.body?.status !== "ok") {
  console.error("FAIL readiness: Worker up but a dependency is degraded (see above)");
  failed = true;
} else {
  console.log("PASS readiness: all dependencies ok");
}

process.exit(failed ? 1 : 0);
