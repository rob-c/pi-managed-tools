---
title: "GPLv2-only relicensing is gated on dependency licences"
kind: "decision"
summary: "GPLv2-only relicensing depends on your dependencies, not your code: all imports are MIT so it is allowed, but Apache-2.0 anywhere in YOUR deps would block it — and do it before the first commit."
tags: [licensing, gplv2, spdx, dependencies, git]
created: "2026-11-21T03:25:46.886Z"
updated: "2026-11-21T03:26:19.022Z"
---
Relicensing this project to GPLv2-only is allowed because every package it imports is MIT — the check that decides it is **not** your own code but the licences of your dependencies, and the one that would have blocked it is Apache-2.0, which GPLv2 cannot accept. Do the relicence **before the first commit**: with no git history and no contributors there is nobody to negotiate with and no MIT snapshot anyone can claim to have received.

```text
who owns it?          no git history, no external PRs  -> you own all of it   OK
your dependencies?    pi + @earendil-works/* + typebox -> MIT                  OK
                      Apache-2.0 in YOUR deps          -> GPLv2 conflict      STOP
host's dependencies?  pi's own tree has 5 Apache-2.0 pkgs, but pi is a
                      peerDependency you never bundle -> not your problem     OK
vendored binaries?    shellcheck (GPLv3), busybox (GPLv2) fetched at runtime
                      = user-initiated, not redistribution                   OK
                      anything vendored into the tarball                     STOP
```

## The checks, in order

1. `git log` — if there are outside commits, relicensing needs their authors' consent (or a CLA/DCO collected up front).
2. Every package **you** import: `node -e 'console.log(require("PKG/package.json").license)'` or `npm view PKG license`. MIT ✓, ISC ✓, BSD ✓, Apache-2.0 ✗ for GPLv2 (it is GPLv3-only), stricter GPL ✗.
3. Anything vendored or bundled, as opposed to fetched: a GPLv3 binary inside a GPLv2-only package is a conflict; fetching it from upstream on the user's machine is not.
4. Use the SPDX `-only` form: `"license": "GPL-2.0-only"`. Bare `"GPL-2.0"` is deprecated and ambiguous about "or later".

## Why the host's transitive licences do not block

pi is declared as a `peerDependency` and is never bundled — pi's docs forbid bundling host-provided packages anyway. Its 22 dependencies include Apache-2.0 packages, but those are supplied by the user's own pi installation, so no Apache-2.0 code ends up in this package's tarball. The moment this project bundled pi, or vendored a GPLv3 binary, that reasoning collapses.

## Alternatives and what they cost

GPLv2-only excludes teams whose policy forbids GPL tooling. **MPL-2.0** is file-level copyleft and much more corporate-tolerable; **GPL-3.0-only** accepts Apache-2.0 dependencies if one is ever added.
