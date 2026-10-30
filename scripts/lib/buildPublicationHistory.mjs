/**
 * Read-only publication-history admission for the dormant production build identity.
 *
 * A deployment can consume a numeric build version (the shared CalVer planner
 * allocates it) and then fail *before* the tag/Release that records it exists.
 * History is then unchanged, so a later run would be handed the same number for
 * a different commit. This guard proves, before any new allocation, that every
 * earlier transaction either never deployed or published its own build.
 *
 * It only reads, and only from this repository's CI workflow runs. It never
 * reconciles by writing a tag, Release or deployment; anything it cannot prove
 * is refused, so uncertainty can never be mistaken for absence.
 *
 * Operational ceiling: the provider enumerates at most 1000 workflow runs, so
 * exceeding that makes complete enumeration impossible and the guard fails
 * closed. Production deploys are disabled today; raising this ceiling needs a
 * narrower proof, not a silent shortcut.
 */

export const REPOSITORY = "TogetherWeOwn/routeware-shadow-api";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const STEP_NAMES = Object.freeze({
  plan: "Plan deployment build identity",
  deploy: "Deploy Worker",
  publish: "Publish non-Latest deployment build"
});
const JOB_NAME = "Deploy to Cloudflare Workers";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_RUN_RECORDS = 1000;
const MAX_ATTEMPTS = 20;
const MAX_READS = 200;
const API_ORIGIN = "https://api.github.com";

function fail(message) {
  throw new Error(`build publication history: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
  return value;
}

/** Validate the trusted Actions context before any provider read. */
export function assertHistoryContext(context) {
  if (!isObject(context)) fail("history context required");
  if (context.repository !== REPOSITORY) fail("unexpected build repository");
  if (typeof context.sha !== "string" || !/^[0-9a-f]{40}$/.test(context.sha)) fail("exact lowercase build SHA required");
  requirePositiveInteger(context.runId, "run ID");
  requirePositiveInteger(context.attempt, "attempt");
  if (context.eventName !== "push" || context.ref !== "refs/heads/main") fail("build release requires a main push");
}

function createReader(api) {
  if (!isObject(api) || typeof api.request !== "function") fail("history provider transport required");
  let reads = 0;
  return async function read(path) {
    reads += 1;
    if (reads > MAX_READS) fail("history read budget exceeded");
    let response;
    try {
      response = await api.request("GET", path);
    } catch (error) {
      fail(`provider read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(response)) fail(`malformed provider envelope for ${path}`);
    if (response.status !== 200) fail(`provider returned status ${String(response.status)} for ${path}`);
    return { data: response.data, headers: isObject(response.headers) ? response.headers : {} };
  };
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

function nextPagePath(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    fail("unparseable pagination link");
  }
  if (url.origin !== API_ORIGIN) fail("pagination must stay on the GitHub API origin");
  if (!url.pathname.startsWith(`/repos/${REPOSITORY}/`)) fail("pagination must stay in this repository");
  return `${url.pathname}${url.search}`;
}

/**
 * Enumerate every page of a collection, refusing cycles, foreign links, a
 * changing or invalid total, duplicate records and short collection.
 */
async function readCollection(read, base, key, createPath) {
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
    if (declaredTotal === null) {
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) fail(`${key} count invalid`);
      declaredTotal = data.total_count;
    } else if (data.total_count !== declaredTotal) {
      fail(`${key} count changed during enumeration`);
    }
    for (const record of data[key]) {
      if (!isObject(record)) fail(`malformed ${key} record`);
      records.push(record);
    }
    const link = nextLink(headers);
    if (link === null) break;
    const next = nextPagePath(link);
    if (visited.has(next)) fail("cyclic pagination link");
    // Re-enter the loop through the same validated path shape.
    const expected = createPath(visited.size + 1);
    if (next !== expected) fail("pagination link does not continue this collection");
  }
  return { records, declaredTotal };
}

async function listRuns(read) {
  const base = `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs`;
  const { records, declaredTotal } = await readCollection(read, base, "workflow_runs", (page) =>
    `${base}?branch=main&event=push&per_page=${PAGE_SIZE}&page=${page}`
  );
  if (declaredTotal > MAX_RUN_RECORDS) fail("run history exceeds the provider enumeration cap");
  const byId = new Map();
  for (const run of records) {
    requirePositiveInteger(run.id, "run record id");
    const existing = byId.get(run.id);
    if (!existing) {
      byId.set(run.id, run);
      continue;
    }
    requirePositiveInteger(existing.run_attempt, "run record attempt");
    requirePositiveInteger(run.run_attempt, "run record attempt");
    if (existing.run_attempt === run.run_attempt) fail("duplicate run record");
    if (existing.run_attempt < run.run_attempt) byId.set(run.id, run);
  }
  if (byId.size !== declaredTotal) fail("run enumeration is incomplete");
  return byId;
}

async function listJobs(read, runId, attempt) {
  const base = `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs`;
  const { records, declaredTotal } = await readCollection(read, base, "jobs", (page) =>
    `${base}?per_page=${PAGE_SIZE}&page=${page}`
  );
  if (records.length !== declaredTotal) fail(`job enumeration for ${runId}/${attempt} is incomplete`);
  return records;
}

