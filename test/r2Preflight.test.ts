import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  R2_BINDING,
  R2_ENABLED_KEY,
  formatMissingBucketError,
  formatNoBucketConfiguredError,
  formatPassLog,
  formatSkipLog,
  isR2Enabled,
  parseBucketName,
  parseVarsValue,
  resolvePreflightInput,
} from "../scripts/lib/r2Preflight.mjs";

const FIXTURE_TOML = [
  "[vars]",
  `${R2_ENABLED_KEY} = "true"`,
  "",
  "[[r2_buckets]]",
  `binding = "${R2_BINDING}"`,
  'bucket_name = "routeware-csv-snapshots"',
  "",
  "[env.test.vars]",
  `${R2_ENABLED_KEY} = "false"`,
  "",
  "[[env.test.r2_buckets]]",
  `binding = "${R2_BINDING}"`,
  'bucket_name = "routeware-csv-snapshots-test"',
  "",
].join("\n");

describe("r2-preflight enabled gate", () => {
  it("is on when unset (default)", () => {
    expect(isR2Enabled(undefined)).toBe(true);
    expect(isR2Enabled(null)).toBe(true);
  });

  it("treats only \"false\" (any case) as off", () => {
    expect(isR2Enabled("false")).toBe(false);
    expect(isR2Enabled("FALSE")).toBe(false);
    expect(isR2Enabled("False")).toBe(false);
    expect(isR2Enabled("true")).toBe(true);
    expect(isR2Enabled("")).toBe(true);
  });
});

describe("wrangler.toml parsing", () => {
  it("reads the production [vars] value, not [env.test.vars]", () => {
    expect(parseVarsValue(FIXTURE_TOML, R2_ENABLED_KEY)).toBe("true");
  });

  it("returns null for an absent key", () => {
    expect(parseVarsValue(FIXTURE_TOML, "NO_SUCH_KEY")).toBeNull();
  });

  it("reads the production [[r2_buckets]] name, not the test one", () => {
    expect(parseBucketName(FIXTURE_TOML, R2_BINDING)).toBe("routeware-csv-snapshots");
  });

  it("returns null when the binding is absent", () => {
    expect(parseBucketName("[vars]\n", R2_BINDING)).toBeNull();
    expect(parseBucketName(FIXTURE_TOML, "NO_SUCH_BINDING")).toBeNull();
  });
});

describe("resolvePreflightInput", () => {
  it("resolves production defaults from wrangler.toml", () => {
    expect(resolvePreflightInput({ env: {}, tomlText: FIXTURE_TOML })).toEqual({
      enabled: true,
      bucket: "routeware-csv-snapshots",
    });
  });

  it("lets the environment override toml (dashboard-Variable semantics)", () => {
    expect(
      resolvePreflightInput({
        env: { [R2_ENABLED_KEY]: "false" },
        tomlText: FIXTURE_TOML,
      })
    ).toEqual({ enabled: false, bucket: "routeware-csv-snapshots" });
    expect(
      resolvePreflightInput({
        env: { SNAPSHOTS_BUCKET: "custom-bucket" },
        tomlText: FIXTURE_TOML,
      })
    ).toEqual({ enabled: true, bucket: "custom-bucket" });
  });
});

describe("preflight messages", () => {
  it("skip names the flag", () => {
    expect(formatSkipLog()).toContain(`${R2_ENABLED_KEY}=false`);
  });

  it("pass names the bucket", () => {
    expect(formatPassLog("routeware-csv-snapshots")).toContain("routeware-csv-snapshots");
  });

  it("missing-bucket error is fail-closed with the exact fix", () => {
    const msg = formatMissingBucketError("routeware-csv-snapshots");
    expect(msg).toContain(`${CHECK_NAME}: FAIL`);
    expect(msg).toContain("routeware-csv-snapshots");
    expect(msg).toContain("npx wrangler r2 bucket create routeware-csv-snapshots");
    expect(msg).toContain(R2_BINDING);
  });

  it("unconfigured-binding error names the fix or the opt-out", () => {
    const msg = formatNoBucketConfiguredError();
    expect(msg).toContain(R2_BINDING);
    expect(msg).toContain(`${R2_ENABLED_KEY}="false"`);
  });
});
