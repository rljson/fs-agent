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
pnpm test     # 72 files, 988 scenarios, 100 % coverage, then eslint
```

## Where to start

| if you are | read |
| --- | --- |
| **using the package** | [README.public.md](README.public.md) — install, the production configuration, every option and what it costs, troubleshooting |
| **deciding whether to trust it** | [README.tests.md](README.tests.md) — what the 988 scenarios actually prove, and what they cannot |
| **changing the sync** | [README.architecture.md](README.architecture.md) — the mechanism, and why each rule exists |
| **calling the API** | [README.api.md](README.api.md) — every export, grouped by module, with what it costs |
| **setting the repo up** | [README.contributors.md](README.contributors.md) — run, debug, build, publish |
| **stuck** | [README.trouble.md](README.trouble.md) |

## Reference

| document | what is in it |
| --- | --- |
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
