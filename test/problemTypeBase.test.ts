import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBLEM_TYPE_BASE,
  PROBLEM_TYPE_BASE,
  notFoundProblem,
  problemType,
  resolveProblemTypeBase,
} from "../src/lib/problem";
import { validationFailureHook } from "../src/routes/shared";

/**
 * HANDOVER.md open-task #1: the problem+json `type` URI base is
 * no longer hardcoded — it resolves from the `PROBLEM_TYPE_BASE` wrangler
 * var, with the committed docs URL as fallback.
 *
 * What this file proves:
 * - the default is byte-identical to the old hardcoded URL (existing
 *   verbatim-pin tests pass unmodified);
 * - a non-empty `PROBLEM_TYPE_BASE` binding wins, verbatim;
 * - empty/absent/non-string bindings fall back (including the committed
 *   `""` wrangler default and envs that never set the key);
 * - the override flows through `notFoundProblem` and the validation hook.
 */

const CUSTOM = "https://docs.example.com/problems#";

describe("resolveProblemTypeBase", () => {
  it("keeps the committed docs URL as the historical default export", () => {
    expect(PROBLEM_TYPE_BASE).toBe(
      "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#"
    );
    expect(DEFAULT_PROBLEM_TYPE_BASE).toBe(PROBLEM_TYPE_BASE);
  });

  it("falls back without an env or with an irrelevant env", () => {
    expect(resolveProblemTypeBase()).toBe(DEFAULT_PROBLEM_TYPE_BASE);
    expect(resolveProblemTypeBase(undefined)).toBe(DEFAULT_PROBLEM_TYPE_BASE);
    expect(resolveProblemTypeBase({} as Env)).toBe(DEFAULT_PROBLEM_TYPE_BASE);
  });

  it("falls back on empty, blank, or non-string bindings", () => {
    for (const v of ["", "   ", 0, 42, null, true, {}]) {
      expect(
        resolveProblemTypeBase({ PROBLEM_TYPE_BASE: v } as unknown as Env)
      ).toBe(DEFAULT_PROBLEM_TYPE_BASE);
    }
  });

  it("honors a non-empty PROBLEM_TYPE_BASE binding verbatim", () => {
    const env = { PROBLEM_TYPE_BASE: CUSTOM } as unknown as Env;
    expect(resolveProblemTypeBase(env)).toBe(CUSTOM);
    expect(problemType("not-found", env)).toBe(`${CUSTOM}not-found`);
  });

  it("keeps single-arg problemType on the default base", () => {
    expect(problemType("bad-request")).toBe(`${DEFAULT_PROBLEM_TYPE_BASE}bad-request`);
  });
});

describe("override flows through the helpers", () => {
  it("notFoundProblem honors the override", async () => {
    const env = { PROBLEM_TYPE_BASE: CUSTOM } as unknown as Env;
    const body = (await notFoundProblem("/api/v1/nope", env).json()) as {
      type: string;
    };
    expect(body.type).toBe(`${CUSTOM}not-found`);
    const fallback = (await notFoundProblem("/api/v1/nope").json()) as {
      type: string;
    };
    expect(fallback.type).toBe(`${DEFAULT_PROBLEM_TYPE_BASE}not-found`);
  });

  it("validationFailureHook honors the override, defaults without it", async () => {
    const failure = {
      success: false as const,
      target: "query",
      error: { issues: [{ path: ["limit"] }] },
    };
    const env = { PROBLEM_TYPE_BASE: CUSTOM } as unknown as Env;
    const custom = (await validationFailureHook(failure, { env })?.json()) as {
      type: string;
    };
    expect(custom.type).toBe(`${CUSTOM}bad-request`);
    // Framework-shaped context: zod-validator calls the hook as
    // `hook(result, context)` where env rides on the context object
    // (review note) — proves the wiring claim, not just the path.
    const frameworkCtx = {
      env,
      validated: {},
      req: {},
      next: () => Promise.resolve(),
    };
    const viaCtx = (await validationFailureHook(
      failure,
      frameworkCtx as unknown as Parameters<typeof validationFailureHook>[1]
    )?.json()) as { type: string };
    expect(viaCtx.type).toBe(`${CUSTOM}bad-request`);
    const fallback = (await validationFailureHook(failure)?.json()) as {
      type: string;
    };
    expect(fallback.type).toBe(`${DEFAULT_PROBLEM_TYPE_BASE}bad-request`);
  });
});
