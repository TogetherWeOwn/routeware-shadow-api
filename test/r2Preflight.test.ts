import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  R2_BINDING,
  R2_ENABLED_KEY,
  formatLookupFailure,
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

  it("does not inherit a disabled flag from a named environment when [vars] is absent", () => {
    const tomlText = '[env.test.vars]\nSNAPSHOTS_R2_ENABLED = "false"\n';
    expect(parseVarsValue(tomlText, R2_ENABLED_KEY)).toBeNull();
    expect(resolvePreflightInput({ tomlText })).toEqual({ enabled: true, bucket: null });
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
    expect(resolvePreflightInput({ tomlText: FIXTURE_TOML })).toEqual({
      enabled: true,
      bucket: "routeware-csv-snapshots",
    });
  });

  it("ignores shell overrides that Wrangler does not deploy", () => {
    const input = {
      env: { [R2_ENABLED_KEY]: "false", SNAPSHOTS_BUCKET: "custom-bucket" },
      tomlText: FIXTURE_TOML,
    };
    expect(resolvePreflightInput(input)).toEqual({
      enabled: true,
      bucket: "routeware-csv-snapshots",
    });
  });

  it("skips only when the deployed config disables R2", () => {
    expect(resolvePreflightInput({
      tomlText: FIXTURE_TOML.replace(`${R2_ENABLED_KEY} = "true"`, `${R2_ENABLED_KEY} = "false"`),
    })).toEqual({ enabled: false, bucket: "routeware-csv-snapshots" });
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

  it("preserves a confirmed missing-bucket diagnostic and its create fix", () => {
    const msg = formatLookupFailure("snapshots", {
      status: 1, stderr: "\u001b[31mThe specified bucket does not exist. [code: 10006]\u001b[0m",
    });
    expect(msg).toContain("npx wrangler r2 bucket create snapshots");
    expect(msg).toContain("The specified bucket does not exist. [code: 10006]");
  });

  it.each([
    "CLOUDFLARE_API_TOKEN must be set in a non-interactive environment.",
    "Authentication error [code: 10000]",
    "Access denied [code: 10003]",
    "fetch failed: getaddrinfo ENOTFOUND api.cloudflare.com",
    "Unrecognized error",
    "Bucket not found, but without a confirmed API code",
    "Unknown failure [code: 100060]",
  ])("does not recommend creating a bucket for lookup failure: %s", (stderr) => {
    const msg = formatLookupFailure("snapshots", { status: 1, stderr });
    expect(msg).toContain(`${CHECK_NAME}: FAIL`);
    expect(msg).toContain("could not be verified");
    expect(msg).toContain(stderr);
    expect(msg).not.toContain("bucket create");
    expect(msg).not.toContain("not found in the configured account");
  });

  it.each([
    { code: "ENOENT" },
    { code: "ETIMEDOUT", signal: "SIGTERM" },
    { signal: "SIGKILL" },
    { status: 1 },
    {},
  ])("fails closed on process errors without stderr: %j", (error) => {
    const msg = formatLookupFailure("snapshots", error);
    expect(msg).toContain(`${CHECK_NAME}: FAIL`);
    expect(msg).toContain("Wrangler exited without diagnostics");
    expect(msg).toContain(error.code || error.signal || String(error.status || "unknown error"));
    expect(msg).not.toContain("bucket create");
  });

  it("does not classify a code on stdout or an interrupted lookup as not-found", () => {
    for (const error of [
      { status: 1, stdout: "[code: 10006]" },
      { code: "ETIMEDOUT", signal: "SIGTERM", stderr: "[code: 10006]" },
    ]) {
      expect(formatLookupFailure("snapshots", error)).not.toContain("bucket create");
    }
  });

  it("redacts supplied credentials from stderr and stdout diagnostics", () => {
    const secret = "fixture-secret-not-a-real-credential";
    for (const error of [{ stderr: `Invalid token: ${secret}` }, { stdout: `Invalid token: ${secret}` }]) {
      const msg = formatLookupFailure("snapshots", error, [secret]);
      expect(msg).toContain("Invalid token: [REDACTED]");
      expect(msg).not.toContain(secret);
    }
  });

  it("unconfigured-binding error names the fix or the opt-out", () => {
    const msg = formatNoBucketConfiguredError();
    expect(msg).toContain(R2_BINDING);
    expect(msg).toContain(`${R2_ENABLED_KEY}="false"`);
  });
});
