<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# The test suite, as a document

**69 files, 806 scenarios, 100 % coverage on statements, branches, functions and
lines.** One command runs all of it:

```bash
pnpm test        # vitest --coverage --no-file-parallelism, then eslint
```

`--no-file-parallelism` is not a preference. Twenty-six of these files drive
real servers, real sockets, real watchers and real timers; run in parallel they
fight over the cores and invent failures. Four different tests once failed
across four CI runs of the same commit, each passing on re-run — not four bugs,
one scheduler.

This document says what the suite actually proves, because the number 806 does
not. It is organised by the question answered rather than by file; the file
index is at the end.

---

## 1. Three tiers, and why the distinction is the point

| tier | what it is | files |
| --- | --- | --- |
| **mesh** | a real `Server`, real sockets (`createSocketPair`), real watchers, real files on disk, two to four nodes, with cuts, heals, mutes, deafenings and stopped processes | 11 |
| **client–server** | two or three clients and a real hub, each suite run **twice** — once over `SocketMock`, once over a real socket.io server configured at production's 50 MB limit | 6 |
| **unit / decision** | one agent, or a pure function with no filesystem and no clock | 52 |

A decision-tier test proves a RULE. It does not prove the rule is ever
reached, and the difference has cost this package real defects: every decision
in the join protocol was proven by a pure function while the input was never
assembled, and the defect was in the assembly. So a scenario answered only at
the unit tier is marked **partial** in [scenario-matrix.md](doc/scenario-matrix.md),
and the tiers above exist to close exactly that gap.

The mesh harness (`test/mesh/fs-mesh.ts`) is the instrument most of the hard
results come from. It can `cut()` a node (both directions), `mute()` it (its
work reaches nobody while it still hears), `deafen()` it (it announces into a
void), `down()` and `up()` it (a stopped PROCESS, which is what a crash is,
rather than a broken network), and `join()` a node whose folder was written
*before* its agent started — which is what restoring a backup actually looks
like. `converged()` compares **file contents**, not refs, and names the paths
that differ when it fails.

---

## 2. What the suite proves

### 2.1 That something arrives at all

The floor. `shared-sync-tests.ts` holds 35 scenarios and is run twice, once per
transport: a file A→B and B→A, content changes, empty files, binaries, files
with spaces and special characters, a file that grows and then shrinks, a
100 KB file, multiple files created at once, a new directory with files,
directory deletion, deeply nested creation, empty directories, nested empty
directories, a rename, convergence that then stops producing traffic, and —
asserted explicitly — that teardown really stops it.

At mesh tier the same floor is `fs-mesh.spec.ts` T1–T7 and
`fs-mesh-field-defects.spec.ts` F1–F10, each of which is a defect that was
measured in the field rather than an invented case.

### 2.2 That a deletion travels — the hardest thing here

Deletion is where this package has lost data, and it carries the most tests
per line of code anywhere in it.

The architecture is the claim: **an absence is not a deletion.** A tree lacks a
path because the sender removed it or because the sender never had it, and a
content hash cannot tell the two apart. Every attempt to infer it failed — a
rule asking "could the sender have seen my state?", a flag for whether the
transport carried ancestry, a guard for files not yet announced, and a set of a
thousand remembered past states. Four reverts, 155 files of measured drift
across four machines, and a file deleted from 3 642 that was back moments
later. So a removal is **stated** in the edit chain by the node that performed
it, and that statement is the only authority.

What holds it up:

- `fs-collect-removals.spec.ts` (31) — the walk that finds what was removed,
  including netting re-adds against removals in order, concluding **nothing**
  from a walk that cannot complete, and stopping at a bound rather than
  reading a whole history.
- `fs-plan-removals.spec.ts` (19) — which stated removals may be applied, with
  two floors rather than one.
- `fs-agent-tombstone-log.spec.ts` (9) — what a restart remembers it deleted.
  A restart that forgets is how a deletion is undone by the first peer that
  never heard about it.
- `fs-agent-mass-delete-guard.spec.ts` (15) — refusing a deletion that looks
  like a loss, *and* allowing a large one that is still a minority, *and*
  reporting what it refused so the numbers can be judged.
- At mesh tier: A2 (a delete made while partitioned stays deleted), T2 (a
  delete survives a merge with a peer that still holds the file), T4 (a delete
  made while cut off is not resurrected on rejoin — a coin flip through four
  work packages, now 8 of 8), F1 (removing a **directory** propagates, not just
  its files), F7 (100 deletions out of 400 complete everywhere), I7 (a peer's
  deletion does not remove a file re-created since), and J9 (a deletion made
  while the agent was **down** still propagates).

