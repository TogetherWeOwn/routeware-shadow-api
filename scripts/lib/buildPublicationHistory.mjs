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
 * Discovery uses exhaustive, unfiltered workflow enumeration rather than the
 * capped branch/event search. All per-attempt obligations remain; physical
 * collection bounds and provider/read-budget failures still refuse admission.
 */

import { createBuildRepairProof, isReviewedBuildWorkflow, MAX_REPAIR_READS } from "./buildPublicationRepair.mjs";
import {
  REPOSITORY, WORKFLOW_PATH, PAGE_SIZE, MAX_PAGES, createLinkNormalizer,
  readCollection, discoverBuildRuns, assertStableBuildRunInventory
} from "./buildPublicationDiscovery.mjs";

export { REPOSITORY } from "./buildPublicationDiscovery.mjs";
const STEP_NAMES = Object.freeze({
  plan: "Plan deployment build identity",
  deploy: "Deploy Worker",
  publish: "Publish non-Latest deployment build"
});
const JOB_NAME = "Deploy to Cloudflare Workers";
const MAX_ATTEMPTS = 20;
/**
 * Cover every supported run AND attempt, including all bounded job pages, one
 * numeric-link identity lookup and one workflow read per attempt. Provider quota
 * failures still refuse; this safety ceiling is not a promise of live API quota.
 */
const MAX_READS = MAX_PAGES * PAGE_SIZE * MAX_ATTEMPTS * (MAX_PAGES + 4) + MAX_REPAIR_READS + 2 * MAX_PAGES + 100;

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

async function listJobs(read, expected) {
  const { runId, attempt, sha } = expected;
  const base = `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs`;
  const { records, declaredTotal } = await readCollection(read, "jobs", (page) =>
    `${base}?per_page=${PAGE_SIZE}&page=${page}`
  );
  if (records.length !== declaredTotal) fail(`job enumeration for ${runId}/${attempt} is incomplete`);
  // Every row must be identifiable before filtering by name can prove absence.
  const ids = new Set();
  for (const job of records) {
    requirePositiveInteger(job.id, "job id");
    if (ids.has(job.id)) fail("duplicate job record");
    ids.add(job.id);
    if (typeof job.name !== "string" || job.name.trim().length === 0) fail("job name missing or malformed");
    if (job.run_id !== runId) fail("job belongs to another run");
    if (job.run_attempt !== attempt) fail("job belongs to another attempt");
    if (job.head_sha !== sha) fail("job belongs to another commit");
  }
  return records;
}

