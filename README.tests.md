<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# The test suite, as a document

**63 files, 719 scenarios, 100 % coverage on statements, branches, functions and
lines.** 718 must pass; one is committed inverted, and §2.11 says which and why.
One command runs all of it:

```bash
pnpm test        # vitest --coverage --no-file-parallelism, then eslint
```

`--no-file-parallelism` is not a preference. **Thirty-three of these files**
drive a real `Server`, a real socket pair or the mesh harness — with real
watchers and real timers; run in parallel they fight over the cores and invent
failures. Four different tests once failed
across four CI runs of the same commit, each passing on re-run — not four bugs,
one scheduler.

This document says what the suite actually proves, because the number 719 does
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
the unit tier is answered only **partly**, and the tiers above exist to close
exactly that gap.

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

Deletion is where this package has lost data, and it carries the most tests per
line of code anywhere in it.

The architecture is the claim: **an absence is not a deletion.** A tree lacks a
path because its author removed it or because its author never had it, and a
content hash cannot tell the two apart. Every attempt to infer it failed. So a
deletion is applied for one reason only — the head that lacks the file
**descends from this node's own** — and an absence anywhere else reaches the
folder only through a three-way merge against the common ancestor.

What holds it up:

- `fs-relate.spec.ts` — how two heads stand, including that a descent found is
  proof even where another part of the history cannot be read, and that a walk
  out of budget answers `fork`, never `behind`.
- `fs-send.spec.ts` and `fs-agent-mass-delete-guard.spec.ts` — the guards: a
  sender does not author a mass disappearance its watcher did not see, and a
  receiver keeps what an apply would lose.
- `fs-collect-removals.spec.ts` — the net delta a join uses to tell a stale
  copy from new work, netting re-adds against removals in order.
- At mesh tier: T2 (a delete survives a merge with a peer that still holds the
  file), T4 (a delete made while cut off is not resurrected on rejoin), F1
  (removing a **directory** propagates), F7 (100 deletions out of 400 complete
  everywhere), **F11** (deletions from alternating nodes, one with a clock 20 s
  fast, all arrive and none returns), I7 (a peer's deletion does not remove a
  file re-created since), J9 (a deletion made while the agent was **down**
  propagates), and the wiped-and-reverted file (a machine that lost its folder
  does not empty the fleet, and is refilled).

### 2.3 That two people editing one file lose nothing

`fs-merge.spec.ts` carries the conflict table on maps; `fs-conflict-rules.spec.ts`
carries it on disks — one test per row, C1–C6, on two real nodes and a stamping
hub, each forcing its order instead of racing for it, plus *C3 with no stamp*:
nothing is decided, nothing is lost, the wait is told, and two nodes do not
answer each other's announcements in a loop.

The guarantee: both versions survive, the one that reached the fleet later keeps
the name — by the hub's stamp, never a clock — every node reaches the same
verdict, and the conflict is reported. `fs-stamps.spec.ts` holds how a version's
stamp is derived, including a walk that stops at a row it cannot read yet.

At mesh tier: F5 (four nodes editing one file end on one version), F10 (two
nodes keep both versions **and say so**), T3 (both changes kept from a shared
ancestor), and `simultaneous-edit.spec.ts` (three nodes contesting one file).

### 2.4 That a document never goes backwards

`fs-mesh-invariants.spec.ts` asserts properties over the ROUTE rather than the
destination: *a document never goes backwards while one person edits it*, *a
converged deletion does not come back*, *every node ends on the last save*,
*every announcement carries a chain head*, and — under random churn and
partitions across three seeds — *a disagreement is never silent*.

These are the expensive ones, and they are the tests that caught defects no
example-based test could. One was the scanner's: Node rounds an mtime to the
nearest millisecond, so a file the agent applied in the second half of the
millisecond the next scan started in read as one still being written, and the
receiver announced the version before it. `fs-scanner.spec.ts` now pins it — a
rewrite the agent noted reads as written, an un-noted one as the version before.
Another: a receiver catching up recorded itself as the author of
a file it had never edited, 28 seconds after the real edit, and the whole fleet
settled one version behind the last save about one run in three.

