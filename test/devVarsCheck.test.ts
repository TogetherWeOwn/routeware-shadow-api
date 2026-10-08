import { describe, expect, it } from "vitest";
import { resolveChainedBase } from "../src/scheduled";
import {
  checkDevVarsValues,
  isValidChainedBase,
  isValidReportQueryDate,
  mergeEffectiveVars,
  parseDevVarsText,
  parseWranglerVarsSection
} from "../scripts/lib/devVarsCheck.mjs";

/**
 * Regression tests for TOG-6538: the old checker split each `.dev.vars` line
 * on the first `=` and validated the raw text, while `wrangler dev` applies
 * dotenv semantics (export prefix, quote stripping, unquoted `#` comments).
 * Values also went unchecked (`SESSION_TTL_SECONDS` arrived quoted → NaN
 * expiry crash in `sessionExpiryMs`; a comment-polluted token never matches
 * the constant-time compare in `src/lib/auth.ts` → 401).
 *
 * All fixture secrets below are obvious placeholders, never real credentials
 * (CONVENTIONS.md sections 4-5). Findings name keys only, never values.
 */

// Placeholder-shaped effective vars; SESSION_TTL_SECONDS / TARGET_ORIGIN /
// LOGIN_URL mirror the wrangler.toml [vars] defaults under test.
function validEffective(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    LOGIN_USERNAME: "placeholder-user",
    LOGIN_PASSWORD: "placeholder-pass",
    SESSION_TTL_SECONDS: "1800",
    TARGET_ORIGIN: "https://placeholder.example",
    LOGIN_URL: "https://placeholder.example/Account/Login",
    SHADOW_API_TOKEN: "placeholder-token",
    ...overrides
  };
}

describe("parseDevVarsText (dotenv parity — TOG-6538)", () => {
  it("strips surrounding single, double and backtick quotes", () => {
    const parsed = parseDevVarsText(
      "A='quoted'\nB=\"double\"\nC=`back`\nD=bare\n"
    );
    expect(parsed).toMatchObject({ A: "quoted", B: "double", C: "back", D: "bare" });
  });

  it("strips an `export` prefix and spaces around `=`", () => {
    const parsed = parseDevVarsText("export LOGIN_USERNAME = spaced-user\n");
    expect(parsed.LOGIN_USERNAME).toBe("spaced-user");
  });

  it("strips unquoted trailing `#` comments but keeps `#` inside quotes", () => {
    const parsed = parseDevVarsText(
      "A=value # trailing comment\nB=\"keep#hash\"\nC='also#kept'\n"
    );
    expect(parsed).toMatchObject({ A: "value", B: "keep#hash", C: "also#kept" });
  });

  it("treats a quoted-empty value as empty (old checker saw two quote chars)", () => {
    expect(parseDevVarsText("SHADOW_API_TOKEN=\"\"\n").SHADOW_API_TOKEN).toBe("");
  });

  it("lets later entries win on duplicate keys, like dotenv", () => {
    expect(parseDevVarsText("A=first\nA=second\n").A).toBe("second");
  });

  it("ignores comment, blank and keyless lines exactly as dotenv does", () => {
    const parsed = parseDevVarsText("# full comment\n\nno-equals-here\nA=1\n");
    expect(parsed).toEqual({ A: "1" });
  });

  it("handles CRLF content without leaking `\\r` into values", () => {
    expect(parseDevVarsText("A=value\r\nB=other\r\n")).toMatchObject({
      A: "value",
      B: "other"
    });
  });
});

