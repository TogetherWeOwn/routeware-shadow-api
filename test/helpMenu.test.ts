import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import { formatHelpMenu, groupScripts, isLifecycleHook } from "../scripts/lib/helpMenu.mjs";

const scripts = packageJson.scripts as Record<string, string>;

/**
 * Regression tests for TOG-9233 (`npm run help`): the menu lists every
 * user-facing script exactly once, hides npm lifecycle hooks, and keeps
 * `first-run` and `help` in the general group.
 */
describe("npm run help menu (TOG-9233)", () => {
  it("hides a lifecycle hook only when its base script exists", () => {
    expect(isLifecycleHook("predev", scripts)).toBe(true);
    expect(isLifecycleHook("dev", scripts)).toBe(false);
    expect(isLifecycleHook("prebuild", { dev: "x" })).toBe(false);
  });

  it("lists every non-hook package.json script exactly once", () => {
    const listed = groupScripts(scripts).flatMap(({ entries }) => entries.map(({ name }) => name));
    const expected = Object.keys(scripts).filter((name) => !isLifecycleHook(name, scripts));
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it("puts first-run and help in the general group", () => {
    const general = groupScripts(scripts).find(({ group }) => group === "general");
    expect(general?.entries.map(({ name }) => name)).toEqual(expect.arrayContaining(["first-run", "help"]));
  });

  it("keeps a namespace together, with its top-level script joining the group", () => {
    const groups = groupScripts({
      test: "vitest run",
      "test:watch": "vitest",
      "db:seed": "node scripts/db-seed.mjs",
      "first-run": "node scripts/first-run.mjs",
    });
    expect(groups.map(({ group }) => group)).toEqual(["general", "test", "db"]);
    expect(groups[1].entries.map(({ name }) => name)).toEqual(["test", "test:watch"]);
  });

  it("renders each group under its heading with the command beside each name", () => {
    const text = formatHelpMenu(
      groupScripts({ "first-run": "node scripts/first-run.mjs", "db:seed": "node scripts/db-seed.mjs" }),
    );
    expect(text).toContain("general\n  first-run  node scripts/first-run.mjs");
    expect(text).toContain("db\n  db:seed    node scripts/db-seed.mjs");
  });

  it("truncates long commands", () => {
    const text = formatHelpMenu(groupScripts({ "long:one": "x".repeat(200) }));
    expect(text).toContain(`${"x".repeat(69)}...`);
    expect(text).not.toContain("x".repeat(73));
  });
});
