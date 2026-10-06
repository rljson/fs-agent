<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# THE RULE

**Content-based linked chaining is the mechanism of consistency. Nothing is
transferred, and no action is taken, except through the shared edit chain —
consequently chained, and applied in order.**

No heuristic is an acceptable substitute. Where one exists today it is a gap to
be closed, not a design choice to be balanced against the chain. This document
exists because that gap turned out to be larger than anyone had written down,
and because ten separate fixes for one defect were each attempted at the wrong
end of it.

The practical reading, in the order it has to happen:

1. **make the chain able to answer** — a verdict that arrives too late is
   indistinguishable from no chain at all;
2. **then the heuristics stop being reached**, having become unnecessary rather
   than forbidden;
3. **then remove them**, and the safety floors that exist only to catch their
   mistakes;
4. **the agreement memo is one line at the end of that**, not the start.

Removing a heuristic before step 1 removes a mechanism the fleet is currently
relying on. That was measured — see *Why the chain is not actually leading*
below — and it is the single most expensive thing in this file to re-learn.

# The convergence contract — who may delete a file, and on what evidence

Written 2026-10-05, after six separate fixes for one defect were each measured
and withdrawn. They failed for the same reason, and it is not a bug in any of
them: **they all corrected the one deletion authority that already consults the
edit chain, while the deletions were coming from two that do not.**

This document enumerates every mechanism that can remove a file from a synced
folder and states the evidence each acts on. It exists because that list had
never been written down in one place, and six attempts were made without it.

## The five authorities

| mechanism | evidence it acts on | consults chain ordering |
| --- | --- | --- |
| `_applyIncomingRemovals` | a chain entry **states** the removal | **yes** |
| `_applyReconcilePlan` → `plan.drop` | the peer's **manifest** holds a tombstone for a path we hold live | **yes, since `_dropsTheChainForbids`** |
| `FsConflictResolver` → `deleteFileAt` | the **merge plan** resolved the path away — it is in neither branch's merged set | **yes**, and it loses no bytes either way |
| `_pruneExtraneous` | the caller passed `cleanTarget: true` | n/a — never used by `syncFromDb` |
| `_makeRoomFor` | the incoming tree says this path is now the other KIND of thing | n/a — local and mechanical |

All three that can fire during an ordinary sync honour the chain.

The row for `FsConflictResolver` said **no** for a long time and was already
wrong when it was written — a stale row, not a hole, and it was listed as an
open release risk on the strength of this table alone. The code orders every
conflicting path by `lastEditOfPath` and `compareTimeId` (`winnerFor`), and an
edit/delete conflict preserves the losing side's content as a conflict copy, so
neither verdict can lose bytes. Asserted by *"gives a path to whichever side
edited it LAST when both did"*, *"orders by the chain timeId before anything
else"* and *"edit/delete conflict: surviving edit is preserved even when winner
deleted"*.

The lesson is about this document, not the code: **a table is not evidence.**
Both corrections in this file so far — the hub's "unmarked announcements" and
this row — were believed because they were written down.

## What "consults chain ordering" means

`_applyIncomingRemovals` asks, per path, whether anything has happened to it
since the removal was minted:

- `unannounced` — local work no peer has heard of outranks any removal, because
  no removal can have been about it;
- `localTimeIds` — this node's own claim on the path, compared by `timeId`;
- `chainTimeIds` — the chain's last edit of the path, for the case this node
  holds a file it RECEIVED rather than authored and therefore claims nothing.

A removal loses to anything newer. That is the rule the chain exists to
provide, and it is why `_applyIncomingRemovals` is safe to act on a statement
minted minutes ago.

**Neither of the other two asks any of this.** The bucket round compares two
manifests and drops what the peer tombstoned. The merge deletes what its plan
resolved away. Both are correct about the state they were computed from, and
neither can tell that the state is stale — so a file created after that state
was captured is deleted by evidence that predates it.

## Why that produces the observed failures

