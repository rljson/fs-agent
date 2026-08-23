# The safety rescan is an open design question

Not a tuning knob. Recording what is measured, so the next attempt starts
here rather than at the same wrong turn.

## What it does

`FsScanner` runs a periodic full `scan()`. When the resulting content key
differs from the previous one it emits a `safety-rescan` notification, which
`syncToDb` treats like any other change: store the tree, broadcast the ref.
It exists because the native watcher drops events under burst load, especially
Windows `ReadDirectoryChangesW`.

## What is wrong with it

Drift has two causes and the rescan cannot tell them apart:

- a **local** change the watcher missed — this is what it is for, and it
  should broadcast;
- a **remote** change not yet applied here — broadcasting re-asserts this
  node's stale view.

In the second case a node re-broadcasts a tree that still contains a file a
peer has just deleted, and the deletion is undone.

## Evidence

Same bug at three settings, measured by changing only the interval:

| interval | result |
| --- | --- |
| 5s | three-client delete test fails **consistently** |
| 30s | fails **intermittently** — only when the suite runs slowly under load |
| effectively off | full suite passes, 292/292 |

The handover proposed 30s -> 5s because it helped on two machines. On three it
makes the failure deterministic.

## Why this gets worse on the trees we care about

The scan is O(N) over the whole tree, and the window in which a node can
re-broadcast stale state grows with how long applying a remote change takes.
Deep trees with large files are the worst case on both counts: the scan is
expensive, and remote applies are slow. Shortening the interval makes both
worse.

## Directions, none obviously right

- Broadcast rescan drift only when it differs from the last **received** ref as
  well as the last **sent** one, so a not-yet-applied remote change cannot be
  re-asserted.
- Let the rescan repair the watcher without pushing at all, leaving propagation
  to real events. Cheapest, but reintroduces the dropped-event hole it exists
  to cover.
- Detect drift by mtime rather than content for large trees, and only fall back
  to hashing what looks changed.

Until one is chosen, the interval is `RLJSON_FS_RESCAN_MS`-overridable so a
large deployment can back it off without a code change.

## Update: the safety rescan is probably NOT the mechanism

Traced every sync trigger across three agents at a 5s interval:

- **No push is triggered by `safety-rescan`** in these runs. Every one is a real
  watcher event. The interval correlated with the failure because it changes
  timing, not because the rescan does the resurrecting.
- Peers broadcast a tree **still containing the file**, triggered by `modified`,
  immediately after applying that file. That is `resumeWatch()` ->
  `_rescanAfterPause()` firing `_notifyChange({ type: 'modified' })` once the
  pause ends: an echo of the apply, arriving with `_remoteApplyInFlight` already
  cleared, so the WP1b flag does not cover it.

So the open question narrows, and moves: it is not "how should the safety rescan
decide whether to push", it is **"an apply echo is indistinguishable from a local
edit once the pause ends"**. The post-pause notification needs to carry its
provenance, or the content-key dedup that should absorb it needs to be
understood — it evidently does not under three nodes.

This also means the interval is a red herring for WP1. Left at 30s because 5s
remains unproven, but it is not the thing to fix.
