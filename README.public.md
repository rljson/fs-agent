<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent

> **A powerful filesystem agent that seamlessly synchronizes your file system with RLJSON databases, providing automatic bidirectional sync, tree structures, and content-addressed blob storage.**

## Overview

`@rljson/fs-agent` bridges the gap between your filesystem and RLJSON databases. It watches for changes, extracts hierarchical tree structures, stores file content efficiently in blob storage with automatic deduplication, and maintains complete version history. With built-in bidirectional synchronization, your filesystem and database stay perfectly in sync—automatically.

### Why Use fs-agent?

- 🔄 **Automatic Synchronization**: Changes flow seamlessly between filesystem and database
- 🌳 **Tree Structures**: Represents directories as RLJSON tree structures with parent-child relationships
- 💾 **Smart Storage**: Content-addressed blob storage eliminates duplicate file content
- 📜 **Version History**: Every change is tracked with complete insert history
- 🔁 **Bidirectional Sync**: Changes in either direction are automatically propagated
- 🛡️ **Loop Prevention**: Intelligent pause/resume mechanism prevents infinite sync loops
- ✅ **Type-Safe**: Full TypeScript support with comprehensive type definitions
- 🧪 **Battle-Tested**: 100% test coverage with 123 tests

## Installation

```bash
npm install @rljson/fs-agent
```

## Quick Start

### Basic Usage - Automatic Sync

The simplest way to get started is with automatic synchronization:

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

// Create tree table (must end with "Tree")
const treeKey = 'projectFilesTree';
const treeTableCfg = createTreesTableCfg(treeKey);
await db.core.createTableWithInsertHistory(treeTableCfg);

// Create FsAgent - syncing starts automatically!
const agent = new FsAgent('./my-project', new BsMem(), {
  db,
  treeKey,
  ignore: ['node_modules', '.git', 'dist'],
  maxDepth: 10,
});

// That's it! The agent now:
// ✓ Watches your filesystem for changes
// ✓ Extracts tree structures from directories
// ✓ Stores file content in blob storage
// ✓ Syncs everything to the database automatically

// When you're done:
agent.dispose();
```

### Bidirectional Sync

Enable two-way synchronization so changes in the database also update the filesystem:

```typescript
const agent = new FsAgent('./my-project', new BsMem(), {
  db,
  treeKey,
  bidirectional: true, // ← Enable bidirectional sync
  ignore: ['node_modules', '.git', 'dist'],
});

// Now the agent handles changes in BOTH directions:
// 1. Filesystem changes → automatically synced to database
// 2. Database changes → automatically synced to filesystem
// 3. Loop prevention ensures no infinite sync cycles
// 4. Both sides stay perfectly synchronized
```

## Core Concepts

### Tree Structures

`fs-agent` represents your filesystem as RLJSON tree structures:

```typescript
// Directory hierarchy:
// my-project/
//   ├── src/
//   │   ├── index.ts
//   │   └── utils.ts
//   └── package.json

// Becomes a tree structure where:
// - Each file/directory is a tree node
// - Nodes are content-addressed (identified by hash)
// - Parent-child relationships are preserved
// - Changes are tracked via insert history
```

### Blob Storage

Files are stored efficiently using content-addressed blob storage:

- **Deduplication**: Identical files are stored only once
- **Content-Addressed**: Files are identified by their content hash
- **Efficient**: Only changed files are re-stored
- **Flexible**: Works with any `Bs` (Blob Storage) implementation

### Automatic Watching

When you create an `FsAgent` with `db` and `treeKey` options:

1. Initial scan happens immediately
2. File watcher starts monitoring changes
3. Changes trigger automatic database sync
4. No manual intervention needed

### Bidirectional Sync

With `bidirectional: true`, the agent listens for database changes:

1. Monitors database insert history for the tree table
2. Detects when other processes add new tree versions
3. Automatically restores new versions to filesystem
4. Pauses filesystem watching during restoration (prevents loops)
5. Resumes watching after restoration completes

## API Reference

### FsAgent

Main class that orchestrates filesystem operations.

#### Constructor

```typescript
new FsAgent(rootPath: string, bs?: Bs, options?: FsAgentOptions)
```

**Parameters:**

- `rootPath` - Root directory to monitor
- `bs` - Blob storage instance (defaults to `BsMem`)
- `options` - Configuration options

**Options:**

```typescript
interface FsAgentOptions {
  // Scanning options
  ignore?: string[]; // Patterns to ignore (e.g., ['node_modules', '*.log'])
  maxDepth?: number; // Maximum directory depth (default: 10)
  followSymlinks?: boolean; // Follow symbolic links (default: false)

