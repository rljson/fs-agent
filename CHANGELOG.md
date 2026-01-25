# Changelog

## [Unreleased]

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