**The churn scenarios found three things, and only one of them was what it
looked like.** One was a real defect and is fixed — a same-path conflict settled
by content hash rather than by when the edit happened, which made the fleet
converge on a superseded write. One did not exist: the test's own count of a
node's tree entries used a field those nodes do not have, so it counted
directories and the folder root as files and reported a consistent fleet as a
loss. The third had never been gated at all, because the test read the fleet's
convergence verdict and used only its snapshot.

All three are now asserted: the same files, the same bytes, and — if that ever
fails — that some node's `diverged` said so. The silence
check is kept beside the equality check rather than instead of it, because a
disagreement nobody noticed is a different defect from one every node is
announcing, and a failure should say which. The seed fixes the write sequence
and nothing else, so each run is a different race; that is why these are run
repeatedly rather than once, and why a count of passes is the only evidence
worth quoting.

### 2.5 That joining a network cannot destroy what is already there

A folder's contents cannot say where a joining node belongs in the history. A
node that authored a lineage root from whatever it happened to hold, and pushed
it as the network's newest claim, would carry one defect with two faces: every
node gets its own root, so every announcement classifies as a fork; and a
machine restored from a backup pushes a month of deleted files back to the
fleet.

`fs-plan-join.spec.ts` (9) decides it against the chain, with every path in at
most one of four buckets — write, announce, recover, conflict — and
`fs-mesh-matrix.spec.ts` proves it reached: **J4+J5** (a joiner keeps its own
new work and does not resurrect a deletion) and **J9** twice (work done while
the agent was down is not lost; a deletion made then still propagates).

A file the history deliberately deleted is neither announced nor destroyed: it
is renamed aside into `.fsagent-recovered/`, which the scanner ignores.

### 2.6 That a lost message heals itself

`heals-after-forced-divergence.spec.ts` (scenarios × 2 hub signals) drops
messages on purpose: a new file whose push the hub never received, a deletion
whose push it never received, a deletion a peer never received, a peer deletion
that must **not** be undone, every node healing when the hub received nothing
at all, and a node that misses every forward while another keeps writing.

There is no separate repair mechanism to test: the hub says its head again on
the beacon or the bootstrap, and `receive` is the repair. `fs-receive.spec.ts`
holds that decision — one case per relation — and
`fs-agent-anti-entropy.spec.ts` the wiring: what the agent hears, what it
reports, that a head nobody can read is said once per pair, and that a stopped
receive side stops reporting.

### 2.6b That a host application is told what happened

`fs-signals.spec.ts` (34) tests the sink with no filesystem at all, which is
what lets it assert the awkward parts directly: the cap dropping the oldest, the
per-kind counters surviving that drop, a listener that throws not costing the
next one its notification, and a persisted log coming back from a shape nobody
validated on the way out.

That last part is most of the file, deliberately. A signal log is read from a
folder that users, backup tools and other builds of this agent all write into,
so it will be truncated, half-written and occasionally produced by a newer
version. Every branch of that tolerance has a case: not an object, `null`, a
`signals` that is not an array, an entry missing each required field in turn, a
total that is not a finite number, and a good entry either side of a bad one.
Two of those encode decisions rather than defences — an unknown `kind` is
**kept**, because it is still a true record of something that happened, and
restoring does **not** fire subscribers, because replaying history through the
callback would make every restart look like a fresh folder-wide conflict.

`fs-agent-signals.spec.ts` (19) is the other half: one case per place in the
agent that does something to a user's folder, asserting the **fields** rather
than that something was emitted. A signal with the right kind and the wrong
`action` is worse than no signal, because it gets filtered into silence.

The mass-delete guard tests and the mesh harness's `mesh.conflicts` collector
read the signal channel too: there is no other surface left to assert.

### 2.7 That a node claims only what it changed

The standing design rule: one identical chain on every client, an edit exists
only where the change was made, a receiver adopts and never authors.

