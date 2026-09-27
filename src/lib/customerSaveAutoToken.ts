import {
  forwardWithSessionRetry,
  type EstablishSession
} from "./forwardWithSessionRetry";
import { routewareWebRwUrl } from "./upstreamUrl";

function escapeRegexKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last occurrence wins (duplicate keys in x-www-form-urlencoded). */
export function lastUrlEncodedValue(raw: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|&)${escapeRegexKey(key)}=([^&]*)`, "gi");
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
 * For SaveCustomerLongForm: if the body is x-www-form-urlencoded and the anti-forgery
 * token is missing or a placeholder, GET the add/edit modal HTML with the same session
 * cookies and inject `__RequestVerificationToken` before forwarding upstream.
 *
 * The modal fetch runs through `forwardWithSessionRetry`, so an expired stored
 * session (modal answers 302 → login) re-establishes once and retries instead
 * of surfacing a 502 the next save would hit again (TOG-6462).
 */
export async function prepareSaveCustomerLongFormBody(
  env: Env,
  sessionStub: DurableObjectStub,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null,
  establishSession: EstablishSession
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

  const modalReq = new Request("http://routeware-shadow.internal/modal", {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "x-requested-with": "XMLHttpRequest",
      referer: incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });

  const modalResp = await forwardWithSessionRetry(
    env,
    sessionStub,
    modalReq,
    modalUrl,
    null,
    establishSession,
    { internalMarker: "anti-forgery-modal" }
  );
  if (!modalResp.ok) {
    throw new Error(
      `Could not load anti-forgery modal (${modalPath}): HTTP ${modalResp.status}`
    );
  }
  const html = await modalResp.text();
  const token = extractRequestVerificationTokenFromHtml(html);
  if (!token) {
    throw new Error(
      "Could not parse __RequestVerificationToken from Routeware modal HTML (layout may have changed)."
    );
  }

  const merged = injectAntiForgeryTokenIntoUrlencoded(raw, token);
  return new TextEncoder().encode(merged).buffer;
}
