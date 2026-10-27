import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";

/**
 * Truthful dry-run guarantee for the three mounted entity saves.
 *
 * A `?dryRun=true` HTTP 200 is a local-preparation result only. The saved
 * handlers check a nonempty body, check for a stored cookie, and run the
 * anti-forgery preparation that applies to that request:
 *
 * - customer: `prepareSaveCustomerLongFormBody` returns unchanged for a
 *   disabled auto-token or a supplied non-placeholder token; otherwise it
 *   may consult its session-keyed token cache or GET `AddNewLong` /
 *   `LoadLongCustomerModal`.
 * - address: `prepareSaveAddressFormBody` has the same two skip branches;
 *   otherwise it GETs `CreateBlankAddress` (new, needs `CustomerID`) or
 *   `LoadAddressModal`.
 * - container: `prepareSaveContainerFormBody` has the same two skip
 *   branches; otherwise it GETs `CreateBlankContainer` (new, needs
 *   `PickupAddressID`) or `LoadContainerModal`.
 *
 * None of those paths posts the form upstream, proves that a stored cookie
 * is currently authenticated, or validates every upstream business rule.
 * The explicit-token customer case and the absent/stale-cookie cases are
 * executable controls in `saveDryRun.acceptance.test.ts`; this file pins
 * only that the mounted OpenAPI descriptions and the consumer quickstart
 * say so. Assertions are concept-level: no full sentence or paragraph is
 * pinned, and any truthful wording carrying every concept passes.
 *
 * Expected RED on the baseline: the mounted descriptions and the
 * quickstart recipe do not yet state the scope limit, the stored-cookie
 * distinction, the conditional modal preparation, the non-proofs below,
 * or the quickstart recovery action. The retained guarantees (503
 * fail-closed, never logs in, the hermetic proof command) already pass
 * and must stay green.
 */

type OpenApiDocument = {
  paths: Record<string, Record<string, { description?: string }>>;
};

const ENTITIES = ["customer", "address", "container"] as const;

// Strong non-proof phrasing, kept distinct from incidental negations such
// as "no Location header" elsewhere in an operation description.
const NOT_PROOF =
  "(?:does not prove|does not guarantee|do not prove|is not proof|not proof of|no guarantee|not a guarantee|never proves|does not mean|does not show|does not establish)";

function expectNotProven(text: string, concept: string, label: string): void {
  const pattern = new RegExp(
    `${NOT_PROOF}[\\s\\S]{0,340}?${concept}|${concept}[\\s\\S]{0,90}?(?:is not|are not)[\\s\\S]{0,20}?(?:proven|guaranteed|validated)`,
    "i"
  );
  expect(text, label).toMatch(pattern);
}

/** Every guarantee limit a dry-run 200 must state, wherever it is sold. */
function expectDryRunGuarantee(rawText: string, where: string): void {
  // Markdown wraps phrases across lines; concepts are about wording, not
  // where a line happened to break.
  const text = rawText.replace(/\s+/g, " ");
  // Success is scoped to the checks on the local preparation path taken.
  expect(text, `${where}: dryRun is named`).toMatch(/dryRun/);
  expect(text, `${where}: success is scoped to applicable local preparation`).toMatch(
    /(?:only|limited)[\s\S]{0,140}?(?:local|applicable|preparation|prep)|(?:local|applicable)[\s\S]{0,100}?(?:checks|preparation|prep)/i
  );

  // A stored cookie is presence, not a currently authenticated session.
  expect(text, `${where}: stored cookie is distinguished`).toMatch(
    /stored[\s\S]{0,50}?cookie/i
  );
  expectNotProven(
    text,
    "(?:authenticat[\\s\\S]{0,50}?(?:upstream|session)|(?:upstream|current)[\\s\\S]{0,50}?authenticat)",
    `${where}: a currently authenticated upstream session is not proven`
  );

  // The upstream form/business rules never ran.
  expectNotProven(
    text,
    "(?:upstream[\\s\\S]{0,50}?(?:accept|valid)|business[\\s\\S]{0,50}?(?:accept|valid)|form[\\s\\S]{0,50}?accept)",
    `${where}: upstream form/business acceptance is not proven`
  );
  expectNotProven(
    text,
    "(?:required[- ]field|complete[\\s\\S]{0,40}?validation)",
    `${where}: complete required-field validation is not proven`
  );

  // Nothing about a later live save is promised either.
  expectNotProven(
    text,
    "(?:future[\\s\\S]{0,50}?save|save[\\s\\S]{0,50}?success)",
    `${where}: future save success is not proven`
  );
  expectNotProven(text, "idempoten", `${where}: idempotency is not proven`);
  expectNotProven(
    text,
    "(?:refresh[\\s\\S]{0,50}?(?:local|D1|state)|refreshed local)",
    `${where}: refreshed local state is not proven`
  );

  // Token preparation is conditional: it may make a modal GET, and the
  // supplied-token and disabled-auto-token branches can skip it entirely.
  expect(text, `${where}: modal preparation is conditional`).toMatch(
    /may[\s\S]{0,100}?(?:modal|token)|(?:modal|token)[\s\S]{0,100}?may/i
  );
  expect(text, `${where}: supplied explicit token can skip preparation`).toMatch(
    /(?:explicit|supplied|client)[\s\S]{0,160}?skip|skip[\s\S]{0,160}?(?:explicit|supplied)/i
  );
  expect(text, `${where}: disabled auto-token can skip preparation`).toMatch(
    /disabled[\s\S]{0,80}?(?:auto[- ]?token|token)|(?:auto[- ]?token)[\s\S]{0,80}?disabled/i
  );

  // Retained fail-closed guarantees (already true on the baseline).
  expect(text, `${where}: absent session fails closed with 503`).toMatch(
    /(?:fails closed|fail-closed)[\s\S]{0,120}?503|503[\s\S]{0,120}?(?:fails closed|fail-closed)/i
  );
  expect(text, `${where}: dry-run never logs in`).toMatch(
    /never logs in|never log in|no login/i
  );
}

