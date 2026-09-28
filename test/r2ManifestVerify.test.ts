import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  formatVerifyReport,
  parseManifest,
  sha256HexBytes,
  verifyManifestHashes,
} from "../scripts/lib/r2ManifestVerify.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

type ManifestFileMap = Record<
  string,
  { key: string; sha256: string; bytes: number }
>;

function manifestJson(files: ManifestFileMap) {
  return JSON.stringify({ version: 1, date: "2026-09-28", files });
}

describe("r2 manifest verify (pure)", () => {
  it("hashes bytes deterministically (sha256 vectors)", () => {
    expect(sha256HexBytes(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256HexBytes(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("parses a valid manifest and sorts entries", () => {
    const text = manifestJson({
      "customer.csv": { key: "snapshots/2026-9-28/customer.csv", sha256: SHA_A, bytes: 10 },
      "address.csv": { key: "snapshots/2026-9-28/address.csv", sha256: SHA_B, bytes: 20 },
    });
    const parsed = parseManifest(text, "snapshots/2026-09-28.manifest.json");
    expect(parsed.ok).toBe(true);
    // Optional chaining: a missing manifest fails the assertion at runtime,
    // which is the correct test outcome (the lib's return union is inferred
    // from untyped JS, so `ok` doesn't narrow).
    expect(parsed.manifest?.date).toBe("2026-09-28");
    expect(parsed.manifest?.files.map((f) => f.name)).toEqual(["address.csv", "customer.csv"]);
  });

  it("rejects non-JSON, wrong version, bad date, and malformed entries", () => {
    const key = "snapshots/2026-09-28.manifest.json";
    expect(parseManifest("not json{", key).ok).toBe(false);
    expect(parseManifest(manifestJson({}).replace('"version":1', '"version":2'), key).error).toMatch(
      /unsupported manifest version/
    );
    expect(parseManifest(JSON.stringify({ version: 1, date: "yesterday", files: {} }), key).error).toMatch(
      /date is not YYYY-MM-DD/
    );
    const badSha = manifestJson({ "customer.csv": { key: "k", sha256: "zzz", bytes: 1 } });
    expect(parseManifest(badSha, key).error).toMatch(/malformed sha256/);
    const badBytes = manifestJson({ "customer.csv": { key: "k", sha256: SHA_A, bytes: -1 } });
    expect(parseManifest(badBytes, key).error).toMatch(/malformed byte size/);
    expect(parseManifest(JSON.stringify({ version: 1, date: "2026-09-28", files: null }), key).error).toMatch(
      /files is not an object/
    );
  });

  it("passes when every entry matches", () => {
    const files = [{ name: "customer.csv", key: "k", sha256: SHA_A, bytes: 10 }];
    const result = verifyManifestHashes(files, [{ ...files[0] }]);
    expect(result).toEqual({ ok: true, passed: ["customer.csv"], mismatched: [], missing: [] });
  });

  it("names the file with both hashes on a one-byte tamper", () => {
    const files = [{ name: "customer.csv", key: "snapshots/2026-09-28/customer.csv", sha256: SHA_A, bytes: 10 }];
    const tampered = [{ name: "customer.csv", key: files[0].key, sha256: SHA_B, bytes: 11 }];
    const result = verifyManifestHashes(files, tampered);
    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([
      {
        name: "customer.csv",
        key: "snapshots/2026-09-28/customer.csv",
        expectedSha256: SHA_A,
        actualSha256: SHA_B,
        expectedBytes: 10,
        actualBytes: 11,
      },
    ]);
    const report = formatVerifyReport("snapshots/2026-09-28.manifest.json", result);
    expect(report).toMatch(`FAIL customer.csv (snapshots/2026-09-28/customer.csv): sha256 mismatch`);
    expect(report).toContain(SHA_A);
    expect(report).toContain(SHA_B);
    expect(report).toMatch(/0 passed, 1 mismatched, 0 missing/);
  });

  it("reports manifest entries that cannot be fetched as missing", () => {
    const files = [
      { name: "customer.csv", key: "k1", sha256: SHA_A, bytes: 1 },
      { name: "address.csv", key: "k2", sha256: SHA_B, bytes: 2 },
    ];
    const result = verifyManifestHashes(files, [{ ...files[0] }], ["address.csv"]);
    expect(result.ok).toBe(false);
    expect(result.passed).toEqual(["customer.csv"]);
    expect(result.missing).toEqual(["address.csv"]);
    expect(formatVerifyReport("m", result)).toMatch(/FAIL address\.csv: listed in manifest but not fetchable/);
  });

  it("check name is stable for the wrapper's log prefix", () => {
    expect(CHECK_NAME).toBe("r2-manifest");
  });
});
