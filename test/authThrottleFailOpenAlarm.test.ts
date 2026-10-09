import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_THROTTLE_WINDOW_MS,
  recordAuthFailure,
  resetAuthThrottleFailOpenLogForTests
} from "../src/lib/authThrottle";

// Alarm contract for the `AUTH THROTTLE FAIL-OPEN` event (TOG-8885): when the
// throttle DO fails, the event must fire exactly once per window — the alarm
// without the spam. Companion to the dedup cases in
// test/authThrottle.test.ts (TOG-6530); this file pins the operator-visible
// contract the runbook
// (docs/AUTH-THROTTLE-FAIL-OPEN-ALARM-RUNBOOK.md) keys on.

// Fresh TEST-NET-3 IP, never used by authThrottle/throttleBurst/XFF suites
// (the stubbed DO never sees it, but a leaked bucket must not either).
const DEAD_DO_IP = "203.0.113.210";

function reqWith(headers: Record<string, string>): {
  header: (n: string) => string | undefined;
} {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { header: (n: string) => lower[n.toLowerCase()] };
}

function envWithDeadDo(): Env {
  return {
    AUTH_SESSION: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () =>
        ({
          fetch: async () => {
            throw new Error("DO unreachable");
          }
        }) as unknown as DurableObjectStub
    }
  } as unknown as Env;
}

describe("auth-throttle fail-open alarm contract (TOG-8885)", () => {
  const req = reqWith({ "CF-Connecting-IP": DEAD_DO_IP });

  // `console.error` is swapped directly rather than with `vi.spyOn`: under
  // `@cloudflare/vitest-pool-workers` the console methods are bound accessors,
  // so reading `console.error` back does not return the installed spy (same
  // pattern as test/authThrottle.test.ts and test/dataEntityPostHandlers.test.ts).
  const loggedErrors: Record<string, unknown>[] = [];
  const realConsoleError = console.error;
  const expectedFailOpenEvent = {
    level: "error",
    msg: "AUTH THROTTLE FAIL-OPEN",
    route: "authThrottle.failOpen",
    reason: "do_error",
    ms: null
  };

  beforeEach(() => {
    resetAuthThrottleFailOpenLogForTests();
    loggedErrors.length = 0;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args[0] as Record<string, unknown>);
    };
  });

  // Restore after each test (not just after all): a leaked swap would blind
  // every suite sharing the worker process.
  afterEach(() => {
    console.error = realConsoleError;
  });

  it("fires exactly one line per window on DO failure (burst of 5 → 1 line)", async () => {
    // Arrange — the throttle DO is dead; auth stays enforced by the caller.
    const env = envWithDeadDo();

    // Act — a burst of failures inside one window.
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) {
      const verdict = await recordAuthFailure(env, req, now + i);
      expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
    }

    // Assert — exactly one structured event with a fixed category and no IP/token/PII.
    expect(loggedErrors).toEqual([expectedFailOpenEvent]);
    expect(JSON.stringify(loggedErrors[0])).not.toContain(DEAD_DO_IP);
  });

  it("fires again past the window edge (next window → second line)", async () => {
    // Arrange
    const env = envWithDeadDo();
    const now = 4_000_000;

    // Act — one failure opens the window's line, the next window re-fires.
    await recordAuthFailure(env, req, now);
    expect(loggedErrors).toEqual([expectedFailOpenEvent]);
    await recordAuthFailure(env, req, now + AUTH_THROTTLE_WINDOW_MS + 1);

    // Assert — exactly two structured events, one per window.
    expect(loggedErrors).toEqual([expectedFailOpenEvent, expectedFailOpenEvent]);
  });
});
