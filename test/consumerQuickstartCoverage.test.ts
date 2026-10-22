import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import quickstart from "../docs/CONSUMER-QUICKSTART.md?raw";

/**
 * Consumer-quickstart GET coverage ratchet (roadmap R16-05).
 *
 * Agents pick tools from `docs/CONSUMER-QUICKSTART.md` before reading the
 * registry, so every GET operation in the mounted OpenAPI document must be
 * either referenced there by path or named in ALLOWLIST with the reason it
 * stays out of the consumer narrative. A new GET route fails this file until
 * a human documents it or allowlists it — silence is not an option.
 *
 * Referenced = the doc contains the operation's path with each `{param}`
 * replaced by a concrete segment (e.g. `/api/v1/customer-snapshot/42` covers
 * `/api/v1/customer-snapshot/{customerId}`), bounded so a longer path never
 * covers its prefix (`/changes` does not cover the bare list).
 *
 * The two recipes this card adds (the customer `changes` feed and the R2
 * snapshot archive) are pinned as referenced, so they cannot be satisfied by
 * an allowlist entry instead. Both sections stay small (<= 30 lines each);
 * the cap keeps recipes copy-paste sized and pushes overflow into the
 * runbooks the quickstart already links.
 *
 * Oracles: the mounted `/openapi.json` document (same fetch as
 * `test/openapiContract.test.ts`); recipe facts are pinned by
 * `test/customerSnapshotChanges.test.ts`,
 * `test/customerChangesCursor.acceptance.test.ts` and
 * `test/snapshotArchive.test.ts`.
 */

// GET operations intentionally absent from the consumer quickstart. Each
// entry needs a reason: the test fails on short reasons, on entries that no
// longer exist as registry GETs, and on entries the quickstart now covers
// (graduate them out instead of leaving a stale excuse).
const ALLOWLIST: Record<string, string> = {
  "GET /api/v1/routeware/account/login-page":
    "Upstream login-page probe passthrough (sessionless, strips Set-Cookie): a session/login diagnostic, not a consumer data read.",
  "GET /api/v1/routeware/customer/add-new-long":
    "New-customer HTML/JS form shell; optional for API clients because save-long-form fetches the anti-forgery token server-side, and the quickstart create path posts the documented field set directly.",
  "GET /api/v1/routeware/home/index":
    "Sessioned upstream Home/Index passthrough answering whatever the SPA serves (HTML, JSON, other): not consumer data.",
  "GET /api/v1/data-snapshot/orphans":
    "Privileged (sync-secret) FK-integrity audit for operators; normal syncs cannot create orphans, and counts/samples are an integrity signal, not a consumer read."
};

const CHANGES_KEY = "GET /api/v1/customer-snapshot/changes";
const MAX_RECIPE_LINES = 30;

type OpenApiDocument = {
  paths: Record<string, Record<string, unknown>>;
};

async function registryGetPaths(): Promise<string[]> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  const doc = (await res.json()) as OpenApiDocument;
  return Object.entries(doc.paths)
    .filter(([path, item]) => path.startsWith("/api/v1/") && "get" in item)
    .map(([path]) => `GET ${path}`)
    .sort((a, b) => a.localeCompare(b));
}

/** True when the doc references the template with concrete param segments. */
function isReferenced(key: string): boolean {
  const template = key.slice("GET ".length);
  const pattern = template
    .split(/(\{[^}]+\})/g)
    .map((part) =>
      /^\{[^}]+\}$/.test(part)
        ? "[^/?#\\s\"'`)\\]]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp(`${pattern}(?![A-Za-z0-9_\\-/])`).test(quickstart);
}

/** Lines of the `## ` section starting at `marker`, excluding the next section. */
function sectionLines(marker: string): string[] {
  const start = quickstart.indexOf(marker);
  expect(start, `quickstart is missing section ${marker}`).toBeGreaterThanOrEqual(0);
  const rest = quickstart.indexOf("\n## ", start + 1);
  const section = rest === -1 ? quickstart.slice(start) : quickstart.slice(start, rest);
  return section.replace(/\n$/, "").split("\n");
}

describe("consumer quickstart GET coverage", () => {
  it("references or allowlists every registry GET", async () => {
    const uncovered = (await registryGetPaths()).filter(
      (key) => !isReferenced(key) && !(key in ALLOWLIST)
    );

    expect(uncovered).toEqual([]);
  });

  it("keeps every allowlist entry current, undocumented and reasoned", async () => {
    const gets = new Set(await registryGetPaths());

    const problems = Object.entries(ALLOWLIST).flatMap(([key, reason]) => {
      if (!gets.has(key)) return [`${key}: no longer a registry GET`];
      if (isReferenced(key)) return [`${key}: now documented, remove the entry`];
      if (reason.trim().length < 20) return [`${key}: reason too short to explain the omission`];
      return [];
    });

    expect(problems).toEqual([]);
  });

  it("pins the changes feed and snapshot archive as documented recipes, not allowlist entries", async () => {
    const gets = await registryGetPaths();
    const archive = gets.filter((key) => key.startsWith("GET /api/v1/snapshots/"));
    expect(archive.length).toBeGreaterThan(0);

    for (const key of [CHANGES_KEY, ...archive]) {
      expect(isReferenced(key), `${key} must stay a quickstart recipe`).toBe(true);
      expect(key in ALLOWLIST, `${key} must not be allowlisted away`).toBe(false);
    }
  });

  it.each([
    ["## 2b. Incremental sync", "/api/v1/customer-snapshot/changes"],
    ["## 3a. Snapshot archives", "/api/v1/snapshots/"]
  ])("keeps the %s recipe at most 30 lines with a runnable example", (marker, path) => {
    const lines = sectionLines(marker);

    expect(lines.length).toBeLessThanOrEqual(MAX_RECIPE_LINES);
    expect(lines.join("\n")).toContain(path);
    expect(lines.join("\n")).toContain("```bash");
  });
});
