import { describe, expect, it } from "vitest";
import {
  assertNoPrTriggerSkips,
  findPrTriggerSkips
} from "../scripts/lib/ciWorkflowCheck.mjs";

/**
 * Regression tests for TOG-6539: `check-ci-workflow.mjs` asserted
 * `on.pull_request: [main]` but never asserted `build`/`hygiene` lack
 * `if:`/`paths-ignore` skips — a workflow edit could drop the CSV/`.dev.vars`
 * gate on PRs while the invariant check stayed green.
 *
 * Fixture workflows are credential-free skeletons (job/step names only, no
 * secrets or PII) per CONVENTIONS.md sections 4-5.
 */

function fixtureWorkflow(overrides: { on?: string; build?: string; hygiene?: string } = {}): string {
  const on =
    overrides.on ??
    ["on:", "  pull_request:", "    branches: [main]", "  push:", "    branches: [main]", ""].join("\n");
  const build = overrides.build ?? ["  build:", "    runs-on: [self-hosted, two-selfhosted]", ""].join("\n");
  const hygiene =
    overrides.hygiene ??
    ["  hygiene:", "    runs-on: [self-hosted, two-selfhosted]", "    steps:", "      - run: npm test", ""].join(
      "\n"
    );
  return [on, "jobs:", build, hygiene].join("\n");
}

describe("findPrTriggerSkips (TOG-6539)", () => {
  it("accepts the unskipped gate workflow", () => {
    expect(findPrTriggerSkips(fixtureWorkflow())).toEqual([]);
    expect(() => assertNoPrTriggerSkips(fixtureWorkflow())).not.toThrow();
  });

  it("fails when hygiene gains paths-ignore (the acceptance fixture)", () => {
    const workflow = fixtureWorkflow({
      hygiene: [
        "  hygiene:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    paths-ignore:",
        "      - 'docs/**'",
        "    steps:",
        "      - run: npm test",
        ""
      ].join("\n")
    });
    const errors = findPrTriggerSkips(workflow);
    expect(errors.some((e) => e.includes("hygiene") && e.includes("paths-ignore"))).toBe(true);
    expect(() => assertNoPrTriggerSkips(workflow)).toThrow(/hygiene.*paths-ignore/);
  });

  it("fails on a job-level if: on either gate job", () => {
    const workflow = fixtureWorkflow({
      build: [
        "  build:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    if: github.event_name == 'push'",
        ""
      ].join("\n")
    });
    const errors = findPrTriggerSkips(workflow);
    expect(errors.some((e) => e.includes("build") && e.includes("'if:'"))).toBe(true);
    expect(() => assertNoPrTriggerSkips(workflow)).toThrow(/build/);
  });

  it("fails on a step-level if: inside a gate job", () => {
    const workflow = fixtureWorkflow({
      hygiene: [
        "  hygiene:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    steps:",
        "      - name: PII gate",
        "        if: github.event_name == 'push'",
        "        run: npm test",
        ""
      ].join("\n")
    });
    const errors = findPrTriggerSkips(workflow);
    expect(errors.some((e) => e.includes("hygiene") && e.includes("steps must not"))).toBe(true);
    expect(() => assertNoPrTriggerSkips(workflow)).toThrow(/hygiene/);
  });

  it("fails when the pull_request trigger narrows with paths or types", () => {
    const paths = fixtureWorkflow({
      on: ["on:", "  pull_request:", "    branches: [main]", "    paths:", "      - 'src/**'", ""].join("\n")
    });
    expect(findPrTriggerSkips(paths).some((e) => e.includes("paths"))).toBe(true);
    const types = fixtureWorkflow({
      on: ["on:", "  pull_request:", "    branches: [main]", "    types: [opened]", ""].join("\n")
    });
    expect(findPrTriggerSkips(types).some((e) => e.includes("types"))).toBe(true);
  });

  it("still requires the pull_request trigger itself", () => {
    const workflow = fixtureWorkflow({
      on: ["on:", "  push:", "    branches: [main]", ""].join("\n")
    });
    expect(findPrTriggerSkips(workflow).some((e) => e.includes("pull requests targeting main"))).toBe(
      true
    );
  });

  it("ignores narrowing on push: (PR gate is what this guards)", () => {
    const workflow = fixtureWorkflow({
      on: [
        "on:",
        "  pull_request:",
        "    branches: [main]",
        "  push:",
        "    branches: [main]",
        "    paths-ignore:",
        "      - 'docs/**'",
        ""
      ].join("\n")
    });
    expect(findPrTriggerSkips(workflow)).toEqual([]);
  });

  it("names jobs and keys only — never fixture content", () => {
    const errors = findPrTriggerSkips(
      fixtureWorkflow({
        hygiene: ["  hygiene:", "    paths-ignore:", "      - 'docs/**'", ""].join("\n")
      })
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).not.toContain("docs/**");
    }
  });
});
