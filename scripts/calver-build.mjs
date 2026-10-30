import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildVersion } from "../src/lib/buildVersion.ts";
import { assertBuildPublicationHistory } from "./lib/buildPublicationHistory.mjs";

export { assertBuildPublicationHistory };

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

function readContext() {
  return {
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
}

// Read-only provider transport for the admission guard. It only issues GETs and
// carries the job's own token; nothing here writes tags, Releases or deployments.
// The token is validated on first use so a disabled context, which performs no
// reads at all, never needs one.
function githubTransport(token) {
  return {
    async request(method, path) {
      requireValue(method === "GET", "history admission is read-only");
      requireValue(typeof token === "string" && token.length > 0, "GitHub token required for history admission");
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "routeware-shadow-api-build-admission"
        }
      });
      const text = await response.text();
      let data = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { status: response.status, headers: { link: response.headers.get("link") ?? undefined }, data };
    }
  };
}

// Actions expressions enter through data, never executable shell or user JSON.
async function main() {
  const context = readContext();
  const phase = process.argv[2];
  requireValue(phase === "history" || phase === "plan" || phase === "publish", "expected history, plan or publish phase");
  if (phase === "history") {
    await assertBuildPublicationHistory(context, githubTransport(process.env.GITHUB_TOKEN));
    return;
  }
  const request = phase === "plan"
    ? planBuildRequest(context)
    : publishBuildRequest(JSON.parse(process.env.CALVER_PLAN || "null"), context);
  requireValue(typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT.length > 0, "Actions output file required");
  appendFileSync(process.env.GITHUB_OUTPUT, `request=${request ? JSON.stringify(request) : ""}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`calver-build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
