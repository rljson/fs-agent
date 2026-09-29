# Changelog

## [0.0.81]

### Files move as streams, and the 50 MB ceiling is gone

Every blob on every path was a whole file in memory: the scanner read a file with
`readFile` and handed the Buffer to `setBlob`; a restore fetched the whole blob
with `getBlob` and then wrote it. On a remote store that Buffer also had to cross
as one socket message — so a file larger than the transport's 50 MB
`maxHttpBufferSize` could not be fetched at all, whatever the memory.

That was not hypothetical. One 63 MB file left three of four nodes permanently
holding a file the fourth had deleted; the customer's largest document was
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

## [Unreleased]

### Changed

- **The simultaneous-write contest now measures what the One Client ships, and
  passes.** `simultaneous-edit.spec.ts` built its agents without a hub state
  beacon, so the anti-entropy had no announcement to compare against and could
  never repair what three simultaneous writes left behind; the shipped case was
  therefore encoded as an expected failure. With the beacon on, both cases
  converge — five rounds, three runs, every round on one version within
  18-23 s. `doc/known-limits.md` records what this does and does not fix: the
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
  (ONE-446). Every hub announcement — the server's state beacon, or its
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

