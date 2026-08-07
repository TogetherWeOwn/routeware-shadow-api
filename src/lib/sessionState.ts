export type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

export async function readSessionState(
  stub: DurableObjectStub
): Promise<SessionState> {
  const response = await stub.fetch("https://auth/get");
  return response.json() as Promise<SessionState>;
}

const MS_PER_SECOND = 1000;

/**
 * Absolute expiry (epoch ms) for a session established now.
 *
 * Validates `SESSION_TTL_SECONDS` rather than trusting it: `Number(undefined)` is
 * `NaN`, and a `NaN` expiry silently disables proactive refresh forever, because
 * every `now >= expiresAtMs - skew` comparison against `NaN` is false. Failing
 * loudly here beats a Worker that quietly stops refreshing. The generated `Env`
 * type claims this is always present, but that type is derived from
 * `wrangler.toml` and is not enforced at runtime.
 */
export function sessionExpiryMs(env: Env, nowMs: number = Date.now()): number {
  const ttlSeconds = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      `SESSION_TTL_SECONDS must be a positive number; got ${JSON.stringify(env.SESSION_TTL_SECONDS)}.`
    );
  }
  return nowMs + ttlSeconds * MS_PER_SECOND;
}