`fs-agent-authorship.spec.ts` (a received file, a stated deletion, a real edit
after both, and an absence only a lagging scan reports), `fs-agent-no-laundering.spec.ts` (a node does not re-advertise
what it adopted; a partial apply stays quiet; authoring never reads the watcher's
last pass — the F9 revert, pinned deterministically), `fs-agent-own-echo.spec.ts`,
`fs-agent-self-parent.spec.ts` and `fs-agent-stale-reconnect.spec.ts` hold the
edges, with `fs-edit-chain.spec.ts` and `fs-chain-crosses-the-wire.spec.ts`
under them.

The receiving half: an apply writes over nothing it has not read.
`fs-agent-receive-degradation.spec.ts` lands a save between a receive's scan and
its apply — once under an apply, once under a merge. The apply stops, the save
becomes this node's work, and the head is merged; a scan that cannot catch up
stops receiving again after `RECEIVE_AGAIN_MAX` tries, and the next time the
head is said tries again.

Also here: `fs-ref-vs-content.spec.ts` — identical content written at different
times gives **one** ref and one content map. mtime is deliberately not part of
content identity: while it was, the same bytes gave a different ref per machine.

### 2.8 That a hostile or broken filesystem breaks only itself

| suite | what it survives |
| --- | --- |
| `fs-agent-locked-file.spec.ts` (8) | a file another process holds open — the rest of the restore lands, every locked file is named, a non-lock write failure still aborts, and the half-applied state is **not** advertised to peers |
| `fs-impossible-filename.spec.ts` (4) | a path the filesystem refuses — a 300-character path, `CON.txt`. Each blocks only itself |
| `fs-filenames.spec.ts` (5) | a German filename round-tripping byte for byte, two Unicode spellings of one name not destroying each other, a case-only rename |
| `fs-hostile-tree.spec.ts` (7) | a tree from a peer is not trusted with paths — no escaping the sync root |
| `fs-filetype-changes.spec.ts` (6) | a path that changes what it IS: file → directory, directory → file, symlinks |
| `fs-scanner-vanish.spec.ts` (12) | an entry deleted between `readdir` and `stat` |
| `fs-disk-full.spec.ts` (3) | ENOSPC — a clean abort with a message, not a silent standstill |
| `fs-slow-copy.spec.ts` (3) | a file still being written: never hashed half-done, and one unsettled file does not stop the folder |
| `fs-clock-skew.spec.ts` (6) | a machine whose clock is wrong — a file is visible whatever its timestamp says |
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

### 2.10 That the wire format is what it claims to be

There is no mixed-version test, because there is only one format — every node
announces a chain head, and the fleet is upgraded together.

What holds that is a census rather than a sample: `every announcement carries a
chain head`, in `mesh/fs-mesh-invariants.spec.ts`, records every ref each node
puts on the wire across the whole mesh tier and fails if any is bare. **Zero
bare refs.**

### 2.11 Reproductions, kept verbatim

`field-repro.spec.ts` reproduces reported failures as written,
and `fs-mesh-wiped-and-reverted.spec.ts` the two shapes a machine comes back
in: a folder **wiped** (must not empty the fleet, must be refilled) and a
folder **reverted** to an older copy. Several suites carry a backlog ID in
their `describe` — `F1/D2`, `F1/D5`, `V2/D3`, `L2/D4`, `F5`, `F7`, `S5` — so
the item that paid for the test is readable from the test.

The reverted shape holds the package's **one inverted test**, *a node reverted
to an older copy does not drag the fleet back*. A revert performed underneath a
**running** agent is not decidable from the history: that node had adopted the
edit whose file is now missing, which is the precise condition for a legitimate
deletion, so its own watcher states the removal and every peer is right to obey
it. Three detectors were built for it and each one suppressed ordinary work — a
rename's target, an atomic save, a create/delete/recreate. The test carries that
measurement and runs on every gate, so it turns red the day a protection exists.
The field shape — a backup restored while the agent is **stopped** — is covered,
because that node joins and `planJoin` renames what the history removed into
`.fsagent-recovered/`.

---

## 3. The conventions, and why each exists

**`it.fails` for a known-red test, never `it.skip`.** An inverted test passes
while the body fails and turns red the day it starts working, with "this works
now — remove the inversion and let it gate". A skipped test is silent in both
directions and relies on somebody remembering to come back. Ten were committed
inverted during the edit-chain work; **nine are now ordinary assertions and
there are no skips anywhere in the package.**

