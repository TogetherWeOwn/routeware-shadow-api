import { describe, expect, it } from "vitest";
import {
  formatVerifyReport,
  parseManifest,
  verifyManifestHashes,
} from "../scripts/lib/r2ManifestVerify.mjs";

/**
 * Independent daily-sidecar boundary tests. Fixtures use only the public v1
 * writer layout; no writer changes, R2, Wrangler, credentials or CSV data.
 * The companion scripts/verify-r2-manifest.acceptance.test.mjs exercises --expect,
 * machine results and zero-execution controls through the real CLI.
 *
 * Breaks caught: trusting a date-shaped string, accepting arbitrary object keys,
 * treating an empty/ambiguous comparison as proof, and matching hashes by name
 * while ignoring the actual object's identity.
 */
const DATE = "2026-09-28";
const MANIFEST_KEY = "snapshots/2026-09-28.manifest.json";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

type Entry = { name: string; key: string; sha256: string; bytes: number };

function entry(table = "customer", date = DATE): Entry {
  return {
    name: `${table}.csv`,
    key: `snapshots/${date}/${table}.csv`,
    sha256: SHA_A,
    bytes: 10,
  };
}

function sidecar(files: unknown, date = DATE) {
  return JSON.stringify({ version: 1, date, files });
}

function fileMap(table = "customer", date = DATE) {
  const { name, ...value } = entry(table, date);
  return { [name]: value };
}

