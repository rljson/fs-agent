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
