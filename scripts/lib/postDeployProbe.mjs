/**
 * Skip-safe planning for the post-deploy probe (gap G18).
 *
 * The scheduled workflow runs without operator credentials: when no bearer
 * token is resolvable, the authed probes must SKIP (explicit log) instead of
 * failing, while the public liveness probe still runs. Manual runs stay
 * strict (missing token fails) unless the caller passes --skip-if-no-token.
 *
 * Read-only guarantee: every planned probe is a GET against a fixed
 * /api/v1/* path; the planner never produces a mutating method or path.
 */

export const CHECK_NAME = "post-deploy-probe";
export const SKIP_FLAG = "--skip-if-no-token";
export const SCHEDULED_FLAG = "--scheduled";
export const BASE_ENV = "SHADOW_API_BASE";
export const DEFAULT_BASE = "http://localhost:8787";

export const PROBES = Object.freeze([
  Object.freeze({ id: "public-health", method: "GET", path: "/api/v1/health", authenticated: false }),
  Object.freeze({ id: "shadow-health", method: "GET", path: "/api/v1/shadow/health", authenticated: true }),
  Object.freeze({ id: "readiness", method: "GET", path: "/api/v1/readiness", authenticated: true }),
]);
export const PUBLIC_PROBE_PATH = PROBES[0].path;
export const AUTHED_PROBE_PATHS = Object.freeze(PROBES.filter((p) => p.authenticated).map((p) => p.path));

/** All probe paths the script may ever hit (GET only, read-only). */
export const ALL_PROBE_PATHS = Object.freeze(PROBES.map((p) => p.path));

/**
 * Resolve the probe base origin: explicit positional arg wins, then the
 * SHADOW_API_BASE environment variable (same name as
 * scripts/smoke-readiness.mjs), then the local-dev default for manual runs.
 * Scheduled runs require an explicit remote HTTPS target before any fetch.
 */
export function resolveBase({ positional = "", env = {}, scheduled = false } = {}) {
  const configured = (positional ?? "").trim() || String(env[BASE_ENV] ?? "").trim();
  if (!scheduled && env.GITHUB_EVENT_NAME !== "schedule") return configured || DEFAULT_BASE;
  if (!configured) {
    throw new Error(`scheduled probe requires ${BASE_ENV} or <base-url>; configure an approved staging origin (no localhost fallback)`);
  }
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("scheduled probe requires a valid staging HTTPS origin");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const local = host === "localhost" || host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) || host === "0.0.0.0" || host === "[::1]" || host === "[::]" ||
    /^\[::ffff:(7f[0-9a-f]{2}:|0:0\])/.test(host);
  if (url.protocol !== "https:" || local || url.username || url.password) {
    throw new Error("scheduled probe requires a remote staging HTTPS origin without URL credentials (local targets are not allowed)");
  }
  if (url.pathname !== "/" || configured.includes("?") || configured.includes("#")) {
    throw new Error("scheduled probe requires a bare staging HTTPS origin (no non-root path, query, or fragment)");
  }
  return configured;
}

/**
 * Plan each probe as "run", "skip" (no token + skip flag), or "fail"
 * (no token, strict manual mode). The public liveness probe always runs.
 */
export function planProbes({ hasToken, skipIfNoToken } = {}) {
  const authedMode = hasToken ? "run" : skipIfNoToken ? "skip" : "fail";
  const reason = hasToken
    ? null
    : skipIfNoToken
      ? "no bearer token (scheduled skip-safe mode)"
      : "no bearer token";
  return [
    { path: PUBLIC_PROBE_PATH, mode: "run", reason: null },
    ...AUTHED_PROBE_PATHS.map((path) => ({ path, mode: authedMode, reason })),
  ];
}

/**
 * Cron-freshness verdict (gap O4).
 *
 * The server computes staleness (`GET /api/v1/readiness` →
 * `checks.cron.stale`, threshold `CRON_STALE_AFTER_MS` in
 * `src/lib/readiness.ts`, 48h); the probe only reads the verdict, never
 * re-implements the threshold, so the two cannot drift apart.
 *
 * Returns one of:
 * - "stale"   — `cron.stale === true`: the daily cron has not recorded a run
 *               within the threshold. The probe must fail (that is the alert).
 * - "fresh"   — `cron.stale === false`: the cron is running. Pass.
 * - "unknown" — absent legacy cron metadata; advisory only.
 * - "malformed" — present metadata without an explicit boolean stale; fail.
 * Metadata is retained for existing library consumers, never CLI output.
 */
