# OpenAPI contract-drift check (TOG-6282)

**Status:** script + unit tests merged; CI/schedule wiring pending operator
publication (no new services, no paid tiers, no new secrets — same constraint
as the cron alarm runbook).

**Why:** a route module built on plain `Hono` instead of `createRouteModule()`
still serves traffic while silently dropping every one of its routes from
`/openapi.json` (`OpenAPIHono.route()` merges a sub-app's registry only for
`OpenAPIHono` instances). The runtime contract test
(`test/openapiContract.test.ts`) pins this under workerd; this check pins it
statically and credential-free so it can run in CI hygiene and on a nightly
schedule with no Worker runtime, no secrets, and no network access
(CONVENTIONS.md §3).

## 0. The command

```bash
node scripts/check-openapi-drift.mjs
# openapi-drift: OK — 34/34 declared op(s) published across 11 mounted module(s)
```

Reads `src/app.ts` (mounts) and `src/routes/*.ts` (declared
`createRoute({ method, path })` vs registered `<module>.openapi(<route>, …)`).
Exit 0 when every declared op is published; exit 1 naming each dropped op (or
module) with its cause; exit 2 when an input is missing/unreadable — never a
missing file reported as a pass. Flags (for fixture-driven proofs without
touching `src/`):

```bash
node scripts/check-openapi-drift.mjs --app=<path> --routes-dir=<path>
```

Pure rule lives in `scripts/lib/openapiDriftCheck.mjs`, unit-tested by
`test/openapiDriftCheck.test.ts` without Wrangler, credentials, or network.

## 1. What it flags (cause → fix)

| Cause | Meaning | Fix |
|---|---|---|
| plain-Hono module | Module not built with `createRouteModule()` (bare `hono` import, `new Hono(`, or `.get(…)`/`.post(…)` direct handlers). Served, undocumented. | Rebuild with `createRouteModule()`; register each route via `<mod>.openapi(…)`. |
| declared, never registered | `createRoute()` const with no matching `<mod>.openapi(<name>, …)`. Serves nothing, documents nothing. | Register it, or delete the dead declaration. |
| exported, never mounted | `*Routes` export with no `app.route(…)` mount. Unreachable and undocumented. | Mount it in `src/app.ts` (before the doc endpoints, after the two `/api/v1/*` gates), or delete it. |
| mounted, unreadable | `app.route()` name with no resolvable import. | Fix the import, or remove the mount. |

`.openapi("Name")` schema-naming calls never count as registrations — only
`.openapi(<routeIdent>, …)` does.

## 2. Acceptance proof: dummy plain-Hono route fails the gate

The unit test mounts a synthetic plain-Hono module (new `Hono()` + a direct
`.get("/api/v1/widget", …)`) and asserts both declared ops drop with the
plain-Hono cause named. To replay against fixtures by hand:

```bash
mkdir -p /tmp/drift-proof/routes
cat > /tmp/drift-proof/app.ts <<'EOF'
import { dummyRoutes } from "./routes/dummy";
app.route("/", dummyRoutes);
EOF
cat > /tmp/drift-proof/routes/dummy.ts <<'EOF'
import { Hono } from "hono";
export const dummyRoutes = new Hono();
dummyRoutes.get("/api/v1/dummy", (c) => c.json({}));
EOF
node scripts/check-openapi-drift.mjs --app=/tmp/drift-proof/app.ts --routes-dir=/tmp/drift-proof/routes
# openapi-drift: mounted via app.route() but module file src/routes/dummy.ts could not be read
```

(The fixture import `./routes/dummy` resolves to `src/routes/dummy.ts`
relative to the repo root; point `--routes-dir` at a real `src/routes`
overlay for a full mountable proof, or rely on the unit test, which wires the
same regression directly through `runDriftCheck`.) A reviewer can also verify
live: temporarily rebuild any one module on plain `Hono` in a scratch
worktree and watch the check name every dropped op.

## 3. Schedule (for operator publication — not yet wired)

Nightly, credential-free, alongside the other static gates. Until an
operator publishes it, run by hand after any route-module change:

- **Cadence:** nightly on `main` (schedule trigger) + every PR touching
  `src/routes/` or `src/app.ts` (path filter). Detection latency ≤ 24h, same
  bound as the cron alarm loop.
- **Where:** a `schedule: cron: "0 6 * * *"` trigger on the hygiene job
  (build/hygiene stay credential-free per `check-ci-workflow`; this check
  reads source text only, so it needs no token).
- **Alerting:** the step's non-zero exit fails the run — the finding IS the
  alert (name, op, cause in the log). No paging tier, same posture as the
  coverage ratchet and per-file gate. Record the disposition where the team
  looks.

Snippets for the wiring change (one `package.json` line, one hygiene step,
one `check-ci-workflow` pin — bundled together when an operator publishes):

```json
"check:openapi-drift": "node scripts/check-openapi-drift.mjs",
```

```yaml
- name: OpenAPI contract drift — no silent route drops (TOG-6282)
  run: npm run check:openapi-drift
```

```js
assert.match(
  hygiene,
  /npm run check:openapi-drift/,
  "hygiene must run the OpenAPI contract-drift check (TOG-6282)"
);
```

## 4. What this check does not cover

- Runtime-only divergence (a handler that throws, an auth gate mis-order):
  that is `test/openapiContract.test.ts` territory under workerd.
- Whether the documented schemas match upstream Routeware shapes: the
  discovery recorder (`tools/api-discovery/`) owns that.
