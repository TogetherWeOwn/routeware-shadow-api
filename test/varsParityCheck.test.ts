import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  SECRET_KEYS,
  compareVarsParity,
  formatFailureLog,
  formatPassLog,
  parseExampleCommentedKeys,
} from "../scripts/lib/varsParityCheck.mjs";

/**
 * Regression tests for Gap G20: a new var can land in
 * wrangler.toml [vars] without a `.dev.vars.example` mention (or vice
 * versa), causing a fail-closed surprise at deploy or a confusing local
 * setup. Only key names are ever handled — no values, real or fixture.
 */

describe("parseExampleCommentedKeys", () => {
  it("finds commented # KEY=, # KEY: and bare # KEY mentions", () => {
    const text = [
      "# Copy to .dev.vars (gitignored). Never commit real values.",
      "# AUTH_MODE=auto",
      "#CUSTOMER_SAVE_AUTO_TOKEN=false",
      "# SNAPSHOTS_R2_ENABLED: false",
      "# TARGET_ORIGIN",
      "OPENAPI_DOCS_ENABLED=true",
      "",
    ].join("\n");
    expect(parseExampleCommentedKeys(text)).toEqual([
      "AUTH_MODE",
      "CUSTOMER_SAVE_AUTO_TOKEN",
      "SNAPSHOTS_R2_ENABLED",
      "TARGET_ORIGIN",
    ]);
  });

  it("ignores prose comments and indented non-key text", () => {
    const text = [
      "# HTTP login needs no Browser Rendering, so `npm run dev` works.",
      "# Set \"browser\" to force the Puppeteer path.",
      "   # not a key: lowercase words here",
      "# 123-NOT-A-KEY=x",
      "",
    ].join("\n");
    expect(parseExampleCommentedKeys(text)).toEqual([]);
  });

  it("dedupes repeated mentions and sorts", () => {
    const text = ["# ZEBRA=x", "# APPLE=y", "# ZEBRA=z", ""].join("\n");
    expect(parseExampleCommentedKeys(text)).toEqual(["APPLE", "ZEBRA"]);
  });
});

describe("compareVarsParity", () => {
  it("passes when every wrangler key is active or commented in the example", () => {
    const outcome = compareVarsParity(
      { TARGET_ORIGIN: "", AUTH_MODE: "" },
      { TARGET_ORIGIN: "" },
      ["AUTH_MODE"]
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.missingInExample).toEqual([]);
    expect(outcome.extraInExample).toEqual([]);
    expect(outcome.staleCommented).toEqual([]);
  });

  it("fails on a wrangler key missing from both active and commented example keys", () => {
    const outcome = compareVarsParity({ NEW_VAR: "", TARGET_ORIGIN: "" }, { TARGET_ORIGIN: "" }, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.missingInExample).toEqual(["NEW_VAR"]);
  });

  it("does not require secrets in wrangler [vars] (they live in .dev.vars / wrangler secret)", () => {
    const example: Record<string, string> = {};
    for (const key of SECRET_KEYS) example[key] = "";
    const outcome = compareVarsParity({ TARGET_ORIGIN: "" }, { ...example, TARGET_ORIGIN: "" }, []);
    expect(outcome.ok).toBe(true);
  });

  it("pins the secret allowlist to the five documented credential keys", () => {
    expect([...SECRET_KEYS].sort()).toEqual([
      "CUSTOMER_SNAPSHOT_SYNC_SECRET",
      "LOGIN_PASSWORD",
      "LOGIN_USERNAME",
      "SHADOW_API_READ_TOKEN",
      "SHADOW_API_TOKEN",
    ]);
  });

  it("fails on an extra active example key that is neither a wrangler key nor a secret", () => {
    const outcome = compareVarsParity({ TARGET_ORIGIN: "" }, { TARGET_ORIGIN: "", TYPO_VAR: "" }, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.extraInExample).toEqual(["TYPO_VAR"]);
  });

  it("fails on a stale commented example key with no counterpart", () => {
    const outcome = compareVarsParity({ TARGET_ORIGIN: "" }, { TARGET_ORIGIN: "" }, ["REMOVED_VAR"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.staleCommented).toEqual(["REMOVED_VAR"]);
  });

  it("lets a commented secret stay without a wrangler counterpart", () => {
    const outcome = compareVarsParity({}, {}, ["SHADOW_API_TOKEN"]);
    expect(outcome.ok).toBe(true);
  });
});

describe("vars-parity never prints values", () => {
  it("reports keys only even when the parsed maps carry secret-shaped values", () => {
    const secretValue = "placeholder-secret-value";
    const outcome = compareVarsParity(
      { TARGET_ORIGIN: "https://placeholder.example", NEW_VAR: secretValue },
      { TARGET_ORIGIN: "https://placeholder.example" },
      []
    );
    expect(outcome.ok).toBe(false);
    const report = formatFailureLog(outcome);
    expect(report).toContain("NEW_VAR");
    expect(report).not.toContain(secretValue);
    expect(report).not.toContain("https://placeholder.example");
  });
});

describe("vars-parity report format", () => {
  it("pins the check name and names keys only", () => {
    expect(CHECK_NAME).toBe("vars-parity");
    expect(formatPassLog(17, 12)).toContain("vars-parity: PASS");
    const report = formatFailureLog({
      missingInExample: ["NEW_VAR"],
      extraInExample: ["TYPO_VAR"],
      staleCommented: ["OLD_VAR"],
    });
    expect(report).toContain("NEW_VAR");
    expect(report).toContain("TYPO_VAR");
    expect(report).toContain("OLD_VAR");
  });
});
