import { describe, expect, it } from "vitest";
import {
  ALL_PROBE_PATHS,
  AUTHED_PROBE_PATHS,
  BASE_ENV,
  CHECK_NAME,
  DEFAULT_BASE,
  PUBLIC_PROBE_PATH,
  SKIP_FLAG,
  formatSkipLine,
  planProbes,
  resolveBase,
} from "../scripts/lib/postDeployProbe.mjs";

describe("post-deploy-probe skip-safe planner (TOG-8365)", () => {
  it("keeps the check name and skip flag stable for the scheduled workflow", () => {
    expect(CHECK_NAME).toBe("post-deploy-probe");
    expect(SKIP_FLAG).toBe("--skip-if-no-token");
  });

  it("resolves base from positional arg, then SHADOW_API_BASE env, then local default", () => {
    expect(resolveBase({ positional: "https://w.example", env: { [BASE_ENV]: "https://e.example" } })).toBe(
      "https://w.example"
    );
    expect(resolveBase({ positional: "  ", env: { [BASE_ENV]: "https://e.example" } })).toBe(
      "https://e.example"
    );
    expect(resolveBase({ positional: "", env: {} })).toBe(DEFAULT_BASE);
    expect(resolveBase({ positional: "", env: { [BASE_ENV]: "   " } })).toBe(DEFAULT_BASE);
  });

  it("runs every probe when a bearer token resolves", () => {
    expect(planProbes({ hasToken: true, skipIfNoToken: true })).toEqual([
      { path: PUBLIC_PROBE_PATH, mode: "run", reason: null },
      { path: AUTHED_PROBE_PATHS[0], mode: "run", reason: null },
      { path: AUTHED_PROBE_PATHS[1], mode: "run", reason: null },
    ]);
  });

  it("skips (never fails) the authed probes without a token in scheduled mode", () => {
    const plan = planProbes({ hasToken: false, skipIfNoToken: true });
    expect(plan[0]).toEqual({ path: PUBLIC_PROBE_PATH, mode: "run", reason: null });
    for (const entry of plan.slice(1)) {
      expect(entry.mode).toBe("skip");
      expect(entry.reason).toContain("skip-safe");
    }
  });

  it("fails closed without a token in strict manual mode", () => {
    const plan = planProbes({ hasToken: false, skipIfNoToken: false });
    expect(plan[0].mode).toBe("run");
    expect(plan.slice(1).map((entry) => entry.mode)).toEqual(["fail", "fail"]);
  });

  it("only ever plans GET probes against fixed read-only /api/v1/* paths", () => {
    expect(ALL_PROBE_PATHS).toEqual([PUBLIC_PROBE_PATH, ...AUTHED_PROBE_PATHS]);
    for (const path of ALL_PROBE_PATHS) {
      expect(path.startsWith("/api/v1/")).toBe(true);
    }
    expect(ALL_PROBE_PATHS).toHaveLength(3);
  });

  it("formats a skip line naming the path and the token remediation", () => {
    const line = formatSkipLine({ path: AUTHED_PROBE_PATHS[0], reason: "no token" });
    expect(line).toContain(`SKIP GET ${AUTHED_PROBE_PATHS[0]}`);
    expect(line).toContain("SHADOW_API_TOKEN");
    expect(line).toContain(SKIP_FLAG);
    expect(line).not.toContain("Bearer");
  });
});