### 2.3 That two people editing one file lose nothing

`fs-conflict-resolver.spec.ts` (41) and `fs-manifest.spec.ts` (36) carry the
decisions; `fs-conflict-integration.spec.ts` and `conflict-sync.spec.ts` carry
them end to end. The guarantee is that one version wins **deterministically on
every node**, the loser survives as a renamed conflict copy, and the conflict
is reported rather than silently settled.

The winner is chosen on the edit's own `timeId`, authored where the change was
made — not on which advertisement arrived last and not on the greater content
hash, both of which this package has shipped and both of which produced a
different answer per machine.

At mesh tier: F5 (four nodes editing one file end on one version), F10 (two
nodes keep both versions **and say so**), T3 (both changes kept from a shared
ancestor), and `simultaneous-edit.spec.ts` (five rounds of three nodes
contesting one file).

### 2.4 That a document never goes backwards

`fs-mesh-invariants.spec.ts` asserts properties over the ROUTE rather than the
destination: *a document never goes backwards while one person edits it*, *a
converged deletion does not come back*, *every node ends on the last save*, and
convergence under random churn and partitions across three seeds.

These are the expensive ones — four minutes for six scenarios — and they are
the tests that caught a defect no example-based test could: a receiver catching
up recorded itself as the author of a file it had never edited, 28 seconds
after the real edit, and the whole fleet settled one version behind the last
save about one run in three.

### 2.5 That joining a network cannot destroy what is already there

A joining node used to author a lineage root from whatever it happened to hold
and push it as the network's newest claim. That is one defect with two faces:
every node got its own root, so every announcement classified as a fork; and a
machine restored from a backup pushed a month of deleted files back to the
fleet.

`fs-plan-join.spec.ts` (9) decides it against the chain, with every path in at
most one of four buckets — write, announce, recover, conflict — and
`fs-mesh-matrix.spec.ts` proves it reached: **J4+J5** (a joiner keeps its own
new work and does not resurrect a deletion) and **J9** twice (work done while
the agent was down is not lost; a deletion made then still propagates).

A file the history deliberately deleted is neither announced nor destroyed: it
is renamed aside into `.fsagent-recovered/`, which the scanner ignores.

### 2.6 That a lost message heals itself

`heals-after-forced-divergence.spec.ts` (8 scenarios × 2 transports) drops
messages on purpose: a new file whose push the hub never received, a deletion
whose push it never received, a deletion a peer never received, a peer deletion
that must **not** be undone, every node healing when the hub received nothing
at all, and a node that misses every forward while another keeps writing. It
keeps the original failure as its own case too.

`fs-anti-entropy.spec.ts` (36) and `fs-anti-entropy-level1.spec.ts` (10) carry
the decision. Level 1 is **enumerations, not examples** — "for every pair of
views" — because the defect class here is two situations that need opposite
actions arriving as the same value. That matters concretely: a release passed
every example test in the suite, fixed the case it was written for, and then
flipped a production folder between two states about twenty times in ninety
seconds. Ninety seconds of a customer's folder rewriting itself was an
expensive way to learn something a loop over a three-element set says before
the commit.

### 2.7 That a node claims only what it changed

The standing design rule: one identical chain on every client, an edit exists
only where the change was made, a receiver adopts and never authors, and no
edit without predecessors.

`fs-agent-authorship.spec.ts`, `fs-agent-no-laundering.spec.ts` (6, *a node
does not re-advertise what it adopted*), `fs-agent-own-echo.spec.ts`,
`fs-agent-self-parent.spec.ts`, `fs-agent-inbound-verdict.spec.ts` (7),
`fs-agent-stale-reconnect.spec.ts` (13) and
`fs-agent-send-retires-left-state.spec.ts` hold the edges, with
`fs-edit-chain.spec.ts` (20), `fs-classify.spec.ts` (11) and
`fs-chain-crosses-the-wire.spec.ts` under them.

Also here: `fs-ref-vs-content.spec.ts` — identical content written at different
times gives **one** ref. mtime is deliberately not part of content identity,
because it does not survive a restore byte for byte and on Windows regularly
does not, and while it was in the identity the same bytes gave a different ref
per machine and a node's deletions were refused by everybody.