Both unguarded authorities fire *more often* when divergence is detected more
often. So:

- **correcting the agreement memo** (`_contentAgreed`, keyed on the hub ref
  alone instead of on the pair) makes the fleet notice real divergence — and
  the repairs it then runs delete through the two unguarded authorities.
  Measured: I7b from 5/5 passing to 8/8 failing, with the memo as the only
  change, and again with `@rljson/io`'s read fix linked.
- **the churn fuzzer's stable split** has the same shape from the other side: a
  node holding a conflict copy the others deleted, with every node reporting
  `diverged=false`.

The six withdrawn attempts, for the record, so they are not retried:

| attempt | why it looked right | why it failed |
| --- | --- | --- |
| memo keyed on the pair | the memo really is unsound | turns the detector on; the repairs delete |
| `currentRef` from the live scan | a node should not claim a state it is not in | makes own work look like divergence — `fork-is-not-a-lag` |
| filter `~BE~`/`~BR~` out of `observe` | a bucket envelope is not a state | something in the bucket path depends on those observations |
| `blocked` when a chain exists but gave no verdict | the heuristics are provably wrong there | the heuristic repairs are load-bearing for delivery |
| push-only drift announcement | announcing cannot delete locally | announcing IS a deletion order elsewhere (then) |
| chain-led removal ordering | the ordering fact was never asked for | correct, and kept — but the deletions were not coming from there |

## The contract this is missing

> **One ordering rule, honoured by every mechanism that deletes.**

A path must not be deleted on evidence older than the newest edit of that path,
whoever made it and whichever mechanism is acting. The chain already answers
that question — `lastEditOf(head, path)` — and two of the three deleting
mechanisms never ask it.

That is one rule applied in three places, not three rules. It is also the same
shape as the fix that made `_applyIncomingRemovals` safe, and the same shape as
"an absence is not a deletion": **do not act on a fact derived from a state
without checking whether the state is still current.**

## What to do with this — and what does NOT work

The obvious fix was tried, measured and reverted. **Recorded here so it is not
tried a second time.**

The idea: give the bucket round's `plan.drop` and the merge's `resolvedAway`
the same ordering rule, by asking `lastEditOf(head, path)` whether the
history's newest word on that path is `changed` or `removed`, and refusing the
deletion when it says the file exists.

**It cannot be asked from the deciding node's own head, and that is fatal.**
`lastEditOf` walks back from a head through what that head descends from. A
node being told to delete a path has NOT yet applied the entry that states the
removal — that is precisely why it is being told — so its own head cannot see
it. The newest word it finds is the file's creation, so the guard refuses every
removal it was built to order, including every correct one.

Measured, with both guards in place: four deletion-propagation tests red —
`delivers a deletion a peer never received`, `does not undo a peer deletion it
missed`, `T4: a delete made while cut off is not resurrected on rejoin`, and J9.
The matrix passed 9 of 9 in isolation, which is how the mistake survived long
enough to be committed: the scenarios that catch it live in other files.

So the rule is right and **the information needed to apply it is not available
where the deletion happens**:

- a bucket **manifest** carries paths and blob ids, and no chain reference or
  time at all — there is nothing to date the tombstone against;
- a **merge** holds two branch tips, and the edit that would outrank its
  opinion is by construction one that neither tip descends from.

Anything built on this has to give those two mechanisms a reference into the
chain they do not currently carry — a tombstone that names the entry that
created it, or a merge basis that can be compared against a later entry. That
is a protocol change to the manifest, not a guard.

The agreement memo therefore stays inverted, and the churn split stays open.
Nine attempts are catalogued above; the tenth was this one.

A note on what NOT to do, because it was tried: do not make the detector
quieter to keep the deletions safe. That is the state the package is in today —
under-reporting divergence to avoid acting on it — and it is why a fleet can
sit permanently split while every node reports health.

---

# Why the chain is not actually leading

Added 2026-10-05, on the question *"content-based linked chaining IS the main
mechanism of consistency — why do we still have other mechanisms?"*