export function evalCronFreshness({ cron } = {}) {
  if (cron === undefined) {
    return { verdict: "unknown", lastRunAt: null, detail: null };
  }
  if (!isRecord(cron) || typeof cron.stale !== "boolean") {
    return { verdict: "malformed", lastRunAt: null, detail: null };
  }
  return {
    verdict: cron.stale ? "stale" : "fresh",
    lastRunAt: cron.lastRunAt ?? null,
    detail: typeof cron.detail === "string" ? cron.detail : null,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only fixed diagnostics leave the CLI; never format response or exception text.
export const NEXT_ACTIONS = Object.freeze({
  invalid_arguments: "Use --help and supply each option once with at most one target.",
  invalid_target: "scheduled probe requires a bare remote HTTPS origin without URL credentials, path, query or fragment; for manual runs supply a valid HTTP(S) URL.",
  missing_token: "Set SHADOW_API_TOKEN or CUSTOMER_SNAPSHOT_SYNC_SECRET, or pass --token-env=NAME; use --skip-if-no-token only for skip-safe execution.",
  http_auth: "Verify the selected bearer token and its authorization for the target; do not retry with another credential.",
  http_client: "Check target routing and access policy; for HTTP 429 respect the service retry guidance before a separately authorized run.",
  http_server: "Inspect the target service and dependency health before a separately authorized run.",
  http_redirect: "Verify the intended origin and routing; redirects are not followed by this fixed-GET probe.",
  http_status: "Verify the target implements the documented health and readiness status contract.",
  network_error: "Check target connectivity and TLS configuration before a separately authorized run.",
  timeout: "Check target latency and dependency health; the timeout covers fetch and response body reading.",
  invalid_json: "Verify the endpoint returns a JSON health payload rather than an intermediary response.",
  invalid_health: "Verify the health endpoint returns status ok, a service string and the documented API version where required.",
  invalid_readiness: "Inspect readiness dependencies and verify the documented readiness payload contract.",
  cron_stale: "Check the cron trigger and docs/CRON-SYNC-ALARM-RUNBOOK.md; use the server staleness verdict, not a local timestamp threshold.",
  malformed_readiness: "Verify checks.cron contains an explicit boolean stale; inspect the deployed readiness contract before proceeding.",
});

export function probeResult(probe, { outcome = "pass", errorCode = null, httpStatus = null, cron = null } = {}) {
  return {
    id: probe.id, method: probe.method, path: probe.path, outcome, errorCode,
    httpStatus, httpClass: httpStatus === null ? null : `${Math.floor(httpStatus / 100)}xx`,
    retryable: ["network_error", "timeout", "http_server"].includes(errorCode) || httpStatus === 429,
    nextAction: errorCode === null ? null : NEXT_ACTIONS[errorCode], cron,
  };
}

export function probePlan() {
  return PROBES.map((probe) => ({
    ...probeResult(probe, { outcome: probe.authenticated ? "unresolved" : "planned" }),
    nextAction: probe.authenticated ? "Resolve the selected bearer token only during a separately authorized execution; this plan does not inspect credentials." : null,
  }));
}

/** Shared text/JSON evaluation. The body is read fully, but never serialized. */
export function evaluateProbe(probe, { httpStatus, body, invalidJson = false, errorCode = null }) {
  const fail = (code, cron = null) => probeResult(probe, { outcome: "fail", errorCode: code, httpStatus, cron });
  if (errorCode) return fail(errorCode);
  if (httpStatus === 401 || httpStatus === 403) return fail("http_auth");
  if (httpStatus >= 500) return fail("http_server");
  if (httpStatus >= 400) return fail("http_client");
  if (httpStatus >= 300) return fail("http_redirect");
  if (httpStatus !== 200) return fail("http_status");
  if (invalidJson) return fail("invalid_json");
  if (probe.id !== "readiness") {
    if (!isRecord(body) || body.status !== "ok" || typeof body.service !== "string" ||
        (probe.authenticated && body.version !== "v1")) return fail("invalid_health");
    return probeResult(probe, { httpStatus });
  }
  if (!isRecord(body) || !["ok", "degraded"].includes(body.status) ||
      typeof body.service !== "string" || !isRecord(body.checks)) return fail("invalid_readiness");
  const verdict = evalCronFreshness({ cron: body.checks.cron }).verdict;
  const cron = verdict === "unknown" ? "absent" : verdict;
  if (cron === "malformed") return fail("malformed_readiness", cron);
  if (cron === "stale") return fail("cron_stale", cron);
  if (body.status !== "ok") return fail("invalid_readiness", cron);
  return probeResult(probe, { httpStatus, cron });
}

export function probeDocument({ mode = "run", target = null, checks = [], errorCode = null } = {}) {
  const failure = checks.find((row) => row.outcome === "fail");
  const code = errorCode ?? failure?.errorCode ?? null;
  return {
    schemaVersion: 1, command: "probe:post-deploy", mode, ok: code === null,
    target, checks, errorCode: code, nextAction: code === null ? null : NEXT_ACTIONS[code],
  };
}

export function formatSkipLine({ path, reason } = {}) {
  return (
    `SKIP GET ${path} -> ${reason ?? "no bearer token"}\n` +
    `  set SHADOW_API_TOKEN (or CUSTOMER_SNAPSHOT_SYNC_SECRET) in the environment,` +
    ` pass --token-env=NAME, or drop ${SKIP_FLAG} to fail closed. The token value is never logged.`
  );
}
