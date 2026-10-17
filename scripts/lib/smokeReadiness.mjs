/**
 * Pure verdict logic for the post-deploy smoke check.
 *
 * `scripts/smoke-readiness.mjs` is the thin impure wrapper around this module:
 * it resolves env/flags, calls `runSmokeReadiness` with the real `fetch`, prints
 * the returned lines, and exits with the returned code. Everything here is pure
 * (responses in, output lines and exit code out) except `runSmokeReadiness`,
 * which takes an injected `fetchImpl` so unit tests can use a fake without
 * spawning processes. Never print token values from this module.
 */

export const CHECK_NAME = "smoke-readiness";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const HEALTH_PATH = "/api/v1/health";
export const READINESS_PATH = "/api/v1/readiness";

export function usage() {
  return [
    `Usage: SHADOW_API_BASE=<origin> SHADOW_API_TOKEN=<token> node scripts/smoke-readiness.mjs [--timeout-ms=N]`,
    "",
    "  --timeout-ms=N  Per-request fetch timeout in ms (default 15000)",
    "",
    "Hits the public liveness probe first (no auth), then the authenticated",
    "readiness probe, and prints per-dependency status. Exits 0 only when the",
    "Worker is up AND every readiness check passes; exits 1 otherwise, exits 2",
    "on missing env or an invalid flag. The token value is never printed.",
  ].join("\n");
}

/**
 * @param {string[]} args argv without node/script (e.g. process.argv.slice(2))
 * @returns {{ timeoutMs: number }}
 * @throws {Error} with a usage message on an invalid flag value
 */
export function parseSmokeArgs(args) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (const arg of args ?? []) {
    if (arg === "--help" || arg === "-h") {
      const done = new Error(usage());
      done.code = "SMOKE_HELP";
      throw done;
    } else if (arg.startsWith("--timeout-ms=")) {
      const n = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(n) || n <= 0) {
        const invalid = new Error(`Invalid --timeout-ms value: ${arg}\n\n${usage()}`);
        invalid.code = "SMOKE_BAD_TIMEOUT";
        throw invalid;
      }
      timeoutMs = Math.floor(n);
    } else if (arg.startsWith("--")) {
      const unknown = new Error(`Unknown flag: ${arg}\n\n${usage()}`);
      unknown.code = "SMOKE_BAD_FLAG";
      throw unknown;
    }
  }
  return { timeoutMs };
}

/**
 * Map a fetch rejection to a one-line error class for `FAIL ... -> <class>`.
 * AbortError (our timeout) becomes "timeout"; a Node cause code (e.g.
 * ECONNREFUSED) passes through; anything else is "network-error". Never
 * includes the token: callers must not interpolate error.message, which could
 * echo request details.
 */
export function classifyFetchError(error) {
  if (error?.name === "AbortError") return "timeout";
  const code = error?.cause?.code;
  if (typeof code === "string" && code !== "") return code;
  return "network-error";
}

/**
 * Fetch JSON with a per-request timeout. Resolves to `{ status, body }` where
 * `body` is null for empty or non-JSON payloads. Rejects on timeout/network;
 * callers map the rejection with `classifyFetchError`.
 */