### 2.8 That a hostile or broken filesystem breaks only itself

| suite | what it survives |
| --- | --- |
| `fs-agent-locked-file.spec.ts` (7) | a file another process holds open — the rest of the restore lands, every locked file is named, a non-lock write failure still aborts, and the half-applied state is **not** advertised to peers |
| `fs-impossible-filename.spec.ts` (4) | a path the filesystem refuses — a 300-character path, `CON.txt`. Each blocks only itself |
| `fs-filenames.spec.ts` (5) | a German filename round-tripping byte for byte, two Unicode spellings of one name not destroying each other, a case-only rename |
| `fs-hostile-tree.spec.ts` (4) | a tree from a peer is not trusted with paths — no escaping the sync root |
| `fs-filetype-changes.spec.ts` (6) | a path that changes what it IS: file → directory, directory → file, symlinks |
| `fs-scanner-vanish.spec.ts` (12) | an entry deleted between `readdir` and `stat` |
| `fs-disk-full.spec.ts` (3) | ENOSPC — a clean abort with a message, not a silent standstill |
| `fs-slow-copy.spec.ts` (3) | a file still being written: never hashed half-done, and one unsettled file does not stop the folder |
| `fs-clock-skew.spec.ts` (3) | a machine whose clock is wrong — a file is visible whatever its timestamp says |
| `fs-agent-blob-stream.spec.ts` (3) | a file larger than one socket message, and a transfer that breaks off mid-file |

### 2.9 That coming back does not cost what you missed

`fs-mesh-catchup-cost.spec.ts` measures, not asserts-and-hopes: a node away for
twenty saves of one document fetches **one** blob, named by content rather than
counted, so the measurement cannot be satisfied by a blob the node already
held. A number that tracked the number of missed saves would mean the cost of
being away is proportional to how long you were away.

`fs-agent-incremental-restore.spec.ts` (8) and `fs-scale.spec.ts` D8 are the
same property on disk: a new file arriving must not rewrite the folder, and a
second scan of 4 000 files re-reads nothing.

`fs-scale.spec.ts` T1 is endurance — memory, handles and the agent's own
bounded structures sampled while the folder churns. Short by default;
`FS_SOAK_MS=14400000` runs the four hours the register asks for and nothing
about the test changes.

### 2.10 That an upgrade does not split the fleet

`fs-mesh-mixed.spec.ts` runs half the fleet on the old wire format: they
converge, ancestry still crosses, and a deletion travels from a new node to an
old one. `fs-bucket-sync.spec.ts` (29) pins the wire format itself — message
bodies are JSON because a POSIX filename may contain any byte but `/` and NUL.

### 2.11 Reproductions, kept verbatim

`field-repro.spec.ts` reproduces entries from `KNOWN-WEAKNESSES.md` as written,
and `fs-mesh-wiped-and-reverted.spec.ts` the two shapes a machine comes back
in: a folder **wiped** (must not empty the fleet, must be refilled) and a
folder **reverted** to an older copy. Several suites carry a backlog ID in
their `describe` — `F1/D2`, `F1/D5`, `V2/D3`, `L2/D4`, `F5`, `F7`, `S5` — so
the item that paid for the test is readable from the test.

---

## 3. The conventions, and why each exists

**`it.fails` for a known-red test, never `it.skip`.** An inverted test passes
while the body fails and turns red the day it starts working, with "this works
now — remove the inversion and let it gate". A skipped test is silent in both
directions and relies on somebody remembering to come back. Nine were committed
inverted during the edit-chain work and **all nine are now ordinary
assertions**; there is not one inversion left in the package.

**One skip remains, and it is a proof.** *A node reverted to an older copy does
not drag the fleet back* is skipped with the argument written into it: the
reverted node had ADOPTED the edit whose file is now missing, which is the
exact condition for a legitimate deletion, so the two are not separable from
the chain under a live agent. Three detectors were built and each suppressed
ordinary work — a rename's target, an atomic save, a create/delete/recreate —
because authorship claims are recorded *after* the push being judged. The field
shape (a backup restored while the agent is stopped, then a join) is covered by
`planJoin`'s recover bucket.

**A pass count is a sample, not a measurement.** These suites carry several
units of run-to-run variance — more than most fixes move. A change is confirmed
by a run that *isolates* it, repeated: three for a signal, eight before calling
a mesh scenario fixed. This rule exists because a "6/8 → 4/8 regression" was
once reported from three runs whose only difference was a guard that logged
zero hits.