  // Automatic sync options
  db?: Db; // Database instance for auto-sync
  treeKey?: string; // Tree table key for storage
  storageOptions?: {
    // Options for database storage
    includeBlobs?: boolean; //   Include blob data in tree (default: true)
  };

  // Bidirectional sync
  bidirectional?: boolean; // Enable database → filesystem sync (default: false)
}
```

#### Properties

```typescript
agent.rootPath: string          // Root directory path
agent.bs: Bs                    // Blob storage instance
agent.scanner: FsScanner        // File scanner instance
agent.adapter: FsBlobAdapter    // Blob adapter instance
```

#### Methods

##### `extract(): Promise<FsTree>`

Extracts the current filesystem as a tree structure.

```typescript
const tree = await agent.extract();
// Returns: { rootHash: string, trees: Map<string, Tree> }
```

##### `restore(tree: FsTree, targetPath?: string): Promise<void>`

Restores a tree structure to the filesystem.

```typescript
await agent.restore(tree, './restore-location');
```

##### `storeInDb(db: Db, treeKey: string, options?: StoreFsTreeOptions): Promise<void>`

Manually stores the current filesystem state in the database.

```typescript
await agent.storeInDb(db, 'myFilesTree', { includeBlobs: true });
```

##### `syncToDb(db: Db, treeKey: string, options?: StoreFsTreeOptions): Promise<() => void>`

Starts watching filesystem and syncing to database.

```typescript
const stopSync = await agent.syncToDb(db, 'myFilesTree');
// Later: stopSync();
```

##### `syncFromDb(db: Db, treeKey: string): Promise<() => void>`

Starts listening to database and syncing to filesystem.

```typescript
const stopSync = await agent.syncFromDb(db, 'myFilesTree');
// Later: stopSync();
```

##### `dispose(): void`

Stops all syncing and cleans up resources.

```typescript
agent.dispose();
```

### FsScanner

Low-level filesystem scanner (usually accessed via `agent.scanner`).

#### Methods

```typescript
// Scan filesystem once
const tree = await scanner.scan();

// Start watching for changes
await scanner.watch();

// Register change callback
scanner.onChange(async (change) => {
  console.log(change.type, change.path);
});

// Pause/resume watching (for loop prevention)
scanner.pauseWatch();
scanner.resumeWatch();

// Get root tree
const rootTree = scanner.getRootTree();
```

## Advanced Usage

### Manual Sync Control

If you need fine-grained control over synchronization:

```typescript
const agent = new FsAgent('./my-project', new BsMem());

// Start filesystem → database sync
const stopToDb = await agent.syncToDb(db, 'myFilesTree');

// Start database → filesystem sync
const stopFromDb = await agent.syncFromDb(db, 'myFilesTree');
// Stop when needed
stopToDb();
stopFromDb();
```

### Custom Blob Storage

Use any blob storage implementation:

```typescript
import { BsSql } from '@rljson/bs-sql';

