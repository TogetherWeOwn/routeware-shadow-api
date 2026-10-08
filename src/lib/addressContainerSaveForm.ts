import {
  extractRequestVerificationTokenFromHtml,
  injectAntiForgeryTokenIntoUrlencoded,
  isPlaceholderAntiForgeryToken,
  lastUrlEncodedValue
} from "./customerSaveAutoToken";
import {
  forwardWithSessionRetry,
  type ModalRetryContext
} from "./forwardWithSessionRetry";
import { forwardToUpstream } from "./upstreamForward";
import { requireAuthenticatedModal } from "./sessionPreparation";
import { readUpstreamTimeoutMs } from "./upstreamTimeout";
import { routewareWebRwUrl } from "./upstreamUrl";
import type { SessionState } from "./sessionState";

/** Keep create-parent validation ahead of session selection without upstream IO. */
export function validateSaveFormBody(
  env: Env,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null,
  kind: "address" | "container"
): void {
  if (!autoTokenEnabled(env) || !bodyBuffer?.byteLength ||
      !(contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) {
    return;
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bodyBuffer);
  const existing = lastUrlEncodedValue(raw, "__RequestVerificationToken");
  if (existing && !isPlaceholderAntiForgeryToken(existing)) {
    return;
  }
  const idField = kind === "address" ? "PickupAddressID" : "ContainerID";
  const parentField = kind === "address" ? "CustomerID" : "PickupAddressID";
  const id = Number.parseInt(lastUrlEncodedValue(raw, idField) ?? "", 10);
  if ((!Number.isFinite(id) || id <= 0) && lastUrlEncodedValue(raw, parentField) === undefined) {
    throw new Error(`New ${kind} requires ${parentField} in POST body`);
  }
}

function autoTokenEnabled(env: Env): boolean {
  const v = env.CUSTOMER_SAVE_AUTO_TOKEN as string;
  return v !== "false" && v !== "0";
}

/**
 * Modal GET for the address/container save forms. With retry context the fetch
 * runs through `forwardWithSessionRetry` (one re-establish + retry,
 * `internalMarker` preserved) so an expired stored session heals instead of
 * surfacing a 502 the next save would hit again (TOG-6462); without context it
 * keeps the direct forward. Status-shape errors stay with the callers, whose
 * form-specific messages (`Load address modal …` / `Load container modal …`)
 * are pinned by tests and surfaced as the 502 problem+json detail.
 */
async function fetchAntiForgeryModal(
  env: Env,
  session: SessionState,
  modalReq: Request,
  modalUrl: URL,
  retry: ModalRetryContext
): Promise<Response> {
  if (retry.sessionStub && retry.establishSession) {
    return forwardWithSessionRetry(
      env,
      retry.sessionStub,
      modalReq,
      modalUrl,
      null,
      retry.establishSession,
      { internalMarker: "anti-forgery-modal" }
    );
  }
  return forwardToUpstream(modalReq, modalUrl, session, null, {
    internalMarker: "anti-forgery-modal",
    // Direct modal path honors UPSTREAM_TIMEOUT_MS (TOG-8359) — the forwarder
    // default alone would ignore the per-deploy override.
    timeoutMs: readUpstreamTimeoutMs(env)
  });
}

/**
 * For SaveAddressForm: same anti-forgery flow as the customer long form.
 *
 * With retry context the modal fetch runs through `forwardWithSessionRetry`,
 * so an expired stored session (modal answers 302 → login, or HTTP-200 login
 * page) re-establishes once and retries instead of surfacing a 502 the next
 * save would hit again (TOG-6462).
 */
export async function prepareSaveAddressFormBody(
  env: Env,
  session: SessionState,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null,
  retry: ModalRetryContext = {}
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
  const paRaw = lastUrlEncodedValue(raw, "PickupAddressID");
  const pickupId = paRaw !== undefined ? Number.parseInt(paRaw, 10) : Number.NaN;
  const useNew = !Number.isFinite(pickupId) || pickupId <= 0;
  const modalPath = useNew
    ? "/PickupAddress/CreateBlankAddress"
    : "/PickupAddress/LoadAddressModal";
  const modalUrl = routewareWebRwUrl(env.TARGET_ORIGIN, env.TARGET_BASE_PATH, modalPath);
  if (useNew) {
    const cust = lastUrlEncodedValue(raw, "CustomerID");
    if (cust === undefined) {
      throw new Error("New address requires CustomerID in POST body");
    }
    modalUrl.searchParams.set("customerID", cust);
  } else {
    modalUrl.searchParams.set("PickupAddressID", String(pickupId));
  }
  const modalReq = new Request("http://internal/addr-modal", {
    method: "GET",
    headers: {
      accept: "text/html, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      referer:
        incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });
  const modalResp = await fetchAntiForgeryModal(env, session, modalReq, modalUrl, retry);
  await requireAuthenticatedModal(modalResp);
  if (!modalResp.ok) {
    throw new Error(`Load address modal (${modalPath}): HTTP ${modalResp.status}`);
  }
  const html = await modalResp.text();
  const token = extractRequestVerificationTokenFromHtml(html);
  if (!token) {
    throw new Error("No __RequestVerificationToken in address modal HTML");
  }
  const merged = injectAntiForgeryTokenIntoUrlencoded(raw, token);
  return new TextEncoder().encode(merged).buffer;
}

/**
 * For SaveContainerForm: same anti-forgery flow as the customer long form.
 *
 * With retry context the modal fetch runs through `forwardWithSessionRetry`,
 * so an expired stored session (modal answers 302 → login, or HTTP-200 login
 * page) re-establishes once and retries instead of surfacing a 502 the next
 * save would hit again (TOG-6462).
 */
export async function prepareSaveContainerFormBody(
  env: Env,
  session: SessionState,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null,
  retry: ModalRetryContext = {}
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
  const cidRaw = lastUrlEncodedValue(raw, "ContainerID");
  const containerId = cidRaw !== undefined ? Number.parseInt(cidRaw, 10) : Number.NaN;
  const useNew = !Number.isFinite(containerId) || containerId <= 0;
  const modalPath = useNew
    ? "/Container/CreateBlankContainer"
    : "/Container/LoadContainerModal";
  const modalUrl = routewareWebRwUrl(env.TARGET_ORIGIN, env.TARGET_BASE_PATH, modalPath);
  if (useNew) {
    const pa = lastUrlEncodedValue(raw, "PickupAddressID");
    if (pa === undefined) {
      throw new Error("New container requires PickupAddressID in POST body");
    }
    modalUrl.searchParams.set("pickupAddressID", pa);
  } else {
    modalUrl.searchParams.set("ContainerID", String(containerId));
  }
  const modalReq = new Request("http://internal/cont-modal", {
    method: "GET",
    headers: {
      accept: "*/*",
      "x-requested-with": "XMLHttpRequest",
      referer:
        incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });
  const modalResp = await fetchAntiForgeryModal(env, session, modalReq, modalUrl, retry);
  await requireAuthenticatedModal(modalResp);
  if (!modalResp.ok) {
    throw new Error(`Load container modal (${modalPath}): HTTP ${modalResp.status}`);
  }
  const html = await modalResp.text();
  const token = extractRequestVerificationTokenFromHtml(html);
  if (!token) {
    throw new Error("No __RequestVerificationToken in container modal HTML");
  }
  const merged = injectAntiForgeryTokenIntoUrlencoded(raw, token);
  return new TextEncoder().encode(merged).buffer;
}
