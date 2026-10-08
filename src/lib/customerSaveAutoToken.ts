import {
  forwardWithSessionRetry,
  type ModalRetryContext
} from "./forwardWithSessionRetry";
import { readSessionState, type SessionState } from "./sessionState";
import { readUpstreamText } from "./upstreamBody";
import { forwardToUpstream } from "./upstreamForward";
import { requireAuthenticatedModal } from "./sessionPreparation";
import { readUpstreamTimeoutMs } from "./upstreamTimeout";
import { routewareWebRwUrl } from "./upstreamUrl";

function escapeRegexKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last occurrence wins (duplicate keys in x-www-form-urlencoded). */
export function lastUrlEncodedValue(raw: string, key: string): string | undefined {
  // TOG-6520: case-EXACT on purpose. Upstream `Save*` actions read form keys
  // case-sensitively, so a case-insensitive match here picks the edit modal
  // (e.g. `customerid=5` matching `CustomerID`) while upstream treats the same
  // body as a create — an edit-modal token on a create body, a silent wrong
  // operation on PII. Lowercase keys must fall through to the create path.
  const re = new RegExp(`(?:^|&)${escapeRegexKey(key)}=([^&]*)`, "g");
  let m: RegExpExecArray | null;
  let lastEnc: string | undefined;
  while ((m = re.exec(raw)) !== null) {
    lastEnc = m[1];
  }
  if (lastEnc === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(lastEnc.replace(/\+/g, " "));
  } catch {
    return lastEnc.replace(/\+/g, " ");
  }
}

export function extractRequestVerificationTokenFromHtml(html: string): string | null {
  const nameFirst =
    /<input\b[^>]*\bname\s*=\s*["']__RequestVerificationToken["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/i.exec(
      html
    );
  if (nameFirst) {
    return nameFirst[1];
  }
  const valueFirst =
    /<input\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']__RequestVerificationToken["']/i.exec(
      html
    );
  if (valueFirst) {
    return valueFirst[1];
  }
  return null;
}

export function isPlaceholderAntiForgeryToken(value: string): boolean {
  const t = value.trim();
  if (!t) {
    return true;
  }
  if (/replace/i.test(t)) {
    return true;
  }
  if (t === "PASTE_TOKEN_FROM_LOAD_LONG_MODAL_OR_ADD_NEW") {
    return true;
  }
  return false;
}

/** Strips all `__RequestVerificationToken` pairs, then prepends a fresh one. */
export function injectAntiForgeryTokenIntoUrlencoded(raw: string, token: string): string {
  const enc = encodeURIComponent(token);
  let rest = raw.replace(/(?:^|&)__RequestVerificationToken=[^&]*/gi, "");
  rest = rest.replace(/^&+/, "").replace(/&+$/, "");
  return `__RequestVerificationToken=${enc}${rest ? `&${rest}` : ""}`;
}

function autoTokenEnabled(env: Env): boolean {
  const v = env.CUSTOMER_SAVE_AUTO_TOKEN as string;
  return v !== "false" && v !== "0";
}

/**
 * Short server-side TTL for a cached anti-forgery token. Five minutes is long
 * enough that a burst of saves shares one modal GET, and short enough that a
 * rotated upstream token stops being served quickly. Overridable per deploy
 * via the optional `CUSTOMER_SAVE_AUTO_TOKEN_TTL_SECONDS` binding without a
 * `wrangler.toml` change (absent/invalid falls back to the default).
 */
const DEFAULT_ANTI_FORGERY_TOKEN_TTL_MS = 5 * 60 * 1000;

function antiForgeryTokenTtlMs(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>)
    .CUSTOMER_SAVE_AUTO_TOKEN_TTL_SECONDS;
  const seconds =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return DEFAULT_ANTI_FORGERY_TOKEN_TTL_MS;
}

type CachedAntiForgeryToken = { token: string; expiresAtMs: number };

/**
 * Isolate-local token cache, keyed by Routeware session + exact modal URL.
 *
 * The session-cookie prefix is the whole point: after `forwardWithSessionRetry`
 * re-establishes a session, the new cookie misses the old entry and the next
 * save fetches a token bound to the fresh session instead of replaying one
 * minted for the dead session. The modal-URL suffix keeps create (`AddNewLong`)
 * and edit (`LoadLongCustomerModal?customerID=`) tokens on separate entries.
 *
 * Deliberately NOT a cross-isolate store: a cold isolate pays one extra modal
 * GET, which is the safe failure mode. There is no single-flight dedup either —
 * two concurrent cold saves may each fetch; the second write simply overwrites
 * the first with an equally valid token.
 */
