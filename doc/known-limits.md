# Known limits

What this agent does **not** promise. Each entry says what the limit is, how it
was measured, what makes it tolerable, and what fixing it would take — so the
next person weighs the same evidence instead of rediscovering it from a
customer.

## CLOSED — a node's own new work can be discarded when the hub has forked

**Fixed 2026-10-01.** `antiEntropyDecision` no longer counts `lastAppliedRef`
as "a state I am in" once this node has authored something since: a state we
have built on is behind us, so a hub state descending from it is a sibling of
our work rather than a successor to it.

That is 0.0.84's change, which was reverted because it removed the only thing
making one side yield and produced a livelock. The livelock has its own fix (see
below), and with both in place the narrowing is safe.

**Proof:** `test/fs-anti-entropy-level1.spec.ts` D1 and D4, enumerated, with the
control run both ways — removing the narrowing turns D1, D3 and D4 red.

## CLOSED — two nodes could both refuse to yield

**Fixed 2026-10-01**, and it was never closed before: §7.3 of the plan believed
the 0.0.85 revert had restored the yielding side. Enumerated over every
reachable pair, two still ended with nobody yielding — two nodes that have each
applied the other's current state and then authored their own both match
`authored && hub.ref === lastAppliedRef`, both push, neither concedes.

A single push is not a livelock; the repeat is. So attempt 1 keeps the behaviour
that was measured, and a later attempt breaks the tie on the ORIGIN: both sides
compare it the same way, the smaller pushes, the larger yields to a merge. No
coordination and no extra message. A deployment without client identity has no
origin to compare and keeps exactly what it had.

**Proof:** D2, both histories, with the control — removing the tie-break turns
it red.

## CLOSED — one folder could have two refs

**Fixed 2026-10-01, twice over**, because one fix was not enough for a rollout.

A tree ref hashes the whole tree, so two nodes could derive different ones for
byte-identical content. Measured: both machines held 38 identical files with
identical hashes and one reported `diverged: true` for over EIGHT MINUTES across
six merge repairs, logging "equivalent content, skipping restore" every time.

1. **The scan emits a canonical child order.** `readdir` is not sorted and the
   order it returns is a property of the filesystem, not of the folder, so the
   ref hashed something the content map ignored. Computed, not guessed — the
   property test in `test/fs-ref-vs-content.spec.ts` is red without the sort.

2. **A bucket round's verdict is recorded.** The first fix changes every tree
   ref once, so during a rollout a node on an older build derives the old ref
   for every folder it holds, by construction — the symptom would have returned
   for the whole rollout window. Identical per-bucket roots prove two folders
   are the same whatever either calls itself, and the anti-entropy now
   remembers that verdict instead of rediscovering the divergence on every
   beacon.

Together these mean the rollout needs no lockstep: a mixed fleet differs on
refs, agrees on content, and reports agreement.

**Proof:** `fs-ref-vs-content.spec.ts` for the order, and
`fs-anti-entropy.spec.ts` → "content agreement — two refs, one folder" for the
verdict, including that it is per-ref (a hub that genuinely moves on is still
noticed) and bounded.

## CLOSED — a deletion undone when the common ancestor cannot be read

**Fixed 2026-10-01.** The one failure in this file that was reproduced off-lab,
and the one that took the longest.

A node deleted a file while partitioned; on rejoin the file came back on **every**
node including the one that deleted it. A three-way merge does not need a record
of the deletion — given the common ancestor it can prove the file was removed —
but a partitioned node cannot read the rows its peers wrote while it was away,
so the ancestor was unresolvable and the merge degraded to two trees with no way
to tell a deliberate absence from an old one.

**Reconciliation is now additive.** Two nodes compare per-bucket manifests and
each fetches what it is missing; a deletion is carried as an ENTRY at an empty
blob id, so a peer still holding the file sees something to drop rather than an
absence to interpret. There is no outcome in which one side's folder replaces
the other's.

It needed two more things to be true at once, and neither was in the plan:

