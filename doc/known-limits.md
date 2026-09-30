# Known limits

What this agent does **not** promise. Each entry says what the limit is, how it
was measured, what makes it tolerable, and what fixing it would take — so the
next person weighs the same evidence instead of rediscovering it from a
customer.

## A node's own new work can be discarded when the hub has forked

**Measured 2026-09-30.** A folder copied onto NB-2744 produced a state of 15
files / 55 868 bytes from the fleet's 13 / 29 873. The hub never adopted it and
went on announcing the old state, whose ancestry reached a state NB-2744 had
applied the day before. NB-2744 concluded it was behind and chose `pull` —
against its own new folder — and retried five times.

### Why it is still here

It was fixed, and the fix caused something worse.

`antiEntropyDecision` asks whether the hub's state was made from a state "we are
in", counting both `currentRef` and `lastAppliedRef`. Not counting
`lastAppliedRef` once we have authored something since is the correct reading —
a state we have built on is behind us, so a hub state descending from it is a
sibling, not a successor.

It is also the only thing making one side yield. With it removed, both nodes
decided `push`, and a disagreement with nobody yielding is a livelock: NB-2744's
own revision log showed the folder flipping between the 13-file and the 17-file
state **roughly twenty times in ninety seconds** — a delete applied, the files
back within 225 ms, over and over — before settling on the state the user had
deleted. Reverted the same afternoon.

### What it would take

The two situations are indistinguishable at this decision:

| | hub's ref | hub's predecessors |
| --- | --- | --- |
| a peer deleted what we added | a state we once held | our state |
| a peer forked from a shared ancestor | a state we once held | an ancestor |

Both end at "the hub holds something we recognise, made from something we
recognise". Telling them apart needs the predecessor **chain** — whether the
hub's state is reachable *from* ours, or merely shares an ancestor with it — and
one generation of `predecessors` cannot answer that. Nothing in the node API,
`/state` or the revisions endpoint exposes ancestry at all today, which is why
this was diagnosed from symptoms rather than read off.

So the next step is not a cleverer rule. It is carrying and exposing enough
ancestry to ask the question, and that is a protocol change.

### What to watch for

A folder rewriting itself every few seconds, and `antiEntropy.lastRepair.action`
reading `push` on **both** sides of a disagreement. One side must always yield.

## A deletion is undone when the common ancestor cannot be read

**Measured 2026-09-30, off-lab, in seven seconds** — `test/mesh/fs-mesh.spec.ts`
T4, committed skipped because it is red.

A node deletes a file while it is partitioned. On rejoin the file comes back on
**every** node, including the one that deleted it: the apply restores it, the
local scan then finds it present, and the deletion is never announced at all.

### Why, and it is narrower than it looks

A three-way merge does **not** need a record of the deletion. Given the common
ancestor S, our tree and theirs, "absent from theirs and present in S" *is* a
deletion, provably — and `fs-conflict-resolver.ts` gets that right. The same
scenario with the ancestor readable passes (T2).

What fails is the case where the ancestor **cannot be resolved**. A partitioned
node cannot read the revision rows its peers produced while it was away, so the
merge degrades to two trees — one with the file, one without — and nothing
distinguishes a deliberate absence from a state that merely predates the file.

So the missing information is not "that a deletion happened" in general. It is
that a deletion happened **at a node whose ancestry the reader cannot fetch**.
That is what a persistent tombstone supplies, and why it is the fix rather than
better merge logic.

### What it would take

The guard already exists: `_pendingDeletes` (`src/fs-agent.ts`), consumed in
`_restoreTree` as "never re-create a file deleted here and not yet announced".
Its lifetime is one announcement — `_rememberAnnounced` clears it — which is
exactly one push too early. Making it persistent, per folder, is WP1 of
`PLAN-fs-edit-chain.md`.

### What to watch for

A file the user deleted reappearing on the user's own machine, and no `DELETED`
count in that node's restore log line.

## Two people saving the same file at the same time

**The later write does not reliably win.** When two workstations change the
same file within a few seconds of each other, the agents settle on whichever
advertisement arrives last, not on whichever save happened last. One of the two
saves is then replaced — with no conflict, no copy and no log line.

### Why

Causal ordering exists (`_ancestryRelation`: *ahead* / *behind* / *diverged*)
but is consulted only when `resolveConflicts` is on, and that defaults to
**off**. Without it there is no notion of which change was built on which, so
the winner is decided by message timing.

### What was measured (2026-09-27)

- Reproduced deterministically in **1.2 s**: A writes, B writes 30 ms later,
  both end on A's content and B's save is gone.
- On CI it lost roughly two runs in five; locally it passed 20+ times,
  including under full CPU load and on Node 22. A 2-core runner loses a race a
  fast laptop wins. The commit CI first went red on changed only
  `package.json`.
- **Not** a file overwritten mid-restore. At the moment a peer restores, the
  disk holds exactly what that peer last announced. Both writes are announced;
  the network picks the last to arrive.
- A "conflicted copy" fix was built and then **disproved by a control run** —
  there is nothing to copy, because nothing is being overwritten.
- Turning `resolveConflicts` on does not fix it: 3 of 3 runs still fail and it
  additionally breaks `should propagate a deletion across clients`, which is
  the fallout the gate's own comment predicts.

### Why it is acceptable for now

It needs two people saving the **same** file within seconds. In the product
this ships in, CARAT Desktop holds its documents open while they are being
edited (see the `locked-file-does-not-block` recipe), which closes most of that
window.

### What ONE-446 changed (2026-09-28)

**The divergence half is repaired.** With a hub state beacon running
(`stateBeaconMs` on the server, 30 s in the One Client) the anti-entropy notices
a node that disagrees with the hub for longer than its grace period and repairs
it, so three simultaneous writes end on one version even with `resolveConflicts`
off. Measured in `test/client-server/simultaneous-edit.spec.ts`: five rounds,
three runs, every round converged within 18-23 s. Before, the same contest left
three stable versions.

**The ordering half stands.** Which version wins is still decided by the last
advertisement to arrive, not by which save was later — everything below still
applies to that. Without a beacon nothing repairs anything: a deployment that
sets `stateBeaconMs: 0` keeps the old behaviour in full.

### What fixing it takes

Making ancestry authoritative on the default path — deciding by what a change
was built on rather than by arrival order — and then working through the code
that currently assumes arrival order, deletions first. That is days of work in
the path behind the earlier data-loss incidents, and it should be done in small
reversible steps with the full suite green at each one.

### Where it is written down

`test/client-server/advanced-sync.spec.ts` — `simultaneous conflicting edits`,
kept as `it.skip` with the same reasoning. It is skipped rather than deleted so
the promise stays visible, and skipped rather than marked an expected failure
because it PASSES on a fast machine.
