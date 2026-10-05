<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

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

## What to do with this

Order matters, and each step is measurable on its own:

1. **Give the bucket round the ordering rule.** `plan.drop` is a list of paths;
   refuse any whose newest chain edit is later than the manifest the drop was
   computed from. The guard belongs beside the existing mass-delete floor.
2. **Give the merge the same rule** for `resolvedAway`, which is the narrower
   of the two: it already deletes only paths it has an opinion about, so it
   needs the opinion dated.
3. **Only then correct the agreement memo**, and expect the churn split to
   close with it. Until 1 and 2 are done it cannot be enabled, and the test for
   it stays inverted with this file named in the comment.

A note on what NOT to do, because it was tried: do not make the detector
quieter to keep the deletions safe. That is the state the package is in today —
under-reporting divergence to avoid acting on it — and it is why a fleet can
sit permanently split while every node reports health.
