/**
 * Skip-safe planning for the post-deploy probe (TOG-8365, gap G18).
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
export const BASE_ENV = "SHADOW_API_BASE";
export const DEFAULT_BASE = "http://localhost:8787";

export const PUBLIC_PROBE_PATH = "/api/v1/health";
export const AUTHED_PROBE_PATHS = Object.freeze([
  "/api/v1/shadow/health",
  "/api/v1/readiness",
]);

/** All probe paths the script may ever hit (GET only, read-only). */
export const ALL_PROBE_PATHS = Object.freeze([
  PUBLIC_PROBE_PATH,
  ...AUTHED_PROBE_PATHS,
]);

/**
 * Resolve the probe base origin: explicit positional arg wins, then the
 * SHADOW_API_BASE environment variable (same name as
 * scripts/smoke-readiness.mjs), then the local-dev default. Blank inputs
 * fall through so an unset scheduled var never pins an empty origin.
 */
export function resolveBase({ positional = "", env = {} } = {}) {
  const fromArg = (positional ?? "").trim();
  if (fromArg) return fromArg;
  const fromEnv = String(env[BASE_ENV] ?? "").trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BASE;
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
 * Cron-freshness verdict (TOG-9225, gap O4).
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
 * - "unknown" — no `cron` object in the readiness body (older deploy that
 *               predates the TOG-8883 staleness probe). Advisory only: log,
 *               never fail, so old deploys do not page on a missing field.
 */
export function evalCronFreshness({ cron } = {}) {
  if (!cron || typeof cron !== "object") {
    return { verdict: "unknown", lastRunAt: null, detail: null };
  }
  const lastRunAt = cron.lastRunAt ?? null;
  const detail = typeof cron.detail === "string" ? cron.detail : null;
  if (cron.stale === true) {
    return { verdict: "stale", lastRunAt, detail };
  }
  return { verdict: "fresh", lastRunAt, detail };
}

export function formatSkipLine({ path, reason } = {}) {
  return (
    `SKIP GET ${path} -> ${reason ?? "no bearer token"}\n` +
    `  set SHADOW_API_TOKEN (or CUSTOMER_SNAPSHOT_SYNC_SECRET) in the environment,` +
    ` pass --token-env=NAME, or drop ${SKIP_FLAG} to fail closed. The token value is never logged.`
  );
}
