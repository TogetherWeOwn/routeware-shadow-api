import {
  extractRequestVerificationTokenFromHtml,
  injectAntiForgeryTokenIntoUrlencoded,
  isPlaceholderAntiForgeryToken,
  lastUrlEncodedValue
} from "./customerSaveAutoToken";
import { forwardToUpstream } from "./upstreamForward";
import { routewareWebRwUrl } from "./upstreamUrl";
import type { SessionState } from "./sessionState";

function autoTokenEnabled(env: Env): boolean {
  const v = env.CUSTOMER_SAVE_AUTO_TOKEN as string;
  return v !== "false" && v !== "0";
}

export async function prepareSaveAddressFormBody(
  env: Env,
  session: SessionState,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null
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
      "X-Routeware-Shadow-Internal": "anti-forgery-modal",
      referer:
        incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });
  const modalResp = await forwardToUpstream(modalReq, modalUrl, session, null);
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

export async function prepareSaveContainerFormBody(
  env: Env,
  session: SessionState,
  incoming: Request,
  bodyBuffer: ArrayBuffer | null,
  contentType: string | null
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
      "X-Routeware-Shadow-Internal": "anti-forgery-modal",
      referer:
        incoming.headers.get("referer") ?? `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
    }
  });
  const modalResp = await forwardToUpstream(modalReq, modalUrl, session, null);
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