describe("daily manifest requested identity", () => {
  it("preserves a valid nonempty partial manifest without claiming all tables", () => {
    const result = parseManifest(sidecar(fileMap()), MANIFEST_KEY);
    expect(result.ok).toBe(true);
    expect(result.manifest?.files).toEqual([entry()]);
  });

  it("preserves a full v1 daily manifest in deterministic filename order", () => {
    const result = parseManifest(
      sidecar({ ...fileMap("customer"), ...fileMap("container"), ...fileMap("address") }),
      MANIFEST_KEY,
    );
    expect(result.ok).toBe(true);
    expect(result.manifest?.files).toEqual([entry("address"), entry("container"), entry()]);
  });

  it.each(["2024-02-29", "2000-02-29", "2026-12-31"])(
    "accepts the real canonical calendar date %s",
    (date) => {
      expect(parseManifest(sidecar(fileMap("customer", date), date), `snapshots/${date}.manifest.json`).ok).toBe(true);
    },
  );

  it.each([
    "2026-02-29", "1900-02-29", "2026-02-30", "2026-04-31",
    "2026-00-28", "2026-13-28", "2026-09-00", "2026-09-32",
    "2026-9-28", "2026-09-8", "2026-09-28T00:00:00Z", " 2026-09-28",
  ])("rejects impossible/noncanonical date %s even when every date agrees", (date) => {
    expect(parseManifest(sidecar(fileMap("customer", date), date), `snapshots/${date}.manifest.json`).ok).toBe(false);
  });

  it("rejects a well-formed manifest for a different requested day", () => {
    expect(parseManifest(sidecar(fileMap("customer", "2026-09-27"), "2026-09-27"), MANIFEST_KEY).ok).toBe(false);
  });

  it.each([
    { label: "empty object", files: {} },
    { label: "empty array", files: [] },
    { label: "nonempty array", files: [fileMap()["customer.csv"]] },
    { label: "null", files: null },
  ])("rejects files as $label", ({ files }) => {
    expect(parseManifest(sidecar(files), MANIFEST_KEY).ok).toBe(false);
  });

  it.each(["invoice.csv", "Customer.csv", "customer", "../customer.csv", "customer.csv\n"])(
    "rejects unrecognized filename %j", (name) => {
      const { name: _name, ...value } = entry();
      expect(parseManifest(sidecar({ [name]: value }), MANIFEST_KEY).ok).toBe(false);
    },
  );

  it.each([
    "snapshots/2026-09-27/customer.csv",
    "snapshots/2026-9-28/customer.csv",
    "snapshots/2026-09-28/address.csv",
    "snapshot-history/2026-09-28/run-1/customer.csv",
    "snapshots/2026-09-28/../customer.csv",
    "snapshots/2026-09-28/customer.csv?version=old",
    "snapshots/2026-09-28/customer.csv\n",
    "snapshots/2026-09-28/%63ustomer.csv",
  ])("rejects an inconsistent file key %j", (key) => {
    const files = fileMap();
    files["customer.csv"].key = key;
    expect(parseManifest(sidecar(files), MANIFEST_KEY).ok).toBe(false);
  });

  it("rejects a reused key even when hashes and byte counts agree", () => {
    const files = { ...fileMap(), ...fileMap("address") };
    files["address.csv"].key = files["customer.csv"].key;
    expect(parseManifest(sidecar(files), MANIFEST_KEY).ok).toBe(false);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "10", null])(
    "rejects an unsafe/noninteger byte count %j", (bytes) => {
      expect(parseManifest(sidecar({ "customer.csv": { ...fileMap()["customer.csv"], bytes } }), MANIFEST_KEY).ok).toBe(false);
    },
  );

  it.each([0, Number.MAX_SAFE_INTEGER])("accepts safe nonnegative byte count %s", (bytes) => {
    expect(parseManifest(sidecar({ "customer.csv": { ...fileMap()["customer.csv"], bytes } }), MANIFEST_KEY).ok).toBe(true);
  });

  it("does not echo an attacker-controlled filename or key in parse diagnostics", () => {
    const marker = "UNTRUSTED_MANIFEST_CANARY";
    const result = parseManifest(sidecar({ [`${marker}.csv`]: { key: marker, sha256: SHA_A, bytes: 1 } }), MANIFEST_KEY);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

describe("manifest hash verification binds actual object identity", () => {
  it("keeps matching hash/byte results and missing diagnostics", () => {
    const expected = [entry("address"), entry()];
    const result = verifyManifestHashes(expected, [entry()], ["address.csv"]);
    expect(result.ok).toBe(false);
    expect(result.passed).toEqual(["customer.csv"]);
    expect(result.missing).toEqual(["address.csv"]);
    expect(formatVerifyReport(MANIFEST_KEY, result)).toContain("address.csv");
    expect(verifyManifestHashes([entry()], [entry()]).ok).toBe(true);
  });

  it("cannot succeed without a single verified entry", () => {
    expect(verifyManifestHashes([], []).ok).toBe(false);
  });

  it("rejects a different actual key even with the correct name/hash/bytes", () => {
    expect(verifyManifestHashes([entry()], [entry("customer", "2026-09-27")]).ok).toBe(false);
  });

  it("rejects swapped actual keys whose hashes and sizes happen to match", () => {
    const address = entry("address");
    const customer = entry();
    const actual = [{ ...address, key: customer.key }, { ...customer, key: address.key }];
    expect(verifyManifestHashes([address, customer], actual).ok).toBe(false);
  });

  it.each(["identical", "conflicting"])("rejects %s duplicate actual names in either order", (kind) => {
    const first = entry();
    const second = { ...first, sha256: kind === "identical" ? SHA_A : SHA_B };
    expect(verifyManifestHashes([first], [first, second]).ok).toBe(false);
    expect(verifyManifestHashes([first], [second, first]).ok).toBe(false);
  });

  it("rejects the same actual key supplied under two different names", () => {
    const customer = entry();
    const alias = { ...customer, name: "address.csv" };
    expect(verifyManifestHashes([customer], [customer, alias]).ok).toBe(false);
  });

  it("reports byte-only and hash-only mismatches by filename", () => {
    for (const actual of [{ ...entry(), bytes: 11 }, { ...entry(), sha256: SHA_B }]) {
      const result = verifyManifestHashes([entry()], [actual]);
      expect(result.ok).toBe(false);
      expect(result.mismatched.map((m) => m.name)).toEqual(["customer.csv"]);
      expect(formatVerifyReport(MANIFEST_KEY, result)).toContain("customer.csv");
    }
  });

  it("keeps valid output deterministic regardless of supplied actual order", () => {
    const expected = [entry("address"), entry("container"), entry()];
    const forward = verifyManifestHashes(expected, [...expected]);
    const reversed = verifyManifestHashes(expected, [...expected].reverse());
    expect(forward.ok).toBe(true);
    expect(reversed).toEqual(forward);
    expect(forward.passed).toEqual(["address.csv", "container.csv", "customer.csv"]);
  });
});
