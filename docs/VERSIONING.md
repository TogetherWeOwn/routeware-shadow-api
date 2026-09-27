# Versioning and release policy

`package.json#version` is the single source of truth for the release
version. The OpenAPI document (`GET /openapi.json`, `info.version`) reads it
via `src/lib/version.ts` — bumping `package.json` moves the spec version with
no other edit.

## Bump policy (semver)

- **Patch** (`x.y.z+1`): bug fixes, doc fixes, internal refactors, test-only
  changes. No consumer-visible contract change.
- **Minor** (`x.y+1.0`): new endpoints, new optional fields, new query
  parameters. Backwards compatible — existing consumers keep working.
- **Major** (`x+1.0.0`): removed or renamed endpoints, changed required
  fields, changed response shapes, changed auth requirements.

## Release checklist

1. Bump `version` in `package.json` (`npm version patch|minor|major
   --no-git-tag-version` keeps the edit local without tagging).
2. Add a `CHANGELOG.md` entry under a new `## [x.y.z]` heading describing
   consumer-visible changes.
3. The OpenAPI contract test (`test/openapiContract.test.ts`) asserts
   `info.version` equals `package.json#version`, and the full-document
   snapshot records the new version — run `npm test` and update the snapshot
   with `vitest run test/openapiContract.test.ts -u` only after confirming
   the version change is the sole diff.