**Assert WHAT, not HOW MANY.** The catch-up cost test asserted "at most two
blobs" and measured three; the third was the writer's own in-flight push and
the second a blob the node already held. Rewritten to name the contents
touched, it reports one blob on every run. A bound raised to swallow a known
failure stops measuring anything.

**`ORIGIN_FIXTURE` says what is true of a fixture.** A folder with files and no
history defers its first announcement and asks the network for its state first,
because announcing over an established fleet is how a restored backup drags it
back. Nearly every fixture here has exactly that shape and almost none has a
peer with a history to wait for, so `{ joinWaitMs: 0 }` states "this folder is
the first state of its own history". It is not a way around the behaviour — a
test that means to exercise joining sets a real wait.

**Goldens** are snapshots reviewed by a human: `pnpm updateGoldens`, then read
the diff. `test/goldens/example.log` snapshots the agent's own field layout, so
adding a field is expected to change it.

---

## 4. What this suite cannot answer

Named rather than implied, with the full mapping in
[lab-recipe-coverage.md](doc/lab-recipe-coverage.md).

Of the lab's 23 file-sync recipes, 14 are answered here at a tier that fails
the build. The rest are of two honest kinds:

- **A budget or a size.** Sync latency, the cold-start budget, and the 44 MB
  file that is the customer's real number. A budget asserted on a developer
  laptop measures the laptop.
- **An environment this suite does not have.** A Windows file lock (the one
  thing on the list a mesh on macOS cannot settle — it wants a Windows
  runner), the OS watcher at a scale that overwhelms it, a transport limit, and
  the real customer folder across four workstations.

Open items are tracked in [known-limits.md](doc/known-limits.md) and
[q3-backlog-status.md](doc/q3-backlog-status.md).

---

## 5. File index

Counts are static `it(...)` declarations; the runtime total is higher because
several suites generate cases in a loop.

### Mesh tier

| file | n | what it covers |
| --- | --- | --- |
| `mesh/fs-mesh.spec.ts` | 6 | T1–T7, the scenarios the sync has to survive |
| `mesh/fs-mesh-field-defects.spec.ts` | 10 | F1–F10, field defects reduced off-lab |
| `mesh/fs-mesh-matrix.spec.ts` | 7 | the scenario matrix at mesh tier (L7, L8, I7, I10, J4+J5, J9 ×2) |
| `mesh/fs-mesh-invariants.spec.ts` | 4 | invariants over the route, not the destination |
| `mesh/fs-mesh-wiped-and-reverted.spec.ts` | 6 | a node comes back empty, or holding an older copy |
| `mesh/fs-mesh-additive.spec.ts` | 3 | additive reconciliation (A1–A3) |
| `mesh/fs-mesh-mixed.spec.ts` | 3 | a mixed-version fleet |
| `mesh/fs-mesh-catchup-cost.spec.ts` | 2 | coming back does not cost what you missed |
| `fs-editor-patterns.spec.ts` | 6 | how real programs save |
| `fs-chain-crosses-the-wire.spec.ts` | 4 | the chain crosses the wire |
| `field-repro.spec.ts` | 3 | KNOWN-WEAKNESSES reproductions, verbatim |

### Client–server tier

| file | n | what it covers |
| --- | --- | --- |
| `client-server/shared-sync-tests.ts` | 35 | the shared production suite — **run twice**, below |
| `client-server/socket-mock.spec.ts` | ×35 | the shared suite over `SocketMock` |
| `client-server/socket-io.spec.ts` | ×35 | the shared suite over a real socket.io server at production's 50 MB limit |
| `client-server/advanced-sync.spec.ts` | 15 | three clients, catch-up, teardown and restart, 10 MB, 100 files, rapid overwrites |
| `client-server/heals-after-forced-divergence.spec.ts` | 8 | deliberately dropped messages |
| `client-server/conflict-sync.spec.ts` | 2 | a real offline divergent edit, both versions preserved |
| `client-server/simultaneous-edit.spec.ts` | 1 | five rounds of three nodes contesting one file |

### Unit and decision tier

