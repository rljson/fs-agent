# Changelog

## [0.1.0]

The edit chain becomes the sync mechanism. A folder's state is no longer a bare
content hash passed between machines; it is a chain of Edits, each naming what
changed, what was removed, which Edits it came from, and when. Every rule in the
package now asks that chain instead of inferring an answer from what a folder
happens to hold.

### Breaking

- **Every tree ref in the fleet changes.** Content identity fixes a canonical
  child order and no longer includes file modification times — a modification
  time does not survive a restore byte for byte, and on Windows regularly does
  not, so the same bytes used to hash differently per machine and a node's
  deletions were refused by everybody. Nothing is destroyed and no data moves,
  but the fleet reads divergent until every machine has re-scanned. **Upgrade
  machines together.**
- **Announcements carry a chain head (`~H~`), not a bare tree ref.** A build
  that does not speak it cannot take part, and there is no compatibility switch:
  `FsAgentOptions.announceTreeRef` is removed.
- `bucketSync` (additive reconciliation) is **on by default**.

### A deletion is a stated fact

A tree records what a folder holds, so an absence used to be read as a deletion
— by the receiver, and then, when that was removed, by the sender on its behalf.
Both are gone. A removal is only ever stated for a file this agent **watched**
being deleted, and only a stated removal deletes anything anywhere.

- Nothing prunes on a peer's authority. A received tree may add and may
  overwrite; a file disappears when some machine has said so in the chain.
- Removals are ordered by the chain's `timeId` and walked back through
  `previous`, so a deletion made during a partition is still found on rejoin.
- `ManifestEntry` carries `editedAt`, so an old tombstone cannot beat a newer
  write to the same path.
- The tombstone log is persisted in `.fsagent-state.json` and reloaded on start,
  rather than cleared one announcement after the delete.

### Repairs decide from reachability

`antiEntropyDecision` asks the chain — `behind` → pull, `ahead` → push, `fork` →
merge, a truncated walk → **`blocked`**, reported and not repaired. A node that
is behind now **asks** rather than waiting to be told, which is what refills a
machine whose folder was wiped. `ahead` no longer requires having authored the
state, so a node that adopted a peer's tree can still propagate its own
deletion.

### Conflicts

Two people saving one file get a three-way merge, a winner chosen on the chain's
`timeId` rather than on whichever content hash sorts higher, the losing copy kept
under a conflicted-copy name, and a conflict **signal** the caller can read.

### Joining a network

A folder with files and no history does not speak: it asks the network for a head
and applies it before the filesystem. `planJoin` then puts every path in at most
one of four buckets, deciding each against the chain — so a machine restored from
a backup no longer pushes a month of deletions to the fleet, and files it holds
that the history never named are kept as new work.

### Other fixes

- Two concurrent in-place writes no longer blend bytes; there is one
  write-a-file module instead of three.
- A copy still being written is held back on its first sight whatever its
  timestamp says, so a stalled writer cannot get a truncated file published.
- Ignore patterns accept globs.
- Mass-delete refusals are reported through `FsAgent.refusedDeletions`, not only
  logged, so a host application can diagnose a refusal it did not cause.
- The package builds. `crypto` was not externalised, so `pnpm build` had never
  produced a bundle on this line of work; the test run in `prebuild` hid it.

### Documentation

`README.api.md` is new and covers every export. `README.architecture.md`,
`README.tests.md` and `README.public.md` are rewritten against the code — the old
"Client A → Client B" flow described a mechanism this package no longer uses. The
suite is 70 files and 916 scenarios at 100 % coverage, and `README.tests.md` says
what they prove and what they cannot.

## [0.0.85]

### Reverts the 0.0.84 fork fix — it caused a livelock

0.0.84 stopped counting `lastAppliedRef` as "where I am" once a node had
authored something since. The reasoning holds and the fix worked for the case it
was written for: a folder copied onto node-C propagated instead of being
discarded, measured on a real fleet.

**It also removed the only thing making one side yield.** Both nodes then chose
`push`, and a disagreement with nobody yielding is a livelock. From node-C's own
revision log the same afternoon: the folder flipped between the 13-file and the
17-file state **roughly twenty times in ninety seconds** — a delete applied, the
files back within 225 ms, over and over — before settling on the state the user
had deleted.

A folder rewriting itself twenty times a minute is worse than either single
failure, so this goes back to the behaviour that shipped for months: additions
can be discarded on a fork, deletions propagate, one side always yields.

### The defect is recorded, not forgotten

