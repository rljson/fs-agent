<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent

Filesystem agent for RLJSON that provides automatic synchronization between filesystem and database with tree structures and blob storage.

## Features

- **Automatic Database Sync**: Watch filesystem changes and automatically sync to database
- **Tree Structures**: Extract filesystem as RLJSON tree structures
- **Blob Storage**: Store file content in blob storage with deduplication
- **Version Tracking**: Maintain insert history for version tracking
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Well-Tested**: 100% test coverage

## Installation

```bash
npm install @rljson/fs-agent
```

## Quick Start

### Automatic Sync

```typescript
import { FsAgent } from '@rljson/fs-agent';
import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { BsMem } from '@rljson/bs';
import { createTreesTableCfg } from '@rljson/rljson';

// Setup database
const io = new IoMem();
await io.init();
const db = new Db(io);
const treeKey = 'projectFiles';
const treeTableCfg = createTreesTableCfg(treeKey);
await db.core.createTableWithInsertHistory(treeTableCfg);

// Create FsAgent with automatic syncing
const agent = new FsAgent('./my-project', new BsMem(), {
  db,
  treeKey,
  ignore: ['node_modules', '.git', 'dist'],
  maxDepth: 10,
});

// Agent automatically:
// 1. Watches filesystem for changes
// 2. Extracts tree structures
// 3. Stores blobs in blob storage
// 4. Syncs changes to database

// When done, clean up resources
agent.dispose();
```

### Manual Sync

You can still use the manual approach if needed:

```typescript
const agent = new FsAgent('./my-project');

// Manually start syncing
const stopSync = await agent.syncToDb(db, treeKey);

// Later, stop syncing
stopSync();
```

## Usage

### Automatic Watching

- Filesystem changes are automatically detected
- No need to manually call `syncToDb()` or `watch()`
- Initial sync happens immediately on instantiation

### Automatic Syncing

- File additions, modifications, and deletions are tracked
- Trees are extracted and stored in the database
- Blob content is stored in blob storage
- Insert history is maintained for version tracking

### Resource Management

- Call `agent.dispose()` to stop watching and clean up resources
- Safe to call even if syncing was never started
- No memory leaks from file watchers

## Options

```typescript
interface FsAgentOptions {
  /** Ignore patterns for scanning */
  ignore?: string[];
  /** Maximum depth for directory traversal */
  maxDepth?: number;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
  /** Database instance for automatic syncing */
  db?: Db;
  /** Tree key for database storage */
  treeKey?: string;
  /** Storage options for database operations */
  storageOptions?: StoreFsTreeOptions;
}
```

## Benefits

1. **Simpler API**: Just provide db and treeKey in constructor
2. **Less boilerplate**: No need to manage sync lifecycle manually
3. **Automatic cleanup**: dispose() handles all cleanup
4. **Type-safe**: Full TypeScript support with type checking
5. **Tested**: 100% test coverage including automatic sync scenarios

## Example

[src/example.ts](src/example.ts)
