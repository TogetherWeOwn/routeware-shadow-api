import { describe, expect, it } from "vitest";
import {
  CHECKS,
  CHECK_NAME,
  formatSummary,
  summarizeResults,
} from "../scripts/lib/verifyConfig.mjs";

/**
 * Regression tests for Gap O3: three separate config checks an
 * operator must remember (devvars, vars-parity, d1-drift) get one
 * `npm run verify:config` preflight with a single pass/fail summary. Only
 * check names and pass/fail are ever handled — no values, real or fixture.
 */

describe("verify:config chain", () => {
  it("chains exactly the three operator config checks, d1-drift local-only", () => {
    expect(CHECKS.map((c) => c.name)).toEqual(["check:devvars", "check:vars-parity", "check:d1-drift"]);
    const drift = CHECKS.find((c) => c.name === "check:d1-drift");
    expect(drift?.args).toEqual([]);
  });

  it("summarizes all-green as pass", () => {
    const summary = summarizeResults(
      CHECKS.map((c) => ({ name: c.name, ok: true }))
    );
    expect(summary.ok).toBe(true);
    expect(formatSummary(summary)).toBe(
      `${CHECK_NAME}: PASS — 3/3 checks green (check:devvars, check:vars-parity, check:d1-drift)`
    );
  });

  it("summarizes one broken check as fail naming that check", () => {
    const summary = summarizeResults([
      { name: "check:devvars", ok: false },
      { name: "check:vars-parity", ok: true },
      { name: "check:d1-drift", ok: true },
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.failed).toEqual(["check:devvars"]);
    expect(formatSummary(summary)).toContain("check:devvars");
    expect(formatSummary(summary)).toContain("npm run check:devvars");
  });

  it("treats a short run (leg missing) as fail", () => {
    expect(summarizeResults([{ name: "check:devvars", ok: true }]).ok).toBe(false);
    expect(summarizeResults([]).ok).toBe(false);
  });
});
