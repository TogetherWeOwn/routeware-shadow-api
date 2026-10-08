import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  DEFAULT_LIMIT,
  EXEMPT_PATHS,
  countLines,
  findOversize,
  formatFailureLog,
  formatPassLog,
  isExempt,
} from "../scripts/lib/sourceFileSize.mjs";

/** A repo-relative entry with exactly `lines` wc-style lines. */
function entry(path: string, lines: number) {
  return { path, text: Array(lines).fill("x").join("\n") + "\n" };
}

describe("source-file-size guard", () => {
  it("pins the 800-line limit and the single generated-file exemption", () => {
    expect(DEFAULT_LIMIT).toBe(800);
    expect(EXEMPT_PATHS).toEqual(["src/worker-configuration.d.ts"]);
  });

  it("counts lines wc-style: trailing newline does not add a line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("x")).toBe(1);
    expect(countLines("x\n")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  it("exempts only the generated worker-configuration.d.ts", () => {
    expect(isExempt("src/worker-configuration.d.ts")).toBe(true);
    expect(isExempt("src/app.ts")).toBe(false);
    expect(isExempt("src/lib/dataEntityHandlers.ts")).toBe(false);
  });

  it("passes at exactly the limit and fails one line over", () => {
    expect(findOversize([entry("src/a.ts", 800)], {})).toEqual([]);
    expect(findOversize([entry("src/a.ts", 801)], {})).toEqual([
      { path: "src/a.ts", lines: 801 },
    ]);
  });

  it("skips the exempt path regardless of size and sorts offenders by path", () => {
    const offenders = findOversize(
      [
        entry("src/worker-configuration.d.ts", 5000),
        entry("src/z.ts", 900),
        entry("src/a.ts", 801),
        entry("src/ok.ts", 100),
      ],
      {},
    );
    expect(offenders.map((o: { path: string }) => o.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("honors a custom limit override", () => {
    expect(findOversize([entry("src/a.ts", 11)], { limit: 10 })).toHaveLength(1);
    expect(findOversize([entry("src/a.ts", 10)], { limit: 10 })).toEqual([]);
  });

  it("formats pass and failure logs naming the check and the offenders", () => {
    expect(formatPassLog(51, 800)).toContain(`${CHECK_NAME}: PASS`);
    const log = formatFailureLog([{ path: "src/a.ts", lines: 801 }], 800);
    expect(log).toContain(`${CHECK_NAME}: FAIL`);
    expect(log).toContain("src/a.ts (801 lines)");
  });
});
