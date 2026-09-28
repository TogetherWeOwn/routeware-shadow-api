# Security Policy

If you believe you have found a security vulnerability in this repository,
thank you — please report it privately so it can be fixed before it is
disclosed. **Do not open a public issue, discussion, or PR for a suspected
vulnerability.**

## How to report

Use **GitHub private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Select **Advisories**, then **Report a vulnerability** (draft a security
   advisory).

Please include, to the extent you can without exfiltrating real data:

- what is affected (route, file, or configuration),
- steps to reproduce against a local/dev deployment (`npm run dev`),
- the impact you see, and
- whether real credentials, tokens, or personal data were accessed
  (say so plainly so rotation can be prioritised — do **not** paste the
  values themselves into the report).

Do not include secrets, passwords, tokens, or personal data in the report
itself. Redact values; describe them by name (e.g. `SHADOW_API_TOKEN`)
instead.

## Scope

In scope:

- this repository's Worker code (`src/`), its authentication and
  authorization checks, and its data routes;
- D1 migrations and local/dev configuration shipped in this repo;
- the CI workflow (`.github/workflows/ci.yml`) insofar as it guards the
  above (e.g. secret/PII hygiene checks).

Out of scope (do not test against these):

- the upstream Routeware tenant and any production Cloudflare resources —
  use local dev (`npm run dev`) or fixtures instead;
- third-party dependencies themselves (report those to the upstream
  project; reports about a dependency are in scope only if this repo
  uses it unsafely);
- social engineering, physical attacks, and spam/phishing reports.

## Response SLA

We aim to:

- **acknowledge** your report within **72 hours**,
- complete **triage** (valid / not valid, severity) within **7 days**, and
- ship a fix or publish a remediation plan within **30 days** for
  confirmed issues.

If a report goes unacknowledged past these windows, a brief follow-up on
the same advisory thread is welcome. Fixes are credited on request —
tell us in the report how you would like to be named (or that you prefer
to stay anonymous).

## Safe harbor

Good-faith security research conducted within the scope above and without
accessing, modifying, or exfiltrating real user data will be treated as
authorized. We will not pursue legal action against researchers who follow
this policy, and we ask that you give us a reasonable window to remediate
before any public disclosure.

Please do not: access other users' data, degrade service availability,
or retain or disclose any data you may inadvertently encounter — delete
local copies and tell us what was reached so it can be contained.

## Background for maintainers

The history of a past credential/PII exposure in this repository's
lineage, its purge, and the rotation and hygiene steps around it are
recorded in [`docs/SECURITY-REMEDIATION.md`](./docs/SECURITY-REMEDIATION.md).
Read that document before any repository-visibility change or credential
rotation; it is required reading alongside this policy, not a substitute
for it.