describe("checkDevVarsValues (full required env — TOG-6538)", () => {
  it("accepts a complete effective vars set", () => {
    expect(checkDevVarsValues(validEffective()).ok).toBe(true);
  });

  it("accepts SESSION_TTL_SECONDS that arrives quoted in the file (effective value is bare)", () => {
    const dev = parseDevVarsText('SESSION_TTL_SECONDS="1800"\n');
    expect(dev.SESSION_TTL_SECONDS).toBe("1800");
    expect(checkDevVarsValues(validEffective(dev)).ok).toBe(true);
  });

  it("fails precisely on a quoted-non-numeric TTL (the old checker passed it, then sessionExpiryMs threw)", () => {
    const result = checkDevVarsValues(validEffective({ SESSION_TTL_SECONDS: '"soon"' }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("SESSION_TTL_SECONDS"))).toBe(true);
  });

  it("fails precisely when SESSION_TTL_SECONDS is missing (wrangler has no default to fall back on)", () => {
    const rest = validEffective();
    delete rest.SESSION_TTL_SECONDS;
    const result = checkDevVarsValues(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("SESSION_TTL_SECONDS"))).toBe(true);
  });

  it("fails precisely when TARGET_ORIGIN or LOGIN_URL is missing", () => {
    const noOrigin = validEffective();
    delete noOrigin.TARGET_ORIGIN;
    expect(checkDevVarsValues(noOrigin).errors.some((e) => e.includes("TARGET_ORIGIN"))).toBe(
      true
    );
    const noLoginUrl = validEffective();
    delete noLoginUrl.LOGIN_URL;
    expect(checkDevVarsValues(noLoginUrl).errors.some((e) => e.includes("LOGIN_URL"))).toBe(true);
  });

  it("rejects an unparseable TARGET_ORIGIN or LOGIN_URL (old checker never looked)", () => {
    const result = checkDevVarsValues(validEffective({ TARGET_ORIGIN: "not a url" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("TARGET_ORIGIN"))).toBe(true);
  });

  it("rejects an unknown AUTH_MODE instead of letting it silently fall back to browser login", () => {
    const result = checkDevVarsValues(validEffective({ AUTH_MODE: "magic" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("AUTH_MODE"))).toBe(true);
  });

  it("accepts every documented AUTH_MODE (case-insensitive) and an absent one (wrangler default)", () => {
    for (const mode of ["auto", "http", "browser", "AUTO"]) {
      expect(checkDevVarsValues(validEffective({ AUTH_MODE: mode })).ok).toBe(true);
    }
    const rest = validEffective({ AUTH_MODE: "auto" });
    delete rest.AUTH_MODE;
    expect(checkDevVarsValues(rest).ok).toBe(true);
  });

  it("still requires a non-empty client token and names both candidate keys", () => {
    const bare: Record<string, string> = { ...validEffective() };
    delete bare.SHADOW_API_TOKEN;
    const result = checkDevVarsValues(bare);
    expect(result.ok).toBe(false);
    const tokenError = result.errors.find((e) => e.includes("SHADOW_API_TOKEN"));
    expect(tokenError).toBeDefined();
    expect(tokenError).toContain("CUSTOMER_SNAPSHOT_SYNC_SECRET");
  });

  it("accepts the sync-secret fallback as the client token", () => {
    const bare: Record<string, string> = { ...validEffective() };
    delete bare.SHADOW_API_TOKEN;
    expect(
      checkDevVarsValues({ ...bare, CUSTOMER_SNAPSHOT_SYNC_SECRET: "placeholder-sync" }).ok
    ).toBe(true);
  });

  it("rejects a comment-only token (dotenv yields an empty value, the gate 401s)", () => {
    const dev = parseDevVarsText("SHADOW_API_TOKEN= # TODO fill in\n");
    expect(dev.SHADOW_API_TOKEN).toBe("");
    const bare: Record<string, string> = { ...validEffective() };
    delete bare.SHADOW_API_TOKEN;
    expect(checkDevVarsValues({ ...bare, ...dev }).ok).toBe(false);
  });

  it("requires LOGIN_USERNAME and LOGIN_PASSWORD by name", () => {
    const rest = validEffective();
    delete rest.LOGIN_USERNAME;
    delete rest.LOGIN_PASSWORD;
    const result = checkDevVarsValues(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("LOGIN_USERNAME"))).toBe(true);
    expect(result.errors.some((e) => e.includes("LOGIN_PASSWORD"))).toBe(true);
  });

  describe("operational key families (TOG-9212, gap O2)", () => {
    it("fails fast on a bogus REPORT_QUERY_START_DATE (acceptance: before any sync)", () => {
      const result = checkDevVarsValues(validEffective({ REPORT_QUERY_START_DATE: "bogus" }));
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("REPORT_QUERY_START_DATE"))).toBe(true);
    });

    it("rejects malformed and impossible REPORT_QUERY_* dates but accepts real ones", () => {
      for (const bad of ["2026-13-01", "2026-02-30", "2026-02-29", "06/01/2026", "20260601"]) {
        const result = checkDevVarsValues(validEffective({ REPORT_QUERY_END_DATE: bad }));
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes("REPORT_QUERY_END_DATE"))).toBe(true);
      }
      // Leap-year Feb 29 is a real calendar date.
      expect(
        checkDevVarsValues(
          validEffective({
            REPORT_QUERY_START_DATE: "2024-02-29",
            REPORT_QUERY_END_DATE: "2024-03-01"
          })
        ).ok
      ).toBe(true);
      expect(
        checkDevVarsValues(
          validEffective({
            REPORT_QUERY_START_DATE: "1900-01-01",
            REPORT_QUERY_END_DATE: "1900-01-01"
          })
        ).ok
      ).toBe(true);
    });

    it("rejects START_DATE after END_DATE", () => {
      const result = checkDevVarsValues(
        validEffective({
          REPORT_QUERY_START_DATE: "2026-06-10",
          REPORT_QUERY_END_DATE: "2026-06-01"
        })
      );
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes("REPORT_QUERY_START_DATE") && e.includes("REPORT_QUERY_END_DATE")
        )
      ).toBe(true);
    });

    it("treats absent or empty REPORT_QUERY_* dates as unset (runtime placeholder fallback)", () => {
      const missing = validEffective();
      delete missing.REPORT_QUERY_START_DATE;
      delete missing.REPORT_QUERY_END_DATE;
      expect(checkDevVarsValues(missing).ok).toBe(true);
      expect(
        checkDevVarsValues(
          validEffective({ REPORT_QUERY_START_DATE: "", REPORT_QUERY_END_DATE: "   " })
        ).ok
      ).toBe(true);
    });

    it("rejects non-numeric *_REPORT_QUERY_ID values but allows unset ones (EXPORT_PATH alternative)", () => {
      for (const key of [
        "CUSTOMER_REPORT_QUERY_ID",
        "ADDRESS_REPORT_QUERY_ID",
        "CONTAINER_REPORT_QUERY_ID"
      ]) {
        const result = checkDevVarsValues(validEffective({ [key]: "abc" }));
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes(key))).toBe(true);
      }
      expect(checkDevVarsValues(validEffective({ CUSTOMER_REPORT_QUERY_ID: "23" })).ok).toBe(
        true
      );
      const unset = validEffective();
      delete unset.CUSTOMER_REPORT_QUERY_ID;
      delete unset.ADDRESS_REPORT_QUERY_ID;
      delete unset.CONTAINER_REPORT_QUERY_ID;
      expect(checkDevVarsValues(unset).ok).toBe(true);
      expect(
        checkDevVarsValues(validEffective({ CUSTOMER_REPORT_QUERY_ID: "  " })).ok
      ).toBe(true);
    });

    it("rejects non-positive REPORT_QUERY_POLL_* overrides but allows unset ones (compiled defaults)", () => {
      for (const key of ["REPORT_QUERY_POLL_INTERVAL_MS", "REPORT_QUERY_POLL_MAX_ATTEMPTS"]) {
        for (const bad of ["soon", "0", "-5"]) {
          const result = checkDevVarsValues(validEffective({ [key]: bad }));
          expect(result.ok).toBe(false);
          expect(result.errors.some((e) => e.includes(key))).toBe(true);
        }
      }
      expect(
        checkDevVarsValues(
          validEffective({
            REPORT_QUERY_POLL_INTERVAL_MS: "2500",
            REPORT_QUERY_POLL_MAX_ATTEMPTS: "24"
          })
        ).ok
      ).toBe(true);
      const unset = validEffective({
        REPORT_QUERY_POLL_INTERVAL_MS: "",
        REPORT_QUERY_POLL_MAX_ATTEMPTS: ""
      });
      delete unset.REPORT_QUERY_POLL_INTERVAL_MS;
      delete unset.REPORT_QUERY_POLL_MAX_ATTEMPTS;
      expect(checkDevVarsValues(unset).ok).toBe(true);
    });

    it("rejects a malformed SHADOW_API_PUBLIC_BASE but allows empty/absent (single-invocation fallback)", () => {
      for (const bad of [
        "not a url",
        "ftp://api.example.test",
        "https://api.example.test/worker",
        "https://api.example.test?x=1",
        "https://api.example.test#frag",
        "https://user:pass@api.example.test"
      ]) {
        const result = checkDevVarsValues(validEffective({ SHADOW_API_PUBLIC_BASE: bad }));
        expect(result.ok).toBe(false);
        expect(result.errors.some((e) => e.includes("SHADOW_API_PUBLIC_BASE"))).toBe(true);
      }
      expect(
        checkDevVarsValues(validEffective({ SHADOW_API_PUBLIC_BASE: "https://api.example.test" }))
          .ok
      ).toBe(true);
      expect(checkDevVarsValues(validEffective({ SHADOW_API_PUBLIC_BASE: "" })).ok).toBe(true);
      const unset = validEffective();
      delete unset.SHADOW_API_PUBLIC_BASE;
      expect(checkDevVarsValues(unset).ok).toBe(true);
    });

    it("isValidReportQueryDate rejects impossible dates without echoing the value", () => {
      expect(isValidReportQueryDate("bogus")).toBe(false);
      expect(isValidReportQueryDate("2026-13-40")).toBe(false);
      expect(isValidReportQueryDate("2026-02-29")).toBe(false);
      expect(isValidReportQueryDate("2024-02-29")).toBe(true);
      expect(isValidReportQueryDate("1900-01-01")).toBe(true);
    });

    it.each([
      ["https://api.example.test?", false],
      ["https://api.example.test/?", false],
      ["https://api.example.test#", false],
      ["https://api.example.test/#", false],
      ["https://api.example.test?#", false],
      ["https://api.example.test/?#", false],
      ["https://api.example.test#?", false],
      ["https://api.example.test/#?", false],
      ["  https://api.example.test/?  ", false],
      ["  https://api.example.test/#  ", false],
      ["https://api.example.test?x=1", false],
      ["https://api.example.test#frag", false],
      ["ftp://api.example.test", false],
      ["https://api.example.test/worker", false],
      ["https://user:pass@api.example.test", false],
      ["not a url", false],
      ["", false],
      ["   ", false],
      ["https://api.example.test", true],
      ["https://api.example.test/", true],
      ["http://api.example.test", true],
      ["http://api.example.test/", true],
      ["http://localhost:8787", true],
      ["  https://api.example.test/  ", true]
    ] as const)("isValidChainedBase mirrors the runtime for %s", (raw, accepted) => {
      expect(isValidChainedBase(raw)).toBe(accepted);
      expect(resolveChainedBase(raw) !== null).toBe(accepted);

      const result = checkDevVarsValues(validEffective({ SHADOW_API_PUBLIC_BASE: raw }));
      // Empty configuration remains valid: it selects single-invocation fallback.
      expect(result.ok).toBe(accepted || !raw.trim());
      if (!accepted && raw.trim()) {
        expect(result.errors.some((error) => error.includes("SHADOW_API_PUBLIC_BASE"))).toBe(true);
        expect(result.errors.join("\n")).not.toContain(raw);
      }
    });

    it("never echoes operational values in findings (keys only)", () => {
      const result = checkDevVarsValues(
        validEffective({
          REPORT_QUERY_START_DATE: "not-a-real-date-value",
          SHADOW_API_PUBLIC_BASE: "https://bad.example.test/worker"
        })
      );
      expect(result.ok).toBe(false);
      for (const error of result.errors) {
        expect(error).not.toContain("not-a-real-date-value");
        expect(error).not.toContain("https://bad.example.test/worker");
      }
    });
  });

  it("never echoes values in findings (keys only)", () => {
    const secretValue = "placeholder-secret-value";
    const result = checkDevVarsValues(
      validEffective({ SHADOW_API_TOKEN: "   ", LOGIN_PASSWORD: secretValue })
    );
    expect(result.ok).toBe(false);
    for (const error of result.errors) {
      expect(error).not.toContain(secretValue);
    }
  });
});

