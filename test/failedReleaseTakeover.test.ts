import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession, TAKEOVER_WINDOW_MS } from "../src/authSession.do";
import {
  isConcurrentRefreshTimeout,
  releaseRefreshLock,
  storeSession
} from "../src/lib/sessionRefreshLock";
import { readSessionState } from "../src/lib/sessionState";
import { authSessionTestState } from "./authSessionTestState";

/**
 * Bounded fresh acquisition after an explicit failed release (TOG-18119, CISO
 * option B): when a refresh holder's login fails and its `/unlock` releases a
 * held lock without a `/set`, one queued waiter takes over with a single
 * fresh login instead of every waiter stalling to a 502.
 *
 * Driven through the REAL `AuthSession` over the transactional Map-backed
 * fake so the atomic `/takeover` election and the episode bookkeeping are the
 * production code, not a reimplementation. Login is stubbed to publish fresh
 * material through the REAL `storeSession` (no network, no credentials).
 *
 * Fixture hygiene: every cookie is a synthetic stand-in
 * (CONVENTIONS.md §§ 4-5); only lock flags and timestamps cross the DO.
 */

const FAILED_COOKIE = ".WebRW=SYNTHETIC-FAILED-HOLDER-NOT-A-CREDENTIAL";
const FRESH_COOKIE = ".WebRW=SYNTHETIC-TAKEOVER-NOT-A-CREDENTIAL";
const LOGIN_URL = "https://upstream.invalid/WebRW/Account/Login";
const env = { AUTH_MODE: "http", LOGIN_URL } as unknown as Env;

const httpLoginCalls = { count: 0 };
let httpLoginShouldFail = false;

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    httpLoginCalls.count += 1;
    if (httpLoginShouldFail) {
      throw new Error("Synthetic takeover login failure");
    }
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, FRESH_COOKIE, Date.now() + 120_000);
  })
}));
vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => { throw new Error("Unexpected browser login"); })
}));

const { establishSession } = await import("../src/lib/establishSession");

function harness() {
  const fake = authSessionTestState();
  const session = new AuthSession(fake.state, {} as Env);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    await fake.ready();
    return session.fetch(new Request(input, init));
  });
  const stub = { fetch } as unknown as DurableObjectStub;
  const callsTo = (path: string): number =>
    fetch.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
  return { ...fake, stub, fetch, callsTo };
}

/** A held lock whose stored cookie already expired: the failed-holder setup. */
async function failedHolderSetup(stub: DurableObjectStub): Promise<void> {
  await storeSession(stub, FAILED_COOKIE, Date.now() + 1);
  await vi.advanceTimersByTimeAsync(1);
  await stub.fetch("https://auth/lock");
}

function settleAll(count: number, stub: DurableObjectStub) {
  return Promise.all(
    Array.from({ length: count }, () =>
      establishSession(env, stub, LOGIN_URL).then(
        () => null,
        (err: unknown) => err
      )
    )
  );
}

