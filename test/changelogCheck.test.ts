import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  evaluateChangelogGate,
  formatFailureLog,
  formatPassLog,
  isContractVisiblePath,
  unreleasedCardIds,
  unreleasedSection,
} from "../scripts/lib/changelogCheck.mjs";

/**
 * Regression tests (gap G9): `[Unreleased]` sat empty with no
 * enforcement, so consumer-visible contract changes landed without a
 * changelog entry. All fixtures are synthetic path/card-id strings — no
 * values, real or otherwise.
 */

describe("isContractVisiblePath", () => {
  it("flags route, app, worker, lib-shape, wrangler and migration paths", () => {
    for (const path of [
      "src/routes/customers.ts",
      "src/app.ts",
      "src/worker.ts",
      "src/lib/auth.ts",
      "wrangler.toml",
      "migrations/d1/0003_add_index.sql",
    ]) {
      expect(isContractVisiblePath(path)).toBe(true);
    }
  });

  it("skips docs, tests, scripts, CI, nested lib internals and the changelog itself", () => {
    for (const path of [
      "docs/VERSIONING.md",
      "test/auth.test.ts",
      "scripts/check-changelog.mjs",
      "scripts/lib/changelogCheck.mjs",
      ".github/workflows/ci.yml",
      ".github/pull_request_template.md",
      "src/lib/snapshot/sync.ts",
      "CHANGELOG.md",
      "package.json",
      "README.md",
    ]) {
      expect(isContractVisiblePath(path)).toBe(false);
    }
  });
});

describe("unreleasedSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- TOG-8385: the gate itself.",
    "",
    "## [1.0.0] - 2026-09-27",
    "",
    "Initial release.",
    "",
  ].join("\n");

  it("extracts the body between [Unreleased] and the next release heading", () => {
    const section = unreleasedSection(changelog);
    expect(section).toContain("- TOG-8385: the gate itself.");
    expect(section).not.toContain("Initial release.");
  });

  it("returns null when there is no [Unreleased] heading", () => {
    expect(unreleasedSection("# Changelog\n\n## [1.0.0]\n")).toBe(null);
  });

  it("reads to end of file when [Unreleased] is the last heading", () => {
    expect(unreleasedSection("## [Unreleased]\n\n- TOG-1: x.\n")).toContain("TOG-1");
  });
});

describe("unreleasedCardIds", () => {
  it("collects sorted unique TOG ids from bullets", () => {
    expect(unreleasedCardIds("- TOG-9: b.\n- TOG-7: a.\n- TOG-9: dup.\n")).toEqual([
      "TOG-7",
      "TOG-9",
    ]);
  });

  it("returns empty when no card id is named", () => {
    expect(unreleasedCardIds("- some entry with no card.\n")).toEqual([]);
  });
});

describe("evaluateChangelogGate", () => {
  const entry = (card: string) =>
    `# Changelog\n\n## [Unreleased]\n\n- ${card}: a contract change.\n\n## [1.0.0]\n`;

  it("passes docs/test/scripts/CI-only changes with skipped=true", () => {
    const outcome = evaluateChangelogGate(
      ["docs/VERSIONING.md", "test/auth.test.ts", "scripts/check-x.mjs", ".github/workflows/ci.yml"],
      "# Changelog\n\n## [Unreleased]\n",
      []
    );
    expect(outcome).toEqual({ ok: true, contractPaths: [], cards: [], skipped: true });
  });

  it("passes a contract change covered by its card bullet", () => {
    const outcome = evaluateChangelogGate(
      ["src/routes/customers.ts"],
      entry("TOG-8385"),
      ["TOG-8385"]
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.contractPaths).toEqual(["src/routes/customers.ts"]);
    expect(outcome.cards).toEqual(["TOG-8385"]);
  });

  it("passes without a claimed card when any Unreleased bullet exists", () => {
    const outcome = evaluateChangelogGate(["src/app.ts"], entry("TOG-1"), []);
    expect(outcome.ok).toBe(true);
  });

  it("fails a contract change with an empty [Unreleased]", () => {
    const outcome = evaluateChangelogGate(
      ["src/routes/customers.ts"],
      "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n",
      ["TOG-8385"]
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.contractPaths).toEqual(["src/routes/customers.ts"]);
  });

  it("fails when the Unreleased bullets name a different card than claimed", () => {
    const outcome = evaluateChangelogGate(
      ["wrangler.toml"],
      entry("TOG-1"),
      ["TOG-8385"]
    );
    expect(outcome.ok).toBe(false);
  });

  it("fails when there is no [Unreleased] heading at all", () => {
    const outcome = evaluateChangelogGate(["src/worker.ts"], "# Changelog\n", []);
    expect(outcome.ok).toBe(false);
  });

  it("dedupes and sorts contract paths, ignoring the changelog itself", () => {
    const outcome = evaluateChangelogGate(
      ["src/worker.ts", "CHANGELOG.md", "src/app.ts", "src/worker.ts"],
      entry("TOG-8385"),
      ["TOG-8385"]
    );
    expect(outcome.contractPaths).toEqual(["src/app.ts", "src/worker.ts"]);
    expect(outcome.ok).toBe(true);
  });

  it("formats pass and failure logs naming paths, never values", () => {
    const pass = formatPassLog(["src/app.ts"], ["TOG-8385"]);
    expect(pass).toContain(CHECK_NAME);
    expect(pass).toContain("TOG-8385");
    const fail = formatFailureLog({ contractPaths: ["src/app.ts"], cards: [] });
    expect(fail).toContain("src/app.ts");
    expect(fail).toContain("[Unreleased]");
  });
});
