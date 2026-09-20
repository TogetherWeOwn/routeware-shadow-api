import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  OPERATOR_TODO,
  SKIP_REASON,
  SKIPPED_CHECK_ALLOWLIST,
  evaluateGate,
  formatSkipLog,
  missingTokenError,
  requireToken,
} from "../scripts/lib/shadowApiV1Gate.mjs";

describe("shadow-api-v1 credential gate", () => {
  it("keeps the staging check on the skipped-check allowlist", () => {
    expect(SKIPPED_CHECK_ALLOWLIST).toEqual({ [CHECK_NAME]: SKIP_REASON });
  });

  it("surfaces the operator reason and TODO when CF_TOKEN is absent", () => {
    const result = evaluateGate("");

    expect(result).toEqual({
      status: "skipped",
      reason: SKIP_REASON,
      todo: OPERATOR_TODO,
    });
    expect(formatSkipLog(result)).toContain(
      `${CHECK_NAME}: SKIPPED\nreason: ${SKIP_REASON}`
    );
    expect(formatSkipLog(result)).toContain(`TODO: ${OPERATOR_TODO}`);
  });

  it("is ready only when CF_TOKEN is present", () => {
    expect(evaluateGate("staging-token")).toEqual({
      status: "ready",
      reason: null,
      todo: null,
    });
    expect(requireToken("staging-token").status).toBe("ready");
  });

  it("fails the local unskip path with a clear missing-token error", () => {
    expect(() => requireToken(" ")).toThrow(missingTokenError());
    expect(() => requireToken(" ")).toThrow("shadow-api-v1: missing CF_TOKEN");
  });
});
