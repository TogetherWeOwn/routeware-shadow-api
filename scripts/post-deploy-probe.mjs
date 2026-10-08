#!/usr/bin/env node
/**
 * Post-deploy probe (TOG-6274, extended TOG-7382): hits GET /api/v1/health
 * (public), GET /api/v1/shadow/health (authed) and GET /api/v1/readiness
 * (authed) against a base URL.
 *
 * Usage:
 *   node scripts/post-deploy-probe.mjs <base-url> [--token-env=NAME] [--timeout-ms=N] [--skip-if-no-token] [--scheduled]
 *   npm run probe:post-deploy -- <base-url>
 *   npm run probe:post-deploy:scheduled   (scheduled mode: SHADOW_API_BASE + skip-safe)
 *
 * Base resolution: explicit <base-url> wins, then $SHADOW_API_BASE (same name
 * as scripts/smoke-readiness.mjs), then http://localhost:8787 for local dev.
 * --scheduled (also enforced for GITHUB_EVENT_NAME=schedule) requires a
 * configured remote HTTPS staging target; no local fallback is permitted.
 *
 * Token resolution (never printed, never committed):
 *   1. --token-env=NAME (value read from process.env[NAME])
 *   2. process.env.SHADOW_API_TOKEN
 *   3. process.env.CUSTOMER_SNAPSHOT_SYNC_SECRET
 *   4. `.dev.vars` beside wrangler.toml (local-dev convenience: SHADOW_API_TOKEN,
 *      else CUSTOMER_SNAPSHOT_SYNC_SECRET) — values are read, not logged.
 *
 * Exit 0 only when all three probes pass; otherwise exit 1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argv, env, exit } from "node:process";
import {
  BASE_ENV,
  DEFAULT_BASE,
  SKIP_FLAG,
  SCHEDULED_FLAG,
  evalCronFreshness,
  formatSkipLine,
  resolveBase,
} from "./lib/postDeployProbe.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_SNIPPET = 500;

function usage() {
  return [
    `Usage: node scripts/post-deploy-probe.mjs <base-url> [--token-env=NAME] [--timeout-ms=N] [${SKIP_FLAG}] [${SCHEDULED_FLAG}]`,
    "",
    "  <base-url>      Worker origin, e.g. http://localhost:8787 or",
    "                  https://routeware-shadow-api.<account>.workers.dev",
    `                  (defaults to $${BASE_ENV}, else ${DEFAULT_BASE} when omitted)`,
    "  --token-env=NAME  Env var holding the bearer token",
    "                  (default: SHADOW_API_TOKEN, else CUSTOMER_SNAPSHOT_SYNC_SECRET)",
    "  --timeout-ms=N    Per-probe fetch timeout in ms (default 15000)",
    `  ${SKIP_FLAG}  skip (exit 0) the authed probes when no token resolves;`,
    "                  Without it a missing token fails (exit 1).",
    `  ${SCHEDULED_FLAG}  require an approved remote HTTPS staging origin;`,
    "                  also enforced automatically for GitHub schedule events.",
    "",
    "Token is never printed. For local dev it is read from the environment or",
    "from .dev.vars (SHADOW_API_TOKEN preferred, CUSTOMER_SNAPSHOT_SYNC_SECRET fallback).",
  ].join("\n");
}

function parseArgs(args) {
  let base = "";
  let tokenEnv = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let skipIfNoToken = false;
  let scheduled = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      exit(0);
    } else if (arg === SKIP_FLAG) {
      skipIfNoToken = true;
    } else if (arg === SCHEDULED_FLAG) {
      scheduled = true;
    } else if (arg.startsWith("--token-env=")) {
      tokenEnv = arg.slice("--token-env=".length).trim();
    } else if (arg.startsWith("--timeout-ms=")) {
      const n = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --timeout-ms value: ${arg}`);
        exit(1);
      }
      timeoutMs = Math.floor(n);
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}\n\n${usage()}`);
      exit(1);
    } else if (!arg.startsWith("-")) {
      base = arg;
    }
  }
  try {
    const resolved = resolveBase({ positional: base, env, scheduled });
    return { base: resolved, tokenEnv, timeoutMs, skipIfNoToken };
  } catch (error) {
    console.error(`post-deploy probe configuration: ${error.message}`);
    exit(1);
  }
}

/** Read KEY=value pairs from `.dev.vars` without ever logging values. */
function readDevVars() {
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const raw = fs.readFileSync(path.join(root, ".dev.vars"), "utf8").replace(/^\uFEFF/, ""); // strips BOM
    const out = {};
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).replace(/\r$/, "").trim();
      const value = trimmed.slice(eq + 1).replace(/\r$/, "").trim();
      if (key && value && !(key in out)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveToken(tokenEnv) {
  const names = tokenEnv
    ? [tokenEnv]
    : ["SHADOW_API_TOKEN", "CUSTOMER_SNAPSHOT_SYNC_SECRET"];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { value, source: `env ${name}` };
  }
  if (!tokenEnv) {
    const devVars = readDevVars();
    for (const name of ["SHADOW_API_TOKEN", "CUSTOMER_SNAPSHOT_SYNC_SECRET"]) {
      if (devVars[name]) return { value: devVars[name], source: `.dev.vars ${name}` };
    }
  }
  return null;
}

