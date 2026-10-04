<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent

**Keeps a folder on several machines the same, without a central authority
deciding what the folder contains.**

Each machine watches its own folder, writes down what changed, and tells the
others. A hub relays and never arbitrates. Two people editing at once get one
agreed result with both versions kept; a machine switched off for a week
catches up without replaying the week; and a deletion travels as a stated fact
rather than being inferred from a file being missing — which is the design
decision everything else follows from.

```bash
npm install @rljson/fs-agent
pnpm test     # 69 files, 806 scenarios, 100 % coverage, then eslint
```

## Where to start

| if you are | read |
| --- | --- |
| **using the package** | [README.public.md](README.public.md) — install, the production configuration, every option and what it costs, troubleshooting |
| **deciding whether to trust it** | [README.tests.md](README.tests.md) — what the 806 scenarios actually prove, and what they cannot |
| **changing the sync** | [README.architecture.md](README.architecture.md) — the design, and why each rule exists |
| **setting the repo up** | [README.contributors.md](README.contributors.md) — run, debug, build, publish |
| **stuck** | [README.trouble.md](README.trouble.md) |

## Reference

| document | what is in it |
| --- | --- |
| [doc/scenario-matrix.md](doc/scenario-matrix.md) | every way a folder and a history can disagree, what must happen, and which tier proves it |
| [doc/known-limits.md](doc/known-limits.md) | what has been measured and accepted — and the five entries now closed |
| [doc/q3-backlog-status.md](doc/q3-backlog-status.md) | the open quality and stability items, answered from this package |
| [doc/lab-recipe-coverage.md](doc/lab-recipe-coverage.md) | which of the lab's E2E recipes are answered here, and which need real machines |
| [doc/conflict-resolution-design.md](doc/conflict-resolution-design.md) | how a winner is chosen, and how a conflict copy is named |
| [doc/safety-rescan.md](doc/safety-rescan.md) | the periodic rescan, and the watcher gaps it covers |
| [doc/develop.md](doc/develop.md) · [doc/prepare.md](doc/prepare.md) | the development loop and machine setup |
| [src/client-server/README.md](src/client-server/README.md) | the client–server rules, with a component diagram |
| [CHANGELOG.md](CHANGELOG.md) | releases |
| [README.blog.md](README.blog.md) | notes, newest last |

## Before you upgrade an existing fleet

**Every tree ref changes.** Content identity now fixes a canonical child order
and excludes file modification times. Nothing is destroyed and no data moves,
but the fleet reads divergent until every machine has re-scanned, so upgrade
them together. See
[Rolling Out](README.architecture.md#rolling-out-what-a-peer-can-notice).