// SQL-backed blob storage
const sqlBs = new BsSql(myDatabase);
const agent = new FsAgent('./my-project', sqlBs, {
  db,
  treeKey: 'filesTree',
});
```

### Ignore Patterns

Control what gets scanned and synced:

```typescript
const agent = new FsAgent('./my-project', new BsMem(), {
  db,
  treeKey: 'filesTree',
  ignore: [
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '*.log',
    '.DS_Store',
    'tmp/**',
  ],
});
```

### Limited Depth Scanning

Control how deep to traverse directories:

```typescript
const agent = new FsAgent('./my-project', new BsMem(), {
  db,
  treeKey: 'filesTree',
  maxDepth: 3, // Only scan 3 levels deep
});
```

### Extract and Restore

Work with tree structures directly:

```typescript
// Extract current state
const tree = await agent.extract();

// Trees are content-addressed
console.log('Root hash:', tree.rootHash);
console.log('Total nodes:', tree.trees.size);

// Restore to a different location
await agent.restore(tree, './backup-location');

// Or restore from database
const dbAdapter = new FsDbAdapter(db, 'myFilesTree');
const treeFromDb = await dbAdapter.loadFsTree('abc123'); // tree hash
await agent.restore(treeFromDb, './restore-here');
```

### Version History

Access historical versions via insert history:

```typescript
import { Route } from '@rljson/rljson';

// Get insert history for the tree
const route = Route.fromFlat(`${treeKey}/`);
const historyResult = await db.getInsertHistory(route, {});

// historyResult contains all versions with timestamps
for (const entry of historyResult.history) {
  const treeRef = entry.treeRef;
  const timestamp = entry.insertedAt;

  // Load and restore specific version
  const tree = await agent.loadFromDb(db, treeKey, treeRef);
  await agent.restore(tree, `./version-${timestamp}`);
}
```

### Change Detection

React to specific filesystem changes:

```typescript
agent.scanner.onChange(async (change) => {
  switch (change.type) {
    case 'add':
      console.log('File added:', change.path);
      break;
    case 'change':
      console.log('File modified:', change.path);
      break;
    case 'unlink':
      console.log('File deleted:', change.path);
      break;
    case 'addDir':
      console.log('Directory created:', change.path);
      break;
    case 'unlinkDir':
      console.log('Directory deleted:', change.path);
      break;
  }
});
```

## Error Handling

`fs-agent` provides robust error handling with clear error messages:

```typescript
try {
  const agent = new FsAgent('./nonexistent', new BsMem(), {
    db,
    treeKey: 'filesTree',
  });
} catch (error) {
  // Error: Root path "./nonexistent" does not exist. Cannot scan non-existent directory.
}
```

### Common Error Scenarios

1. **Missing Root Path**: Clear error if directory doesn't exist
2. **Database Failures**: Errors include context about what operation failed
3. **Invalid Tree Data**: Validation errors explain what's wrong
4. **Sync Failures**: Non-fatal errors logged, syncing continues
5. **Loop Detection**: Automatic prevention via pause/resume

## Examples

### Example 1: Simple Project Sync

```typescript
import { FsAgent } from '@rljson/fs-agent';
import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { BsMem } from '@rljson/bs';
import { createTreesTableCfg } from '@rljson/rljson';

