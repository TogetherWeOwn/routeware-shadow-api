import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  classifyFetchError,
  evaluateSmokeReadiness,
  parseSmokeArgs,
  runSmokeReadiness,
  usage,
} from "../scripts/lib/smokeReadiness.mjs";

const TOKEN = "dummy-secret-xyz-never-log";

function okReadinessBody() {
  return {
    status: "ok",
    checks: {
      d1: { ok: true },
      r2: { ok: true, bound: true, enabled: true },
      config: { ok: true, customer: "c", address: "a", container: "ct" },
      cron: {
        stale: false,
        lastRunAt: "2026-10-01T07:00:00.000Z",
        tables: {
          customer: { outcome: "ok", ranAt: "2026-10-01T07:00:00.000Z" },
          address: { outcome: "ok", ranAt: "2026-10-01T07:00:00.000Z" },
          container: { outcome: "ok", ranAt: "2026-10-01T07:00:00.000Z" },
        },
      },
    },
  };
}

function okInputs() {
  return {
    health: { status: 200, body: { status: "ok" } },
    unauth: { status: 401, body: { status: "error" } },
    ready: { status: 200, body: okReadinessBody() },
  };
}

function allLines(result: { stdout: string[]; stderr: string[] }) {
  return [...result.stdout, ...result.stderr].join("\n");
}