function assertAttemptIdentity(metadata, expected) {
  if (!isObject(metadata)) fail("attempt metadata missing");
  if (metadata.id !== expected.runId) fail("attempt metadata belongs to another run");
  if (metadata.run_attempt !== expected.attempt) fail("attempt metadata belongs to another attempt");
  if (metadata.head_sha !== expected.sha) fail("attempt metadata belongs to another commit");
  if (metadata.path !== WORKFLOW_PATH || metadata.workflow_id !== expected.workflowId) fail("attempt metadata belongs to another workflow");
  if (metadata.event !== "push") fail("attempt metadata is not a push");
  if (metadata.head_branch !== "main") fail("attempt metadata is not a main build");
  if (!isObject(metadata.repository) || metadata.repository.full_name !== REPOSITORY
    || metadata.repository.id !== expected.repositoryId) {
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
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail(`expected at most one ${JOB_NAME} job for ${expected.runId}/${expected.attempt}`);
  const job = matches[0];
  if (job.run_id !== expected.runId) fail("production job belongs to another run");
  if (job.run_attempt !== expected.attempt) fail("production job belongs to another attempt");
  if (job.head_sha !== expected.sha) fail("production job belongs to another commit");
  return job;
}

/**
 * A skipped job with no steps is affirmative evidence that nothing was planned
 * or deployed. A job that never started (queued) is the same evidence: this
 * guard runs while its own transaction holds the exclusive deploy lock, so a
 * queued production job elsewhere in the group has not run, and it must not
 * block the current holder. A started-but-unfinished job is ambiguous and is
 * never treated as safe.
 */
function isAffirmativelySkipped(job) {
  if (!Array.isArray(job.steps) || job.steps.length !== 0) return false;
  // GitHub timestamps wholly skipped jobs even though no runner steps executed.
  if (job.status === "completed" && job.conclusion === "skipped") return true;
  if (job.started_at !== null) return false;
  return (job.status === "queued" && job.conclusion === null)
    || (job.status === "completed" && job.conclusion === "cancelled");
}

/**
 * Legacy classification may only excuse a job that has finished executing.
 * A step still in progress could be deploying right now, so its workflow
 * predating build identity says nothing about whether this attempt consumed one.
 */
function assertJobFinished(job, label) {
  if (!Array.isArray(job.steps)) fail(`${label} production job steps missing`);
  for (const step of job.steps) {
    if (!isObject(step) || step.status !== "completed") fail(`${label} production job has not finished executing`);
  }
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
async function readWorkflow(read, sha) {
  const path = `/repos/${REPOSITORY}/contents/${WORKFLOW_PATH}?ref=${sha}`;
  const { data } = await read(path);
  if (!isObject(data) || data.type !== "file") fail("workflow source is not a file");
  if (data.encoding !== "base64" || typeof data.content !== "string") fail("workflow source encoding unsupported");
  const text = Buffer.from(data.content, "base64").toString("utf8");
  if (text.trim().length === 0) fail("workflow source cannot prove history");
  return text;
}

async function isLegacyWorkflow(read, sha) {
  const text = await readWorkflow(read, sha);
  return !/scripts\/calver-build\.mjs|Plan deployment build identity|Publish non-Latest deployment build/.test(text);
}

/**
 * Judge one completed attempt. Deploying without published proof, or a deploy
 * whose outcome is unknown, may have consumed an unrecorded build identity.
 */
async function assertAttemptSafe(read, run, attempt, assertRepaired) {
  const expected = {
    runId: run.id, attempt, sha: run.head_sha, workflowId: run.workflow_id, repositoryId: run.repository.id
  };
  const metadata = await read(`/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${attempt}`);
  assertAttemptIdentity(metadata.data, expected);
  const job = findProductionJob(await listJobs(read, expected), expected);
  // Complete job enumeration plus exact terminal cancellation metadata proves
  // this attempt ended without ever creating its production job. Run-list state
  // alone cannot prove this (it may describe a later rerun).
  if (job === null) {
    if (metadata.data.status === "completed" && metadata.data.conclusion === "cancelled") return;
    if ((metadata.data.status === "queued" || metadata.data.status === "in_progress")
      && metadata.data.conclusion === null
      && isReviewedBuildWorkflow(await readWorkflow(read, run.head_sha))) return;
    if (await isLegacyWorkflow(read, run.head_sha)) return;
    fail(`attempt ${run.id}/${attempt} has no production job under a build-aware workflow`);
  }
  if (isAffirmativelySkipped(job)) {
    if (job.status === "queued" && !isReviewedBuildWorkflow(await readWorkflow(read, run.head_sha))) {
      fail(`attempt ${run.id}/${attempt} has a queued production job without reviewed lock wiring`);
    }
    return;
  }
  // Anything that has started but not finished is ambiguous: it could be
  // deploying while this admission runs.
  assertJobFinished(job, `${run.id}/${attempt}`);
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
  if (steps.publish.conclusion !== "success") {
    await assertRepaired({ ...expected, jobId: job.id }, await readWorkflow(read, run.head_sha));
  }
}

/**
 * Resolve when it is safe to allocate a new build identity, throw otherwise.
 * Disabled contexts perform no provider reads at all.
 */
export async function assertBuildPublicationHistory(context, api) {
  assertHistoryContext(context);
  if (context.enabled !== true) return;
  return proveBuildPublicationHistory(context, createReader(api));
}

/** Pure proof seam for bounded synthetic readers; never a planner or transport.
 * Production callers use assertBuildPublicationHistory and its admission reader.
 */
export async function proveBuildPublicationHistory(context, read) {
  assertHistoryContext(context);
  if (context.enabled !== true) return;
  if (typeof read !== "function") fail("history proof reader required");
  const discovery = await discoverBuildRuns(read);
  const { runs } = discovery;
  const current = runs.get(context.runId);
  if (!current) fail("current build run is missing from the enumerated history");
  if (current.run_attempt !== context.attempt) fail("current build attempt is not the enumerated latest attempt");
  if (current.head_sha !== context.sha) fail("current build run does not belong to this commit");
  const currentMetadata = await read(`/repos/${REPOSITORY}/actions/runs/${context.runId}/attempts/${context.attempt}`);
  assertAttemptIdentity(currentMetadata.data, {
    runId: context.runId, attempt: context.attempt, sha: context.sha,
    workflowId: current.workflow_id, repositoryId: current.repository.id
  });

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
  const assertRepaired = createBuildRepairProof(read, createLinkNormalizer(read), REPOSITORY);
  for (const { run, attempt } of pending) {
    await assertAttemptSafe(read, run, attempt, assertRepaired);
  }
  assertStableBuildRunInventory(discovery, await discoverBuildRuns(read));
}
