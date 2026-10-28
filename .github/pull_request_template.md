<!--
Title: Conventional Commits header, e.g. `fix(auth): refuse expired sudo sessions`.
Types: feat fix perf refactor test docs build ci chore revert style security. Max 100 chars, no trailing period.
Keep issue numbers out of the title. Link them under "Linked Issues" instead.
Write short, plain sentences. Fill in every section: the `pr-lint` check reads them.
Full rules: CONTRIBUTING.md, "Pull request standards".
-->

## Thinking Path

<!--
  Required. Trace your reasoning from the project down to this change, as a blockquote.
  Start with what this repo is, narrow through the subsystem and the problem, and end with
  why this PR exists. Aim for 5-8 steps; the check needs at least 3 real ones.
-->

> - routeware-shadow-api is a Cloudflare Worker fronting the Routeware admin site, with authenticated API routes and D1 snapshots archived to R2
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

<!--
  Required for feat, fix, perf, refactor and security. Pick ONE:
  (A) Issue exists: link the GitHub issue, e.g. `Fixes #123` or `Refs #123`.
  (B) No issue exists: describe the problem here in your own words.
-->

Fixes #

## What Changed

<!-- One bullet per logical unit. -->

-

## Verification

<!-- Commands you ran and their results, so a reviewer can repeat them. -->

-

## Risks

<!-- Migration safety, breaking changes, behaviour shifts, credential or host impact. "Low risk" if genuinely minor. -->

-

## Model Used

<!--
  Required. Provider, exact model ID or version, context window, reasoning mode and tool use if known.
  If no AI model was used, write "None - human-authored".
-->

-

## Checklist

- [ ] I wrote a thinking path that runs from the project to this change
- [ ] I named the model used, with its version
- [ ] I searched for duplicate or related PRs and linked them above
- [ ] I ran the tests locally and they pass
- [ ] I added or updated tests where applicable
- [ ] I updated the documentation this change touches
- [ ] No secret, token or credential is in the diff, the title, the body or the branch name
- [ ] CI is green on the exact head before I ask for review
- [ ] I followed `docs/CONVENTIONS.md` and kept the authentication, PII and no-network-test invariants intact
- [ ] I added an issue-referencing bullet as a `changelog/unreleased/<number>-<slug>.md` fragment for any consumer-visible contract change, or this is docs/test/scripts/CI-only
- [ ] I did not run a production deploy or remote migration as ordinary development
