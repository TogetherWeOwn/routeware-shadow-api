import { describe, expect, it } from "vitest";
import { verifyManifestHashes } from "../scripts/lib/r2ManifestVerify.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// Non-handoff pin for the cross-day same-date guard in verifyManifestHashes
// (review key cross-day-unpinned-fix): adjacent-day keys share the "snapshots/"
// prefix bytes, so a prefix-slice date extraction collapses 27/28 into one
// bucket and a mixed-day manifest would verify. Mixed-day input must fail
// closed; same-day controls must pass.
describe("r2 manifest cross-day guard pin (non-handoff)", () => {
  it("rejects mixed adjacent-day manifest entries", () => {
    const files = [
      { name: "customer.csv", key: "snapshots/2026-09-27/customer.csv", sha256: SHA_A, bytes: 10 },
      { name: "address.csv", key: "snapshots/2026-09-28/address.csv", sha256: SHA_B, bytes: 20 },
    ];
    const result = verifyManifestHashes(files, files.map((f) => ({ ...f })));
    expect(result).toEqual({ ok: false, passed: [], mismatched: [], missing: [], invalid: true });
  });

  it("accepts same-day multi-entry controls", () => {
    const files = [
      { name: "customer.csv", key: "snapshots/2026-09-28/customer.csv", sha256: SHA_A, bytes: 10 },
      { name: "address.csv", key: "snapshots/2026-09-28/address.csv", sha256: SHA_B, bytes: 20 },
    ];
    const result = verifyManifestHashes(files, files.map((f) => ({ ...f })));
    expect(result).toEqual({ ok: true, passed: ["address.csv", "customer.csv"], mismatched: [], missing: [] });
  });
});
