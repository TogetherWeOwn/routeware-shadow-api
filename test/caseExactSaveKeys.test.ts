import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Urlencoded form keys are case-EXACT on the save path.
 *
 * `lastUrlEncodedValue` used to match case-insensitively while upstream
 * `Save*` actions read form keys case-sensitively: a client sending
 * `customerid=5` got the *edit* modal token here while upstream treated the
 * same body as a *create* — a silent wrong operation on PII. Lowercase keys
 * must now fall through to the create path on every form, matching what
 * upstream does with the same body.
 *
 * Modal query-parameter audit (same card): the five modal fetch spellings are
 * deliberately inconsistent upstream and must NOT be "tidied" —
 * `LoadLongCustomerModal?customerID=`, `CreateBlankAddress?customerID=`,
 * `LoadAddressModal?PickupAddressID=`, `CreateBlankContainer?pickupAddressID=`,
 * `LoadContainerModal?ContainerID=`. They are pinned in
 * `test/addressContainerSaveForm.test.ts` (+ customer controls below) and
 * `docs/TEST-INVARIANTS.md`; this file pins that lowercase *body* keys select
 * the create-side modal for each of those spellings.
 *
 * `upstreamForward` is mocked; `customerSaveAutoToken` runs for real.
 */

const calls: { urls: string[] } = { urls: [] };

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (_incoming: Request, upstreamUrl: URL) => {
    calls.urls.push(upstreamUrl.toString());
    return new Response(
      '<form><input name="__RequestVerificationToken" value="FRESH-TOKEN" /></form>',
      { status: 200, headers: { "content-type": "text/html" } }
    );
  }
}));

const { lastUrlEncodedValue, prepareSaveCustomerLongFormBody } = await import(
  "../src/lib/customerSaveAutoToken"
);
const { prepareSaveAddressFormBody, prepareSaveContainerFormBody } = await import(
  "../src/lib/addressContainerSaveForm"
);

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";

function makeEnv(): Env {
  return { TARGET_ORIGIN: ORIGIN, TARGET_BASE_PATH: BASE } as unknown as Env;
}

const session = { cookieHeader: "ASP.NET_SessionId=abc123", expiresAtMs: null, refreshing: false };
const URLENCODED = "application/x-www-form-urlencoded";

function body(raw: string): ArrayBuffer {
  return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

function request(): Request {
  return new Request("http://internal/save", { method: "POST" });
}

beforeEach(() => {
  calls.urls = [];
});

describe("lastUrlEncodedValue is case-exact", () => {
  it("does not match a lowercase key against a PascalCase lookup", () => {
    // Arrange — the exact wrong-operation shape from the card.
    // Act / Assert
    expect(lastUrlEncodedValue("customerid=5", "CustomerID")).toBeUndefined();
  });

  it("still matches the exact spelling", () => {
    expect(lastUrlEncodedValue("CustomerID=5", "CustomerID")).toBe("5");
  });

  it("last duplicate wins among exact-spelling duplicates only", () => {
    // Arrange — a lowercase twin must not shadow the exact key.
    // Act / Assert
    expect(lastUrlEncodedValue("CustomerID=5&customerid=7&CustomerID=9", "CustomerID")).toBe("9");
  });

  it("treats single-letter keys case-sensitively", () => {
    expect(lastUrlEncodedValue("a=1&A=2", "a")).toBe("1");
    expect(lastUrlEncodedValue("a=1&A=2", "A")).toBe("2");
  });

  it("does not match a wrong-case anti-forgery token key", () => {
    expect(
      lastUrlEncodedValue("__requestverificationtoken=stale", "__RequestVerificationToken")
    ).toBeUndefined();
  });
});

describe("lowercase body keys take the create modal on every save form", () => {
  const env = makeEnv();

  it("customer: lowercase customerid loads AddNewLong, not the edit modal", async () => {
    // Arrange
    // Act
    await prepareSaveCustomerLongFormBody(env, session, request(), body("customerid=5"), URLENCODED);

    // Assert — upstream reads `customerid` as absent (create), so the token
    // must come from the create modal too.
    expect(calls.urls).toHaveLength(1);
    expect(calls.urls[0]).toBe(`${ORIGIN}${BASE}/Customer/AddNewLong`);
  });

  it("customer control: exact CustomerID still loads the edit modal", async () => {
    // Arrange
    // Act
    await prepareSaveCustomerLongFormBody(env, session, request(), body("CustomerID=5"), URLENCODED);

    // Assert
    expect(calls.urls).toHaveLength(1);
    expect(calls.urls[0]).toBe(`${ORIGIN}${BASE}/Customer/LoadLongCustomerModal?customerID=5`);
  });

  it("address: lowercase pickupaddressid falls through to CreateBlankAddress", async () => {
    // Arrange
    // Act
    await prepareSaveAddressFormBody(
      env,
      session,
      request(),
      body("pickupaddressid=10&CustomerID=5"),
      URLENCODED
    );

    // Assert — consistent with upstream, which sees no PickupAddressID (create).
    expect(calls.urls).toHaveLength(1);
    expect(calls.urls[0]).toBe(`${ORIGIN}${BASE}/PickupAddress/CreateBlankAddress?customerID=5`);
  });

  it("address: lowercase customerid alone throws the create-path missing-parent error", async () => {
    // Arrange — no exact-case id key at all: create path with no parent.
    // Act
    const error = (await prepareSaveAddressFormBody(
      env,
      session,
      request(),
      body("customerid=5&Address=1+Main+St"),
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert — the same error an absent CustomerID produces; no modal fetch.
    expect(error.message).toBe("New address requires CustomerID in POST body");
    expect(calls.urls).toEqual([]);
  });

  it("container: lowercase containerid falls through to CreateBlankContainer", async () => {
    // Arrange
    // Act
    await prepareSaveContainerFormBody(
      env,
      session,
      request(),
      body("containerid=100&PickupAddressID=10"),
      URLENCODED
    );

    // Assert — consistent with upstream, which sees no ContainerID (create).
    expect(calls.urls).toHaveLength(1);
    expect(calls.urls[0]).toBe(
      `${ORIGIN}${BASE}/Container/CreateBlankContainer?pickupAddressID=10`
    );
  });

  it("container: lowercase containerid with no address throws the create-path error", async () => {
    // Arrange
    // Act
    const error = (await prepareSaveContainerFormBody(
      env,
      session,
      request(),
      body("containerid=100&Size=96"),
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error.message).toBe("New container requires PickupAddressID in POST body");
    expect(calls.urls).toEqual([]);
  });
});
