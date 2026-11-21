---
title: "Uploading to the pi gallery means npm publish, not a form"
kind: "instruction"
summary: "The pi gallery is an automated npm index keyed on the \"pi-package\" keyword — npm publish is the upload, no form exists, and the listing appears within minutes."
tags: [npm, publish, gallery, provenance]
created: "2026-11-21T03:39:04.159Z"
updated: "2026-11-21T03:39:04.159Z"
---
The pi package gallery at pi.dev/packages has no upload, submission form, PR or allowlist — it is an automated index of npm, so **publishing to npm is the upload**. The only requirement is the `pi-package` keyword on the published version; the index re-reads npm within a few minutes and the package then appears at `https://pi.dev/packages/<name>`. `https://pi.dev/api/packages` answers `501` ("API routes are reserved for future features"), which is the clearest evidence there is nothing to POST to.

```text
npm publish  ──> registry.npmjs.org ──2-3 min──> pi.dev/packages/<name>
                     ▲                             ▲
                     └── keyword "pi-package" ─────┘   (the only gate)
```

## Steps for an unscoped name

```sh
npm login                        # or: npm login --auth-type=web
npm view pi-managed-tools        # 404 = name is free
npm publish                      # unscoped: no --access public needed
pi install npm:pi-managed-tools  # verify the published artifact installs
```

## What decides whether it is findable

- `keywords` must contain `pi-package`. Nothing else about the manifest gates listing — packages in the index were observed with no `repository`, no `pi` manifest and pre-release versions.
- `files` decides what ships. Here: `src/`, `skills/`, `README.md`, `CHANGELOG.md` (LICENSE is always included) — `tests/` and `scripts/` are excluded while staying in git.
- `pi.` fields (`extensions`, `skills`, `changelogPath`) tell pi what to load from the tarball.

## Pitfalls

- **A published version is effectively permanent.** Unpublish is only possible within 72 hours and the number stays burned afterwards, so check `npm pack --dry-run` first.
- **Provenance is the only credibility signal available**, since the gallery does no review: `npm publish --provenance` from GitHub Actions with `permissions: id-token: write` ties the tarball to the commit. For a package that downloads and executes binaries, that is worth more than any README claim.
- Never vendor the downloaded binaries into the tarball — `shellcheck` is GPL-3.0 and this package is GPL-2.0-only.
