import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/addressContainerSaveForm.ts` — the anti-forgery token preparation that
 * runs before every `SaveAddressForm` / `SaveContainerForm` POST is forwarded
 * upstream.
 *
 * Every interesting failure here is silent. Routeware answers a POST carrying a
 * stale, missing or wrong-modal `__RequestVerificationToken` with an HTML error
 * page rather than an error status, so a mistake in modal selection or in the
 * query-parameter casing does not surface as an exception — it surfaces as a
 * save that quietly does nothing. These tests pin the four things that decide
 * which token gets fetched: the enable flag, the pass-through guards, the
 * new-vs-edit modal choice, and the exact query parameter names.
 *
 * `customerSaveAutoToken` and `upstreamUrl` are pure and deliberately NOT mocked
 * — the URLs and the merged body asserted below are the real ones.
 */

type ModalCall = {
  method: string;
  url: string;
  accept: string | null;
  requestedWith: string | null;
  referer: string | null;
  cookie: string | null;
  body: ArrayBuffer | null;
  internalMarker: string | undefined;
};

const calls: { modals: ModalCall[] } = { modals: [] };
const behavior: { responses: Array<() => Response> } = { responses: [] };

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function tokenHtml(token: string): Response {
  return html(`<form><input name="__RequestVerificationToken" value="${token}" /></form>`);
}

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records each call's settled
  // result, which turns any deliberate rejection into an unhandled rejection
  // under @cloudflare/vitest-pool-workers.
  forwardToUpstream: async (
    incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null,
    bodyBuffer: ArrayBuffer | null,
    options: { internalMarker?: string } = {}
  ) => {
    calls.modals.push({
      method: incoming.method,
      url: upstreamUrl.toString(),
      accept: incoming.headers.get("accept"),
      requestedWith: incoming.headers.get("x-requested-with"),
      referer: incoming.headers.get("referer"),
      cookie: session?.cookieHeader ?? null,
      body: bodyBuffer,
      internalMarker: options.internalMarker
    });
    const next = behavior.responses.shift();
    return next ? next() : tokenHtml("FRESH-TOKEN");
  }
}));

const { prepareSaveAddressFormBody, prepareSaveContainerFormBody } = await import(
  "../src/lib/addressContainerSaveForm"
);

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const DEFAULT_REFERER = `${ORIGIN}${BASE}/Customer/Customers`;

function makeEnv(autoToken?: string): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    CUSTOMER_SAVE_AUTO_TOKEN: autoToken
  } as unknown as Env;
}

const session = { cookieHeader: "ASP.NET_SessionId=abc123", expiresAtMs: null, refreshing: false };

const URLENCODED = "application/x-www-form-urlencoded";

function body(raw: string): ArrayBuffer {
  return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

function decode(buffer: ArrayBuffer | null): string {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://internal/save", { method: "POST", headers });
}

/** Valid for either form, so guard tests can run against both. */
const GUARD_BODY = "CustomerID=5&PickupAddressID=10&ContainerID=100&Enabled=true";

beforeEach(() => {
  calls.modals = [];
  behavior.responses = [];
});

const FORMS = [
  { name: "prepareSaveAddressFormBody", prepare: prepareSaveAddressFormBody },
  { name: "prepareSaveContainerFormBody", prepare: prepareSaveContainerFormBody }
] as const;

describe.each(FORMS)("$name pass-through guards", ({ prepare }) => {
  it('returns the body untouched when CUSTOMER_SAVE_AUTO_TOKEN is "false"', async () => {
    // Arrange
    const buffer = body(GUARD_BODY);

    // Act
    const result = await prepare(makeEnv("false"), session, request(), buffer, URLENCODED);

    // Assert — the same object, so nothing was re-encoded either.
    expect(result).toBe(buffer);
    expect(calls.modals).toEqual([]);
  });

  it('returns the body untouched when CUSTOMER_SAVE_AUTO_TOKEN is "0"', async () => {
    // Arrange
    const buffer = body(GUARD_BODY);

    // Act
    const result = await prepare(makeEnv("0"), session, request(), buffer, URLENCODED);

    // Assert
    expect(result).toBe(buffer);
    expect(calls.modals).toEqual([]);
  });

  it("treats an unset CUSTOMER_SAVE_AUTO_TOKEN as enabled", async () => {
    // Arrange — the flag is opt-OUT. An opt-in reading would silently disable
    // token injection everywhere the binding is absent.
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(makeEnv(undefined), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals).toHaveLength(1);
  });

  it('treats any value other than "false" or "0" as enabled', async () => {
    // Arrange
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(makeEnv("no"), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals).toHaveLength(1);
  });

  it("returns a null body unchanged", async () => {
    // Act
    const result = await prepare(makeEnv(), session, request(), null, URLENCODED);

    // Assert
    expect(result).toBeNull();
    expect(calls.modals).toEqual([]);
  });

  it("returns a zero-length body unchanged", async () => {
    // Arrange
    const empty = new ArrayBuffer(0);

    // Act
    const result = await prepare(makeEnv(), session, request(), empty, URLENCODED);

    // Assert
    expect(result).toBe(empty);
    expect(calls.modals).toEqual([]);
  });

  it("returns the body unchanged when the content type is absent", async () => {
    // Arrange
    const buffer = body(GUARD_BODY);

    // Act
    const result = await prepare(makeEnv(), session, request(), buffer, null);

    // Assert
    expect(result).toBe(buffer);
    expect(calls.modals).toEqual([]);
  });

  it("returns the body unchanged for a non-urlencoded content type", async () => {
    // Arrange — a JSON or multipart body has no urlencoded token field to merge
    // into, so rewriting it would corrupt the upload.
    const buffer = body(GUARD_BODY);

    // Act
    const result = await prepare(makeEnv(), session, request(), buffer, "application/json");

    // Assert
    expect(result).toBe(buffer);
    expect(calls.modals).toEqual([]);
  });

  it("still injects when the content type is uppercase and carries a charset", async () => {
    // Arrange — browsers send `; charset=UTF-8`, and the header is
    // case-insensitive, so an exact-match check here would skip real requests.
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(
      makeEnv(),
      session,
      request(),
      buffer,
      "Application/X-WWW-Form-UrlEncoded; charset=UTF-8"
    );

    // Assert
    expect(calls.modals).toHaveLength(1);
  });

  it("returns the body unchanged when a real token is already present", async () => {
    // Arrange
    const buffer = body(`__RequestVerificationToken=already-real&${GUARD_BODY}`);

    // Act
    const result = await prepare(makeEnv(), session, request(), buffer, URLENCODED);

    // Assert — no modal round trip for a client that did its own token handling.
    expect(result).toBe(buffer);
    expect(calls.modals).toEqual([]);
  });

  it("fetches a fresh token when the present one is a placeholder", async () => {
    // Arrange
    const buffer = body(`__RequestVerificationToken=REPLACE_ME&${GUARD_BODY}`);

    // Act
    const result = await prepare(makeEnv(), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals).toHaveLength(1);
    expect(decode(result)).toContain("__RequestVerificationToken=FRESH-TOKEN");
  });

  it("fetches a fresh token when the present one is blank", async () => {
    // Arrange
    const buffer = body(`__RequestVerificationToken=&${GUARD_BODY}`);

    // Act
    await prepare(makeEnv(), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals).toHaveLength(1);
  });

  it("sends the session cookie and the internal marker on the modal fetch", async () => {
    // Arrange — the marker header is what tells a trusted server-side fetch from
    // a client request; without the cookie the modal returns the login page and
    // no token.
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(makeEnv(), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].cookie).toBe("ASP.NET_SessionId=abc123");
    expect(calls.modals[0].internalMarker).toBe("anti-forgery-modal");
    expect(calls.modals[0].method).toBe("GET");
    expect(calls.modals[0].body).toBeNull();
    expect(calls.modals[0].requestedWith).toBe("XMLHttpRequest");
  });

  it("forwards the caller's referer to the modal fetch", async () => {
    // Arrange
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(
      makeEnv(),
      session,
      request({ referer: `${ORIGIN}${BASE}/Customer/Edit/5` }),
      buffer,
      URLENCODED
    );

    // Assert
    expect(calls.modals[0].referer).toBe(`${ORIGIN}${BASE}/Customer/Edit/5`);
  });

  it("falls back to the customers page when the caller sent no referer", async () => {
    // Arrange — Routeware rejects modal requests with no referer.
    const buffer = body(GUARD_BODY);

    // Act
    await prepare(makeEnv(), session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].referer).toBe(DEFAULT_REFERER);
  });

  it("throws when the modal fetch is not ok", async () => {
    // Arrange
    behavior.responses = [() => html("gone", 500)];
    const buffer = body(GUARD_BODY);

    // Act
    const error = (await prepare(makeEnv(), session, request(), buffer, URLENCODED).catch(
      (e: unknown) => e
    )) as Error;

    // Assert — failing loudly beats forwarding a POST that will be rejected as
    // an anti-forgery violation.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 500");
  });

  it("throws when the modal HTML carries no token", async () => {
    // Arrange — a Routeware layout change shows up here first.
    behavior.responses = [() => html('<form><input name="Other" value="x" /></form>')];
    const buffer = body(GUARD_BODY);

    // Act
    const error = (await prepare(makeEnv(), session, request(), buffer, URLENCODED).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("__RequestVerificationToken");
  });
});

describe("prepareSaveAddressFormBody modal selection", () => {
  const env = makeEnv();

  it("loads the edit modal for an existing pickup address", async () => {
    // Arrange
    const buffer = body("PickupAddressID=10&CustomerID=5&Address=1+Main+St");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert — note the parameter is `PickupAddressID`, not the lowercase form
    // used on the create path; the modal ignores an unrecognised name and
    // returns a token bound to the wrong record.
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/PickupAddress/LoadAddressModal?PickupAddressID=10`
    );
  });

  it("loads the blank-address modal with a lowercase customerID when no id is posted", async () => {
    // Arrange
    const buffer = body("CustomerID=5&Address=1+Main+St");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/PickupAddress/CreateBlankAddress?customerID=5`
    );
  });

  it("treats a zero pickup address id as a new address", async () => {
    // Arrange — the SPA posts 0 for an unsaved row.
    const buffer = body("PickupAddressID=0&CustomerID=5");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/PickupAddress/CreateBlankAddress");
  });

  it("treats a negative pickup address id as a new address", async () => {
    // Arrange
    const buffer = body("PickupAddressID=-1&CustomerID=5");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/PickupAddress/CreateBlankAddress");
  });

  it("treats an unparseable pickup address id as a new address", async () => {
    // Arrange
    const buffer = body("PickupAddressID=abc&CustomerID=5");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/PickupAddress/CreateBlankAddress");
  });

  it("normalises a zero-padded pickup address id", async () => {
    // Arrange
    const buffer = body("PickupAddressID=0010&CustomerID=5");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/PickupAddress/LoadAddressModal?PickupAddressID=10`
    );
  });

  it("uses the last duplicate pickup address id", async () => {
    // Arrange — urlencoded bodies may repeat a key; last wins upstream too.
    const buffer = body("PickupAddressID=10&CustomerID=5&PickupAddressID=22");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/PickupAddress/LoadAddressModal?PickupAddressID=22`
    );
  });

  it("throws when a new address has no CustomerID to hang it from", async () => {
    // Arrange — CreateBlankAddress without a customer yields a token bound to
    // nothing, and the save would silently create an orphan.
    const buffer = body("Address=1+Main+St");

    // Act
    const error = (await prepareSaveAddressFormBody(
      env,
      session,
      request(),
      buffer,
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("New address requires CustomerID in POST body");
    expect(calls.modals).toEqual([]);
  });

  it("names the attempted modal path and status when the fetch fails", async () => {
    // Arrange
    behavior.responses = [() => html("nope", 404)];
    const buffer = body("PickupAddressID=10&CustomerID=5");

    // Act
    const error = (await prepareSaveAddressFormBody(
      env,
      session,
      request(),
      buffer,
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert — which modal was attempted is the whole diagnostic.
    expect(error.message).toBe("Load address modal (/PickupAddress/LoadAddressModal): HTTP 404");
  });

  it("prepends the fetched token and preserves the other fields", async () => {
    // Arrange
    behavior.responses = [() => tokenHtml("tok+A/B=")];
    const buffer = body("PickupAddressID=10&CustomerID=5&Address=1+Main+St");

    // Act
    const result = await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(decode(result)).toBe(
      "__RequestVerificationToken=tok%2BA%2FB%3D&PickupAddressID=10&CustomerID=5&Address=1+Main+St"
    );
  });

  it("replaces a placeholder token rather than posting two of them", async () => {
    // Arrange — a duplicate key would let the stale value win upstream.
    behavior.responses = [() => tokenHtml("REAL")];
    const buffer = body(
      "__RequestVerificationToken=PASTE_TOKEN_FROM_LOAD_LONG_MODAL_OR_ADD_NEW&PickupAddressID=10"
    );

    // Act
    const result = await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    const merged = decode(result);
    expect(merged).toBe("__RequestVerificationToken=REAL&PickupAddressID=10");
    expect(merged.match(/__RequestVerificationToken=/g)).toHaveLength(1);
  });

  it("requests the modal as HTML", async () => {
    // Arrange
    const buffer = body("PickupAddressID=10&CustomerID=5");

    // Act
    await prepareSaveAddressFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].accept).toBe("text/html, */*; q=0.01");
  });
});

describe("prepareSaveContainerFormBody modal selection", () => {
  const env = makeEnv();

  it("loads the edit modal for an existing container", async () => {
    // Arrange
    const buffer = body("ContainerID=100&PickupAddressID=10");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/Container/LoadContainerModal?ContainerID=100`
    );
  });

  it("loads the blank-container modal with a lowercase pickupAddressID for a new container", async () => {
    // Arrange — the create path's parameter differs in case from the edit
    // path's, and from the address form's; getting it wrong returns a modal
    // with no address context.
    const buffer = body("PickupAddressID=10&Size=96");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/Container/CreateBlankContainer?pickupAddressID=10`
    );
  });

  it("keys the new-container modal off the address, not the customer", async () => {
    // Arrange — a container hangs from an address; CustomerID is not a
    // substitute and must not be used as a fallback.
    const buffer = body("CustomerID=5&Size=96");

    // Act
    const error = (await prepareSaveContainerFormBody(
      env,
      session,
      request(),
      buffer,
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("New container requires PickupAddressID in POST body");
    expect(calls.modals).toEqual([]);
  });

  it("treats a zero container id as a new container", async () => {
    // Arrange
    const buffer = body("ContainerID=0&PickupAddressID=10");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/Container/CreateBlankContainer");
  });

  it("treats a negative container id as a new container", async () => {
    // Arrange
    const buffer = body("ContainerID=-5&PickupAddressID=10");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/Container/CreateBlankContainer");
  });

  it("treats an empty container id as a new container", async () => {
    // Arrange
    const buffer = body("ContainerID=&PickupAddressID=10");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toContain("/Container/CreateBlankContainer");
  });

  it("passes the new-container address id through verbatim", async () => {
    // Arrange — unlike the container id on the edit path, this one is not
    // parsed to a number, so it is forwarded exactly as posted.
    const buffer = body("PickupAddressID=0010&Size=96");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/Container/CreateBlankContainer?pickupAddressID=0010`
    );
  });

  it("names the attempted modal path and status when the fetch fails", async () => {
    // Arrange
    behavior.responses = [() => html("nope", 502)];
    const buffer = body("PickupAddressID=10&Size=96");

    // Act
    const error = (await prepareSaveContainerFormBody(
      env,
      session,
      request(),
      buffer,
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("Load container modal (/Container/CreateBlankContainer): HTTP 502");
  });

  it("throws a container-specific message when the modal HTML has no token", async () => {
    // Arrange
    behavior.responses = [() => html("<form></form>")];
    const buffer = body("ContainerID=100&PickupAddressID=10");

    // Act
    const error = (await prepareSaveContainerFormBody(
      env,
      session,
      request(),
      buffer,
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("No __RequestVerificationToken in container modal HTML");
  });

  it("prepends the fetched token and preserves the other fields", async () => {
    // Arrange
    behavior.responses = [() => tokenHtml("CT-1")];
    const buffer = body("ContainerID=100&PickupAddressID=10&Size=96");

    // Act
    const result = await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(decode(result)).toBe(
      "__RequestVerificationToken=CT-1&ContainerID=100&PickupAddressID=10&Size=96"
    );
  });

  it("requests the modal with a permissive accept header", async () => {
    // Arrange
    const buffer = body("ContainerID=100&PickupAddressID=10");

    // Act
    await prepareSaveContainerFormBody(env, session, request(), buffer, URLENCODED);

    // Assert
    expect(calls.modals[0].accept).toBe("*/*");
  });
});