async function syncProject() {
  // Setup
  const io = new IoMem();
  await io.init();
  const db = new Db(io);

  const treeTableCfg = createTreesTableCfg('projectTree');
  await db.core.createTableWithInsertHistory(treeTableCfg);

  // Sync
  const agent = new FsAgent('./src', new BsMem(), {
    db,
    treeKey: 'projectTree',
    ignore: ['*.tmp'],
  });

  // Runs automatically!
  // Clean up when done
  process.on('SIGINT', () => {
    agent.dispose();
    process.exit();
  });
}
```

### Example 2: Backup and Restore

```typescript
async function backupAndRestore() {
  // Create agent
  const agent = new FsAgent('./my-data', new BsMem());

  // Extract current state
  const backup = await agent.extract();
  console.log('Backed up', backup.trees.size, 'nodes');

  // ... later, restore from backup
  await agent.restore(backup, './my-data-restored');
}
```

### Example 3: Bidirectional Sync

```typescript
async function bidirectionalSync() {
  // Setup database
  const io = new IoMem();
  await io.init();
  const db = new Db(io);

  const treeTableCfg = createTreesTableCfg('sharedTree');
  await db.core.createTableWithInsertHistory(treeTableCfg);

  // Agent 1: Watches ./alice and syncs to DB
  const alice = new FsAgent('./alice', new BsMem(), {
    db,
    treeKey: 'sharedTree',
    bidirectional: true, // ← Bidirectional
  });

  // Agent 2: Watches ./bob and syncs to DB
  const bob = new FsAgent('./bob', new BsMem(), {
    db,
    treeKey: 'sharedTree',
    bidirectional: true, // ← Bidirectional
  });

  // Now:
  // - Changes in ./alice → sync to DB → appear in ./bob
  // - Changes in ./bob → sync to DB → appear in ./alice
  // - Loop prevention ensures stability
}
```

### Example 4: Custom Change Handling

```typescript
async function customHandling() {
  const agent = new FsAgent('./watched', new BsMem(), {
    db,
    treeKey: 'watchedTree',
  });

  let changeCount = 0;

  agent.scanner.onChange(async (change) => {
    changeCount++;

    if (change.type === 'add' && change.path.endsWith('.ts')) {
      console.log(`New TypeScript file: ${change.path}`);
      // Could trigger build, linting, etc.
    }

    if (changeCount % 10 === 0) {
      console.log(`Processed ${changeCount} changes`);
    }
  });
}
```

## Best Practices

### 1. Use Ignore Patterns

Always ignore build artifacts, dependencies, and temporary files:

```typescript
{
  ignore: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '*.log',
    '.DS_Store',
    'tmp',
  ];
}
```

### 2. Dispose When Done

Always clean up resources:

```typescript
const agent = new FsAgent(path, bs, options);

try {
  // Use agent...
} finally {
  agent.dispose();
}
```

### 3. Use Bidirectional Sync Carefully

Bidirectional sync is powerful but consider:

- Multiple agents sharing the same `treeKey` will sync to each other
- Loop prevention is automatic but adds slight latency
- Best for collaborative scenarios or distributed systems

### 4. Monitor Depth

Use `maxDepth` for deep directory structures:

```typescript
{
  maxDepth: 5,  // Prevents extremely deep recursion
}
```

### 5. Handle Errors

Wrap agent creation in try-catch for better error handling:

```typescript
try {
  const agent = new FsAgent(userProvidedPath, bs, options);
} catch (error) {
  console.error('Failed to create agent:', error.message);
}
```

## Performance

- **Efficient Scanning**: Only scans changed directories
- **Deduplication**: Identical files stored once
- **Content-Addressed**: Fast lookups via hashes
- **Optimized Watching**: Uses native filesystem events
- **Smart Sync**: Only syncs when changes detected

## Troubleshooting

### Agent not syncing changes

Check that automatic sync is enabled:

```typescript
const agent = new FsAgent(path, bs, {
  db, // ← Must be provided
  treeKey, // ← Must be provided
});
```

### Bidirectional sync not working

Ensure `bidirectional: true` is set:

```typescript
const agent = new FsAgent(path, bs, {
  db,
  treeKey,
  bidirectional: true, // ← Required for db→fs sync
});
```

### High memory usage

Reduce scan depth or add more ignore patterns:

```typescript
{
  maxDepth: 3,
  ignore: ['large-directory/**'],
}
```

### Files not appearing

Check ignore patterns aren't too broad:

```typescript
// Bad: ignores everything
ignore: ['*'];

// Good: specific patterns
ignore: ['node_modules', '*.log'];
```

## Related Packages

- `@rljson/db` - RLJSON database
- `@rljson/bs` - Blob storage interface
- `@rljson/rljson` - Core RLJSON library
- `@rljson/io` - I/O abstractions

## License

See [LICENSE](LICENSE) file.

## More Information

- [Example Code](src/example.ts)
- [Architecture](README.architecture.md)
- [Contributors](README.contributors.md)