The answer is structural, and it is not that anything overrules the chain.
**The chain was added alongside the mechanisms it was meant to replace, and the
old ones are still reached — because the chain's verdict usually is not
available when the decision is made.**

## The six decisions still taken without it

| mechanism | decides from | what its own comments say |
| --- | --- | --- |
| `antiEntropyDecision` fallback | a content hash and one generation of predecessors | *"§2.2 is the proof that cannot be made correct"* — the two situations needing opposite actions arrive as the same value |
| `_inboundRefVerdict` / `isNewestFromSender` | a **per-sender** sequence number | *"the real fix is for the bootstrap to carry the originating client, so the origin filter works and this check stops being needed at all"* |
| the bucket round | a file list: paths, hashes, tombstones. No edits, no predecessors, no order | — |
| `_treesHaveEquivalentContent` | comparing two trees, to clear a divergence | — |
| mass-delete floors (`MASS_DELETE_*`, `ALL_GONE_MIN_FILES`) | arbitrary counts and ratios | a safety net that exists *because* the four above can be wrong |
| `_lastSentRef` / `_lastSentContentKey` / own-echo | this node's own bookkeeping | measured disagreeing with itself three ways: 7 files held, a 5-file ref claimed, a 4-file state last announced |

## Why they are reached at all

Not because anything prefers them. Because the chain is asked and does not
answer in time:

- ~~**the hub's announcements carry no chain head.**~~ **RETRACTED, and the
  real cause found — see "Where the headless announcements came from" below.**
  The hub is faithful: `Server` keeps `this._latestRef = ref` with the prefix
  intact and relays what it was handed. The headless announcements were the
  agent's own, from exactly one line, and they were the *merge* revisions;
- **chain reads were stalling.** 24–27 reads per gate run blocked for a full
  10 s, `resolveAnnouncement` among them. A verdict that arrives too late is
  indistinguishable from no verdict at all. `@rljson/io`'s group-read fix
  removes those; 9 remain from `ancestryPrevious`.

So the rule "the chain leads" is not being broken by a competing rule. It is
being **bypassed by timeouts and by an announcement format that omits the one
field the rule needs.**

## What each would need to be retired

1. **the heuristic fallback** — every announcement must carry the chain head, so
   a reachability verdict always exists. Then absent means "no chain in this
   fleet", which is the only case the heuristics were ever right for.
   **DONE for the one case that was failing:** the merge revision is announced
   as a head, and a mesh-wide census now records 0 bare refs. What remains is
   not a format gap but the stalling reads below.
2. **`isNewestFromSender`** — the bootstrap must carry the originating client,
   as its own comment says. A per-sender sequence cannot order two senders.
