# Changelog

## [Unreleased]

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
  `bootstrapHeartbeatMs`), whose announcements carry `p`.
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

