# Delete propagation: a ref that arrives but is never adopted

This file started as "the safety rescan is an open design question". It was
wrong twice, in instructive ways, so the wrong turns are kept at the bottom
rather than deleted. The measurement that settled it is first.

## The invariant

> The connector marks a ref **received** the instant it arrives. The agent
> retires a ref only when it **leaves a state it adopted**. Any ref that
> arrives and is never adopted is therefore marked received forever.

Because a tree ref is a pure content hash, that is not a lost notification —
it silently makes a *state* unreachable. A peer that later puts the folder back
into exactly that state re-derives that exact ref, and the advertisement is
discarded before any agent sees it.

Deleting a file created earlier in the same session is precisely that shape:
the folder goes A → B → A, and the return trip re-derives A's ref.

`invalidateSent` (db 0.0.30) already covered the sender's half. This is the
receiver's half, and it had three separate holes.

## The three holes, all measured

Traced with a per-node tag on every notify / adopt / push, plus ACCEPT-INCOMING
and DROP-INCOMING inside `Connector`, running `test/client-server` at a 5s
rescan interval until the three-client delete test failed.

**1. A ref adopted with no restore was never recorded.**
`syncFromDb` returns early when the incoming tree already matches the folder
("equivalent content, skipping restore"). That ref *describes the folder* — it
is an adopted state — but the early return skipped the bookkeeping, so it was
never retired. Every agent reaches its BOOTSTRAP state this way, since peers
that are already in sync have equivalent content by definition.

```
[b] EXIT=equivalent-content m4_MIU7B (BOOKKEEPING NOT UPDATED)
...  a creates mod.txt, modifies it, then deletes it — back to the seed state
[a] PUSH m4_MIU7B files=[seed.txt] cause=deleted
[C b] DROP-INCOMING m4_MIU7B (already received)      <- deletion reached no peer
```

Fixed by `FsAgent._adoptAppliedRef`, called from both exits.

**2. Single-flight dropped a pending ref without handing it back.**
`scheduleProcess` keeps only the latest ref — correct, the newer one describes
the newer state — but the superseded ref had already been marked received and
was never looked at. Fixed by `invalidateReceived` on the ref being replaced,
the same treatment an apply that fails terminally already gets.

**3. `Connector._missedRef` is a one-slot buffer that silently overwrote.**
Refs arriving before `listen()` are parked in a single slot. A second arrival
replaces the first; both are marked received, only the survivor is delivered.

```
[C c] IN kQKLvAEl                                 <- A's bootstrap ref
[C c] MISSED-SLOT kQKLvAEl overwrites=<none>
[C c] IN q24yumZY                                 <- B's bootstrap ref
[C c] MISSED-SLOT q24yumZY overwrites=kQKLvAEl    <- kQKLvAEl lost, still marked
[C c] REPLAY-MISSED q24yumZY
...
[a] PUSH kQKLvAEl [seed.txt] cause=deleted
[C c] DROP-IN kQKLvAEl
```

Fixed in `@rljson/db` `Connector._notifyCallbacks`: hand the replaced ref back.
Delivery is still (correctly) skipped — only the dedup mark is lifted.

## Why three peers and not two

Pure arithmetic, and it is worth stating because it looked like a load bug for
weeks. Each node receives a bootstrap ref from every other node at once. With
two connectors one ref lands in the pre-`listen()` window; with three there is
a second one to overwrite it. Two nodes also tend to *heal* hole 1 by accident:
when both folders hold identical content their bootstrap refs are equal, so
each node's own `_sendRef` (which calls `invalidateSent`) clears the ref from
its own received set. With three nodes the refs differ and nothing clears them.

## Wrong turn 1: the safety rescan

The rescan was blamed because the failure tracks the interval: at 5s the
three-client delete test failed consistently, at 30s intermittently, with the
rescan off the suite passed. Measuring which notification actually triggers
each push showed **no push is triggered by `safety-rescan` at all**. The
interval matters only because it shifts timing — which bootstrap refs land in
which window. It is a red herring for this bug.

## Wrong turn 2: the post-pause apply echo

`resumeWatch()` -> `_rescanAfterPause()` -> `_notifyChange({type:'modified'})`
does fire after an apply, with `_remoteApplyInFlight` already cleared, and it
does look exactly like a local edit. But it is harmless: across two full traced
runs, **every** echo that reached `debouncedSync` was absorbed by the
content-key dedup. The handful that pushed had genuinely different content
(a real local file, or the same path with a different blobId) — the debounce
had simply coalesced the echo with a real event.

So the echo is real and the reasoning about it was sound; it just is not the
mechanism. `_remoteApplyInFlight` and its `safety-rescan` gate are kept as
defence, but they were never load-bearing for this failure.

## Still open

The `relation === 'ahead'` early return has the same shape as hole 1: the ref
is marked received and never adopted. It is left alone deliberately. That
branch only runs with `resolveConflicts` on, and there the ancestry classifier
would ignore a genuine return to an ancestor state anyway — so retiring the ref
would not by itself make the revert work. That is a separate question about the
conflict path, and it deserves its own measurement rather than a fix by
analogy.