the known-constraints register gains the fork case in full, and the decision test now pins
the WRONG answer with both halves of the trap written down — the fix and what it
cost — so the next person does not rediscover either.

**Why it cannot be fixed by reading this decision more cleverly:** "a peer
deleted what we added" and "a peer forked from an ancestor we share" arrive
identical — the hub holds a state we once held, made from a state we recognise.
Separating them needs the predecessor CHAIN, not one generation of it, and
nothing in the node API, `/state` or the revisions endpoint exposes ancestry at
all. Today's diagnosis was inferred from symptoms for exactly that reason. The
next step is carrying and exposing that ancestry, which is a protocol change.

## [0.0.84]

### A fork is not a lag — anti-entropy no longer discards local work

**Measured on a real fleet, 2026-09-30, and this one loses data.** A folder copied
onto node-C produced `qFU9…` — 15 files, 55 868 bytes — from the fleet state
`ca3ls…` (13 files, 29 873 bytes). The hub never adopted it and went on
announcing `ca3ls…`. node-C then decided **it** was the one behind and chose
`pull`, which means adopt the hub's older state over its own new folder. It
retried five times.

`antiEntropyDecision` asked whether the hub's state was made from a state "we
are in", where

```ts
const statesIAmIn = [currentRef, lastAppliedRef];
```

`lastAppliedRef` is a state this node ONCE adopted. The moment it builds on that
state it has moved on, so a hub state descending from the same ancestor is a
**sibling** of ours, not a successor — a fork, not a lag. Counting it anyway made
a node holding new work conclude it was behind.

**The fix:** `lastAppliedRef` counts only while we have authored nothing since.

```ts
const statesIAmIn = authored ? [currentRef] : [currentRef, lastAppliedRef];
```

The measured case now falls through to the deletion check and then to `merge` — both
sides kept — or to `push` when the hub sits on the very state our work was made
from. Never a silent discard.

### What did not change

Both deletion cases keep working, and they are the reason this code is delicate:
a peer that deletes what we added returns the folder to a state we already hold,
and pushing over that would put the deleted file back. Those match on
`currentRef`, so they never needed `lastAppliedRef`.

Not one existing decision test had `lastPushedRef` set — every one of them
describes a node with no local work to lose, which is why none of them caught
this. Four tests added, including the field scenario verbatim and a control that
a genuine forward is still pulled.

## [0.0.83]

### Changed

- **`@rljson/db` 0.0.48 and `@rljson/server` 0.0.71**, the two halves of the
 gap-fill fix. The server bounds the SIZE of a gap-fill answer (it used to send
 the whole matching ref log in one `socket.emit` — 124 kB for a full log, 203 kB
 with predecessors); db bounds the RATE at which one is asked for (an answer is
 processed ref by ref, so any ref in it that jumped another sender's sequence
 asked again). A cloud relay served 858 answers in 18.2 seconds before
 dying of `Reached heap limit` at 990 MB. Either half survives that; together a
 reconnect costs a couple of 25 kB messages.

## [0.0.82]

### Files move as streams, and the 50 MB ceiling is gone

Every blob on every path was a whole file in memory: the scanner read a file with
`readFile` and handed the Buffer to `setBlob`; a restore fetched the whole blob
with `getBlob` and then wrote it. On a remote store that Buffer also had to cross
as one socket message — so a file larger than the transport's 50 MB
`maxHttpBufferSize` could not be fetched at all, whatever the memory.

That was not hypothetical. One 63 MB file left three of four nodes permanently
holding a file the fourth had deleted; the largest observed document was
45.9 MB against the same cap.

- **Restore streams to disk.** `_atomicWriteStream` is the streaming twin of
 `_atomicWriteFile`, same platform rule, one chunk at a time.
- **Scanning streams off disk** for files above `STREAM_ABOVE_BYTES` (4 MB), and
 still reads smaller ones whole — below one chunk, the whole-file read costs no
 more memory than a stream would, and the scanner runs this once per file across
 trees of hundreds of thousands of files. Files are now **opened** rather than
 read, so a vanished file still announces itself where it always did and the
 held descriptor cannot be truncated by a delete mid-transfer.
- **`FsBlobAdapter` streams both directions**, `fileToBlob` and `blobToFile`.
- **Error attribution preserved.** Bytes now arrive *during* the write, so a peer
 going away mid-file surfaces at the write rather than the fetch. Such errors are
 tagged and reported as an unfetchable blob — one file skipped, the tree applied
 — never as a locked document, which is a different problem with a different
 person to talk to.
