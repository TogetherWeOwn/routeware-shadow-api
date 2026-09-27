import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  compareAppliedState,
  formatDriftReport,
  hashContent,
  parseManifest,
  parseWranglerExecuteJson,
  renderManifest,
  verifyFileHashes,
} from "../scripts/lib/d1DriftCheck.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("d1 drift check", () => {
  it("hashes content deterministically", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("hello\n"));
    expect(hashContent("")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips a sha256sum manifest, ignoring comments and blanks", () => {
    const text = `# checked-in manifest\n\n${SHA_A}  0001_a.sql\n${SHA_B}  0002_b.sql\n`;
    const entries = parseManifest(text);
    expect(entries).toEqual([
      { name: "0001_a.sql", sha: SHA_A },
      { name: "0002_b.sql", sha: SHA_B },
    ]);
    expect(parseManifest(renderManifest([...entries].reverse()))).toEqual(entries);
  });

  it("rejects malformed manifest lines", () => {
    expect(() => parseManifest("not-a-hash  0001.sql")).toThrow(`${CHECK_NAME}: malformed manifest line`);
  });

  it("detects edited, missing, and extra migration files", () => {
    const manifest = [
      { name: "0001.sql", sha: SHA_A },
      { name: "0002.sql", sha: SHA_B },
    ];
    expect(verifyFileHashes(manifest, manifest).ok).toBe(true);
    const edited = verifyFileHashes(
      [
        { name: "0001.sql", sha: SHA_B },
        { name: "0002.sql", sha: SHA_B },
      ],
      manifest
    );
    expect(edited.ok).toBe(false);
    expect(edited.mismatched).toEqual(["0001.sql"]);
    const missing = verifyFileHashes([{ name: "0001.sql", sha: SHA_A }], manifest);
    expect(missing.missing).toEqual(["0002.sql"]);
    const extra = verifyFileHashes([...manifest, { name: "0003.sql", sha: SHA_A }], manifest);
    expect(extra.extra).toEqual(["0003.sql"]);
  });

  it("compares file lists against journal rows both ways", () => {
    expect(compareAppliedState(["a.sql"], ["a.sql"]).ok).toBe(true);
    const pending = compareAppliedState(["a.sql", "b.sql"], ["a.sql"]);
    expect(pending.ok).toBe(false);
    expect(pending.unapplied).toEqual(["b.sql"]);
    expect(pending.orphaned).toEqual([]);
    const orphaned = compareAppliedState(["a.sql"], ["a.sql", "gone.sql"]);
    expect(orphaned.ok).toBe(false);
    expect(orphaned.orphaned).toEqual(["gone.sql"]);
  });

  it("parses wrangler execute JSON into journal names", () => {
    const stdout = JSON.stringify([{ results: [{ name: "0001.sql" }, { name: "0002.sql" }], success: true }]);
    expect(parseWranglerExecuteJson(stdout)).toEqual(["0001.sql", "0002.sql"]);
    expect(() => parseWranglerExecuteJson("not json")).toThrow(`${CHECK_NAME}: wrangler output is not JSON`);
    expect(() => parseWranglerExecuteJson(JSON.stringify([{ results: [{ no: "name" }] }]))).toThrow(
      `${CHECK_NAME}: journal row without a name`
    );
  });

  it("formats a human drift report naming every file", () => {
    const lines = formatDriftReport({
      hashCheck: { ok: false, missing: ["m.sql"], extra: ["e.sql"], mismatched: ["x.sql"] },
      stateCheck: { ok: false, unapplied: ["u.sql"], orphaned: ["o.sql"] },
    });
    expect(lines.join("\n")).toContain("x.sql");
    expect(lines.join("\n")).toContain("u.sql");
    expect(lines.join("\n")).toContain("o.sql");
    expect(formatDriftReport({ hashCheck: null, stateCheck: null })).toEqual([]);
  });
});
