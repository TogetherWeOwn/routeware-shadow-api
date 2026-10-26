#!/usr/bin/env node
/**
 * Fixed-GET post-deploy probe. Manual base resolution: positional target,
 * SHADOW_API_BASE, then localhost. Scheduled validation is not probe authority.
 * Plans/help/refusals never resolve credentials or read .dev.vars.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argv, env } from "node:process";
import {
  BASE_ENV, DEFAULT_BASE, SKIP_FLAG, SCHEDULED_FLAG, PROBES, NEXT_ACTIONS,
  evaluateProbe, formatSkipLine, probeDocument, probePlan, probeResult, resolveBase,
} from "./lib/postDeployProbe.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
// Bounded target plus fixed rows/diagnostics keeps JSON output below 8192 bytes.
const MAX_ORIGIN_LENGTH = 1024;

function usage() {
  return [
    `Usage: node scripts/post-deploy-probe.mjs [<base-url>] [--json] [--dry-run] [--token-env=NAME] [--timeout-ms=N] [${SKIP_FLAG}] [${SCHEDULED_FLAG}]`,
    "",
    `  <base-url>        Worker URL (defaults to $${BASE_ENV}, else ${DEFAULT_BASE})`,
    "  --json            One schemaVersion 1 JSON result; no stderr diagnostics.",
    "  --dry-run         Plan only: no fetch, credential resolution or .dev.vars read.",
    "                    Authenticated execution stays unresolved, even with a token.",
    "  --token-env=NAME   Select only this environment variable for the bearer.",
    "                    Default: SHADOW_API_TOKEN, else CUSTOMER_SNAPSHOT_SYNC_SECRET,",
    "                    then .dev.vars for local-dev convenience (execution only).",
    "  --timeout-ms=N     Per-probe timeout for fetch AND body read (default 15000).",
    `  ${SKIP_FLAG}  Missing token skips authed checks (exit 0); otherwise fails.`,
    `  ${SCHEDULED_FLAG}  Require a bare remote HTTPS origin; also enforced for schedule events.`,
    "                    Validation is not a hostname approval allowlist or permission.",
    "  --help, -h         Show this help without probing or resolving credentials.",
    "",
    ...PROBES.map((probe) => `  ${probe.id}: ${probe.method} ${probe.path}`),
    "",
    "JSON output is bounded to 8192 bytes, not the current response-body reader.",
    "No raw response, exception or cron metadata is printed. No redirects or retries.",
    "Exit 0 means checks passed (or explicit skips), or a valid plan, NOT plan health.",
    "In JSON mode --help returns an empty successful envelope, not a probe result.",
  ].join("\n");
}

function parseArgs(args) {
  let base = "";
  let tokenEnv = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let skipIfNoToken = false;
  let scheduled = false;
  let help = false;
  const seen = new Set();
  for (const arg of args) {
    const flag = arg.startsWith("-") ? arg.split("=", 1)[0] : "target";
    const key = flag === "-h" ? "--help" : flag;
    if (seen.has(key)) throw new Error("invalid_arguments");
    seen.add(key);
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json" || arg === "--dry-run") continue;
    else if (arg === SKIP_FLAG) skipIfNoToken = true;
    else if (arg === SCHEDULED_FLAG) scheduled = true;
    else if (arg.startsWith("--token-env=")) {
      tokenEnv = arg.slice("--token-env=".length);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error("invalid_arguments");
    } else if (arg.startsWith("--timeout-ms=")) {
      const n = Number(arg.slice("--timeout-ms=".length));
      // Node timers overflow outside the signed 32-bit range; never silently shorten a timeout.
      if (!Number.isFinite(n) || n < 1 || n > 2_147_483_647) throw new Error("invalid_arguments");
      timeoutMs = Math.floor(n);
    } else if (arg.startsWith("-")) throw new Error("invalid_arguments");
    else base = arg;
  }
  return { base, tokenEnv, timeoutMs, skipIfNoToken, scheduled, help };
}

/** Read KEY=value pairs from .dev.vars only during execution; never log values. */
function readDevVars() {
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const raw = fs.readFileSync(path.join(root, ".dev.vars"), "utf8").replace(/^﻿/, "");
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
  const names = tokenEnv ? [tokenEnv] : ["SHADOW_API_TOKEN", "CUSTOMER_SNAPSHOT_SYNC_SECRET"];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  if (!tokenEnv) {
    const devVars = readDevVars();
    for (const name of names) if (devVars[name]) return devVars[name];
  }
  return null;
}