- **`BlobUnavailableError`'s record corrected**: the class stays, because a blob
 can still be genuinely unreachable, but size is no longer one of the reasons.

Requires `@rljson/bs` 0.0.27, where `getBlobStream` became a series of ranged
pulls. Before that release it returned a deserialised `{}` over any real socket —
229 test failures' worth of proof that the old contract could not work.

## [0.0.81]

### Changed

- **The simultaneous-write contest now measures what a host client ships, and
 passes.** `simultaneous-edit.spec.ts` built its agents without a hub state
 beacon, so the anti-entropy had no announcement to compare against and could
 never repair what three simultaneous writes left behind; the shipped case was
 therefore encoded as an expected failure. With the beacon on, both cases
 converge — five rounds, three runs, every round on one version within
 18-23 s. the known-constraints register records what this does and does not fix: the
 divergence is repaired, the choice of winner is still arrival order.

## [Unreleased]

### Changed

- **`@rljson` dependencies lifted to the current releases**: `db` 0.0.47, `io`
 0.0.80, `rljson` 0.0.83, and the `server` dev-dependency 0.0.68 — the release
 that sends the state beacon and carries `p`, which is what the client-server
 tests below need. `db` 0.0.47 also carries the gap-fill fix: without it, a
 message the hub never received made the connector re-ask for the same gap
 until the stack overflowed, which took a random test down with it.

### Added

- **Anti-entropy: a lost message no longer leaves the network divergent**
 Every hub announcement — the server's state beacon, or its
 bootstrap heartbeat — is compared with the agent's own state (the
 tree ref is the folder's checksum); a divergence that outlives a grace period
 while nothing is applying is repaired — **push** when the hub holds an
 earlier push of ours or the state our push was made from, **pull** when the
 hub's state descends from ours, **merge** (then additively) when neither can
 be shown. Every repair goes through the ordinary apply / push paths and their
 guards. On by default (`antiEntropy: { enabled, graceMs, maxBackoffMs }`);
 needs `@rljson/server` 0.0.67+ with `stateBeaconMs` (or a
 `bootstrapHeartbeatMs`), whose announcements carry `p`, and
 `@rljson/db` 0.0.44 (`stateBeaconEvent`). The grace period is measured
 while this node's OWN state stands still — however often the hub's
 changes — so a node that misses every forward while another machine keeps
 writing is still repaired. A stopped sync reports no status.
 `agent.antiEntropyStatus` reports divergence and repairs.
 Covered by `test/client-server/heals-after-forced-divergence.spec.ts`: one
 ref message dropped on purpose per case, including a node deleting its own
 file and a peer deleting it, plus a control run that must stay divergent.

- **Persistent scan cache (`scanCachePath`)**: `FsScanOptions` / `FsAgentOptions`
 gain an opt-in `scanCachePath`. When set, a file whose `mtime` **and** `size`
 are unchanged since the last scan is no longer re-read or re-hashed — its
 cached `blobId` is reused. The cache is loaded once on the first `scan()` and
 re-written (atomically) after every scan, and self-prunes deleted paths, so a
 RESTART does not re-read the whole folder (a cold scan of an 80 GB catalog is
 ~48 min) and the periodic safety-rescan stays cheap. Opt-in: with no
 `scanCachePath` behaviour is unchanged. Requires a persistent blob store
 (e.g. `@rljson/bs-fs`). A missing/corrupt cache file is tolerated (cold scan).

### Breaking Changes

- **API Refactoring**: `syncToDb()` and `syncFromDb()` now require explicit `Connector` parameter
 - Removed union type parameters for better readability
 - Methods now use signature: `syncToDb(db: Db, connector: Connector, treeKey: string, options?: StoreFsTreeOptions)`
 - Methods now use signature: `syncFromDb(db: Db, connector: Connector, treeKey: string, restoreOptions?: RestoreOptions)`
 - Constructor options `db`, `treeKey`, `bidirectional`, `storageOptions`, and `restoreOptions` are deprecated
 - Auto-sync from constructor will throw an error - use explicit `syncToDb()`/`syncFromDb()` methods instead
 - Migration: Create a `Connector` instance and pass it explicitly to sync methods

### Removed

- Removed legacy `db.notify` polling mechanism
- Removed 100+ lines of complex union type parameter mapping logic

### Added

- Added `Connector` import from `@rljson/db`
- Cleaner, more explicit API with required Connector parameter

## [0.0.1]

Initial commit.

