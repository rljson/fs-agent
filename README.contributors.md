<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Contributors Guide

- [The gate](#the-gate)
- [Before you change the sync](#before-you-change-the-sync)
- [How to measure a change](#how-to-measure-a-change)
- [Test conventions](#test-conventions)
- [Setup, develop, administrate](#setup-develop-administrate)
- [Pinned dependencies](#pinned-dependencies)

## The gate

```bash
pnpm test          # vitest --coverage --no-file-parallelism, then eslint
pnpm updateGoldens # re-record the snapshots, then READ the diff
```

**100 % on statements, branches, functions and lines**, and it is enforced.
Two things follow from that:

- **Never add `/* v8 ignore */` to avoid testing reachable code.** The marker
  is for a branch that genuinely cannot be taken, and it must say *why* after
  `@preserve`. Forty-nine of the markers here carry no reason, and seven dead
  ones hid among them for months — a whole constructor pattern that never
  worked, kept reachable by two tests that asserted nothing.
- **100 % coverage does not mean anything was checked.** A test with no
  `expect(` is not a test. If you find one, it is usually the only thing
  keeping dead code alive.

`--no-file-parallelism` is not a preference. Twenty-six files drive real
servers, sockets, watchers and timers; in parallel they fight over the cores
and invent failures.

## Before you change the sync

Read these first — each is short, and each records a defect that cost real
data:

1. [The design in one page](README.architecture.md#the-design-in-one-page) —
   five paragraphs, and the constraint everything follows from.
2. **An absence is not a deletion.** Four separate rules were built to infer a
   deletion from a tree's silence and all four were withdrawn. If a change you
   are making needs to know "did the sender delete this or never have it",
   stop: the answer is not available, which is why removals are stated.
3. **A node claims only what it changed.**
   [Authorship](README.architecture.md#authorship-a-node-claims-only-what-it-changed)
   — including the trap that claims are recorded *after* the push being judged,
   so a node is a stranger to its own newest work at that moment.
4. **No `await` in the push path.** The yield between "this is what I am
   announcing" and "this is the entry for it" lets another apply land in the
   middle. That alone cost a node its place in a ten-round run.
5. [doc/scenario-matrix.md](doc/scenario-matrix.md) — if the behaviour you are
   changing is a row there, that row names the test that must still pass.

## How to measure a change

**A pass count is a sample, not a measurement.** These suites carry several
units of run-to-run variance — more than most fixes move.

- Confirm a change with a run that **isolates** it (`-t "<name>"`, one file),
  **repeated**: three for a signal, **eight** before calling a mesh scenario
  fixed.
- Never compare two runs that differ in more than one change. A
  "6/8 → 4/8 regression" was once reported here from three runs whose only
  difference was a guard that logged zero hits.
- **Run the control.** A "conflicted copy" fix was once built on a theory a
  control run then disproved — there was nothing to copy.
- **Assert WHAT, not HOW MANY.** A cost test asserted "at most two blobs" and
  measured three; the third was the writer's own in-flight push and the second
  a blob the node already held. Naming the contents made it one, every run.
- A bound raised to swallow a known failure stops measuring anything.

```bash
# one scenario, repeated
for i in $(seq 1 8); do pnpm exec vitest run test/mesh/fs-mesh.spec.ts \
  -t "T4" --coverage.enabled=false; done
```

## Test conventions

- **`it.fails` for a known-red test, never `it.skip`.** An inverted test passes
  while the body fails and turns red the day it starts working. A skip is
  silent in both directions. Nine were committed inverted during the
  edit-chain work and all nine are now ordinary assertions.
- **A skip must carry its argument.** The one skip left in the package is a
  proof that the case is not decidable, written into the test.
- **`ORIGIN_FIXTURE`** (`{ joinWaitMs: 0 }`) says "this folder is the first
  state of its own history". Use it where that is true; set a real wait where
  the test means to exercise joining.
- **Tiers matter.** A decision-tier test proves a RULE, not that the rule is
  reached — and this package has had defects in the reaching, not the rule. See
  [README.tests.md](README.tests.md).
- **Goldens are reviewed, not accepted.** `pnpm updateGoldens` then read the
  diff. `test/goldens/example.log` snapshots the agent's own field layout, so
  adding a field is expected to change it.

## Setup, develop, administrate

| | |
| --- | --- |
| Machine setup | [doc/prepare.md](doc/prepare.md) |
| The development loop | [doc/develop.md](doc/develop.md) |
| Debugging in VS Code | [doc/debug-with-vscode.md](doc/debug-with-vscode.md) |
| Repository and ruleset setup | [doc/create-new-repo.md](doc/create-new-repo.md) |
| Fast coding | [doc/fast-coding-guide.md](doc/fast-coding-guide.md) |
| Code review | [doc/code-review.md](doc/code-review.md) |
| Goldens | [doc/update-goldens.md](doc/update-goldens.md) |

## Pinned dependencies

**Do NOT update ESLint to v10.x.** The package is pinned to `eslint ~9.39.2`
because `eslint-plugin-tsdoc@0.5.0` is incompatible with ESLint v10's API
changes — `context.getSourceCode()` was removed. Updating breaks the build.

**Bumping an `@rljson/*` dependency needs the `pnpm.overrides` entry too**, or
the old version stays installed and nothing tells you.