function assertAttemptIdentity(metadata, expected) {
  if (!isObject(metadata)) fail("attempt metadata missing");
  if (metadata.id !== expected.runId) fail("attempt metadata belongs to another run");
  if (metadata.run_attempt !== expected.attempt) fail("attempt metadata belongs to another attempt");
  if (metadata.head_sha !== expected.sha) fail("attempt metadata belongs to another commit");
  if (metadata.path !== WORKFLOW_PATH) fail("attempt metadata belongs to another workflow");
  if (metadata.event !== "push") fail("attempt metadata is not a push");
  if (metadata.head_branch !== "main") fail("attempt metadata is not a main build");
  if (!isObject(metadata.repository) || metadata.repository.full_name !== REPOSITORY) {
    fail("attempt metadata belongs to another repository");
  }
  if (!isObject(metadata.head_repository) || metadata.head_repository.full_name !== REPOSITORY) {
    fail("attempt metadata has a foreign head repository");
  }
  if (metadata.repository.id !== metadata.head_repository.id) fail("attempt metadata mixes two repositories");
  requirePositiveInteger(metadata.repository.id, "attempt repository id");
}

function findProductionJob(jobs, expected) {
  const matches = jobs.filter((job) => job.name === JOB_NAME);
  if (matches.length !== 1) fail(`expected exactly one ${JOB_NAME} job for ${expected.runId}/${expected.attempt}`);
  const job = matches[0];
  if (job.run_id !== expected.runId) fail("production job belongs to another run");
  if (job.run_attempt !== expected.attempt) fail("production job belongs to another attempt");
  if (job.head_sha !== expected.sha) fail("production job belongs to another commit");
  return job;
}

/** A skipped job with no steps is affirmative evidence that nothing was planned or deployed. */
function isAffirmativelySkipped(job) {
  return job.conclusion === "skipped" && Array.isArray(job.steps) && job.steps.length === 0;
}

function findIdentitySteps(job) {
  if (!Array.isArray(job.steps)) fail("production job steps missing");
  const counts = Object.entries(STEP_NAMES).map(([key, name]) => ({
    key,
    name,
    matches: job.steps.filter((step) => isObject(step) && step.name === name)
  }));
  if (counts.some((entry) => entry.matches.length > 1)) fail("ambiguous build identity steps");
  if (counts.some((entry) => entry.matches.length === 0)) return null;
  return Object.fromEntries(counts.map((entry) => [entry.key, entry.matches[0]]));
}

function assertStepsCompleted(steps, label) {
  for (const [key, step] of Object.entries(steps)) {
    if (step.status !== "completed") fail(`${label} ${key} step is not complete`);
  }
}

/** Live source of the exact run's workflow, never main or a latest ref. */
async function isLegacyWorkflow(read, sha) {
  const path = `/repos/${REPOSITORY}/contents/${WORKFLOW_PATH}?ref=${sha}`;
  const { data } = await read(path);
  if (!isObject(data) || data.type !== "file") fail("workflow source is not a file");
  if (data.encoding !== "base64" || typeof data.content !== "string") fail("workflow source encoding unsupported");
  const text = Buffer.from(data.content, "base64").toString("utf8");
  if (text.trim().length === 0) fail("workflow source cannot prove legacy history");
  return !/scripts\/calver-build\.mjs|Plan deployment build identity|Publish non-Latest deployment build/.test(text);
}

/**
 * Judge one completed attempt. Deploying without published proof, or a deploy
 * whose outcome is unknown, may have consumed an unrecorded build identity.
 */
async function assertAttemptSafe(read, run, attempt) {
  const expected = { runId: run.id, attempt, sha: run.head_sha };
  const metadata = await read(`/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${attempt}`);
  assertAttemptIdentity(metadata.data, expected);
  const job = findProductionJob(await listJobs(read, run.id, attempt), expected);
  if (isAffirmativelySkipped(job)) return;
  const steps = findIdentitySteps(job);
  if (steps === null) {
    if (await isLegacyWorkflow(read, run.head_sha)) return;
    fail(`attempt ${run.id}/${attempt} lacks the build identity steps in a build-aware workflow`);
  }
  assertStepsCompleted(steps, `${run.id}/${attempt}`);
  const deploy = steps.deploy.conclusion;
  if (deploy === "skipped") return;
  if (deploy !== "success") fail(`attempt ${run.id}/${attempt} has an ambiguous deployment`);
  if (steps.plan.conclusion === "skipped") return;
  if (steps.plan.conclusion !== "success") fail(`attempt ${run.id}/${attempt} has an ambiguous build plan`);
  if (steps.publish.conclusion !== "success") fail(`attempt ${run.id}/${attempt} deployed an unpublished build`);
}

/**
 * Resolve when it is safe to allocate a new build identity, throw otherwise.
 * Disabled contexts perform no provider reads at all.
 */
export async function assertBuildPublicationHistory(context, api) {
  assertHistoryContext(context);
  if (context.enabled !== true) return;
  const read = createReader(api);

  const runs = await listRuns(read);
  const current = runs.get(context.runId);
  if (!current) fail("current build run is missing from the enumerated history");
  if (current.run_attempt !== context.attempt) fail("current build attempt is not the enumerated latest attempt");
  if (current.head_sha !== context.sha) fail("current build run does not belong to this commit");
  const currentMetadata = await read(`/repos/${REPOSITORY}/actions/runs/${context.runId}/attempts/${context.attempt}`);
  assertAttemptIdentity(currentMetadata.data, { runId: context.runId, attempt: context.attempt, sha: context.sha });

  const currentKey = `${context.runId}/${context.attempt}`;
  const pending = [];
  for (const run of runs.values()) {
    requirePositiveInteger(run.run_attempt, "run attempt count");
    if (run.run_attempt > MAX_ATTEMPTS) fail("run attempt history exceeds the attempt bound");
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      if (`${run.id}/${attempt}` === currentKey) continue;
      pending.push({ run, attempt });
    }
  }
  // Oldest first so a reported refusal names the earliest unresolved transaction.
  pending.sort((left, right) => left.run.id - right.run.id || left.attempt - right.attempt);
  for (const { run, attempt } of pending) {
    await assertAttemptSafe(read, run, attempt);
  }
}