async function servedDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

/** The `### Dry-run recipe` section, up to the next `## ` heading. */
function dryRunRecipe(): string {
  const start = quickstartDoc.indexOf("Dry-run recipe");
  expect(start, "quickstart keeps a dry-run recipe section").toBeGreaterThanOrEqual(0);
  const rest = quickstartDoc.indexOf("\n## ", start + 1);
  return rest === -1 ? quickstartDoc.slice(start) : quickstartDoc.slice(start, rest);
}

describe("dry-run guarantee: mounted save descriptions", () => {
  it.each(ENTITIES)(
    "POST /api/v1/data/%s states what dry-run success does and does not validate",
    async (entity) => {
      const doc = await servedDocument();
      const description = doc.paths[`/api/v1/data/${entity}`]?.post?.description ?? "";
      expect(description, `${entity} save publishes a description`).not.toBe("");
      expectDryRunGuarantee(description, `${entity} save description`);
    }
  );
});

describe("dry-run guarantee: consumer quickstart recipe", () => {
  it("states the same limits without the old overclaim", () => {
    const recipe = dryRunRecipe();
    expectDryRunGuarantee(recipe, "quickstart dry-run recipe");

    // The baseline overclaim this outcome removes.
    expect(recipe, "recipe no longer promises form fields plus session health").not.toMatch(
      /form fields\s+plus session health/i
    );
    expect(recipe, "recipe keeps the hermetic proof command").toContain(
      "npm run check:save-dry-run"
    );
  });

  it("gives one safe recovery action for the no-session 503", () => {
    const recipe = dryRunRecipe().replace(/\s+/g, " ");

    // Recover through an authorized existing session/read workflow,
    // reached by a link — not an arbitrary live write.
    expect(recipe, "recovery is an authorized workflow").toMatch(/authori[sz]ed/i);
    expect(recipe, "recovery names a session or read workflow").toMatch(
      /session-establishment|establish[\s\S]{0,40}?session|read[\s\S]{0,40}?workflow|live read/i
    );
    expect(recipe, "recovery is linked").toMatch(/\[[^\]]+\]\([^)]+\)/);
    expect(recipe, "recipe no longer sends readers to a bare live request").not.toMatch(
      /run a live request first/i
    );
    expect(recipe, "no arbitrary live mutation just to establish a session").toMatch(
      /(?:never|do not|don't)[\s\S]{0,180}?(?:arbitrary|live mutation|mutation[\s\S]{0,100}?session)/i
    );
    expect(recipe, "an ambiguous create is never auto-replayed").toMatch(
      /(?:never|do not|don't)[\s\S]{0,180}?(?:replay|re-post|retry)[\s\S]{0,140}?ambiguous|ambiguous[\s\S]{0,140}?(?:replay|create)/i
    );
  });
});
