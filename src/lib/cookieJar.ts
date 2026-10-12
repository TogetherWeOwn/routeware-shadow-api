/**
 * Scoped session cookie jar (TOG-6529).
 *
 * `httpAuth.ts` used to keep only `name=value` per cookie, so a Path- or
 * Domain-scoped (or already expired) upstream cookie was replayed to every
 * upstream path. This module keeps the scope attributes per cookie and
 * selects only the in-scope, unexpired cookies for each forward URL.
 *
 * PII note: values live here in memory and in the `AuthSession` Durable
 * Object only. Nothing in this module logs names or values.
 */

export type StoredCookie = {
  name: string;
  value: string;
  /** Lowercased effective domain, leading dot stripped. */
  domain: string;
  /** True when no Domain attribute was set (exact-host match only). */
  hostOnly: boolean;
  /** Effective path, always starts with `/`. */
  path: string;
  /** Epoch ms, or null for a session cookie. */
  expiresAtMs: number | null;
  secure: boolean;
};

export type CookieJar = StoredCookie[];

export type ParsedSetCookie =
  | { kind: "set"; cookie: StoredCookie }
  | {
      kind: "delete";
      name: string;
      domain: string;
      hostOnly: boolean;
      path: string;
    };

/** RFC 6265 §5.1.4 default-path from a request path. */
export function defaultCookiePath(requestPath: string): string {
  if (!requestPath.startsWith("/") || requestPath === "/") {
    return "/";
  }
  const lastSlash = requestPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return requestPath.slice(0, lastSlash);
}

function requestScope(requestUrl: string): { host: string; path: string } {
  try {
    const url = new URL(requestUrl);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname || "/"
    };
  } catch {
    return { host: "", path: "/" };
  }
}

/**
 * Parse one `Set-Cookie` header value against the URL that set it.
 * Returns null when the header carries no usable `name=value` pair.
 * A `Max-Age<=0` or already-past `Expires` becomes a `delete` marker so
 * `mergeSetCookies` removes the matching entry instead of storing a
 * dead cookie.
 */
export function parseSetCookie(
  setCookie: string,
  requestUrl: string,
  nowMs: number = Date.now()
): ParsedSetCookie | null {
  const segments = setCookie.split(";");
  const pair = (segments.shift() ?? "").trim();
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const name = pair.slice(0, eq).trim();
  if (!name) {
    return null;
  }
  const value = pair.slice(eq + 1).trim();

  const scope = requestScope(requestUrl);
  let domain = scope.host;
  let hostOnly = true;
  let path: string | null = null;
  let maxAge: number | null = null;
  let expires: number | null = null;
  let secure = false;

  for (const segment of segments) {
    const raw = segment.trim();
    if (!raw) {
      continue;
    }
    const attrEq = raw.indexOf("=");
    const attrName = (attrEq < 0 ? raw : raw.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq < 0 ? "" : raw.slice(attrEq + 1).trim();
    if (attrName === "domain" && attrValue) {
      domain = attrValue.replace(/^\./, "").toLowerCase();
      hostOnly = false;
    } else if (attrName === "path" && attrValue.startsWith("/")) {
      path = attrValue;
    } else if (attrName === "max-age" && /^-?\d+$/.test(attrValue)) {
      maxAge = Number.parseInt(attrValue, 10);
    } else if (attrName === "expires" && attrValue) {
      const ms = Date.parse(attrValue);
      expires = Number.isFinite(ms) ? ms : null;
    } else if (attrName === "secure") {
      secure = true;
    }
  }

  const effectivePath = path ?? defaultCookiePath(scope.path);

  if (maxAge !== null) {
    if (maxAge <= 0) {
      return { kind: "delete", name, domain, hostOnly, path: effectivePath };
    }
    return {
      kind: "set",
      cookie: {
        name,
        value,
        domain,
        hostOnly,
        path: effectivePath,
        expiresAtMs: nowMs + maxAge * 1000,
        secure
      }
    };
  }
  if (expires !== null) {
    if (expires <= nowMs) {
      return { kind: "delete", name, domain, hostOnly, path: effectivePath };
    }
    return {
      kind: "set",
      cookie: { name, value, domain, hostOnly, path: effectivePath, expiresAtMs: expires, secure }
    };
  }
  return {
    kind: "set",
    cookie: { name, value, domain, hostOnly, path: effectivePath, expiresAtMs: null, secure }
  };
}

function jarKey(name: string, domain: string, path: string): string {
  return `${name}\n${domain}\n${path}`;
}

/**
 * Fold every `Set-Cookie` on a response into the jar, keyed by
 * (name, domain, path) per RFC 6265 §5.3. `requestUrl` is the URL that
 * produced the response — it supplies the default domain/path when the
 * header omits them. Responses without `getSetCookie` contribute nothing.
 */
export function mergeSetCookies(
  jar: CookieJar,
  res: Response,
  requestUrl: string,
  nowMs: number = Date.now()
): void {
  const list =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const header of list) {
    const parsed = parseSetCookie(header, requestUrl, nowMs);
    if (!parsed) {
      continue;
    }
    // De-structure per kind so the union narrows cleanly.
    const entry =
      parsed.kind === "delete"
        ? { name: parsed.name, domain: parsed.domain, path: parsed.path }
        : parsed.cookie;
    const key = jarKey(entry.name, entry.domain, entry.path);
    const index = jar.findIndex((c) => jarKey(c.name, c.domain, c.path) === key);
    if (parsed.kind === "delete") {
      if (index >= 0) {
        jar.splice(index, 1);
      }
      continue;
    }
    if (index >= 0) {
      jar[index] = parsed.cookie;
    } else {
      jar.push(parsed.cookie);
    }
  }
}

