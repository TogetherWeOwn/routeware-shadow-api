/**
 * Fixture-driven unit tests for the R2 lifecycle proposal shape guard.
 *
 * `evaluateR2LifecycleProposal` (scripts/lib/r2LifecycleProposalCheck.mjs)
 * pins `docs/r2-lifecycle-proposal.snapshot-history.json` to its byte-clean
 * S3 `PutBucketLifecycleConfiguration` shape: exactly one rule, the frozen
 * rule id, the Filter/Expiration nested-key allowlists, and
 * `Expiration.Days = 30`. This suite feeds it synthetic proposals — one
 * passing fixture plus one single-mutation violation per guarded field — so
 * drift fails here, not at apply time against a live bucket.
 *
 * Pure and hermetic: no Wrangler, credentials, or network access.
 *
 * Runs under `node --test` (wired into `npm run test:probe`, part of the
 * always-run `hygiene` CI job), not vitest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECK_NAME,
  evaluateR2LifecycleProposal,
} from "./lib/r2LifecycleProposalCheck.mjs";

const committed = fileURLToPath(
  new URL("../docs/r2-lifecycle-proposal.snapshot-history.json", import.meta.url),
);

function validProposal() {
  return {
    Rules: [
      {
        ID: "snapshot-history-30d-expiry",
        Status: "Enabled",
        Filter: { Prefix: "snapshot-history/" },
        Expiration: { Days: 30 },
      },
    ],
  };
}

function withRule(mutator) {
  const proposal = validProposal();
  proposal.Rules = [mutator({ ...proposal.Rules[0] })];
  return proposal;
}

function assertViolation(proposal, pattern) {
  const result = evaluateR2LifecycleProposal(proposal);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0, "a violation must name at least one reason");
  assert.match(result.errors.join("\n"), pattern);
  for (const error of result.errors) {
    assert.ok(error.startsWith(`${CHECK_NAME}:`), `every error names the check: ${error}`);
  }
}

test("the committed proposal evaluates clean as-is", () => {
  const parsed = JSON.parse(readFileSync(committed, "utf8"));
  assert.deepEqual(evaluateR2LifecycleProposal(parsed), { ok: true, errors: [] });
});

test("a fixture proposal with the exact guarded shape passes", () => {
  assert.deepEqual(evaluateR2LifecycleProposal(validProposal()), { ok: true, errors: [] });
});

test("rejects a non-object proposal", () => {
  for (const proposal of [null, [], "snapshot-history-30d-expiry", 30]) {
    assertViolation(proposal, /proposal must be an object/);
  }
});

test("rejects an extra top-level key", () => {
  assertViolation({ ...validProposal(), Version: "2012-10-17" }, /Extra top-level key "Version"/);
});

test("rejects a missing Rules array", () => {
  assertViolation({}, /Missing Rules/);
});

for (const [label, rules] of [
  ["zero rules", []],
  ["two rules", [validProposal().Rules[0], { ...validProposal().Rules[0], ID: "second-rule" }]],
  ["a non-array Rules", "not-an-array"],
]) {
  test(`rejects ${label} (exactly one rule required)`, () => {
    assertViolation({ Rules: rules }, /Rules must be an array with exactly one rule/);
  });
}

test("rejects a non-object rule", () => {
  assertViolation({ Rules: [null] }, /rule must be an object/);
});

test("rejects a rule id other than snapshot-history-30d-expiry", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, ID: "snapshot-history-60d-expiry" })),
    /ID must be "snapshot-history-30d-expiry"/,
  );
});

test("rejects a missing rule id", () => {
  assertViolation(
    withRule((rule) => {
      const { ID, ...rest } = rule;
      assert.ok(ID, "fixture must start with an ID to remove");
      return rest;
    }),
    /ID must be "snapshot-history-30d-expiry"/,
  );
});

test("rejects a Status other than Enabled", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Status: "Disabled" })),
    /Status must be "Enabled"/,
  );
});

test("rejects a missing Status", () => {
  assertViolation(
    withRule((rule) => {
      const { Status, ...rest } = rule;
      assert.ok(Status, "fixture must start with a Status to remove");
      return rest;
    }),
    /Status must be "Enabled"/,
  );
});

test("rejects an extra rule key", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, AbortIncompleteMultipartUpload: {} })),
    /Extra rule key "AbortIncompleteMultipartUpload"/,
  );
});

test("rejects Transitions with the no-transition reason", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Transitions: [{ Days: 60, StorageClass: "GLACIER" }] })),
    /Extra rule key "Transitions" — Transitions are not proposed/,
  );
});

test("rejects a missing Filter", () => {
  assertViolation(
    withRule((rule) => {
      const { Filter, ...rest } = rule;
      assert.ok(Filter, "fixture must start with a Filter to remove");
      return rest;
    }),
    /Missing Filter/,
  );
});

test("rejects an extra Filter key", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Filter: { Prefix: "snapshot-history/", Tag: "x" } })),
    /Extra Filter key "Tag"/,
  );
});

test("rejects a Filter.Prefix without the exact trailing-slash prefix", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Filter: { Prefix: "snapshot-history" } })),
    /Filter\.Prefix must be exactly "snapshot-history\/"/,
  );
});

test("rejects a Filter without Prefix", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Filter: {} })),
    /Filter\.Prefix must be exactly "snapshot-history\/"/,
  );
});

for (const prefix of ["", null, "snapshot-history/sub/"]) {
  test(`rejects Filter.Prefix=${JSON.stringify(prefix)} (exact prefix required)`, () => {
    assertViolation(
      withRule((rule) => ({ ...rule, Filter: { Prefix: prefix } })),
      /Filter\.Prefix must be exactly "snapshot-history\/"/,
    );
  });
}

test("rejects a missing Expiration", () => {
  assertViolation(
    withRule((rule) => {
      const { Expiration, ...rest } = rule;
      assert.ok(Expiration, "fixture must start with an Expiration to remove");
      return rest;
    }),
    /Missing Expiration/,
  );
});

test("rejects an extra Expiration key", () => {
  assertViolation(
    withRule((rule) => ({ ...rule, Expiration: { Days: 30, ExpiredObjectDeleteMarker: true } })),
    /Extra Expiration key "ExpiredObjectDeleteMarker"/,
  );
});

for (const days of [29, 31, "30", null]) {
  test(`rejects Expiration.Days=${JSON.stringify(days)} (exactly 30 required)`, () => {
    assertViolation(
      withRule((rule) => ({ ...rule, Expiration: { Days: days } })),
      /Expiration\.Days must be 30/,
    );
  });
}
