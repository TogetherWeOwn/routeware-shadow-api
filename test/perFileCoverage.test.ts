import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  comparePerFile,
  formatPerFileReport,
  normalizePath,
  parseAllowlist,
  parseFileEntries,
  runPerFileCheck,
} from "../scripts/lib/perFileCoverage.mjs";

const ALLOWLIST = JSON.stringify({
  files: [{ path: "src/lib/vendorLogin.ts", reason: "vendor SDK login, untestable in CI" }],
});

function summaryJson(files: Array<[string, number, number]>) {
  const summary: Record<string, unknown> = {
    total: { statements: { total: 100, covered: 50, skipped: 0, pct: 50 } },
  };
  for (const [file, covered, total] of files) {
    summary[`/repo/${file}`] = {
      statements: { total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 },
      branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
      functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
      lines: { total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 },
    };
  }
  return JSON.stringify(summary);
}

describe("per-file coverage gate", () => {
  it("normalizes absolute istanbul keys to repo-relative src paths", () => {
    expect(normalizePath("/home/runner/work/repo/repo/src/lib/foo.ts")).toBe("src/lib/foo.ts");
    expect(normalizePath("src/lib/foo.ts")).toBe("src/lib/foo.ts");
    expect(normalizePath("/other/location.ts")).toBeNull();
    expect(normalizePath("total")).toBeNull();
  });

  it("parses per-file statement counts and skips the total aggregate", () => {
    const entries = parseFileEntries(
      JSON.parse(summaryJson([["src/a.ts", 5, 10], ["src/b.ts", 0, 8]])),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: "src/a.ts", covered: 5, total: 10 });
    expect(() => parseFileEntries({})).not.toThrow();
    expect(() => parseFileEntries(null)).toThrow(`${CHECK_NAME}: coverage summary is not an object`);
    expect(() => parseFileEntries({ "src/a.ts": {} })).toThrow(
      `${CHECK_NAME}: src/a.ts has no statements covered/total counts`,
    );
  });

  it("parses the allowlist and rejects malformed entries", () => {
    expect(parseAllowlist(ALLOWLIST)).toEqual([
      { path: "src/lib/vendorLogin.ts", reason: "vendor SDK login, untestable in CI" },
    ]);
    expect(() => parseAllowlist("not json")).toThrow(`${CHECK_NAME}: allowlist is not valid JSON`);
    expect(() => parseAllowlist("{}")).toThrow(`${CHECK_NAME}: allowlist needs a "files" array`);
    expect(() => parseAllowlist(JSON.stringify({ files: [{ path: "lib/x.ts", reason: "r" }] }))).toThrow(
      `${CHECK_NAME}: allowlist entry 0 needs a "src/..." path`,
    );
    expect(() =>
      parseAllowlist(JSON.stringify({ files: [{ path: "src/x.ts", reason: "  " }] })),
    ).toThrow(`${CHECK_NAME}: allowlist entry for src/x.ts needs a non-empty reason`);
  });

  it("passes when every file has coverage or is allowlisted", () => {
    const entries = parseFileEntries(
      JSON.parse(
        summaryJson([
          ["src/a.ts", 5, 10],
          ["src/lib/vendorLogin.ts", 0, 88],
        ]),
      ),
    );
    const result = comparePerFile(entries, parseAllowlist(ALLOWLIST));
    expect(result.ok).toBe(true);
    expect(result.untested).toEqual([]);
  });

  it("fails on a new uncovered file the allowlist does not name", () => {
    const entries = parseFileEntries(
      JSON.parse(summaryJson([["src/lib/brandNew.ts", 0, 40]])),
    );
    const result = comparePerFile(entries, parseAllowlist(ALLOWLIST));
    expect(result.ok).toBe(false);
    expect(result.untested.map((e: { path: string }) => e.path)).toEqual(["src/lib/brandNew.ts"]);
    const lines = formatPerFileReport(result);
    expect(lines.join("\n")).toContain("src/lib/brandNew.ts: 0/40 statements covered");
  });

  it("lets empty files through and flags graduated and stale allowlist entries", () => {
    const entries = parseFileEntries(
      JSON.parse(
        summaryJson([
          ["src/empty.ts", 0, 0],
          ["src/lib/vendorLogin.ts", 3, 88],
        ]),
      ),
    );
    const result = comparePerFile(entries, [
      { path: "src/lib/vendorLogin.ts", reason: "was untested" },
      { path: "src/lib/deleted.ts", reason: "renamed away" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.untested).toEqual([]);
    expect(result.graduated.map((e: { path: string }) => e.path)).toEqual(["src/lib/vendorLogin.ts"]);
    expect(result.stale.map((e: { path: string }) => e.path)).toEqual(["src/lib/deleted.ts"]);
  });

  it("runs end to end over summary plus allowlist text", () => {
    const ok = runPerFileCheck(summaryJson([["src/a.ts", 1, 10]]), JSON.stringify({ files: [] }));
    expect(ok.ok).toBe(true);
    const bad = runPerFileCheck(summaryJson([["src/lib/brandNew.ts", 0, 40]]), JSON.stringify({ files: [] }));
    expect(bad.ok).toBe(false);
    expect(bad.lines.join("\n")).toContain("src/lib/brandNew.ts");
    expect(() => runPerFileCheck("not json", ALLOWLIST)).toThrow(
      `${CHECK_NAME}: coverage summary is not valid JSON`,
    );
  });
});
