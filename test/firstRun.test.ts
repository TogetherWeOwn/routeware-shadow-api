import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  FIRST_RUN_STEPS,
  formatFirstRunSummary,
  localBaseUrl,
  pickSmokeToken,
  smokeEnv,
  summarizeFirstRun,
  wranglerDevArgs,
} from "../scripts/lib/firstRun.mjs";

const scripts = packageJson.scripts as Record<string, string>;
const STEP_NAMES = ["devvars", "migrate", "seed", "smoke"];
const green = STEP_NAMES.map((name) => ({ name, ok: true }));

/**
 * Regression tests for TOG-9233 (`npm run first-run`): the chain runs in
 * order, stops at the first failure, and every retry hint names a real script.
 */
describe("first-run chain (TOG-9233)", () => {
  it("runs devvars, migrate, seed, smoke in that order", () => {
    expect(FIRST_RUN_STEPS.map((step) => step.name)).toEqual(STEP_NAMES);
  });

  it("points every retry hint at an npm script that exists", () => {
    for (const step of FIRST_RUN_STEPS) {
      const commands = [...step.rerun.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]);
      expect(commands.length, step.name).toBeGreaterThan(0);
      for (const command of commands) {
        expect(scripts, `${step.name} -> ${command}`).toHaveProperty([command]);
      }
    }
  });
});

describe("pickSmokeToken", () => {
  it("prefers SHADOW_API_TOKEN", () => {
    expect(pickSmokeToken({ SHADOW_API_TOKEN: "a", CUSTOMER_SNAPSHOT_SYNC_SECRET: "b" })).toBe("a");
  });

  it("falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET when SHADOW_API_TOKEN is blank", () => {
    expect(pickSmokeToken({ SHADOW_API_TOKEN: "  ", CUSTOMER_SNAPSHOT_SYNC_SECRET: "b" })).toBe("b");
  });

  it("returns an empty string when neither client token is set", () => {
    expect(pickSmokeToken({ LOGIN_USERNAME: "x" })).toBe("");
  });
});

describe("summarizeFirstRun", () => {
  it("is green only when every step passed", () => {
    expect(summarizeFirstRun(green)).toEqual({ ok: true, passed: STEP_NAMES, failed: null, skipped: [] });
  });

  it("stops at the first failure and lists the steps that never ran", () => {
    expect(summarizeFirstRun([{ name: "devvars", ok: true }, { name: "migrate", ok: false }])).toEqual({
      ok: false,
      passed: ["devvars"],
      failed: "migrate",
      skipped: ["seed", "smoke"],
    });
  });

  it("is not green when the run stopped early without a failure", () => {
    expect(summarizeFirstRun([{ name: "devvars", ok: true }]).ok).toBe(false);
  });
});

describe("formatFirstRunSummary", () => {
  it("reports the green step count and names every step", () => {
    expect(formatFirstRunSummary(summarizeFirstRun(green))).toBe(
      `${CHECK_NAME}: PASS — 4/4 steps green (devvars, migrate, seed, smoke)`,
    );
  });

  it("names the failed step, the steps not run, and the retry command", () => {
    const results = [
      { name: "devvars", ok: true },
      { name: "migrate", ok: false },
    ];
    expect(formatFirstRunSummary(summarizeFirstRun(results))).toBe(
      `${CHECK_NAME}: FAIL at migrate; not run: seed, smoke — retry: npm run db:migrate:local`,
    );
  });
});

describe("smoke wiring", () => {
  it("binds wrangler dev to loopback on the chosen port with no interactive session", () => {
    expect(wranglerDevArgs(8791)).toEqual([
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "8791",
      "--show-interactive-dev-session=false",
    ]);
  });

  it("points smoke:readiness at the loopback dev server with the resolved token", () => {
    expect(smokeEnv({ baseUrl: localBaseUrl(8791), token: "t" })).toEqual({
      SHADOW_API_BASE: "http://127.0.0.1:8791",
      SHADOW_API_TOKEN: "t",
    });
  });
});
