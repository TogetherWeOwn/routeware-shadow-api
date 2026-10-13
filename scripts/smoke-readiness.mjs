#!/usr/bin/env node
/**
 * Post-deploy smoke check (TOG-5816, timeouts and verdicts TOG-22090).
 *
 * Usage:
 *   SHADOW_API_BASE=https://<worker-host> SHADOW_API_TOKEN=<token> node scripts/smoke-readiness.mjs [--timeout-ms=N]
 *
 * Hits the public liveness probe first (no auth), then the authenticated
 * readiness probe, and prints per-dependency status. Exits 0 only when the
 * Worker is up AND every readiness check passes; exits 1 otherwise (including
 * when a dependency is degraded — that is the signal to investigate the
 * deploy, not to roll forward); exits 2 on missing env or an invalid flag.
 * Every request is bounded by --timeout-ms (default 15000).
 *
 * Never prints the token. Safe to run against staging/dev; no writes.
 *
 * Pure logic lives in `./lib/smokeReadiness.mjs` and is unit-tested; this file
 * is the thin wrapper around it.
 */
import { argv, env, exit } from "node:process";
import { parseSmokeArgs, runSmokeReadiness, usage } from "./lib/smokeReadiness.mjs";

let timeoutMs;
try {
  ({ timeoutMs } = parseSmokeArgs(argv.slice(2)));
} catch (error) {
  if (error?.code === "SMOKE_HELP") {
    console.log(usage());
    exit(0);
  }
  console.error(error?.message ?? usage());
  exit(2);
}

const base = (env.SHADOW_API_BASE ?? "").replace(/\/$/, "");
const token = env.SHADOW_API_TOKEN ?? env.CUSTOMER_SNAPSHOT_SYNC_SECRET ?? "";

if (!base) {
  console.error(`Missing SHADOW_API_BASE (e.g. https://routeware-shadow-api.<account>.workers.dev)\n\n${usage()}`);
  exit(2);
}
if (!token) {
  console.error(`Missing SHADOW_API_TOKEN (or CUSTOMER_SNAPSHOT_SYNC_SECRET fallback)\n\n${usage()}`);
  exit(2);
}

try {
  const { stdout, stderr, exitCode } = await runSmokeReadiness({
    fetchImpl: fetch,
    base,
    token,
    timeoutMs,
  });
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  exit(exitCode);
} catch (error) {
  // Last-resort guard: one FAIL line, never a stack trace, never the token.
  const safe = String(error?.message ?? error ?? "unknown").split("\n")[0].split(token).join("[redacted]");
  console.error(`FAIL smoke: ${safe.slice(0, 200) || "unexpected error"}`);
  exit(1);
}
