import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildVersion } from "../src/lib/buildVersion.ts";

const REPOSITORY = "TogetherWeOwn/routeware-shadow-api";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function operation(context) {
  requireValue(context.repository === REPOSITORY, "unexpected build repository");
  requireValue(typeof context.sha === "string" && context.sha.length === 40 && /^[0-9a-f]{40}$/.test(context.sha), "exact lowercase build SHA required");
  requireValue(Number.isSafeInteger(context.runId) && context.runId > 0, "positive safe run ID required");
  requireValue(Number.isSafeInteger(context.attempt) && context.attempt > 0, "positive safe attempt required");
  requireValue(context.eventName === "push" && context.ref === "refs/heads/main", "build release requires a main push");
  return `routeware-build:${context.runId}:${context.attempt}`;
}

export function planBuildRequest(context) {
  if (context.enabled !== true) return null;
  return {
    phase: "plan",
    input: {
      channel: "stable",
      sha: context.sha,
      operation: operation(context),
      policy: "direct-release",
      namespace: "build",
      latest: "never"
    }
  };
}

export function publishBuildRequest(plan, context) {
  if (context.enabled !== true || context.deployOutcome !== "success") return null;
  const expectedOperation = operation(context);
  requireValue(plan && typeof plan === "object" && !Array.isArray(plan), "frozen build plan required");
  requireValue(plan.schema === "calver-plan-v1" && plan.repository === REPOSITORY, "unexpected build plan schema/repository");
  requireValue(plan.sha === context.sha && plan.operation === expectedOperation, "build plan does not bind this deployment");
  requireValue(plan.channel === "stable" && plan.namespace === "build" && plan.policy === "direct-release" && plan.latest === "never", "build release must remain stable and non-Latest");
  const version = parseBuildVersion(plan.version);
  requireValue(version !== null && plan.tag === `build/v${version}`, "invalid build plan version/tag");
  const [year, mdd] = version.split(".");
  const date = `${year}-${mdd.slice(0, -2).padStart(2, "0")}-${mdd.slice(-2)}`;
  requireValue(plan.date === date && context.deployedVersion === version, "published identity differs from the deployed frozen plan");
  requireValue(typeof plan.id === "string" && plan.id.length === 64 && /^[0-9a-f]{64}$/.test(plan.id), "build provenance required");
  requireValue(plan.repairDate === null && plan.sourceCanary === null && plan.source === null && plan.evidence === null, "ordinary build publication cannot repair or substitute staging proof");
  // The pinned shared publisher verifies full provenance and immutable refs.
  return { phase: "publish", plan };
}

// Actions expressions enter through data, never executable shell or user JSON.
function main() {
  const context = {
    repository: process.env.CALVER_REPOSITORY,
    sha: process.env.CALVER_SHA,
    runId: Number(process.env.CALVER_RUN_ID),
    attempt: Number(process.env.CALVER_ATTEMPT),
    enabled: process.env.CALVER_ENABLED === "true",
    eventName: process.env.CALVER_EVENT,
    ref: process.env.CALVER_REF,
    deployOutcome: process.env.CALVER_DEPLOY_OUTCOME,
    deployedVersion: process.env.BUILD_VERSION
  };
  const phase = process.argv[2];
  requireValue(phase === "plan" || phase === "publish", "expected plan or publish phase");
  const request = phase === "plan"
    ? planBuildRequest(context)
    : publishBuildRequest(JSON.parse(process.env.CALVER_PLAN || "null"), context);
  requireValue(typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT.length > 0, "Actions output file required");
  appendFileSync(process.env.GITHUB_OUTPUT, `request=${request ? JSON.stringify(request) : ""}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