describe("failed-release takeover (CISO option B)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    httpLoginCalls.count = 0;
    httpLoginShouldFail = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 20-concurrent run after a failed release performs at most two logins", async () => {
    // Arrange — 20 waiters queue on a failed holder's lock.
    const { stub } = harness();
    await failedHolderSetup(stub);
    const pending = settleAll(20, stub);
    await vi.advanceTimersByTimeAsync(0);

    // Act — the holder's login fails and releases; the window admits takeovers.
    await releaseRefreshLock(stub);
    await vi.advanceTimersByTimeAsync(5000);
    const failures = await pending;

    // Assert — every waiter resolved with the fresh publication, and the
    // episode bound held however many requests queued.
    expect(failures.every((failure) => failure === null)).toBe(true);
    expect(httpLoginCalls.count).toBeGreaterThanOrEqual(1);
    expect(httpLoginCalls.count).toBeLessThanOrEqual(2);
    const state = await readSessionState(stub);
    expect(state.cookieHeader).toBe(FRESH_COOKIE);
    expect(state.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("a successful takeover performs exactly one login and delivers the fresh cookie to every waiter", async () => {
    // Arrange
    const { stub, callsTo } = harness();
    await failedHolderSetup(stub);
    const pending = settleAll(3, stub);
    await vi.advanceTimersByTimeAsync(0);

    // Act
    await releaseRefreshLock(stub);
    await vi.advanceTimersByTimeAsync(5000);
    const failures = await pending;

    // Assert — one winner, one login, one atomic claim; every waiter saw the
    // same fresh publication, and the episode cleared with it.
    expect(failures).toEqual([null, null, null]);
    expect(httpLoginCalls.count).toBe(1);
    expect(callsTo("/takeover")).toBe(1);
    const state = await readSessionState(stub);
    expect(state.cookieHeader).toBe(FRESH_COOKIE);
    expect(state.failedReleaseAtMs).toBeUndefined();
    expect(state.takeoverAtMs).toBeUndefined();
  });

  it("a failed takeover fails the remaining waiters at once instead of waiting out the window", async () => {
    // Arrange — the takeover winner's login will fail too.
    const { stub } = harness();
    await failedHolderSetup(stub);
    httpLoginShouldFail = true;
    const pending = settleAll(3, stub);
    await vi.advanceTimersByTimeAsync(0);
    const startedAt = Date.now();

    // Act — holder fails, winner takes over and fails, budget spent.
    await releaseRefreshLock(stub);
    await vi.advanceTimersByTimeAsync(5000);
    const failures = await pending;

    // Assert — one login attempt total. The winner surfaces the real login
    // failure (never masked); the remaining waiters fail fast with the
    // existing timeout shape: ~1 poll interval, not the 90s budget.
    expect(httpLoginCalls.count).toBe(1);
    const timeouts = failures.filter(isConcurrentRefreshTimeout);
    const loginFailures = failures.filter(
      (failure) =>
        failure instanceof Error &&
        failure.message === "Synthetic takeover login failure"
    );
    expect(loginFailures).toHaveLength(1);
    expect(timeouts).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(5000);
    expect(Date.now() - startedAt).toBeLessThan(90_000);
    expect((await readSessionState(stub)).cookieHeader).toBeNull();
  });

  it("a hung holder sees zero takeovers and the waiter still fails closed at 90s", async () => {
    // Arrange — the holder never unlocks; no failed release exists.
    const { stub, callsTo } = harness();
    await failedHolderSetup(stub);
    const pending = settleAll(1, stub);
    await vi.advanceTimersByTimeAsync(0);

    // Act — the full waiter budget runs out with the lock still held.
    await vi.advanceTimersByTimeAsync(95_000);
    const [failure] = await pending;

    // Assert — fail-closed 502 shape, no login, and no takeover was ever
    // attempted against a live holder.
    expect(isConcurrentRefreshTimeout(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "Concurrent session refresh timed out after 90000ms"
    );
    expect(httpLoginCalls.count).toBe(0);
    expect(callsTo("/takeover")).toBe(0);
  });

  it("a late superseded unlock admits no second takeover and preserves the anchor", async () => {
    // Arrange — anchor recorded, winner claimed, winner's login failed.
    const { stub, values } = harness();
    await failedHolderSetup(stub);
    httpLoginShouldFail = true;
    const pending = settleAll(1, stub);
    await vi.advanceTimersByTimeAsync(0);
    await releaseRefreshLock(stub);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    const anchor = values.get("failedReleaseAtMs");
    const claimed = values.get("takeoverAtMs");
    expect(typeof anchor).toBe("number");
    expect(typeof claimed).toBe("number");
    expect(await (await stub.fetch("https://auth/takeover", { method: "POST" })).status).toBe(409);

    // Act — the superseded holder's duplicate unlock lands late.
    await stub.fetch("https://auth/unlock", { method: "POST" });

    // Assert — unlocking an unheld lock records nothing: the anchor and the
    // spent budget are untouched, so no second takeover is admitted.
    expect(values.get("failedReleaseAtMs")).toBe(anchor);
    expect(values.get("takeoverAtMs")).toBe(claimed);
    expect(await (await stub.fetch("https://auth/takeover", { method: "POST" })).status).toBe(409);
    // The lock itself is free — only the episode budget stays spent.
    expect(await (await stub.fetch("https://auth/lock")).status).toBe(200);
  });

  it("unlocking an unheld lock records no episode and /takeover stays ineligible", async () => {
    // Arrange — no lock was ever held.
    const { stub, values } = harness();
    await storeSession(stub, FAILED_COOKIE, Date.now() + 60_000);

    // Act
    await stub.fetch("https://auth/unlock", { method: "POST" });

    // Assert — no anchor, and /takeover changes nothing.
    expect(values.has("failedReleaseAtMs")).toBe(false);
    const state = await readSessionState(stub);
    expect(state.failedReleaseAtMs).toBeUndefined();
    expect(await (await stub.fetch("https://auth/takeover", { method: "POST" })).status).toBe(409);
    expect(values.has("takeoverAtMs")).toBe(false);
  });

  it("/takeover refuses a live cookie without changing state", async () => {
    // Arrange — a failed release happened, but a live cookie is stored.
    const { stub, values } = harness();
    await stub.fetch("https://auth/lock");
    await storeSession(stub, FRESH_COOKIE, Date.now() + 60_000);
    await stub.fetch("https://auth/lock");
    await stub.fetch("https://auth/unlock", { method: "POST" });
    expect(typeof values.get("failedReleaseAtMs")).toBe("number");

    // Act
    const response = await stub.fetch("https://auth/takeover", { method: "POST" });

    // Assert — 409, and the lock flags are untouched: no claim, no steal.
    expect(response.status).toBe(409);
    expect(values.has("takeoverAtMs")).toBe(false);
    expect((await readSessionState(stub)).cookieHeader).toBe(FRESH_COOKIE);
  });

  it("the episode window closes: /takeover past the window is ineligible", async () => {
    // Arrange — a failed release with no takeover claim.
    const { stub } = harness();
    await failedHolderSetup(stub);
    await stub.fetch("https://auth/unlock", { method: "POST" });

    // Act — the whole window passes with no waiter attempting a takeover.
    await vi.advanceTimersByTimeAsync(TAKEOVER_WINDOW_MS + 1);
    const response = await stub.fetch("https://auth/takeover", { method: "POST" });

    // Assert
    expect(response.status).toBe(409);
  });
});