- **the prune rule had to stop deleting on authority it does not have.** It
  was first narrowed, so an absence pruned only for a sender that had
  demonstrably seen this node's state — and then removed outright. There is no
  prune rule and no `senderSawMyState` any more: an absence is never a
  deletion, and a removal is stated in the chain by the node that performed it.
  See [One Decision Site](../README.architecture.md#one-decision-site--and-the-removal-of-the-second).
- **the inline merge had to stop pruning.** It materialises a merged tree, and
  one whose ancestor it could not resolve is missing a side's files. Its
  materialisation is additive and its deletions are targeted at the paths it
  actually resolved away.

Without those the fix traded a lost delete for a lost add.

**Proof:** mesh scenario T4, 8 of 8, on the default path. Its comment carries
the whole progression — 4-5 of 8 as shipped, through five packages that were all
coin flips and two that made it worse.

## CLOSED — two people saving the same file at the same time

**Closed on 2026-10-04 by the edit chain, on the branch `fs-mesh-harness`.**
Everything below is kept as the record of what the limit was and how it was
measured, because the diagnosis at the end of it — *"what fixing it takes:
making ancestry authoritative on the default path"* — is exactly what was then
built.

What changed:

- **A node never moves to a state it has already left, and that is not a
  setting.** `classify` answers `behind` / `ahead` / `fork` / `incomplete`
  from the chain, and the rollback guard asks it **unconditionally** — the
  arrival-order race this section was about cannot happen whatever else is
  configured.
- **Where the chain can answer, it decides the merge too.** The gate on
  `resolveConflicts` remains, because a hub deliberately leaves it off to stay
  a dumb relay, and the One Client sets it `true`
  (`src/config/fs-sync-options.ts`). What is gone is the second opinion: the
  old `_ancestryRelation`, which rebuilt a predecessor map from the entire
  insert-history table on every announcement, now runs only for a peer the
  chain cannot speak for — an old wire format, or a chain that failed to
  initialise.
- **A conflict is ordered on the edit's own `timeId`**, authored where the
  change was made, not on which advertisement arrived last and not on the
  greater blob id. `compareTips` ordering a BRANCH and applying that verdict to
  paths the branch never touched was itself a defect, fixed with per-path
  ancestry (`lastEditOf`).
- **The losing content is always preserved** as a renamed conflict copy, and
  the conflict is reported.

`should converge when both clients modify the same file` — skipped since
2026-09-27 as unachievable — is unskipped and green 8 of 8, and its whole file
15 of 15 twice including the deletion test the old note warned would break.
Note that test is the SEQUENTIAL case (B waits until it holds A's content
before writing); the genuinely simultaneous contest is `fs-mesh-field-defects`'
F5 and F10, which keep both versions and say so.

---

**The historical note follows.** The later write does not win. A deterministic
one does.

When two workstations change the same file at once, the winner is decided by
comparing the two blob ids and taking the greater. Both machines see both ids in
the exchange, so both reach the same answer with no coordination — and unlike
what it replaces, that answer is the SAME on every node.

What it is not is "the later save wins". There is no reliable ordering of two
saves on two machines, so the rule is arbitrary by necessity; it is merely no
longer arbitrary PER NODE. The losing content is reported, and preserved as a
renamed conflict copy wherever `resolveConflicts` is on.

Leaving it unresolved was tried and is worse: three clients editing one file sat
on three versions for ever, because an additive step cannot settle a conflict.
Measured as `simultaneous-edit` failing 4 of 6 in isolation.

### Why the old behaviour was worse

Causal ordering exists (`_ancestryRelation`: *ahead* / *behind* / *diverged*)
but is consulted only when `resolveConflicts` is on, and that defaults to
**off**. Without it there was no notion of which change was built on which, so
the winner was decided by message timing — which is why the measurement below
was a race that a 2-core CI runner lost two runs in five and a fast laptop won
twenty times running.

The rule that replaced it is still arbitrary, but it is not a race: it is a
comparison of two values both sides already hold.

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


## OPEN — a deliberate mass deletion never arrives, and only the log says so

**What the limit is.** The mass-delete guard refuses any incoming deletion that
would remove most of a folder, on three routes: an incoming whole tree
(`restore`), an additive round's drop list (`bucketSync`), and a peer's stated
removals (`removals`). It refuses on **every** node, so a user who deletes
10 000 files on purpose ends up with one machine short of them and the rest
unchanged, and no further message will ever close that gap.

**Why the guard is right anyway.** The two cases are indistinguishable from
inside this package:

- a machine that was wiped — a reinstall, a mounted drive that did not mount,
  a sync folder pointed at the wrong path — telling the fleet to wipe too;
- a person deleting a project on purpose.

Both arrive as "most of the folder is gone". The guard exists because the first
one happened: a peer that had been emptied produced a round dropping **39 of
40** files, and before the floors covered that shape, 39 files were deleted on
every node with no refusal logged at all.

**What is signalled, and where.** Each refusal is reported three ways, from one
place (`FsAgent._refuseDeletion`) so they cannot drift apart:

| where | what it looks like |
| --- | --- |
| the log | `MASS DELETE REFUSED on <folder>: <route> would remove N of M files.` |
| `.sync-errors.log` | the key `restore/massDeleteGuard`, `bucketSync/massDeleteGuard` or `removals/massDeleteGuard` |
| the API | `FsAgent.refusedDeletions` — `{ atMs, route, wouldRemove, held, paths }`, newest last |

**For One Client.** Read `agent.refusedDeletions`. It is the same fact as the
log line in a form a UI on another machine can act on, which the log is not —
and "why did my deletion not arrive" is exactly the question that UI has to
answer. Each record carries the counts the guard judged on and the first ten
paths, which is enough to name the folder and ask the user.

It is bounded at `REFUSED_DELETION_LOG_MAX` (20) and kept in memory, so a
restart clears it while the folders stay split. That is a reason to surface it
promptly, not a reason to persist it: the refusal repeats on the next
announcement, so the list refills on its own.

**What fixing it takes.** A product decision, not a protocol one: an approval
path — the client shows "this would delete N of M files on <machine>", the user
confirms, and the agent applies that one deletion with the guard bypassed for
it. Until that exists, the refusal is the correct behaviour and the gap is a
missing dialog.

## OPEN — a node can finish churn one file short

**What the limit is.** Under sustained random writing, deleting and
partitioning, a node can end a run holding one file fewer than the fleet. It
reports the divergence (`diverged=true`) and names the path
(`differingPaths`), and it does not fetch it inside the test's window.

**Measured.** `converges under random churn and partitions`, roughly 2 runs in
8 before the test was changed to assert the guarantee rather than the aim. The
signature after the agreement-memo fix:

```
A: 4 files  diverged=true   differing=[sub/four.txt]
B: 5 files  diverged=false  local == hub
```

**What makes it tolerable.** Nothing is lost and nothing is silent. Before the
memo fix the same scenario produced **all four nodes reporting
`diverged=false`** while holding different content — a fleet that neither heals
nor admits it needs to. A node that names the file it lacks is a support case;
a node that denies the difference is a data-loss report.

**What the test asserts now.** That no node disagrees **silently**: a node
missing a path must say so in at least one of its two signals — `diverged`, or
a non-empty `differingPaths`.

Either, not both, and that is the deliberate tolerance. The two signals come
from different places: `diverged` is a latch (a difference has persisted long
enough to repair), `differingPaths` is what a content comparison found. They
can disagree, and the disagreement has a known cause — the node's scan
disagreeing with its disk, below. Requiring the latch specifically turned that
documented inconsistency into a red CI run roughly 1 time in 8.

What it still refuses to tolerate is silence, and the original defect was
exactly that: all four nodes at `diverged=false` **and** `differingPaths=[]`
while holding different content. That fails here as loudly as it ever did.

**The underlying cause, for whoever picks this up.** The node's tree and its
disk disagree:

```
B: 9 files on disk  tree=11 entries  diverged=false  local == hub
```

Eleven entries in the tree, nine files on disk. Everything the node decides is
derived from that tree — what it announces, what it compares against, what it
reports as its own ref — so it is genuinely in sync with a state it is not in,
and no signal in the loop can notice, because they all come from the same
stale tree. Start there, not at the anti-entropy.

**What fixing it takes.** The node knows what it is missing, so the gap is in
the repair actually running and completing for it. Start by logging which
decision that node reaches on each beacon and why it does not finish — not by
loosening the guards it is correctly applying.