const antiForgeryTokenCache = new Map<string, CachedAntiForgeryToken>();

function antiForgeryCacheKey(session: SessionState, modalUrl: URL): string {
  return `${session.cookieHeader ?? "no-session"}|${modalUrl.toString()}`;
}

/**
 * Drop all cached anti-forgery tokens. Tests call this in `beforeEach` (the
 * module-level `Map` outlives a single test); production code can call it to
 * force a refetch when an upstream save rejects a token as stale.
 *
 * Note on retry scope: a rejected *save* POST is never retried blindly here —
 * the POST is not idempotent (a create may already have executed upstream) and
 * only a login redirect is provably safe to retry, which is what
 * `forwardWithSessionRetry` already handles. This cache only avoids the modal
 * GET; session rotation and TTL expiry are what evict entries.
 */
export function clearAntiForgeryTokenCache(): void {
  antiForgeryTokenCache.clear();
}

/**
 * TOG-8149: drop every cache entry holding a save-rejected token.
 *
 * Keyed by value, not by session + modal URL, on purpose: after a modal heal
 * `resolveSaveCustomerLongFormToken` stores the entry under the FRESH session
 * while the route still holds the stale one, so a session-keyed evict from the
 * route would miss. The rejected token is known (it is in the forwarded save
 * body), and evicting by value leaves other sessions' tokens — and a cached
 * token a client-supplied explicit token bypassed — untouched. Over-evicting
 * is the safe direction anyway: worst case the next save pays one modal GET.
 *
 * Returns true when at least one entry was dropped.
 */
export function evictAntiForgeryTokenCacheByToken(rejectedToken: string): boolean {
  let evicted = false;
  for (const [key, entry] of antiForgeryTokenCache) {
    if (entry.token === rejectedToken) {
      antiForgeryTokenCache.delete(key);
      evicted = true;
    }
  }
  return evicted;
}

/**
 * TOG-8149: `evictAntiForgeryTokenCacheByToken` for a forwarded save body.
 * Parses `__RequestVerificationToken` (last occurrence wins, same as the
 * inject path) and evicts entries holding it. Returns false when the body
 * carries no token — nothing cached could have been replayed. Never throws:
 * a silent-failure branch must stay a 502, never become a 500.
 */
export function evictAntiForgeryTokenCacheForBody(
  bodyBuffer: ArrayBuffer | null
): boolean {
  try {
    if (!bodyBuffer || bodyBuffer.byteLength === 0) {
      return false;
    }
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bodyBuffer);
    const token = lastUrlEncodedValue(raw, "__RequestVerificationToken");
    if (!token) {
      return false;
    }
    return evictAntiForgeryTokenCacheByToken(token);
  } catch {
    return false;
  }
}

export type PrepareSaveBodyOptions = ModalRetryContext & {
  /** Skip the cache entry even when fresh (stale-token recovery). */
  forceRefresh?: boolean;
  /** Clock override for TTL tests; defaults to `Date.now()`. */
  nowMs?: number;
};

/**
 * Resolve a save-long-form anti-forgery token, preferring the cache. A fresh
 * cached entry for this session + modal URL avoids the modal GET entirely;
 * on a miss (or `forceRefresh`) exactly one GET populates the entry.
 *
 * TOG-6462: with retry context the modal GET runs through
 * `forwardWithSessionRetry`, so an expired stored session (modal answers 302
 * → login, or HTTP-200 login page) re-establishes once and retries instead of
 * surfacing a 502 the next save would hit again. Healing is bounded: exactly
 * one re-login and one retry (a retry that still sees login is returned
 * as-is — non-2xx — and surfaces here as the modal-load error), and a hung
 * upstream throws `UpstreamTimeoutError`, which the retry helper never
 * retries, instead of looping.
 */
