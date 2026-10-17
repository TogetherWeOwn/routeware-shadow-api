import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHECK_NAME,
  evaluateR2LifecycleProposal,
} from "../scripts/lib/r2LifecycleProposalCheck.mjs";

/**
 * Acceptance tests (test-author half of roadmap item R9-05,
 * paired with builder card).
 *
 * FAILING-FIRST: `../scripts/lib/r2LifecycleProposalCheck.mjs` does not exist
 * yet — the Builder implements it on this card's branch without editing this
 * file. Until then every test in this file fails at import time, which is the
 * expected red state ("no guard exists yet").
 *
 * Contract the Builder implements (kept minimal and pure so it is
 * unit-testable without Wrangler, credentials, or network access):
 *
 * - `CHECK_NAME` — stable string tag for the wrapper's log prefix
 *   (expected: `"r2-lifecycle-proposal"`).
 * - `evaluateR2LifecycleProposal(value: unknown)` — validates a parsed
 *   `docs/r2-lifecycle-proposal.snapshot-history.json` body against the
 *   byte-clean S3 `PutBucketLifecycleConfiguration` shape and returns
 *   `{ ok: true, errors: [] }` on success or
 *   `{ ok: false, errors: string[] }` with one human-readable reason per
 *   violation. The committed proposal file must evaluate `ok: true` as-is
 *   (no proposal content changes).
 *
 * Shape under guard (per `docs/R2-LIFECYCLE-PROPOSAL.md`): exactly one rule
 * with `ID` `"snapshot-history-30d-expiry"`, `Status` `"Enabled"`,
 * `Filter.Prefix` exactly `"snapshot-history/"`, `Expiration.Days` 30, no
 * `Transitions` element, and no extra keys at any level.
 */

const PROPOSAL_URL = new URL(
  "../docs/r2-lifecycle-proposal.snapshot-history.json",
  import.meta.url
);

function committedProposal(): unknown {
  return JSON.parse(readFileSync(PROPOSAL_URL, "utf8"));
}

function ruleOf(proposal: unknown): Record<string, unknown> {
  const rules = (proposal as { Rules: Record<string, unknown>[] }).Rules;
  return rules[0];
}

function errorText(result: { errors: string[] }): string {
  return result.errors.join("\n");
}

describe("r2 lifecycle proposal guard", () => {
  it("check name is stable for the wrapper's log prefix", () => {
    expect(CHECK_NAME).toBe("r2-lifecycle-proposal");
  });

  it("accepts the committed proposal file as-is", () => {
    const result = evaluateR2LifecycleProposal(committedProposal());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects a widened Filter.Prefix for the widening reason", () => {
    const mutated = committedProposal() as { Rules: { Filter: { Prefix: string } }[] };
    // Widened: a strict prefix of the intended prefix, so it would also match
    // `snapshots/` aliases and `snapshot-latest/` pointers.
    mutated.Rules[0].Filter.Prefix = "snapshot-";
    const result = evaluateR2LifecycleProposal(mutated);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toMatch(/Prefix/);
  });

  it("rejects an extra top-level key for the extra-key reason", () => {
    const mutated = committedProposal() as Record<string, unknown>;
    mutated.Extra = { anything: true };
    const result = evaluateR2LifecycleProposal(mutated);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toMatch(/[Ee]xtra/);
  });

  it("rejects a missing Expiration for the Expiration reason", () => {
    const mutated = committedProposal();
    delete ruleOf(mutated).Expiration;
    const result = evaluateR2LifecycleProposal(mutated);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toMatch(/Expiration/);
  });

  it("rejects a dropped Status: Enabled intent for the Status reason", () => {
    const mutated = committedProposal();
    ruleOf(mutated).Status = "Disabled";
    const result = evaluateR2LifecycleProposal(mutated);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toMatch(/Status/);
  });

  it("rejects a Transitions element for the Transitions reason", () => {
    const mutated = committedProposal();
    ruleOf(mutated).Transitions = [{ Days: 60, StorageClass: "GLACIER" }];
    const result = evaluateR2LifecycleProposal(mutated);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toMatch(/Transitions/);
  });
});
