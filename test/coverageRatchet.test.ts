import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  compareRatchet,
  formatRatchetReport,
  parseSummary,
  parseThresholds,
  raisedFloors,
  renderThresholdsBlock,
  runRatchet,
} from "../scripts/lib/coverageRatchet.mjs";

const CONFIG = `
    coverage: {
      thresholds: {
        statements: 87,
        branches: 81,
        functions: 91,
        lines: 87
      }
    }
`;

function summaryJson(pcts: Record<string, number>): string {
  const total: Record<string, { total: number; covered: number; skipped: number; pct: number }> = {};
  for (const [metric, pct] of Object.entries(pcts)) {
    total[metric] = { total: 100, covered: pct, skipped: 0, pct };
  }
  return JSON.stringify({ total });
}

const AT_FLOOR = {
  statements: { pct: 87.4, covered: 874, total: 1000 },
  branches: { pct: 81.9, covered: 819, total: 1000 },
  functions: { pct: 91.0, covered: 910, total: 1000 },
  lines: { pct: 87.99, covered: 879, total: 1000 },
};

describe("coverage ratchet", () => {
  it("parses integer floors from vitest config source", () => {
    expect(parseThresholds(CONFIG)).toEqual({ statements: 87, branches: 81, functions: 91, lines: 87 });
  });

  it("rejects config without a complete thresholds block", () => {
    expect(() => parseThresholds("export default {}")).toThrow(`${CHECK_NAME}: no thresholds block`);
    expect(() => parseThresholds("thresholds: { statements: 87 }")).toThrow(
      `${CHECK_NAME}: thresholds block missing branches`
    );
  });

  it("parses measured percentages from a coverage summary", () => {
    const measured = parseSummary(JSON.parse(summaryJson({ statements: 88.2, branches: 81, functions: 91, lines: 87 }))) as {
      statements: { pct: number };
    };
    expect(measured.statements.pct).toBe(88.2);
    expect(() => parseSummary({})).toThrow(`${CHECK_NAME}: coverage summary has no total block`);
    expect(() => parseSummary({ total: { statements: { pct: 90 } } })).toThrow(
      `${CHECK_NAME}: coverage summary total.branches.pct is missing`
    );
  });

  it("passes when every measurement sits within a point above its floor", () => {
    const result = compareRatchet(AT_FLOOR, { statements: 87, branches: 81, functions: 91, lines: 87 });
    expect(result.ok).toBe(true);
    expect(result.stale).toEqual([]);
    expect(result.regressed).toEqual([]);
  });

  it("demands a raise only once the measurement crosses the next integer", () => {
    const floors = { statements: 87, branches: 81, functions: 91, lines: 87 };
    const justUnder = compareRatchet({ ...AT_FLOOR, statements: { pct: 87.99 } }, floors);
    expect(justUnder.ok).toBe(true);
    const crossed = compareRatchet({ ...AT_FLOOR, statements: { pct: 88.0 } }, floors);
    expect(crossed.ok).toBe(false);
    expect(crossed.stale).toEqual([{ metric: "statements", floor: 87, measured: 88.0, suggested: 88 }]);
  });

  it("reports below-floor measurements as regressions, never as lowers", () => {
    const result = compareRatchet(
      { ...AT_FLOOR, branches: { pct: 80.5 } },
      { statements: 87, branches: 81, functions: 91, lines: 87 }
    );
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([]);
    expect(result.regressed).toEqual([{ metric: "branches", floor: 81, measured: 80.5 }]);
  });

  it("renders a paste-ready thresholds block with the raised floors", () => {
    const floors = { statements: 87, branches: 81, functions: 91, lines: 87 };
    const stale = [
      { metric: "statements", floor: 87, measured: 88.3, suggested: 88 },
      { metric: "lines", floor: 87, measured: 89.1, suggested: 89 },
    ];
    const next = raisedFloors(floors, stale);
    expect(next).toEqual({ statements: 88, branches: 81, functions: 91, lines: 89 });
    const block = renderThresholdsBlock(next);
    expect(block).toContain("statements: 88,");
    expect(block).toContain("branches: 81,");
    // Round-trips through the parser: the suggestion is directly applicable.
    expect(parseThresholds(block)).toEqual(next);
    const lines = formatRatchetReport({ ok: false, stale, regressed: [] }, floors);
    expect(lines.join("\n")).toContain(block);
  });

  it("runs end to end over config source plus summary text", () => {
    const ok = runRatchet(CONFIG, summaryJson({ statements: 87.4, branches: 81.2, functions: 91, lines: 87 }));
    expect(ok.ok).toBe(true);
    const stale = runRatchet(CONFIG, summaryJson({ statements: 88.3, branches: 81.2, functions: 91, lines: 87 }));
    expect(stale.ok).toBe(false);
    expect(stale.lines.join("\n")).toContain("statements: measured 88.3% implies floor 88");
    expect(() => runRatchet(CONFIG, "not json")).toThrow(`${CHECK_NAME}: coverage summary is not valid JSON`);
  });
});