| file | n | what it covers |
| --- | --- | --- |
| `fs-agent.spec.ts` | 90 | the agent's surface |
| `fs-scanner.spec.ts` | 55 | scanning, watching, the scan cache |
| `fs-conflict-resolver.spec.ts` | 41 | tip ordering, winners, three-way merge, copy naming |
| `fs-anti-entropy.spec.ts` | 36 | the repair decision, by example |
| `fs-manifest.spec.ts` | 36 | buckets, digests, reconciliation plans |
| `fs-collect-removals.spec.ts` | 31 | the removal walk |
| `fs-bucket-sync.spec.ts` | 29 | the wire format |
| `fs-ignore.spec.ts` | 28 | glob ignore patterns, and every legacy prefix |
| `fs-blob-adapter.spec.ts` | 26 | file ↔ blob |
| `fs-edit-chain.spec.ts` | 20 | the chain |
| `fs-plan-removals.spec.ts` | 19 | which removals may be applied |
| `fs-agent-mass-delete-guard.spec.ts` | 15 | refusing a deletion that looks like a loss |
| `fs-agent-stale-reconnect.spec.ts` | 13 | a peer reconnecting with a stale tree |
| `fs-scanner-vanish.spec.ts` | 12 | an entry that vanishes mid-scan |
| `fs-classify.spec.ts` | 11 | behind / ahead / fork / incomplete |
| `fs-anti-entropy-level1.spec.ts` | 10 | the same decision, **enumerated** |
| `fs-agent-tombstone-log.spec.ts` | 9 | what a restart remembers it deleted |
| `fs-plan-join.spec.ts` | 9 | joining, decided before anything is written |
| `fs-agent-incremental-restore.spec.ts` | 8 | a restore writes only what changed |
| `fs-agent-locked-file.spec.ts` | 7 | a file held open by another process |
| `fs-agent-inbound-verdict.spec.ts` | 7 | is an inbound ref news to this agent |
| `fs-agent-anti-entropy.spec.ts` | 7 | the anti-entropy wiring |
| `fs-ref-vs-content.spec.ts` | 6 | ref identity vs content identity |
| `fs-filetype-changes.spec.ts` | 6 | a path changes what it is |
| `fs-agent-no-laundering.spec.ts` | 6 | a node does not re-advertise what it adopted |
| `fs-db-adapter.spec.ts` | 6 | storing a tree with its predecessors |
| `fs-agent-conflict-log.spec.ts` | 5 | recording a resolved conflict |
| `fs-conflict-integration.spec.ts` | 5 | conflict resolution end to end |
| `fs-filenames.spec.ts` | 5 | unicode and case |
| `fs-level2-surfaces.spec.ts` | 5 | the model must be able to EXPRESS it |
| `blob-io.spec.ts` | 5 | storing a file as a blob |
| `fs-agent-ancestry-warning.spec.ts` | 4 | a transport with no ancestry must say so |
| `fs-divergence-is-content.spec.ts` | 4 | a divergence is a difference in CONTENT |
| `fs-hostile-tree.spec.ts` | 4 | a peer's tree is not trusted with paths |
| `fs-impossible-filename.spec.ts` | 4 | a path the filesystem refuses |
| `fs-scanner-scan-coalescing.spec.ts` | 4 | a burst collapses into at most two passes |
| `fs-agent-silent-joiner.spec.ts` | 4 | an agent with nothing to say does not speak |
| `fs-stage-timings.spec.ts` | 4 | per-stage timings |
| `fs-agent-authorship.spec.ts` | 3 | a node claims only what it changed |
| `fs-agent-blob-stream.spec.ts` | 3 | a restore streams the blob |
| `fs-clock-skew.spec.ts` | 3 | a file is visible whatever its timestamp says |
| `fs-disk-full.spec.ts` | 3 | a full disk |
| `fs-scale.spec.ts` | 3 | scale and endurance |
| `fs-slow-copy.spec.ts` | 3 | a file being written is not distributed half-done |
| `fs-agent-announced-heads.spec.ts` | 2 | parked announcement heads, and their cap |
| `fs-agent-rescan-commits.spec.ts` | 2 | a change found only by the safety rescan |
| `fs-agent-self-parent.spec.ts` | 2 | a push that parents itself |
| `fs-rename-folder.spec.ts` | 2 | renaming a folder |
| `fs-agent-own-echo.spec.ts` | 1 | its own advertisement echoed back |
| `fs-agent-send-retires-left-state.spec.ts` | 1 | leaving a state retires it |
| `example.spec.ts` | 1 | the README example, against a golden |
| `setup/goldens.spec.ts` | 1 | the golden mechanism itself |
