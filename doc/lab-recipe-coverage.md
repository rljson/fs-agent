<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# The lab's recipes, answered in this package

Which of the lab's E2E recipes have an equivalent **here**, at a tier that can
fail the build, and which can only be answered on real machines.

**Why this document exists.** A recipe that only runs in the lab is measured
once a day at best, on four machines, after a deploy. The same question asked
in this package runs in seconds on every commit. Everything that *can* move
here should, and what cannot should be named rather than assumed.

**The tiers.** Only the first two can answer a recipe, because a recipe is a
statement about a fleet:

| tier | what it is | where |
| --- | --- | --- |
| **mesh** | real `Server`, real sockets, real watchers, real files, 2–4 nodes, cuts, heals, stops | `test/mesh/*.spec.ts`, `test/fs-editor-patterns.spec.ts` |
| **client–server** | two or three clients and a real hub, run **twice** — once on `SocketMock`, once on real socket.io | `test/client-server/*.spec.ts` (`shared-sync-tests.ts` is the pair) |
| single-node | one agent, no peer | everything else |

Source: `e2e-recipes.json`, 35 recipes. The 23 below are the ones this package
can speak for — the `Dateisystem` group plus the three `Netzwerk` recipes that
are statements about file sync. The `Cloud`, `Datenbank` and hub-election
recipes belong to `@rljson/mongo-agent`, the EventHub and the One Client.

---

## 1. Answered here, at a tier that fails the build

| recipe | what answers it |
| --- | --- |
| **basic-sync** | `shared-sync` ×2: *propagate a new file from A to B*, *from B to A*, *empty files correctly* |
| **modify-delete** | `shared-sync` ×2: *file content changes*, *file deletions via cleanTarget*, **and *a deletion of a file created DURING the session*** — the third case the recipe names. Plus mesh A2, T2, T4 and F1 |
| **content-variety** | `shared-sync` ×2 covers every element: *new directory with files*, *deeply nested directory creation*, *binary files*, *files with spaces and special chars*, *file growing and shrinking*, *a large file (100KB)*. Plus `advanced-sync` 5 MB binary and 10 MB, and `fs-filenames` for German names and case-only renames |
| **conflict-resolution** | mesh F5 (four nodes, one file), F10 (both versions kept **and reported**), `conflict-sync` *resolves a real offline divergent edit, preserving both versions*, `advanced-sync` *both clients modify the same file* |
| **concurrency** | mesh F2, F3, F5; `advanced-sync` *50 rapid watcher-driven changes*, *the final content after rapid overwrites*, *three clients after concurrent writes* |
| **churn-during-scan** | mesh F6 — *a file written in the middle of heavy churn reaches every node*. Single-node depth in `fs-scanner-scan-coalescing` and `fs-scanner-vanish` |
| **restore-is-incremental** | mesh `catchup-cost` *fetches only what it does not already hold*; `fs-agent-incremental-restore`; `fs-scale` D8 at 4 000 files |
| **mass-delete-guard** | mesh *a node whose folder was WIPED does not empty the fleet*, *a small folder survives a wiped peer too*, *is refilled rather than abandoned*; 15 single-node guard cases |
| **large-file-roundtrip** | mesh F9 — crosses **and** leaves no residue when deleted; `advanced-sync` 10 MB and 5 MB binary |
| **folder-delta** | mesh F7, A2, T2; `editor-patterns` *created, deleted and created again*; `shared-sync` *does not destroy existing files during initial sync* |
| **burst-delete** | mesh F7 — 100 deletions out of 400, complete everywhere |
| **disconnect-recovery** | mesh T5, `catchup-cost`; `heals-after-forced-divergence` (8 cases); `advanced-sync` *still converges after reconnect with new data* |
| **snapshot-bootstrap** | `advanced-sync` *catches up a client that joins after data exists*; mesh T7; matrix J4+J5. The snapshot *transport* is the client's, not this package's |
| **restart-rejoins** | matrix J9 ×2 — *work done while the agent was down is not lost* and *a deletion made while the agent was down propagates*, using `down()`/`up()`: a stopped PROCESS, which is what a restart is. Plus `advanced-sync` *resync after server teardown and restart* |

Fourteen of twenty-three, and every one of them green.

## 2. Answered, but only on one node

The rule is proven; the fleet is not. Each needs a peer to be a recipe.

| recipe | what exists | what is missing |
| --- | --- | --- |
| **locked-file-does-not-block** | `fs-agent-locked-file`, 7 cases including *does not advertise the half-applied state to peers* | a mesh. Windows file semantics are the one thing on this list a mesh on macOS cannot settle — this wants a Windows runner, and it is `scenario-matrix.md`'s L18 |
| **large-file-near-cap** | `fs-agent-blob-stream` *restores a file larger than one socket message could carry* | the actual size. 44 MB is the customer's number and nothing here uses it |
| **bulk-restore-memory** | `fs-scale` T1 samples the heap under churn | a restore, on a fleet. T1 measures a folder churning, not a node being refilled |

## 3. Partly answered

| recipe | covered | not covered |
| --- | --- | --- |
| **ignore-rules** | the half that matters most, at mesh tier: `editor-patterns` *an Office lock file comes and goes without leaving residue* | the ignore PATTERNS themselves — `fs-agent` *should respect ignore patterns* is single-node |
| **cold-start-budget** | mesh T7, a populated folder cold-starting against a populated peer; `fs-scale` D8 at 4 000 files | the BUDGET. Nothing here asserts a deadline, and the recipe is about one |

## 4. Not answered here

| recipe | why |
| --- | --- |
| **sync-latency** | no test asserts a latency budget. The mesh's `settlesOn(…, 30_000)` is a timeout — the point at which a test gives up — not a promise about arrival time. Worth adding: the harness already records a timeline |
| **large-folder-live-delta** | a single new file noticed in a folder large enough to overwhelm the OS watcher. The watcher is the subject, and the sizes that break it are not reachable in a unit suite |
| **large-file-above-cap** | a file beyond the transfer limit must be refused cleanly rather than taking every node's connection down with it. There is no such test, and the blob-stream work removed the 50 MB ceiling, so what the limit now IS needs establishing before it can be asserted |
| **projekte-shape** | the real customer folder, real shape, real size, four workstations. This one is the lab's by definition and should never move here |

---

## What this says about going to the lab

Fourteen recipes are answered in seconds on every commit, including every one
of the five that have cost data in the field: conflict-resolution,
mass-delete-guard, modify-delete, disconnect-recovery and restart-rejoins.

The gaps are honest and they are of two kinds. Three recipes are about a
BUDGET or a SIZE — sync-latency, cold-start-budget, large-file-near-cap — and a
budget asserted on a developer laptop measures the laptop. Four are about an
environment this suite does not have: a Windows file lock, an OS watcher at
scale, a transport limit, and a real customer folder.

None of them is a correctness question that could be answered here and is not.
