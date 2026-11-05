# Unreleased changelog fragments

One file per consumer-visible change, named `<issue-or-PR-number>-<slug>.md`
(for example `432-customer-service-policy-scopes.md`). The file holds the
bullet exactly as it would read under `CHANGELOG.md` `## [Unreleased]`:

```
- #432: One-paragraph, consumer-facing description ...
```

`npm run check:changelog` counts a fragment like a bullet under
`## [Unreleased]`, so adding a fragment satisfies the gate without editing a
shared line. Do not add new bullets to `CHANGELOG.md` itself.

At release, move every fragment's text under the new `## [x.y.z]` heading
(see `docs/VERSIONING.md`) and delete the fragment files.