**One inversion remains, and it is a proof rather than a backlog item.** *A node
reverted to an older copy does not drag the fleet back*
(`fs-mesh-wiped-and-reverted.spec.ts`) carries its own argument: the reverted
node had ADOPTED the edit whose file is now missing, which is the exact
condition for a legitimate deletion, so under a live agent the two are not
separable from the chain. Three detectors were built and every one of them
suppressed ordinary work — a rename's target, an atomic save, a
create/delete/recreate — because authorship claims are recorded *after* the
push being judged. Closing it needs the **L1 approval path**: a human deciding
whether a bulk disappearance is a restore or a deletion, which is a product
decision and not a defect in this package. The field shape that matters today
(a backup restored while the agent is stopped, then a join) is covered by
`planJoin`'s recover bucket and is green.

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

Named rather than implied.

Of the 23 end-to-end file-sync scenarios an integration environment runs, 14 are answered here at a tier that fails
the build. The rest are of two honest kinds:

- **A budget or a size.** Sync latency, the cold-start budget, and the 44 MB
  file that is a realistic production number. A budget asserted on a developer
  laptop measures the laptop.
- **An environment this suite does not have.** A Windows file lock (the one
  thing on the list a mesh on macOS cannot settle — it wants a Windows
  runner), the OS watcher at a scale that overwhelms it, a transport limit, and
  the real production folder across four workstations.

