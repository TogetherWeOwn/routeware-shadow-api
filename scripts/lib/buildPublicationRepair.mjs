import { createHash } from "node:crypto";
import { parseBuildVersion } from "../../src/lib/buildVersion.ts";

const MAX_TAGS = 10000;
const MAX_TAG_PAGES = MAX_TAGS / 100;
// One complete tag inventory per admission, never once per historical failure.
export const MAX_REPAIR_READS = MAX_TAG_PAGES + MAX_TAGS * 3 + 1;

// SHA-256 of the reviewed .github/workflows/ci.yml bytes. A partial YAML match
// cannot establish executable wiring (aliases, env overrides, steps in other
// jobs, etc.). Recognize only this verified transaction's complete source; a
// future workflow needs a reviewed addition here before its repair can admit.
const WORKFLOW_DIGESTS = new Set([
  "39be44474d54333efdf8ca8f5a49ff2c896c2346b83554faaa3e5b17f1f6f552"
]);
const SHA = /^[0-9a-f]{40}$/;
const PLAN_KEYS = "channel,date,evidence,latest,namespace,operation,policy,previousStableTag,repairDate,repository,schema,sha,source,sourceCanary,tag,version";

function fail(message) {
  throw new Error(`build publication repair: ${message}`);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Verify only the pinned engine's flat, ordinary direct-release plan format.
 * No allocation, clock, writer, staging certificate or substitute operation.
 * Its ID is an integrity fingerprint, NOT a signature or rollout attestation.
 */
function publicationPlan(annotation, repository, tag, sha) {
  if (typeof annotation !== "string" || !annotation.startsWith("calver-plan-v1\n")) fail("shared tag annotation missing");
  const record = JSON.parse(annotation.slice("calver-plan-v1\n".length));
  if (!isObject(record)) fail("shared tag annotation malformed");
  const { id, publicationEvidence, ...payload } = record;
  if (Object.keys(payload).sort().join(",") !== PLAN_KEYS) fail("unsupported shared plan fields");
  if (publicationEvidence !== null || payload.evidence !== null || payload.source !== null
    || payload.sourceCanary !== null || payload.repairDate !== null) fail("not the ordinary deployed plan");
  if (payload.schema !== "calver-plan-v1" || payload.repository !== repository
    || payload.policy !== "direct-release" || payload.namespace !== "build"
    || payload.channel !== "stable" || payload.latest !== "never") fail("unexpected shared build policy");
  const version = parseBuildVersion(payload.version);
  if (version === null || tag !== `build/v${version}` || payload.tag !== tag || payload.sha !== sha) fail("annotation target mismatch");
  const [year, mdd] = version.split(".");
  if (payload.date !== `${year}-${mdd.slice(0, -2).padStart(2, "0")}-${mdd.slice(-2)}`) fail("annotation date mismatch");
  const operation = typeof payload.operation === "string" && /^routeware-build:([1-9][0-9]*):([1-9][0-9]*)$/.exec(payload.operation);
  if (!operation || !Number.isSafeInteger(Number(operation[1])) || !Number.isSafeInteger(Number(operation[2]))) fail("unexpected build operation");
  if (payload.previousStableTag !== null && (typeof payload.previousStableTag !== "string"
    || !payload.previousStableTag.startsWith("build/v") || parseBuildVersion(payload.previousStableTag.slice(7)) === null)) fail("invalid previous build tag");
  // All admitted fields are scalars/null. Sorted JSON is exactly the pinned
  // engine's canonical() representation for this restricted schema.
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((key) => [key, payload[key]])));
  if (typeof id !== "string" || id !== digest(canonical)) fail("shared plan integrity mismatch");
  return { ...payload, id };
}

async function listTags(read, normalize, repository) {
  const tags = [];
  const names = new Set();
  const path = (page) => `/repos/${repository}/tags?per_page=100&page=${page}`;
  for (let page = 1; page <= MAX_TAG_PAGES; page += 1) {
    const { data, headers } = await read(path(page));
    if (!Array.isArray(data)) fail("malformed tag enumeration");
    for (const item of data) {
      if (!isObject(item) || typeof item.name !== "string" || !item.name || names.has(item.name)
        || !isObject(item.commit) || typeof item.commit.sha !== "string" || !SHA.test(item.commit.sha)) fail("ambiguous tag enumeration");
      names.add(item.name);
      tags.push(item);
      if (tags.length > MAX_TAGS) fail("tag enumeration exceeds bound");
    }
    const link = typeof headers.link === "string" ? headers.link : "";
    const next = link.split(",").map((part) => part.match(/<([^>]+)>\s*;\s*rel="?next"?/)).find(Boolean);
    if (!next) return tags;
    if (await normalize(next[1]) !== path(page + 1)) fail("tag pagination does not continue this collection");
  }
  fail("tag enumeration exceeds page bound");
}

/** Read the full build inventory before admitting any repair, so another page
 * cannot hide conflicting operation evidence. Only exact annotated tags count.
 */
async function buildInventory(read, normalize, repository) {
  const tags = await listTags(read, normalize, repository);
  const operations = new Map();
  for (const tag of tags) {
    if (!tag.name.startsWith("build/v")) continue;
    if (parseBuildVersion(tag.name.slice(7)) === null) fail("invalid stable build tag");
    const { data: ref } = await read(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag.name)}`);
    if (!isObject(ref) || ref.ref !== `refs/tags/${tag.name}` || !isObject(ref.object)
      || ref.object.type !== "tag" || typeof ref.object.sha !== "string" || !SHA.test(ref.object.sha)) fail("build ref is not an exact annotated tag");
    const { data: object } = await read(`/repos/${repository}/git/tags/${ref.object.sha}`);
    if (!isObject(object) || object.sha !== ref.object.sha || object.tag !== tag.name
      || !isObject(object.object) || object.object.type !== "commit" || object.object.sha !== tag.commit.sha) fail("build tag target mismatch");
    const plan = publicationPlan(object.message, repository, tag.name, tag.commit.sha);
    if (operations.has(plan.operation)) fail("conflicting publications for one operation");
    operations.set(plan.operation, plan);
  }
  return operations;
}

/** A repaired record can clear only the exact already-successful deployment
 * whose frozen plan was used by this known historical workflow. Never writes.
 */
export function createBuildRepairProof(read, normalize, repository) {
  let inventory;
  return async function assertRepaired(expected, workflow) {
    if (!WORKFLOW_DIGESTS.has(digest(workflow))) fail("unsupported historical workflow wiring");
    inventory ??= buildInventory(read, normalize, repository);
    const plan = (await inventory).get(`routeware-build:${expected.runId}:${expected.attempt}`);
    if (!plan || plan.sha !== expected.sha) fail("exact deployed operation has no repaired publication");
    const { data: release } = await read(`/repos/${repository}/releases/tags/${encodeURIComponent(plan.tag)}`);
    if (!isObject(release) || release.tag_name !== plan.tag || release.target_commitish !== expected.sha
      || release.draft !== false || release.prerelease !== false || typeof release.body !== "string"
      || !release.body.includes(`<!-- calver-plan:${plan.id} -->`)
      || !release.body.split("\n").includes(`Source: ${expected.sha}`)) fail("repaired Release does not bind the deployed plan");
  };
}
