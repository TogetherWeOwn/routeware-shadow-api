# Dependency installation policy

## Native npm controls

Use Node 24+ and npm 11.19+ for dependency changes. Both the repository root and
standalone `tools/api-discovery` package have their own `.npmrc`:

```ini
min-release-age=3
ignore-scripts=true
```

Use `npm ci --include=dev` at either package root for a clean locked install.
`npm run discovery:setup` does the discovery clean install, then explicitly runs
`playwright install chromium`. No blanket hook re-enable or package exemption is
needed. `dev` and `typecheck` invoke their prerequisites explicitly because npm
also suppresses pre/post hooks for named commands under `ignore-scripts`.

Older npm versions may ignore the age option; Node's version alone does not prove
npm supports it. Check `npm --version`, `npm config get min-release-age` (3), and
`npm config get ignore-scripts` (true), including with
`npm --prefix tools/api-discovery config get ...`. CI's existing Node 24 setup
does not separately pin npm, so age enforcement there remains dependent on the
runner's bundled npm. No CI age-enforcement claim is made for unsupported npm.

Release-age filtering is not an artifact safety guarantee or a retrospective
lock audit. Existing locked packages, missing publication timestamps, direct
URLs, Git and local sources need separate review. This change uses only locked
`registry.npmjs.org` tarballs with integrity metadata; no non-registry source or
age exemption was introduced. A fresh security patch blocked by the age policy
requires a narrow reviewed decision, not a global relaxation or an audit waiver.

## Reviewed hook inventory (2026-11-05)

There are no root or discovery install/prepare/pack hooks. Exact registry tarballs
were compared with lockfile SHA-512 integrity before reviewing their manifests
and the candidate install sources:

| Scope | Package/version | Candidate hook | Disposition |
| --- | --- | --- | --- |
| Root | esbuild 0.27.3 | `postinstall: node install.js` | Disabled; platform optional package supplies the binary. |
| Root | workerd 1.20260421.1 | `postinstall: node install.js` | Disabled; platform optional package supplies the binary. |
| Root | sharp 0.34.5 | `install: node install/check.js \|\| npm run build` | Disabled; no source-build exception. |
| Both | fsevents 2.3.3 | lock flags install script; manifest has no install hook | Disabled; macOS-only optional native package. |
| Discovery | esbuild 0.28.2 | `postinstall: node install.js` | Disabled; platform optional package supplies the binary. |
| Discovery / Playwright | fsevents 2.3.2 | lock flags install script; manifest has no install hook | Disabled; restored optional transitive from the compatible Playwright release. |

Playwright and playwright-core 1.59.1 and 1.64.1 have no install hooks. Browser
installation is a separately named, explicit setup action. Exact package versions,
registry URLs and full integrity values are retained in the two lockfiles.
No script exceptions are approved; therefore no exception reviewer or expiry is
applicable. Re-review any new candidate hook before changing this disposition.

## Discovery host compatibility

The previous Playwright 1.59.1 artifact maps Chromium and headless-shell downloads
for macOS 13 (Intel/ARM), Ubuntu 20.04 and Debian 11 (x64/ARM64). The 1.64.1 artifact
sets those paths to `undefined`. Restore and exactly pin 1.59.1 in both manifest
and lockfile instead of changing the OS contract or requiring manual system
Chrome. Retain the other security dependency updates.

On 2026-11-05, the installed 1.59.1 CLI's `install chromium --dry-run` succeeded
for all six host-platform overrides. All 12 distinct primary URLs it emitted
(Chromium, headless shell and FFmpeg) answered HTTP 200 to HEAD requests.
This proves installer planning and archive availability, **not** browser runtime
execution on those OS images. Actual headed recording on older hosts was not run.
An npm audit without a Playwright advisory does not establish that a bundled
browser has no vulnerabilities. Future upgrades must recheck both host behavior
and advisories; the pin is not an audit exemption.

## Verification evidence

- npm 11.19.0 / Node 24.21.0: clean root and discovery `npm ci --include=dev`
  succeeded with both native controls active and all hooks disabled.
- A disposable first-party loopback registry probe offered an old and a just-now
  release plus a harmless postinstall marker. Native npm selected the old release,
  refused an exact request for the fresh release (`ETARGET`), and did not write
  the marker. This was a manual enforcement probe, not a networked repository test.
- Changed locked package publication timestamps were independently inspected;
  all exceed three days. The newest retained root update was postcss 8.5.32
  (2026-10-26); discovery esbuild 0.28.2 and tsx 4.23.15 are older still.
- Discovery audit: zero vulnerabilities. Existing combined production/discovery
  audit gate: pass with the same three existing root advisory exceptions. The
  full root install still reports 15 affected packages (13 high, one moderate,
  one low); this change adds no exception and does not claim to remove all debt.
- The setup/policy regression tests failed before the fix. They also cover
  explicit dev/typecheck prerequisites and run in `test:probe` and
  `test:discovery`. Browser plans and archive HEAD probes are manual evidence,
  not claims of full OS-matrix end-to-end testing.

- Full local coverage verification passed: 298 Vitest files, 17,893 passed tests
  and two expected failures, plus 982 Node probe tests. Typecheck, lint, discovery
  tests, console checks, docs links, coverage guards and Worker dry-run build
  passed without install-hook exceptions. This is local evidence, not exact-head
  Actions evidence; no deployment or real-tenant recording was run.
- Existing Dependabot entries cover both npm roots and GitHub Actions with no
  shorter cooldown override or exclusion. Preserve the implicit three-day
  version-update cooldown and the parked zero-PR limits; no frozen automation was
  restarted. Dependabot security updates are not covered by that cooldown.

REA angle: reuse npm's shipped release-age and script controls, and inspect the
exact Playwright browser registry artifacts rather than add a custom installer
or silently narrow the supported-host contract.