async function fetchResult(probe, origin, { token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = null;
  try {
    const res = await fetch(`${origin}${probe.path}`, {
      method: probe.method,
      redirect: "manual",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    httpStatus = res.status;
    // Known HTTP failures do not need a body; a broken stream must not mask them.
    if (httpStatus !== 200) {
      controller.abort();
      return evaluateProbe(probe, { httpStatus });
    }
    // This slice bounds output, NOT response buffering. Keep the timer through text().
    const text = await res.text();
    let body = null;
    let invalidJson = false;
    try { body = JSON.parse(text); } catch { invalidJson = true; }
    return evaluateProbe(probe, { httpStatus, body, invalidJson });
  } catch (error) {
    return probeResult(probe, {
      outcome: "fail", httpStatus,
      errorCode: controller.signal.aborted || error?.name === "AbortError" ? "timeout" : "network_error",
    });
  } finally {
    clearTimeout(timer);
  }
}

function printTextCheck(row) {
  if (row.outcome === "skip") {
    console.log(formatSkipLine({ path: row.path }));
    return;
  }
  const diagnosis = row.errorCode === "missing_token" ? "no bearer token found"
    : row.httpStatus === null ? row.errorCode : `HTTP ${row.httpStatus}`;
  console.log(`${row.outcome.toUpperCase()} GET ${row.path} -> ${diagnosis}`);
  if (row.errorCode !== null) console.error(`  ${NEXT_ACTIONS[row.errorCode]}`);
  if (row.cron === "stale" || row.cron === "malformed") {
    console.log(`FAIL cron freshness -> ${row.cron === "stale" ? "STALE" : "malformed cron metadata"}`);
  } else if (row.cron === "fresh") console.log("PASS cron freshness -> fresh");
  else if (row.cron === "absent") console.log("  cron freshness: UNKNOWN (older deploy without checks.cron) — advisory only, not failing.");
}

function emit(doc, json) {
  if (json) console.log(JSON.stringify(doc));
  else if (doc.errorCode && doc.checks.length === 0) {
    console.error(`post-deploy probe configuration: ${NEXT_ACTIONS[doc.errorCode]}`);
  } else if (doc.mode === "dry-run") {
    console.log(`post-deploy probe plan against ${doc.target} (not a health result)`);
    for (const row of doc.checks) console.log(`${row.outcome} ${row.method} ${row.path}${row.nextAction ? ` — ${row.nextAction}` : ""}`);
  } else {
    const failures = doc.checks.filter((row) => row.outcome === "fail").length;
    const skipped = doc.checks.filter((row) => row.outcome === "skip").length;
    if (failures) console.error(`\npost-deploy probe: ${failures} probe(s) failed against ${doc.target}`);
    else if (skipped) console.log(`\npost-deploy probe: public probe passed against ${doc.target}; ${skipped} authed probe(s) skipped (no token, ${SKIP_FLAG})`);
    else console.log(`\npost-deploy probe: all three probes passed against ${doc.target}`);
  }
  process.exitCode = doc.ok ? 0 : 1;
}

async function main() {
  const args = argv.slice(2);
  // Detect a requested JSON mode even when its spelling/value or an earlier flag is invalid.
  const json = args.some((arg) => arg === "--json" || arg.startsWith("--json="));
  const mode = args.includes("--dry-run") ? "dry-run" : "run";
  let options;
  try { options = parseArgs(args); } catch {
    emit(probeDocument({ mode, errorCode: "invalid_arguments" }), json);
    return;
  }
  if (options.help) {
    if (json) emit(probeDocument({ mode }), true);
    else console.log(usage());
    return;
  }
  let origin;
  try {
    const base = resolveBase({ positional: options.base, env, scheduled: options.scheduled });
    const url = new URL(base);
    origin = url.origin;
    if (!["http:", "https:"].includes(url.protocol) || origin.length > MAX_ORIGIN_LENGTH) throw new Error();
  } catch {
    emit(probeDocument({ mode, errorCode: "invalid_target" }), json);
    return;
  }
  if (mode === "dry-run") {
    emit(probeDocument({ mode, target: origin, checks: probePlan() }), json);
    return;
  }
  const checks = [];
  // Preserve public-first execution, then resolve the bearer once for both authed checks.
  let token = null;
  for (const probe of PROBES) {
    if (probe === PROBES[1]) token = resolveToken(options.tokenEnv);
    const row = probe.authenticated && !token
      ? probeResult(probe, { outcome: options.skipIfNoToken ? "skip" : "fail", errorCode: "missing_token" })
      : await fetchResult(probe, origin, { token: probe.authenticated ? token : null, timeoutMs: options.timeoutMs });
    checks.push(row);
    if (!json) printTextCheck(row);
  }
  emit(probeDocument({ mode, target: origin, checks }), json);
}

await main();