describe("wrangler [vars] overlay (TOG-6538)", () => {
  const TOML = [
    "[vars]",
    'TARGET_ORIGIN = "https://placeholder.example"',
    "SESSION_TTL_SECONDS = 1800",
    "AUTH_MODE = \"auto\"",
    "",
    "[env.test.vars]",
    'TARGET_ORIGIN = "https://other.example"',
    ""
  ].join("\n");

  it("reads the top-level [vars] section with quoted, bare-number and single-quoted values", () => {
    expect(parseWranglerVarsSection(TOML)).toMatchObject({
      TARGET_ORIGIN: "https://placeholder.example",
      SESSION_TTL_SECONDS: "1800",
      AUTH_MODE: "auto"
    });
  });

  it("strips TOML trailing comments on quoted and bare values", () => {
    const toml = [
      "[vars]",
      'TARGET_ORIGIN = "https://placeholder.example" # the tenant',
      "SESSION_TTL_SECONDS = 1800 # seconds",
      "FLAG_BARE = true#nospace-stays-invalid-but-kept",
      ""
    ].join("\n");
    const parsed = parseWranglerVarsSection(toml);
    expect(parsed.TARGET_ORIGIN).toBe("https://placeholder.example");
    expect(parsed.SESSION_TTL_SECONDS).toBe("1800");
    expect(checkDevVarsValues(validEffective(parsed)).ok).toBe(true);
  });

  it("ignores [env.*.vars] sections (env-scoped, not plain `wrangler dev`)", () => {
    expect(parseWranglerVarsSection(TOML).TARGET_ORIGIN).toBe("https://placeholder.example");
  });

  it("lets .dev.vars override wrangler defaults", () => {
    const merged = mergeEffectiveVars(parseWranglerVarsSection(TOML), {
      TARGET_ORIGIN: "https://override.example"
    });
    expect(merged.TARGET_ORIGIN).toBe("https://override.example");
    expect(merged.SESSION_TTL_SECONDS).toBe("1800");
  });

  it("passes validation with LOGIN_* + token from .dev.vars and the rest from wrangler defaults", () => {
    const toml = [
      "[vars]",
      'TARGET_ORIGIN = "https://placeholder.example"',
      'LOGIN_URL = "https://placeholder.example/Account/Login"',
      "SESSION_TTL_SECONDS = 1800",
      'AUTH_MODE = "auto"',
      ""
    ].join("\n");
    const dev = parseDevVarsText(
      "LOGIN_USERNAME=placeholder-user\nLOGIN_PASSWORD=placeholder-pass\nSHADOW_API_TOKEN=placeholder-token\n"
    );
    expect(checkDevVarsValues(mergeEffectiveVars(parseWranglerVarsSection(toml), dev)).ok).toBe(
      true
    );
  });
});
