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
| `_applyReconcilePlan` → `plan.drop` | the peer's **manifest** holds a tombstone for a path we hold live | **no** |
| `FsConflictResolver` → `deleteFileAt` | the **merge plan** resolved the path away — it is in neither branch's merged set | **no** |
| `_pruneExtraneous` | the caller passed `cleanTarget: true` | n/a — never used by `syncFromDb` |
| `_makeRoomFor` | the incoming tree says this path is now the other KIND of thing | n/a — local and mechanical |

Three of them can fire during an ordinary sync. One honours the chain.

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

- **the hub's announcements carry no chain head.** It advertises from the
  server's trees table, not from the ref log it relayed, so the commonest
  announcement in the fleet arrives with no reachability verdict — and the
  decision falls through to the heuristic by default, not by exception;
- **chain reads were stalling.** 24–27 reads per gate run blocked for a full
  10 s, `resolveAnnouncement` among them. A verdict that arrives too late is
  indistinguishable from no verdict at all. `@rljson/io`'s group-read fix
  removes those; 9 remain from `ancestryPrevious`.

So the rule "the chain leads" is not being broken by a competing rule. It is
being **bypassed by timeouts and by an announcement format that omits the one
field the rule needs.**

## What each would need to be retired

1. **the heuristic fallback** — hub announcements must carry the chain head, so
   a reachability verdict always exists. Then absent means "no chain in this
   fleet", which is the only case the heuristics were ever right for.
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

The chain leads where it is consulted, and it is consulted least where it
matters most: on an ordinary hub announcement, which carries no head, under a
read that may not return. Everything in the table above is what fills that
silence — and, measured, **what currently makes deletions converge at all.**

The order that follows from this, and it is the opposite of removing things
first:

1. make the chain able to answer — heads on announcements, reads that return;
2. then the heuristics stop being reached, having become unnecessary rather
   than forbidden;
3. then they can be removed, and the mass-delete floors with them;
4. the agreement memo is one line at the end of that, not the start.

Ten fixes were attempted before this was understood, every one of them at step
3 or 4. They are catalogued above so that the eleventh starts at step 1.
