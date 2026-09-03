#!/usr/bin/env node
/**
 * Verifies the five GitHub-side preconditions the `deploy` job needs before a
 * merge to `main` can ship (docs/HANDOVER.md § 0). Reads only; changes nothing.
 *
 *   node scripts/check-ci-enabled.mjs
 *
 * Requires a token with `administration:read` and `actions:read` on the repo.
 * The Paperclip GitHub App token does NOT carry those scopes — it is
 * contents/pull_requests/issues/metadata only, so every check below reports
 * UNKNOWN under it. That is the point: an unreadable check is never green.
 *
 *   export GH_TOKEN=<a PAT with repo admin read>
 *
 * Exit 0 = every precondition confirmed present. Exit 1 = at least one is
 * missing or unreadable. There is no partial pass.
 */
import { env, argv, exit } from "node:process";

const repo = argv[2] ?? "TogetherWeOwn/routeware-shadow-api";
const token = env.GH_TOKEN || env.GITHUB_TOKEN;

if (!token) {
  console.error("Set GH_TOKEN (or GITHUB_TOKEN) to a token with repo admin read.");
  exit(1);
}

/** The exact names the workflow pins. Changing either here without changing
 *  .github/workflows/ci.yml makes this script lie. */
const ENVIRONMENT_NAME = "production";
const SECRET_NAME = "CLOUDFLARE_API_TOKEN";

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "routeware-shadow-api-ci-check",
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // A 204 or an empty body is legitimate; leave body null.
  }
  return { status: res.status, body };
}

const PASS = "PASS";
const FAIL = "FAIL";
const UNKNOWN = "UNKNOWN";

/**
 * A 403/404 from an endpoint that exists means "this token cannot see it", which
 * is NOT the same as "it is not configured". Reporting that as FAIL would invent
 * a finding; reporting it as PASS would hide one. It gets its own state.
 */
function classify(status, { ok, missing }) {
  if (status === 200) return ok();
  if (status === 404 && missing) return missing();
  if (status === 403 || status === 404) {
    return [UNKNOWN, `HTTP ${status} — token lacks the scope to read this`];
  }
  return [UNKNOWN, `HTTP ${status} — unexpected`];
}

const checks = [
  {
    name: "Actions enabled on the repository",
    hint: "Settings → Actions → General → Allow all actions",
    async run() {
      const { status, body } = await gh("/actions/permissions");
      return classify(status, {
        ok: () =>
          body?.enabled === true
            ? [PASS, `enabled=true (allowed_actions=${body.allowed_actions ?? "n/a"})`]
            : [FAIL, "enabled=false — Actions is administratively disabled"],
      });
    },
  },
  {
    name: `Environment "${ENVIRONMENT_NAME}" exists`,
    hint: `Settings → Environments → New environment → name it exactly ${ENVIRONMENT_NAME}`,
    async run() {
      const { status, body } = await gh(
        `/environments/${encodeURIComponent(ENVIRONMENT_NAME)}`
      );
      return classify(status, {
        ok: () => {
          const reviewers = body?.protection_rules?.find(
            (r) => r.type === "required_reviewers"
          );
          return [
            PASS,
            reviewers
              ? "exists, with required reviewers"
              : "exists — no required reviewers (deploys are unattended)",
          ];
        },
        missing: () => [
          FAIL,
          `absent — the deploy job pins environment: ${ENVIRONMENT_NAME}, so the secret cannot resolve`,
        ],
      });
    },
  },
  {
    name: `Secret ${SECRET_NAME} set in that environment`,
    hint: `gh secret set ${SECRET_NAME} --env ${ENVIRONMENT_NAME} --repo ${repo}`,
    async run() {
      const { status, body } = await gh(
        `/environments/${encodeURIComponent(ENVIRONMENT_NAME)}/secrets`
      );
      return classify(status, {
        ok: () => {
          const names = (body?.secrets ?? []).map((s) => s.name);
          return names.includes(SECRET_NAME)
            ? [PASS, "present (value is not readable, and is not checked here)"]
            : [
                FAIL,
                `absent — environment secrets are: ${names.join(", ") || "(none)"}`,
              ];
        },
        // A 404 here is ambiguous: either the environment is genuinely absent
        // (the check above reports that) or the token cannot see it. Do not
        // assert which — say only what is known.
        missing: () => [
          UNKNOWN,
          "not readable — the environment is absent, or the token cannot see it",
        ],
      });
    },
  },
  {
    name: "Branch protection on main",
    hint: "A merge to main deploys straight to production; there is no staging.",
    async run() {
      // `/branches/main` exposes a boolean `protected` and needs only
      // metadata:read, so this yields a real verdict even under a token that
      // cannot read the full protection object. Ask it first.
      const summary = await gh("/branches/main");
      if (summary.status === 200 && summary.body?.protected === false) {
        return [FAIL, "main is NOT protected"];
      }

      const { status, body } = await gh("/branches/main/protection");
      return classify(status, {
        ok: () => {
          const checksRequired =
            body?.required_status_checks?.contexts?.length ?? 0;
          const reviews = body?.required_pull_request_reviews ? "reviews" : "no reviews";
          return [PASS, `protected (${checksRequired} required checks, ${reviews})`];
        },
        missing: () => [FAIL, "main is NOT protected"],
      });
    },
  },
  {
    name: "A workflow run exists (proves Actions actually fires)",
    hint: "Re-enabling does not retroactively build. Push a trivial commit to trigger one.",
    async run() {
      const { status, body } = await gh("/actions/runs?per_page=1");
      return classify(status, {
        ok: () =>
          (body?.total_count ?? 0) > 0
            ? [PASS, `${body.total_count} run(s); latest: ${body.workflow_runs?.[0]?.conclusion ?? "in progress"}`]
            : [FAIL, "zero runs — nothing has ever executed on this repo"],
      });
    },
  },
];

console.log(`Checking ${repo}\n`);

const results = [];
for (const check of checks) {
  let state;
  let detail;
  try {
    [state, detail] = await check.run();
  } catch (err) {
    [state, detail] = [UNKNOWN, `check threw: ${err.message}`];
  }
  results.push({ ...check, state, detail });
  const mark = state === PASS ? "✔" : state === FAIL ? "✘" : "?";
  console.log(`${mark} [${state}] ${check.name}`);
  console.log(`    ${detail}`);
  if (state !== PASS) console.log(`    → ${check.hint}`);
}

const failed = results.filter((r) => r.state === FAIL);
const unknown = results.filter((r) => r.state === UNKNOWN);

console.log("");
if (failed.length === 0 && unknown.length === 0) {
  console.log("All preconditions confirmed. CI is live and main is protected.");
  exit(0);
}
if (unknown.length) {
  console.log(
    `${unknown.length} check(s) UNKNOWN — the token cannot read them. This is not a pass;\n` +
      "re-run with a token carrying administration:read and actions:read."
  );
}
if (failed.length) {
  console.log(`${failed.length} precondition(s) missing. Runbook: docs/HANDOVER.md § 0.`);
}
exit(1);