export async function fetchJson(fetchImpl, url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    // Read the body outside the parse try: a stall here must reject into
    // classifyFetchError (timeout), not be swallowed as body=null.
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure verdict: responses in, output lines and exit code out.
 *
 * Each of `health`, `unauth`, `ready` is either `{ status, body }` or
 * `{ error }` (a classified error class from `classifyFetchError`). Output
 * strings on the passing path are byte-identical to the previous wrapper
 * so `test/firstRun.test.ts` stays green.
 *
 * @returns {{ stdout: string[], stderr: string[], exitCode: number }}
 */
export function evaluateSmokeReadiness({ health, unauth, ready }) {
  const stdout = [];
  const stderr = [];
  let failed = false;

  // 1. Liveness — public, must be 200 {"status":"ok"}.
  if (health?.error) {
    stderr.push(`FAIL liveness: GET ${HEALTH_PATH} -> ${health.error}`);
    failed = true;
  } else if (health?.status !== 200 || health?.body?.status !== "ok") {
    stderr.push(`FAIL liveness: GET ${HEALTH_PATH} -> ${health?.status}`);
    failed = true;
  } else {
    stdout.push(`PASS liveness: GET ${HEALTH_PATH} -> 200 ok`);
  }

  // 2. Readiness without a token must 401 (gate is up).
  if (unauth?.error) {
    stderr.push(`FAIL auth gate: unauthenticated readiness -> ${unauth.error}`);
    failed = true;
  } else if (unauth?.status !== 401) {
    stderr.push(`FAIL auth gate: unauthenticated readiness -> ${unauth?.status} (expected 401)`);
    failed = true;
  } else {
    stdout.push("PASS auth gate: unauthenticated readiness -> 401");
  }

  // 3. Authenticated readiness — per-dependency status.
  if (ready?.error) {
    stderr.push(`FAIL readiness: GET ${READINESS_PATH} -> ${ready.error}`);
    failed = true;
    return { stdout, stderr, exitCode: 1 };
  }
  const checks = ready?.body?.checks;
  stdout.push(`readiness: HTTP ${ready?.status} status=${ready?.body?.status ?? "unknown"}`);
  for (const name of ["d1", "r2", "config"]) {
    const c = checks?.[name];
    if (!c) {
      stdout.push(`  ${name}: MISSING from response`);
      failed = true;
      continue;
    }
    const flag = name === "config"
      ? `customer=${c.customer} address=${c.address} container=${c.container}`
      : name === "r2"
        ? `bound=${c.bound} enabled=${c.enabled}`
        : "";
    stdout.push(`  ${name}: ${c.ok ? "ok" : "NOT OK"} ${flag}${c.detail ? ` — ${c.detail}` : ""}`.trimEnd());
    if (!c.ok) failed = true;
  }

  // 4. Cron staleness — advisory only. Never flips the overall status.
  const cron = checks?.cron;
  if (!cron) {
    stdout.push("  cron: MISSING from response (older deploy?)");
  } else {
    const perTable = ["customer", "address", "container"]
      .map((t) => `${t}=${cron.tables?.[t]?.outcome ?? "none"}@${cron.tables?.[t]?.ranAt ?? "?"}`)
      .join(" ");
    stdout.push(
      `  cron: ${cron.stale ? "STALE (advisory)" : "fresh"} lastRunAt=${cron.lastRunAt ?? "none"} ${perTable}${cron.detail ? ` — ${cron.detail}` : ""}`.trimEnd()
    );
  }

  if (ready?.status !== 200 || ready?.body?.status !== "ok") {
    stderr.push("FAIL readiness: Worker up but a dependency is degraded (see above)");
    failed = true;
  } else {
    stdout.push("PASS readiness: all dependencies ok");
  }

  return { stdout, stderr, exitCode: failed ? 1 : 0 };
}

/**
 * Run the three smoke probes with per-request timeouts, catching every fetch
 * rejection into a one-line FAIL (no stack trace, no token).
 *
 * @param {{ fetchImpl: Function, base: string, token: string, timeoutMs: number }} opts
 * @returns {Promise<{ stdout: string[], stderr: string[], exitCode: number }>}
 */
export async function runSmokeReadiness({ fetchImpl, base, token, timeoutMs }) {
  const origin = String(base ?? "").replace(/\/$/, "");
  const authHeaders = { authorization: `Bearer ${token}` };

  let health;
  try {
    health = await fetchJson(fetchImpl, `${origin}${HEALTH_PATH}`, {
      headers: {},
      timeoutMs,
    });
  } catch (error) {
    health = { error: classifyFetchError(error) };
  }

  let unauth;
  try {
    unauth = await fetchJson(fetchImpl, `${origin}${READINESS_PATH}`, {
      headers: {},
      timeoutMs,
    });
  } catch (error) {
    unauth = { error: classifyFetchError(error) };
  }

  let ready;
  try {
    ready = await fetchJson(fetchImpl, `${origin}${READINESS_PATH}`, {
      headers: authHeaders,
      timeoutMs,
    });
  } catch (error) {
    ready = { error: classifyFetchError(error) };
  }

  return evaluateSmokeReadiness({ health, unauth, ready });
}
