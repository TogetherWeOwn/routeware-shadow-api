/**
 * Exhaustive workflow-run discovery, without GitHub's filtered-search cap.
 *
 * List ALL runs for ci.yml using only page/per_page. In particular do not send
 * branch/event/created/status filters: GitHub limits those searches to 1000
 * results. Select main pushes locally only after validating the whole inventory.
 * No timestamp/ID cutoff, checkpoint or successful-run filter is authoritative.
 * See docs/BUILD-PUBLICATION-HISTORY.md for the provider contract and bounds.
 */
export const REPOSITORY = "TogetherWeOwn/routeware-shadow-api";
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const PAGE_SIZE = 100;
export const MAX_PAGES = 50;
const API_ORIGIN = "https://api.github.com";

function fail(message) {
  throw new Error(`build publication history: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
}

function nextLink(headers) {
  const raw = typeof headers.link === "string" ? headers.link : null;
  if (raw === null || raw.length === 0) return null;
  for (const part of raw.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

/** Normalize numeric repository links only after an independent identity read. */
export function createLinkNormalizer(read) {
  let repositoryId = null;
  return async function normalize(link) {
    let url;
    try {
      url = new URL(link);
    } catch {
      fail("unparseable pagination link");
    }
    if (url.origin !== API_ORIGIN) fail("pagination must stay on the GitHub API origin");
    const canonical = `/repos/${REPOSITORY}/`;
    if (url.pathname.startsWith(canonical)) return `${url.pathname}${url.search}`;
    const alias = url.pathname.match(/^\/repositories\/(\d+)(\/.*)$/);
    if (!alias) fail("pagination must stay in this repository");
    if (repositoryId === null) {
      const { data } = await read(`/repos/${REPOSITORY}`);
      if (!isObject(data) || !Number.isSafeInteger(data.id) || data.id <= 0) fail("repository identity unavailable");
      if (data.full_name !== REPOSITORY) fail("repository identity mismatch");
      repositoryId = data.id;
    }
    if (Number(alias[1]) !== repositoryId) fail("pagination must stay in this repository");
    return `${canonical.slice(0, -1)}${alias[2]}${url.search}`;
  };
}

/** Counts, exact continuation and a physical page/record bound fail closed. */
export async function readCollection(read, key, createPath) {
  const normalize = createLinkNormalizer(read);
  const visited = new Set();
  const records = [];
  let declaredTotal = null;
  for (;;) {
    const path = createPath(visited.size + 1);
    if (visited.has(path)) fail("cyclic pagination link");
    visited.add(path);
    if (visited.size > MAX_PAGES) fail("pagination exceeded the page bound");
    const { data, headers } = await read(path);
    if (!isObject(data)) fail(`malformed ${key} collection`);
    if (!Array.isArray(data[key])) fail(`${key} collection missing`);
    if (data[key].length > PAGE_SIZE) fail(`${key} page exceeds the record bound`);
    if (declaredTotal === null) {
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) fail(`${key} count invalid`);
      declaredTotal = data.total_count;
      if (declaredTotal > MAX_PAGES * PAGE_SIZE) fail(`${key} count exceeds the page bound`);
    } else if (data.total_count !== declaredTotal) {
      fail(`${key} count changed during enumeration`);
    }
    for (const record of data[key]) {
      if (!isObject(record)) fail(`malformed ${key} record`);
      records.push(record);
    }
    const link = nextLink(headers);
    if (link === null) break;
    const next = await normalize(link);
    if (visited.has(next)) fail("cyclic pagination link");
    const expected = createPath(visited.size + 1);
    if (next !== expected) fail("pagination link does not continue this collection");
  }
  return { records, declaredTotal };
}

function validateRun(run) {
  requirePositiveInteger(run.id, "run record id");
  requirePositiveInteger(run.run_attempt, "run record attempt");
  requirePositiveInteger(run.run_number, "workflow run number");
  requirePositiveInteger(run.workflow_id, "run workflow id");
  if (run.path !== WORKFLOW_PATH) fail("run record belongs to another workflow");
  if (!isObject(run.repository) || run.repository.full_name !== REPOSITORY) fail("run record belongs to another repository");
  requirePositiveInteger(run.repository.id, "run repository id");
  if (typeof run.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(run.head_sha)) fail("run record SHA invalid");
  if (typeof run.event !== "string" || run.event.length === 0) fail("run record event missing");
  if (run.head_branch !== null && (typeof run.head_branch !== "string" || run.head_branch.length === 0)) {
    fail("run record branch missing");
  }
  if (run.event === "push" && run.head_branch === "main") {
    if (!isObject(run.head_repository) || run.head_repository.full_name !== REPOSITORY
      || run.head_repository.id !== run.repository.id) fail("main push has a foreign head repository");
  }
}

function inventoryIdentity(run) {
  // Execution status may advance during admission. Identity and latest attempt
  // must not: a new rerun creates a new obligation even if its SHA is unchanged.
  return JSON.stringify([
    run.id, run.run_number, run.run_attempt, run.workflow_id, run.path, run.repository.id,
    run.repository.full_name, run.head_sha, run.event, run.head_branch,
    run.head_repository?.id ?? null, run.head_repository?.full_name ?? null
  ]);
}

export async function discoverBuildRuns(read) {
  const base = `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs`;
  const { records, declaredTotal } = await readCollection(read, "workflow_runs", (page) =>
    `${base}?per_page=${PAGE_SIZE}&page=${page}`
  );
  const inventory = new Map();
  const runNumbers = new Set();
  const runs = new Map();
  let workflowId = null;
  let repositoryId = null;
  for (const run of records) {
    validateRun(run);
    if (workflowId === null) workflowId = run.workflow_id;
    if (repositoryId === null) repositoryId = run.repository.id;
    if (run.workflow_id !== workflowId || run.repository.id !== repositoryId) fail("run inventory mixes provider identities");
    // The provider lists runs, not attempts. A second version of one run is
    // mutation during pagination, not permission to collapse the two records.
    if (inventory.has(run.id)) fail("duplicate run record");
    if (runNumbers.has(run.run_number)) fail("duplicate workflow run number");
    // GitHub numbers each workflow from 1, incrementing per new run, not rerun.
    // Unique numbers in 1..total plus exact cardinality prove a gap-free prefix.
    // This detects missing retained-prefix records, not deleted suffixes or a
    // replaced workflow incarnation; those need the documented retention proof.
    if (run.run_number > declaredTotal) fail("workflow run sequence is incomplete");
    runNumbers.add(run.run_number);
    inventory.set(run.id, inventoryIdentity(run));
    if (run.event === "push" && run.head_branch === "main") runs.set(run.id, run);
  }
  if (inventory.size !== declaredTotal) fail("run enumeration is incomplete");
  return { inventory, runs };
}

/** Re-enumerate after all attempt evidence, detecting added/deleted runs/reruns. */
export function assertStableBuildRunInventory(before, after) {
  if (before.inventory.size !== after.inventory.size) fail("run inventory changed during proof");
  for (const [id, identity] of before.inventory) {
    if (after.inventory.get(id) !== identity) fail("run inventory changed during proof");
  }
}