/** Fake fetch Response shape: status + text(). */
function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("smoke-readiness verdicts", () => {
  it("exits 0 when every check is ok", () => {
    const result = evaluateSmokeReadiness(okInputs());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("PASS liveness: GET /api/v1/health -> 200 ok");
    expect(result.stdout.join("\n")).toContain("PASS auth gate: unauthenticated readiness -> 401");
    expect(result.stdout.join("\n")).toContain("PASS readiness: all dependencies ok");
  });

  it("exits 1 when liveness is not 200", () => {
    const result = evaluateSmokeReadiness({
      ...okInputs(),
      health: { status: 500, body: { status: "ok" } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("FAIL liveness");
  });

  it("exits 1 when unauthenticated readiness is not 401", () => {
    const result = evaluateSmokeReadiness({
      ...okInputs(),
      unauth: { status: 200, body: { status: "ok" } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("FAIL auth gate");
  });

  it.each(["d1", "r2", "config"] as const)("exits 1 when the %s check is missing", (name) => {
    const body = okReadinessBody() as any;
    delete body.checks[name];
    const result = evaluateSmokeReadiness({ ...okInputs(), ready: { status: 200, body } });
    expect(result.exitCode).toBe(1);
    expect(allLines(result)).toContain(`${name}: MISSING`);
  });

  it("exits 1 when a check reports ok:false", () => {
    const body = okReadinessBody() as any;
    body.checks.d1 = { ok: false, detail: "down" };
    const result = evaluateSmokeReadiness({ ...okInputs(), ready: { status: 200, body } });
    expect(result.exitCode).toBe(1);
    expect(allLines(result)).toContain("NOT OK");
  });

  it("stays exit 0 on a stale cron with an advisory line", () => {
    const body = okReadinessBody() as any;
    body.checks.cron.stale = true;
    const result = evaluateSmokeReadiness({ ...okInputs(), ready: { status: 200, body } });
    expect(result.exitCode).toBe(0);
    expect(allLines(result)).toContain("STALE (advisory)");
  });

  it("exits 1 on a non-JSON body", () => {
    const result = evaluateSmokeReadiness({
      ...okInputs(),
      health: { status: 200, body: null },
    });
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 on a timeout with a single FAIL line and no stack", () => {
    const result = evaluateSmokeReadiness({
      ...okInputs(),
      health: { error: "timeout" },
    });
    expect(result.exitCode).toBe(1);
    const text = allLines(result);
    expect(text).toContain("FAIL liveness");
    expect(text).toContain("timeout");
    expect(text).not.toContain("at ");
    expect(text).not.toContain("AbortError: ");
  });

  it("maps AbortError to timeout and other failures to a network class", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(classifyFetchError(abort)).toBe("timeout");
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(classifyFetchError(refused)).toBe("ECONNREFUSED");
    expect(classifyFetchError(new TypeError("fetch failed"))).toBe("network-error");
  });

  it("sends the bearer token only on the authenticated readiness probe", async () => {
    // Route like the real Worker (first readiness hit without auth -> 401,
    // with the bearer token -> 200) AND record exact header placement, so a
    // mutant that moves the token to the liveness or auth-gate probe, or
    // drops it from the authenticated probe, turns this green suite red.
    const calls: Array<{ url: string; authorization: unknown }> = [];
    const fetchImpl = async (url: string, init?: any) => {
      const authorization = init?.headers?.authorization;
      calls.push({ url: String(url), authorization });
      if (String(url).endsWith("/api/v1/health")) return jsonResponse(200, { status: "ok" });
      if (String(url).endsWith("/api/v1/readiness")) {
        if (authorization === `Bearer ${TOKEN}`) return jsonResponse(200, okReadinessBody());
        return jsonResponse(401, { status: "error" });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const result = await runSmokeReadiness({
      fetchImpl: fetchImpl as any,
      base: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(allLines(result)).not.toContain(TOKEN);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:1/api/v1/health",
      "http://127.0.0.1:1/api/v1/readiness",
      "http://127.0.0.1:1/api/v1/readiness",
    ]);
    // Liveness and the auth-gate probe stay public; only the authenticated
    // readiness probe carries the bearer token.
    expect(calls.map((c) => c.authorization)).toEqual([undefined, undefined, `Bearer ${TOKEN}`]);
  });

  it("bounds a hanging server with a timeout and exits 1 without the token", async () => {
    const hanging = (_url: string, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    const started = Date.now();
    const result = await runSmokeReadiness({
      fetchImpl: hanging as any,
      base: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(1);
    const text = allLines(result);
    expect(text).toContain("FAIL");
    expect(text).toContain("timeout");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("at ");
  });

  it("turns a refused connection into a FAIL line, not a stack trace", async () => {
    const refused = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const result = await runSmokeReadiness({
      fetchImpl: refused as any,
      base: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(1);
    const text = allLines(result);
    expect(text).toContain("FAIL");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("at ");
    expect(text).not.toContain(TOKEN);
  });

  it("reports a stalled body read as timeout on every probe, not a status code", async () => {
    const stalledBody = (_url: string, init?: any) => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      return Promise.resolve({
        status: 200,
        text: () =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(error);
              return;
            }
            init?.signal?.addEventListener("abort", () => reject(error), { once: true });
          }),
      });
    };
    const result = await runSmokeReadiness({
      fetchImpl: stalledBody as any,
      base: "http://127.0.0.1:1",
      token: TOKEN,
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(1);
    const text = allLines(result);
    expect(text).toContain("FAIL liveness: GET /api/v1/health -> timeout");
    expect(text).toContain("FAIL auth gate: unauthenticated readiness -> timeout");
    expect(text).toContain("FAIL readiness: GET /api/v1/readiness -> timeout");
    expect(text).not.toContain("MISSING from response");
    expect(text).not.toContain("degraded");
    expect(text).not.toContain(TOKEN);
  });
});

describe("smoke-readiness timeout flag", () => {
  it("defaults to 15000 ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15000);
    expect(parseSmokeArgs([]).timeoutMs).toBe(15000);
  });

  it("accepts --timeout-ms=N", () => {
    expect(parseSmokeArgs(["--timeout-ms=500"]).timeoutMs).toBe(500);
  });

  it.each([["--timeout-ms=abc"], ["--timeout-ms=0"], ["--timeout-ms=-5"]])(
    "rejects invalid %s",
    (flag) => {
      expect(() => parseSmokeArgs([flag])).toThrow();
    },
  );

  it("documents --timeout-ms in usage", () => {
    expect(usage()).toContain("--timeout-ms");
  });
});