export async function resolveSaveCustomerLongFormToken(
  env: Env,
  session: SessionState,
  incoming: Request,
  modalUrl: URL,
  modalPath: string,
  options: PrepareSaveBodyOptions = {}
): Promise<string> {
  const nowMs = options.nowMs ?? Date.now();
  const retry =
    options.sessionStub && options.establishSession
      ? { sessionStub: options.sessionStub, establishSession: options.establishSession }
      : null;
  if (!options.forceRefresh) {
    const cached = antiForgeryTokenCache.get(antiForgeryCacheKey(session, modalUrl));
    if (cached && nowMs < cached.expiresAtMs) {
      return cached.token;
    }
  }

  const modalReq = new Request("http://routeware-shadow.internal/modal", {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "x-requested-with": "XMLHttpRequest",
      referer: incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });

  const modalResp = retry
    ? await forwardWithSessionRetry(
        env,
        retry.sessionStub,
        modalReq,
        modalUrl,
        null,
        retry.establishSession,
        { internalMarker: "anti-forgery-modal" }
      )
    : await forwardToUpstream(modalReq, modalUrl, session, null, {
        internalMarker: "anti-forgery-modal",
        // Direct modal path honors UPSTREAM_TIMEOUT_MS (TOG-8359) — the
        // forwarder default alone would ignore the per-deploy override.
        timeoutMs: readUpstreamTimeoutMs(env)
      });
  await requireAuthenticatedModal(modalResp, readUpstreamTimeoutMs(env));
  if (!modalResp.ok) {
    throw new Error(
      `Could not load anti-forgery modal (${modalPath}): HTTP ${modalResp.status}`
    );
  }
  const html = await readUpstreamText(modalResp, readUpstreamTimeoutMs(env));
  const token = extractRequestVerificationTokenFromHtml(html);
  if (!token) {
    throw new Error(
      "Could not parse __RequestVerificationToken from Routeware modal HTML (layout may have changed)."
    );
  }
  // Key on the session the token was minted for. After a heal the DO holds
  // the fresh session; caching under it keeps the next save on one modal GET.
  // The direct path has no DO read — the passed session stays the key.
  const cacheSession = retry
    ? await readSessionState(retry.sessionStub)
    : session;
  antiForgeryTokenCache.set(antiForgeryCacheKey(cacheSession, modalUrl), {
    token,
    expiresAtMs: nowMs + antiForgeryTokenTtlMs(env)
  });
  return token;
}

/**
 * For SaveCustomerLongForm: if the body is x-www-form-urlencoded and the anti-forgery
 * token is missing or a placeholder, resolve the token via the session-keyed cache
 * (one modal GET per TTL window) and inject `__RequestVerificationToken` before
 * forwarding upstream.
 *
 * With retry context (`options.sessionStub` + `options.establishSession`) the
 * modal fetch runs through `forwardWithSessionRetry`, so an expired stored
 * session (modal answers 302 → login, or HTTP-200 login page) re-establishes
 * once and retries instead of surfacing a 502 the next save would hit again
 * (TOG-6462). Supplied-token and disabled-auto-token paths return before any
 * session read, unchanged.
 */
export async function prepareSaveCustomerLongFormBody(
  env: Env,
  session: SessionState,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null,
  options: PrepareSaveBodyOptions = {}
): Promise<ArrayBuffer | null> {
  if (!autoTokenEnabled(env)) {
    return bodyBuffer;
  }
  if (!bodyBuffer || bodyBuffer.byteLength === 0) {
    return bodyBuffer;
  }
  const ct = (contentType ?? "").toLowerCase();
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return bodyBuffer;
  }

  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bodyBuffer);
  const existing = lastUrlEncodedValue(raw, "__RequestVerificationToken");
  if (existing && !isPlaceholderAntiForgeryToken(existing)) {
    return bodyBuffer;
  }

  const customerIdRaw = lastUrlEncodedValue(raw, "CustomerID");
  const customerId =
    customerIdRaw !== undefined ? Number.parseInt(customerIdRaw, 10) : Number.NaN;
  const useEditModal = Number.isFinite(customerId) && customerId > 0;

  const modalPath = useEditModal ? "/Customer/LoadLongCustomerModal" : "/Customer/AddNewLong";
  const modalUrl = routewareWebRwUrl(env.TARGET_ORIGIN, env.TARGET_BASE_PATH, modalPath);
  if (useEditModal) {
    modalUrl.searchParams.set("customerID", String(customerId));
  }

  const token = await resolveSaveCustomerLongFormToken(
    env,
    session,
    incoming,
    modalUrl,
    modalPath,
    options
  );

  const merged = injectAntiForgeryTokenIntoUrlencoded(raw, token);
  return new TextEncoder().encode(merged).buffer;
}