/** RFC 6265 §5.1.2 domain match. */
export function domainMatches(cookie: StoredCookie, host: string): boolean {
  if (!host || !cookie.domain) {
    return false;
  }
  if (host === cookie.domain) {
    return true;
  }
  return !cookie.hostOnly && host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 §5.1.4 path match. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * The `Cookie` header for one forward URL: only unexpired, in-scope
 * cookies, most-specific path first. Returns "" when nothing is in scope —
 * the caller then sends no `Cookie` header at all.
 */
export function cookieHeaderForUrl(
  jar: CookieJar,
  target: string | URL,
  nowMs: number = Date.now()
): string {
  let url: URL;
  try {
    url = target instanceof URL ? target : new URL(target);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  const requestPath = url.pathname || "/";
  const isSecure = url.protocol === "https:" || url.protocol === "wss:";
  return jar
    .filter(
      (c) =>
        (c.expiresAtMs === null || nowMs < c.expiresAtMs) &&
        (!c.secure || isSecure) &&
        domainMatches(c, host) &&
        pathMatches(c.path, requestPath)
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Minimal shape of a browser-observed cookie (superset-compatible with the
 * puppeteer `Cookie` type: `name`/`value` required, the rest optional).
 */
export type BrowserCookieLike = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Seconds since the UNIX epoch, `-1`/absent for session cookies. */
  expires?: number;
  /** True when the cookie was observed with the session flag. */
  session?: boolean;
  secure?: boolean;
};

/**
 * Convert browser-observed cookies into stored jar entries. A leading-dot
 * domain (`.example.com`) marks a domain cookie; otherwise the cookie is
 * host-only. Entries without a usable domain are dropped.
 */
export function fromBrowserCookies(cookies: BrowserCookieLike[]): CookieJar {
  const jar: CookieJar = [];
  for (const c of cookies) {
    if (!c.name) {
      continue;
    }
    const rawDomain = (c.domain ?? "").toLowerCase();
    const domain = rawDomain.replace(/^\./, "");
    if (!domain) {
      continue;
    }
    jar.push({
      name: c.name,
      value: c.value ?? "",
      domain,
      hostOnly: !rawDomain.startsWith("."),
      path: c.path && c.path.startsWith("/") ? c.path : "/",
      expiresAtMs:
        c.session || !(typeof c.expires === "number" && c.expires > 0)
          ? null
          : c.expires * 1000,
      secure: c.secure === true
    });
  }
  return jar;
}

/**
 * Legacy unscoped join of the unexpired cookies. Used only as the stored
 * `cookieHeader` fallback for readers that predate scoped storage — the
 * forward path always prefers `cookieHeaderForUrl`.
 */
export function cookieHeaderFrom(jar: CookieJar, nowMs: number = Date.now()): string {
  return jar
    .filter((c) => c.expiresAtMs === null || nowMs < c.expiresAtMs)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