3. **the bucket round** — making it additive-only was TRIED AND REVERTED, and
   the result is the most important measurement in this file.

   Removing its destructive half, and the merge's, broke **four real
   deletion-propagation scenarios**: *delivers a deletion a peer never
   received*, *does not undo a peer deletion it missed*, *T4: a delete made
   while cut off is not resurrected on rejoin*, and J9 — plus two merge tests
   that assert the merge deletes.

   **So the chain does not deliver deletions on its own.** The bucket round and
   the merge are not legacy mechanisms competing with it; they are what HEALS a
   deletion the chain failed to deliver. The chain carries a deletion to a node
   that is listening and reachable. For a node that was cut off, stopped, or
   simply missed the entry, the manifest comparison is the only thing that ever
   notices, because it compares STATE rather than replaying history.

   That reverses the conclusion this file opened with. The non-chain mechanisms
   are not the problem to remove — they are compensating for the chain not
   being self-sufficient, and removing them removes the compensation.

   **So "only the chain deletes" is a goal, not a change.** It requires the
   chain to deliver deletions reliably first: announcements that carry the head
   (point 1), reads that return (`@rljson/io`'s group-read fix), and an
   anti-entropy that asks rather than waits. Until then the bucket round is
   load-bearing and must keep its drops.
4. **`_treesHaveEquivalentContent`** — legitimate as an optimisation (two refs,
   one folder, during a rollout). It must not be allowed to *clear a
   divergence*, which is the agreement-memo bug.
5. **the mass-delete floors** — retire when 1–4 are done. They are a net under
   decisions that can be wrong; with the chain leading there is nothing to
   catch.
6. **the own-echo bookkeeping** — needs one source of truth for "what state am
   I in", derived rather than remembered. Reporting the live scan instead was
   tried and is wrong on its own (`fork-is-not-a-lag`); it needs the push path
   fixed, not the anti-entropy's view.

## The one-line version

The chain leads where it is consulted, and it was consulted least where it
matters most: on the **merge revision** — the state produced by the one
mechanism that exists to settle disagreement was the only state announced
without a head, so it was the state least able to be reasoned about.
Everything in the table above is what filled that silence — and, measured,
**what made deletions converge at all** while it lasted.

The order that follows from this, and it is the opposite of removing things
first:

1. make the chain able to answer — heads on announcements, reads that return;
2. then the heuristics stop being reached, having become unnecessary rather
   than forbidden;
3. then they can be removed, and the mass-delete floors with them;
4. the agreement memo is one line at the end of that, not the start.

Ten fixes were attempted before this was understood, every one of them at step
3 or 4. They are catalogued above so that the eleventh starts at step 1.

# Where the headless announcements came from

Recorded because the wrong half of the system was blamed for it in this very
file, twice, and because the measurement is cheap enough that nobody should
ever argue about it again.

## The instrument

Wrap the connector in the mesh harness and print every ref that leaves a node:

```ts
const orig = connector.send.bind(connector);
connector.send = (r) => {
  console.log(`out ${r.startsWith('~H~') ? 'MARKED' : 'BARE'} ${name} ${r}`);
  orig(r);
};
```

## The reading

`J9`, both scenarios, before the fix:

| node | marked (`~H~<head>`) | bare (tree ref) |
| --- | --- | --- |
| A | 4 | 0 |
| B — the node that merges | 0 | **2** |

Both bare refs came from one line, identified by marking each unsuppressed
`storeFsTree` call: `storeMerge`, in `_buildConflictResolverDeps`.

## The mechanism

`Connector._registerDbObserver` broadcasts `ins[tableKey + 'Ref']` — the raw
**tree** ref from the insert row. Every push in `fs-agent.ts` goes out through
`_sendRef`, which announces `_announceAs(ref)`, the head. `storeMerge` stored
without `skipNotification`, so the observer broadcast it instead — bare, and
*before* `_recordChainEntry` had written the entry, so there was no head to
announce even in principle.

## Why announcing the head was not enough on its own

The merge revision's entry named only its LOCAL parent. The conflict path
`return`s before the apply's own bookkeeping, which is where
`_adoptedChainHead` is set — and that block's comment names "a merge" as one of
the cases it was written for. It never ran for one.

A one-parent merge is not merely incomplete. It resolves BOTH branches but
descends from one, so the peer whose branch was merged in classifies it as a
`fork` against its own head and resolves it again. **Announcing that head would
have converted a finished merge into a standing disagreement** — a heuristic
removal that looks like a fix and is a regression.

So the fix is two halves, and the second is what makes the first safe:

1. adopt the incoming side's head before the resolve, via `_headForTreeRef`, so
   the entry names both parents;
2. suppress the observer and announce the head by hand, after the entry exists.

`_headForTreeRef` is the tree-ref-to-head direction that the old comment in
`storeMerge` said nothing resolved. It had been there since the announced heads
were first parked; the comment was stale, not the capability.

## Which shape reaches the inline merge at all

Measured while building the invariant, and worth more than the invariant.

With `bucketSync` on — the shipping default, since `FsAgentOptions.bucketSync`
defaults to `!announceTreeRef` — a divergence between two nodes that were
connected, partitioned and healed is answered by the **bucket round**.
`_resolveConflictInline` is never entered: `storeMerge` fired **zero** times
for a cut / write-both-sides / heal scenario that produced
`[FsBucketSync] fetch=1 drop=0 redelete=0 conflict=1` on every node.

The shape that does reach it is **stop / change / restart**: a node brought
down, its folder changed while it is down, the fleet changed too, then brought
back. `storeMerge` fired 4 times for that.

Two consequences:

- the bare merge ref was found by `J9` and could not have been found by any
  partition test, however aggressive. The scenario matrix's stop/restart
  entries are not a variation on partitioning — they are the only route into a
  whole branch of the code;
- a test that means to exercise the three-way merge and uses a partition is
  testing the bucket round instead, and will pass for the wrong reason.

## The invariant that holds this

`every announcement carries a chain head`, in
`test/mesh/fs-mesh-invariants.spec.ts`. It records at the connector — the last
point where a ref is still what the peer receives — because the second
producer, `Connector`'s db observer, is invisible from inside `FsAgent`, and
that is precisely how both bare announcements survived so long.

It covers both halves independently; each was checked by reverting one
suppression at a time:

| state of the fix | result |
| --- | --- |
| both suppressions in place | passes |
| merge suppression reverted | fails, 3 bare refs |
| startup suppression reverted | fails, 3 bare refs |

It also asserts that some heads were recorded at all, so a harness that
silently stopped recording cannot make it pass by emptying the list.

# The tombstone that outlived its own supersession

The second row of the table above said **no** until this was fixed, and the
cost of that `no` was a file.

## The scenario

`I7b: a delivered deletion does not beat a later re-creation`. B deletes
`flip.txt` while connected, so every node applies the removal. B is then cut
off. C re-creates the path, strictly afterwards, and A and C both hold it. B
rejoins — and A deletes the file.

## Why the round did it

`reconcile` in `src/fs-manifest.ts` compares two manifests. A manifest says
what a node HOLDS; it never says when the node decided. So:

```ts
if (theirsIsTombstone) {
  plan.drop.push(path);
}
```

is the whole rule. B's tombstone is authority on its own, and the write that
superseded it is not consulted, because a manifest cannot express it.

`reconcile` already knew this about itself. Its comment on the conflict branch
reads: *"The conflict resolver had the same defect ('winners were chosen by
content hash') and was fixed by ordering on the chain; this rule survived
because it is the one that must work with no history at all."* That holds for
the hash tie-break, which is the fallback for two nodes with no shared
history. It does not hold for a tombstone, where a history exists and says
plainly which came first.

The `claimed` set cannot answer it either: it is `_localPathTimeIds`, the paths
THIS node authored. A never authored `flip.txt` — C did — and B's claim was
dropped when B recorded its own removal. Neither side of the round claims the
path, so a claim-based rule leaves it unprotected.

## Why it had never been seen

The test was passing, and for a reason worth recording: **a read was too slow
to deliver the data that triggers the bug.** On `@rljson/io` 0.0.83 the log
carries

```
[FsAgent C] ancestry lookup for this push did not finish
```

so C's push went out with no ancestry, every receiver applied it additively,
and the folder was correct by accident. io 0.0.84 bounded that read. The line
disappears, the push carries its ancestry, the bucket round runs for real —
and `drop=1`.

So io 0.0.84 is not a regression here. It removed a mask. A green test whose
greenness depends on a timeout is not evidence of anything, and this one had
been cited as evidence for a long time.

## The rule

`_dropsTheChainForbids`, applied to the drop list before the mass-delete
guards see it:

> A peer's tombstone may not remove a path whose newest word in THIS node's
> chain is a write.

`lastEditOf` walks back from the local head and reports the newest entry
mentioning the path, in `changed` or in `removed`. A newest word of `changed`
means nothing superseded that write — a newer deletion would itself be an
edit, and this node would have applied it before answering the round. So no
timestamp has to travel and the manifest format is untouched.

Receiver-side, which is not a detail: four sender-side fixes for this family
were built and withdrawn, and the rule that holds is the one each node applies
to its own folder, because that is the only place its chain is authoritative.

Convergence is unaffected. A and C keep the file and say so —

```
[FsAgent A] kept 1 path a peer asked to drop: this node's history has a newer
edit for flip.txt
```

— and B, whose rejoin adopts the fleet's head, lifts its own stale tombstone
through `_applyIncomingRemovals` and fetches the file by the ordinary path.
Eight runs of `I7b`, eight passes, on io 0.0.84.

# One defect, two masks: why the agreement memo has now been tried twice

The memo in `src/fs-anti-entropy.ts` records "the hub's ref X describes the
same content as the folder I am in" and keys it on **X alone**, so the verdict
survives this node moving. It is wrong, it is known to be wrong, and the note
on it used to say the correction was waiting on one missing piece.

It was not one piece. Measured by removing things one at a time, with `I7b: a
delivered deletion does not beat a later re-creation` as the probe:

| state | I7b |
| --- | --- |
| memo keyed on the pair, both side-fixes in | 0 of 8 |
| memo reverted, both side-fixes in | 0 of 6 |
| memo reverted, bare-ref second observe removed | 0 of 3 |
| memo reverted, bucket-envelope filter removed | **3 of 3** |

The two side-fixes were found while attempting the memo and are both correct in
principle:

- **bucket-sync envelopes were reaching `observe`** as if they named a state
  (`hub=~BR~{"r"…`). They name no tree, can never equal a local ref, and so
  made the folder look permanently diverged with the decision coming from
  heuristics on a JSON envelope;
- **a bare hub beacon was observed with no reachability**, so the heuristics
  decided `pull` for a node that was ahead
  (`hub=hd3PHz1r… local=_esQ4A0L… — pull`).

Neither fixed the memo, and the first one BREAKS `I7b` on its own. That is the
finding: the spurious divergence those envelopes produce was suppressing a real
repair, and the repair is a `pull` on a node holding a re-created file. The
pull replaces the folder and the file is gone.

So there is **one defect and two masks**:

1. the memo, which stops the divergence being reported;
2. the envelope pollution, which keeps the tracked hub state moving so the
   divergence never persists long enough to be repaired.

Remove either and a file is lost.

## And the defect underneath has one root cause

Logging the decision inputs with both masks off:

```
anti-entropy: hub=_esQ4A0L… local=hd3PHz1r… diverged for 89s — pull (attempt 44)
```

Forty-four attempts over eighty-nine seconds, every one with `reachability`
**undefined**. It is a livelock — the same unbounded retry of a divergence that
cannot be closed which `@rljson/mongo-agent` bounded in 0.0.52.

And the reason the chain never decides is not that the decision ignores it.
`antiEntropyDecision` switches on `hub.reachability` before any heuristic and
answers `push` for `ahead`. The verdict simply does not arrive: resolving the
announced state is a read, and on this path it still takes the full ten seconds
(`Timeout after 10000ms: … resolveAnnouncement`). **A verdict that arrives late
is indistinguishable from no verdict**, and no verdict is exactly when the
heuristics answer `pull`.

## The order that follows

Not "fix the memo" — that was attempted twice and failed twice:

1. make the reachability read return on the anti-entropy path;
2. then the switch answers from the chain and the livelock stops;
3. then both masks come off together — the memo key and the envelope filter;
4. the memo is one line at the end of that.

Which is what "The one-line version" of this document said from the start:
*make the chain able to answer; then the heuristics stop being reached; then
they can be removed; the agreement memo is one line at the end of that, not the
start.* The two failed attempts were both step 4 before step 1.

This is the third time in this package that a green test turned out to depend on
something being broken: the ancestry read that was too slow to deliver its data
(see above), and now two masks over a bad repair. The pattern is worth naming —
**a test that passes because a mechanism is not running is not evidence that the
mechanism is correct.**
