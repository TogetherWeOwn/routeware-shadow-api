import { describe, expect, it } from "vitest";
import {
  assertEveryJobHasTimeout,
  assertFirstPartyActionsPinned,
  assertNoPrTriggerSkips,
  findJobsMissingTimeouts,
  findPrTriggerSkips,
  findUnpinnedFirstPartyActions
} from "../scripts/lib/ciWorkflowCheck.mjs";

/**
 * Regression tests for TOG-6539 (+ TOG-14898 CI standard): `check-ci-workflow.mjs`
 * asserted `on.pull_request: [main]` but never asserted the gate jobs lack
 * `paths-ignore` skips — a workflow edit could drop the CSV/`.dev.vars`
 * gate on PRs while the invariant check stayed green. `hygiene` (PII + secret
 * scan) stays unconditional; `build` allows only the standard
 * `needs.changes.outputs` gate, which `ci-ok` turns into a pass.
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

  it("fails on a non-standard job-level if: on build, allows the changes gate", () => {
    const bad = fixtureWorkflow({
      build: [
        "  build:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    if: github.event_name == 'push'",
        ""
      ].join("\n")
    });
    const badErrors = findPrTriggerSkips(bad);
    expect(badErrors.some((e) => e.includes("build") && e.includes("needs.changes.outputs"))).toBe(true);
    expect(() => assertNoPrTriggerSkips(bad)).toThrow(/build/);

    const gated = fixtureWorkflow({
      build: [
        "  build:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    if: needs.changes.outputs.code == 'true' || needs.changes.outputs.infra == 'true' || needs.changes.outputs.full == 'true'",
        ""
      ].join("\n")
    });
    expect(findPrTriggerSkips(gated)).toEqual([]);
    expect(() => assertNoPrTriggerSkips(gated)).not.toThrow();
  });

  it("fails on any job-level if: on hygiene (PII gate stays unconditional)", () => {
    const workflow = fixtureWorkflow({
      hygiene: [
        "  hygiene:",
        "    runs-on: [self-hosted, two-selfhosted]",
        "    if: needs.changes.outputs.code == 'true'",
        "    steps:",
        "      - run: npm test",
        ""
      ].join("\n")
    });
    const errors = findPrTriggerSkips(workflow);
    expect(errors.some((e) => e.includes("hygiene") && e.includes("'if:'"))).toBe(true);
    expect(() => assertNoPrTriggerSkips(workflow)).toThrow(/hygiene/);
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

  it("accepts a workflow where every real job is bounded (TOG-19017)", () => {
    const workflow = [
      "on:",
      "jobs:",
      "  build:",
      "    runs-on: [self-hosted, two-selfhosted]",
      "    timeout-minutes: 30",
      "    steps:",
      "      - run: npm test",
      ""
    ].join("\n");
    expect(findJobsMissingTimeouts(workflow)).toEqual([]);
    expect(() => assertEveryJobHasTimeout(workflow, "fixture")).not.toThrow();
  });

  it("fails when a job has no timeout-minutes (TOG-19017)", () => {
    const workflow = [
      "on:",
      "jobs:",
      "  build:",
      "    runs-on: [self-hosted, two-selfhosted]",
      "    steps:",
      "      - run: npm test",
      ""
    ].join("\n");
    expect(findJobsMissingTimeouts(workflow)).toEqual(["build"]);
    expect(() => assertEveryJobHasTimeout(workflow, "fixture")).toThrow(/build/);
  });

  it("ignores job blocks without their own runs-on (reusable-workflow callers) (TOG-19017)", () => {
    const workflow = [
      "on:",
      "jobs:",
      "  ci-ok:",
      "    if: always()",
      "    needs: [build]",
      "    steps:",
      "      - run: echo ok",
      ""
    ].join("\n");
    expect(findJobsMissingTimeouts(workflow)).toEqual([]);
  });

  it("accepts SHA-pinned first-party actions with a version comment (TOG-19017)", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
      "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
      ""
    ].join("\n");
    expect(findUnpinnedFirstPartyActions(workflow)).toEqual([]);
    expect(() => assertFirstPartyActionsPinned(workflow, "fixture")).not.toThrow();
  });

  it("fails when a first-party action floats on a moving tag (TOG-19017)", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      ""
    ].join("\n");
    const errors = findUnpinnedFirstPartyActions(workflow);
    expect(errors.some((e) => e.includes("actions/checkout") && e.includes("@v4"))).toBe(true);
    expect(() => assertFirstPartyActionsPinned(workflow, "fixture")).toThrow(/actions\/checkout/);
  });

  it("fails when a SHA pin has no version comment (TOG-19017)", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      ""
    ].join("\n");
    const errors = findUnpinnedFirstPartyActions(workflow);
    expect(errors.some((e) => e.includes("actions/setup-node") && e.includes("version comment"))).toBe(true);
    expect(() => assertFirstPartyActionsPinned(workflow, "fixture")).toThrow(/version comment/);
  });

  it("ignores third-party actions (only checkout/setup-node are pinned) (TOG-19017)", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: docker/login-action@v3",
      ""
    ].join("\n");
    expect(findUnpinnedFirstPartyActions(workflow)).toEqual([]);
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