function snippet(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_BODY_SNIPPET
    ? `${oneLine.slice(0, MAX_BODY_SNIPPET)}…`
    : oneLine || "(empty body)";
}

async function fetchJson(url, { token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The token travels in the Authorization header but is never logged.
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { base, tokenEnv, timeoutMs, skipIfNoToken } = parseArgs(argv.slice(2));
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    console.error(`Invalid base URL: ${base}\n\n${usage()}`);
    exit(1);
  }

  let failures = 0;

  // Probe 1 — public liveness, no token.
  try {
    const { status, body, raw } = await fetchJson(`${origin}/api/v1/health`, {
      token: null,
      timeoutMs,
    });
    const ok =
      status === 200 && body !== null && body.status === "ok" && typeof body.service === "string";
    console.log(
      `${ok ? "PASS" : "FAIL"} GET /api/v1/health -> HTTP ${status}${ok ? "" : ` ${snippet(raw)}`}`
    );
    if (!ok) {
      console.error("  expected 200 with { status: \"ok\", service: <string> }");
      failures += 1;
    }
  } catch (error) {
    console.log(`FAIL GET /api/v1/health -> ${error.name === "AbortError" ? "timeout" : String(error)}`);
    failures += 1;
  }

  // Probe 2 — authenticated staging slice. In scheduled (skip-safe) mode a
  // missing token skips the authed probes with an explicit log instead of
  // failing: the job has no operator credentials and must not page on that.
  const token = resolveToken(tokenEnv);
  let authedSkipped = 0;
  if (!token) {
    if (skipIfNoToken) {
      console.log(formatSkipLine({ path: "/api/v1/shadow/health" }));
      authedSkipped += 1;
    } else {
      console.log("FAIL GET /api/v1/shadow/health -> no bearer token found");
      console.error(
        "  set SHADOW_API_TOKEN (or CUSTOMER_SNAPSHOT_SYNC_SECRET) in the environment,",
        "pass --token-env=NAME, or populate .dev.vars for local dev. The token value is never logged."
      );
      failures += 1;
    }
  } else {
    try {
      const { status, body, raw } = await fetchJson(`${origin}/api/v1/shadow/health`, {
        token: token.value,
        timeoutMs,
      });
      const ok =
        status === 200 &&
        body !== null &&
        body.status === "ok" &&
        typeof body.service === "string" &&
        body.version === "v1";
      console.log(
        `${ok ? "PASS" : "FAIL"} GET /api/v1/shadow/health -> HTTP ${status} (token from ${token.source}; value redacted)${ok ? "" : ` ${snippet(raw)}`}`
      );
      if (!ok) {
        if (status === 401) {
          console.error("  got 401: the token was rejected (check the value, not the script).");
        } else {
          console.error('  expected 200 with { status: "ok", service: <string>, version: "v1" }');
        }
        failures += 1;
      }
    } catch (error) {
      console.log(
        `FAIL GET /api/v1/shadow/health -> ${error.name === "AbortError" ? "timeout" : String(error)} (token from ${token.source}; value redacted)`
      );
      failures += 1;
    }
  }

  // Probe 3 — authenticated deep readiness (D1, R2, report config).
  // Uses the same bearer resolved above; 200 means ready, 503 means the
  // Worker is up but a dependency is degraded — both prove the endpoint
  // answered, but either way the deploy must not roll forward silently.
  if (!token) {
    if (skipIfNoToken) {
      console.log(formatSkipLine({ path: "/api/v1/readiness" }));
      authedSkipped += 1;
    } else {
      console.log("FAIL GET /api/v1/readiness -> no bearer token found (see probe 2)");
      failures += 1;
    }
  } else {
    try {
      const { status, body, raw } = await fetchJson(`${origin}/api/v1/readiness`, {
        token: token.value,
        timeoutMs,
      });
      const ok =
        (status === 200 || status === 503) &&
        body !== null &&
        (body.status === "ok" || body.status === "degraded") &&
        typeof body.service === "string" &&
        body.checks !== null &&
        typeof body.checks === "object";
      console.log(
        `${ok ? "PASS" : "FAIL"} GET /api/v1/readiness -> HTTP ${status} (token from ${token.source}; value redacted)${ok ? "" : ` ${snippet(raw)}`}`
      );
      if (!ok) {
        if (status === 401) {
          console.error("  got 401: the token was rejected (check the value, not the script).");
        } else {
          console.error('  expected 200/503 with { status: "ok"|"degraded", service: <string>, checks: {...} }');
        }
        failures += 1;
      } else if (status === 503 || body.status === "degraded") {
        console.error("  readiness reports degraded dependencies (see checks above) — failing the probe.");
        failures += 1;
      }
      // Probe 3b — cron freshness (TOG-9225, gap O4). The scheduled 07:30 UTC
      // probe runs after the 07:00 cron, so a stale verdict here means the
      // cron is dead (two consecutive misses past the 48h threshold) and the
      // job must go red — that is the alert. Manual runs assert it too: a
      // human pointing the probe at staging wants the same answer. Only
      // timestamps/outcomes leave the server (never row data or error text).
      const freshness = evalCronFreshness({ cron: body.checks?.cron });
      if (freshness.verdict === "stale") {
        console.log(
          `FAIL cron freshness -> STALE lastRunAt=${freshness.lastRunAt ?? "none"}${freshness.detail ? ` — ${freshness.detail}` : ""}`
        );
        console.error("  the daily cron has not recorded a run within 48h — check the cron trigger and docs/CRON-SYNC-ALARM-RUNBOOK.md.");
        failures += 1;
      } else if (freshness.verdict === "fresh") {
        console.log(`PASS cron freshness -> fresh lastRunAt=${freshness.lastRunAt ?? "none"}`);
      } else {
        console.log("  cron freshness: UNKNOWN (older deploy without checks.cron) — advisory only, not failing.");
      }
    } catch (error) {
      console.log(
        `FAIL GET /api/v1/readiness -> ${error.name === "AbortError" ? "timeout" : String(error)} (token from ${token.source}; value redacted)`
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`\npost-deploy probe: ${failures} probe(s) failed against ${origin}`);
    exit(1);
  }
  if (authedSkipped > 0) {
    console.log(`\npost-deploy probe: public probe passed against ${origin}; ${authedSkipped} authed probe(s) skipped (no token, ${SKIP_FLAG})`);
    return;
  }
  console.log(`\npost-deploy probe: all three probes passed against ${origin}`);
}

await main();
