<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Trouble shooting

Development and test-environment problems. For problems **running** the agent,
see [README.public.md](README.public.md#troubleshooting).

- [Tests fail in ways that do not reproduce](#tests-fail-in-ways-that-do-not-reproduce)
- [A test leaves folders behind](#a-test-leaves-folders-behind)
- [The coverage gate fails but every test passes](#the-coverage-gate-fails-but-every-test-passes)
- [A golden fails after an unrelated change](#a-golden-fails-after-an-unrelated-change)
- [A mesh test hangs instead of failing](#a-mesh-test-hangs-instead-of-failing)
- [VS Code on Windows: debugging is not working](#vs-code-on-windows-debugging-is-not-working)

## Tests fail in ways that do not reproduce

Run the suite the way `package.json` defines it. `vitest run` **without**
`--no-file-parallelism` puts twenty-six integration files — real servers, real
sockets, real watchers, real timers — in contention over the cores, and invents
failures that look exactly like product defects. Four different tests once
failed across four CI runs of the same commit, each passing on re-run.

If a single mesh scenario is flaky, that is information, not noise: run it
eight times before concluding anything either way.

## A test leaves folders behind

The mesh and client–server suites create `test-temp-*` directories in the
repository root and remove them in `afterEach`. A run killed mid-test leaves
them, and a stale one can make the next run read someone else's state:

```bash
rm -rf test-temp-*
```

## The coverage gate fails but every test passes

Expected: the gate is 100 % on all four metrics. The text reporter **omits
fully covered files**, so an empty table means everything is covered, and any
file that appears is the one to look at — with its uncovered line numbers in
the last column.

Before reaching for `/* v8 ignore */`, check whether the branch is genuinely
unreachable. If it is, say why after `@preserve`. If it is reachable, it wants
a test.

## A golden fails after an unrelated change

`test/goldens/example.log` is a snapshot of the agent's own field layout, so
adding or removing a private field changes it legitimately:

```bash
pnpm updateGoldens
git diff test/goldens/      # READ this — that is the point of the step
```

Accepting a golden without reading the diff is how a real behaviour change gets
recorded as a formatting one.

## A mesh test hangs instead of failing

`converged()` and `settlesOn()` poll until a timeout. A hang to the end of the
timeout means the fleet never agreed, and `whyNot(result)` names the paths that
differ — assert on it rather than on `converged` alone, or the failure message
tells you nothing.

A node that was `cut()` and never `heal()`ed will never converge. In the
harness, `cut` is both directions, `mute` is outbound only, `deafen` is inbound
only, and `down`/`up` stop and restart the agent while leaving the folder
reachable.

## VS Code on Windows: debugging is not working

Date: 2025-03-08

⚠️ On Windows, check the repository out on drive C. There is a bug in the VS
Code Vitest extension (v1.14.4) that prevents test debugging from working:
<https://github.com/vitest-dev/vscode/issues/548>. Check from time to time
whether it has been fixed, and remove this note when it has.