Open items are in
[README.public.md § Known constraints](README.public.md#known-constraints).

---

## 5. File index

Counts are what `pnpm test` reports per file, so suites that generate cases in a
loop are counted as they run. They sum to the 719 above.

### Mesh tier

| file | n | what it covers |
| --- | --- | --- |
| `mesh/fs-mesh.spec.ts` | 6 | T1–T7, the scenarios the sync has to survive |
| `mesh/fs-mesh-field-defects.spec.ts` | 11 | F1–F11, field defects reduced in process |
| `mesh/fs-mesh-matrix.spec.ts` | 9 | the scenario matrix at mesh tier (L7, L8, I7, I7b, I10, J4+J5, J6, J9 ×2) |
| `mesh/fs-mesh-invariants.spec.ts` | 7 | invariants over the route, not the destination |
| `mesh/fs-mesh-wiped-and-reverted.spec.ts` | 6 | a node comes back empty, or holding an older copy |
| `mesh/fs-mesh-catchup-cost.spec.ts` | 2 | coming back does not cost what you missed |
| `fs-conflict-rules.spec.ts` | 8 | the conflict table C1–C6 on disks, and C3 before a stamp is known |
| `fs-editor-patterns.spec.ts` | 6 | how real programs save |
| `fs-chain-crosses-the-wire.spec.ts` | 3 | the chain crosses the wire |
| `field-repro.spec.ts` | 3 | reported failures, reproduced verbatim |

### Client–server tier

| file | n | what it covers |
| --- | --- | --- |
| `client-server/socket-mock.spec.ts` | 35 | the shared suite (`shared-sync-tests.ts`) over `SocketMock` |
| `client-server/socket-io.spec.ts` | 35 | the same shared suite over a real socket.io server at production's 50 MB limit |
| `client-server/advanced-sync.spec.ts` | 15 | three clients, catch-up, teardown and restart, 10 MB, 100 files, rapid overwrites |
| `client-server/heals-after-forced-divergence.spec.ts` | 14 | deliberately dropped messages |
| `client-server/conflict-sync.spec.ts` | 2 | a real offline divergent edit, both versions preserved |
| `client-server/simultaneous-edit.spec.ts` | 4 | five rounds of three nodes contesting one file |

### Unit and decision tier

| file | n | what it covers |
| --- | --- | --- |
| `fs-agent.spec.ts` | 81 | the agent's surface |
| `fs-scanner.spec.ts` | 60 | scanning, watching, the scan cache, the agent's own writes |
| `fs-agent-degradation.spec.ts` | 15 | what the agent does when a dependency fails, and the shapes no scenario reaches |
| `fs-agent-receive-degradation.spec.ts` | 16 | receiving when a part of it fails — a tree it cannot read, a stamp or state it cannot file, a folder that moves under the apply, a join |
| `fs-receive.spec.ts` | 11 | what a node does with a head that arrived |
| `fs-relate.spec.ts` | 11 | same / behind / ahead / fork / incomplete |
| `fs-merge.spec.ts` | 22 | `merge3` — the conflict table by example — and copy naming |
| `fs-stamps.spec.ts` | 11 | where each version reached the fleet, derived from payloads |
| `fs-send.spec.ts` | 9 | the sender answers for its edits (`planAuthoring`) |
| `fs-collect-removals.spec.ts` | 26 | the removal walk, and `lastEditOf` |
| `fs-edit-chain.spec.ts` | 16 | the chain |
| `fs-plan-join.spec.ts` | 9 | joining, decided before anything is written |
| `fs-agent-mass-delete-guard.spec.ts` | 11 | refusing a deletion that looks like a loss, and reporting it |
| `fs-agent-anti-entropy.spec.ts` | 7 | receiving what the hub says |
| `fs-agent-stale-reconnect.spec.ts` | 14 | a peer reconnecting with a stale tree |
| `fs-agent-no-laundering.spec.ts` | 7 | a node does not re-advertise what it adopted |
| `fs-agent-authorship.spec.ts` | 4 | a node claims only what it changed |
| `fs-divergence-is-content.spec.ts` | 2 | a divergence is a difference in CONTENT |
| `fs-ref-vs-content.spec.ts` | 6 | ref identity vs content identity |
| `fs-agent-concurrent-write.spec.ts` | 9 | two writes of one path must not blend — 200 rounds per assertion |
| `fs-agent-incremental-restore.spec.ts` | 8 | a restore writes only what changed |
| `fs-agent-locked-file.spec.ts` | 8 | a file held open by another process |
| `fs-agent-blob-stream.spec.ts` | 3 | a restore streams the blob |
| `fs-agent-signals.spec.ts` | 19 | one case per thing the agent signals, asserting the fields |
| `fs-signals.spec.ts` | 34 | the signal sink: the cap, the counters, and a log read from a hostile folder |
| `fs-ignore.spec.ts` | 28 | glob ignore patterns, and every legacy prefix |
| `fs-blob-adapter.spec.ts` | 26 | file ↔ blob |
| `fs-db-adapter.spec.ts` | 6 | storing a tree with its predecessors |
| `blob-io.spec.ts` | 5 | storing a file as a blob |
| `fs-scanner-vanish.spec.ts` | 12 | an entry that vanishes mid-scan |
| `fs-scanner-scan-coalescing.spec.ts` | 4 | a burst collapses into at most two passes |
| `fs-hostile-tree.spec.ts` | 7 | a peer's tree is not trusted with paths |
| `fs-impossible-filename.spec.ts` | 4 | a path the filesystem refuses |
| `fs-filetype-changes.spec.ts` | 6 | a path changes what it is |
| `fs-filenames.spec.ts` | 5 | unicode and case |
| `fs-clock-skew.spec.ts` | 6 | a file is visible whatever its timestamp says |
| `fs-slow-copy.spec.ts` | 3 | a file being written is not distributed half-done |
| `fs-disk-full.spec.ts` | 3 | a full disk |
| `fs-scale.spec.ts` | 3 | scale and endurance |
| `fs-agent-silent-joiner.spec.ts` | 4 | an agent with nothing to say does not speak |
| `fs-stage-timings.spec.ts` | 4 | per-stage timings |
| `fs-agent-rescan-commits.spec.ts` | 1 | a change found only by the safety rescan |
| `fs-agent-self-parent.spec.ts` | 2 | a push that parents itself |
| `fs-rename-folder.spec.ts` | 2 | renaming a folder |
| `fs-agent-own-echo.spec.ts` | 1 | its own advertisement echoed back |
| `example.spec.ts` | 1 | the README example, against a golden |
| `setup/goldens.spec.ts` | 1 | the golden mechanism itself |
