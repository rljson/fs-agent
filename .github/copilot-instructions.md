# Copilot Instructions for @rljson/fs-agent

## Project Overview

`@rljson/fs-agent` synchronizes filesystem changes with RLJSON databases using tree structures and content-addressed blob storage. It's part of the RLJSON ecosystem (`@rljson/bs`, `@rljson/db`, `@rljson/io`, `@rljson/rljson`, `@rljson/server`).

## Critical Architecture Rules (NEVER VIOLATE)

### 1. Socket-Only Client-Server Communication

**Clients MUST communicate via sockets ONLY - never access server resources directly.**

```typescript
// ✅ CORRECT: Client uses own Io/Bs, syncs via socket
const client = new Client(socket, localIo, localBs);
const agent = new FsAgent(folderA, client.bs);
const clientDb = new Db(client.io);

// ❌ FORBIDDEN: Direct server resource access
const agent = new FsAgent(folderA, serverBs); // WRONG!
const clientDb = new Db(serverIo); // WRONG!
```

**Why**: This is essential for distributed deployments. Violating this makes the implementation meaningless.

### 2. Connector Route Matching

**Connector routes MUST match Server route exactly** or messages won't be routed. The route must be based on the tree table name (treeKey), not arbitrary application names.

```typescript
// ✅ CORRECT: Route based on tree table name
const treeKey = 'sharedTree';
const route = Route.fromFlat(`/${treeKey}`);
const server = new Server(route, serverIo, serverBs);
const connectorA = new Connector(clientDbA, route, socketA);
const connectorB = new Connector(clientDbB, route, socketB);

// ❌ WRONG: Route not based on treeKey, or mismatched routes
const serverRoute = Route.fromFlat('myapp.sync'); // Wrong! Not based on treeKey
const connectorA = new Connector(db, Route.fromFlat('/different'), socket); // Wrong! Mismatched
```

### 3. Use Server/Client Classes Directly

**Never manually construct `BsMulti` with `BsPeer` or `IoMulti` with `IoPeer`**. Use `Server` and `Client` from `@rljson/server` - they handle internal complexity. If they don't work, fix `@rljson/server`, not application code.

### 4. Self-Broadcast Filtering

**Connectors receive their own messages via local socket echo** (EventEmitter behavior). FsAgent filters using `_lastSentRef`:

```typescript
// In FsAgent:
this._lastSentRef = ref;
connector.send(ref);

// Later in listener:
if (treeRef === this._lastSentRef) {
  return; // Skip self-broadcast
}
```

Server-side filtering (v0.0.4+) prevents network round-trips but can't prevent local echo.

## Core Components

- **FsScanner**: Scans filesystem, builds tree structures with hash-based nodes
- **FsBlobAdapter**: Converts files ↔ blobs with content-addressed storage
- **FsDbAdapter**: Stores/loads tree structures in database with insert history
- **FsAgent**: Orchestrates scanning, syncing (fs→db and db→fs), watching

## Development Workflow

### Running Tests

```bash
# All tests with coverage
pnpm test

# Specific test file
pnpm exec vitest run test/fs-agent.spec.ts

# Single test by name
pnpm exec vitest run test/fs-agent.spec.ts -t "test name"

# Update goldens after intentional changes
pnpm updateGoldens
```

**Note**: Tests require `cross-env NODE_OPTIONS=--max-old-space-size=8192` for heap-intensive operations.

### Coverage Requirements

From [vitest.config.mts](vitest.config.mts):

- **All metrics MUST be 100%**: Statements, Branches, Functions, Lines
- Coverage validation runs automatically in `pnpm test`
- Build fails if any metric drops below 100%

**Critical**: The project maintains 100% coverage across all files. When adding new code:

1. Write tests that execute all code paths
2. Use `/* v8 ignore next N -- @preserve */` ONLY for truly unreachable defensive code
3. Verify coverage with `pnpm test --coverage`

**Valid v8 ignore patterns**:

```typescript
// Defensive null checks that should never trigger
/* v8 ignore next 3 -- @preserve */
if (!meta) {
  continue;
}

// Error catch blocks for external failures
try {
  result = await db.get(route, { _hash: currentHash });
} catch {
  /* v8 ignore next 3 -- @preserve */
  // Node not found - might be deleted
  continue;
}

// Deprecated constructor patterns (documented as unsupported)
/* v8 ignore next -- @preserve */
if (this._db && this._treeKey) {
  this._startAutoSync().catch((error) => {
    console.error('Failed to start auto-sync:', error);
  });
}
```

**Invalid use of v8 ignore**: Do not use to avoid writing tests for reachable code.

### Building

```bash
pnpm build  # Runs tests first (prebuild), then vite + tsc + copy README
```

## Testing Patterns

### Golden Files

Use `expectGolden()` from [test/setup/goldens.ts](test/setup/goldens.ts) for snapshot-like testing:

```typescript
await expectGolden('my-test.json').toBe(actualData);
// Update with: pnpm updateGoldens
```

Golden files live in `test/goldens/`. Compare JSON structures, not stringified output.

### Client-Server Test Setup

From [src/client-server/client-server-setup.ts](src/client-server/client-server-setup.ts):

```typescript
const { server, clientA, clientDbA, connectorA } = await runClientServerSetup({
  numClients: 2,
});

const agentA = new FsAgent(folderA, clientA.bs);
await agentA.syncToDb(clientDbA, connectorA, 'sharedTree');
```

Each client has **separate local databases** - data flows via server multicast.

**Socket Architecture**: Always use `createSocketPair()` from `@rljson/io` for proper DirectionalSocketMock setup:

```typescript
// ✅ CORRECT: DirectionalSocketMock with createSocketPair
const [serverSocketA, clientSocketA] = createSocketPair();
serverSocketA.connect();
await server.addSocket(serverSocketA);
const clientA = new Client(clientSocketA, localIoA, localBsA);

// ❌ WRONG: Single SocketMock (old pattern, causes issues)
const socket = new SocketMock();
const clientA = new Client(socket, localIoA, localBsA);
```

### Coverage Testing Patterns

**Test all code paths**, including error scenarios:

````typescript
// Test cleanTarget functionality with nested structures
it('should clean unexpected directories and nested files', async () => {
  // Create expected structure
  const expectedDir = join(testDir, 'expected_dir');
  await mkdir(expectedDir, { recursive: true });
  await writeFile(join(testDir, 'wanted.txt'), 'keep me');

  const agent = new FsAgent(testDir);
  const tree = await agent.extract();

  // Add unwanted items after extraction
  await mkdir(join(testDir, 'unwanted_dir/nested'), { recursive: true });
  await writeFile(join(expectedDir, 'unwanted.txt'), 'remove');

  // Restore with cleanTarget removes extras
  await agent.restore(tree, undefined, { cleanTarget: true });

  // Verify cleanup
  expect(await fileExists(join(testDir, 'wanted.txt'))).toBe(true);
  expect(await fileExists(join(testDir, 'unwanted_dir'))).toBe(false);
});

// Test deprecated constructor patterns
it('should reject auto-sync via constructor', async () => {
  const io = new IoMem();
  await io.init();
  const db = new Db(io);

  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  new FsAgent(testDir, undefined, { db, treeKey: 'testTree' });

  await new Promise(resolve => setTimeout(resolve, 10));

  expect(consoleErrorSpy).toHaveBeenCalledWith(
    'Failed to start auto-sync:',
    expect.any(Error)
  );

  consoleErrorSpy.mockRestore();
});
``` - routes MUST be based on treeKey (`Route.fromFlat(\`/${treeKey}\`)`), not arbitrary names
2. **Direct server access**: Never access `serverBs`, `serverIo`, `serverDb` from clients - always use socket communication
3. **Missing tree key suffix**: Tree keys must end with "Tree" (e.g., 'projectFilesTree', not 'projectFiles')
4. **Self-broadcast loops**: Remember connectors receive own messages locally - filter with `_lastSentRef`
5. **Golden updates**: Run `pnpm updateGoldens` after intentional output changes
6. **Wrong socket pattern**: Use `createSocketPair()` for tests, not single `SocketMock`
7. **Coverage shortcuts**: Don't use `/* v8 ignore */` to avoid writing tests - only for truly unreachable defensive code
8. **Notification routes**: When using `notify: true`, ensure route matches treeKey (`Route.fromFlat(\`/${treeKey}\`)`), not with `+` suffix

## Critical Implementation Details

### Route Architecture

**The route represents the data structure path in the database, not an application identifier.**

Routes derive from tree table names (treeKey):
- Correct: `Route.fromFlat(\`/${treeKey}\`)` where treeKey = 'sharedTree'
- Wrong: `Route.fromFlat('myapp.sync')` - arbitrary application name
- Wrong: `Route.fromFlat(\`/${treeKey}+\`)` - unnecessary suffix

Why: Server and all Connectors must use the same route for message routing. The route tells the system WHERE in the database to find tree data. Arbitrary names break this connection.

### Auto-Sync Constructor Pattern (DEPRECATED)

**Do not use `db` and `treeKey` in FsAgent constructor options**. This pattern is deprecated and will throw errors:

```typescript
// ❌ DEPRECATED: Auto-sync via constructor
new FsAgent(folder, bs, {
  db,
  treeKey: 'myTree',
  bidirectional: true
});

// ✅ CORRECT: Use syncToDb/syncFromDb methods with Connector
const agent = new FsAgent(folder, bs);
await agent.syncToDb(db, connector, treeKey);
await agent.syncFromDb(db, connector, treeKey, { cleanTarget: true });
````

Why: Connectors require sockets which aren't available in the constructor. The methods provide proper control over sync lifecycle.

### Tree Storage Pattern

Trees are stored as **separate rows with parent-child relationships**, not as a single denormalized structure:

```typescript
// Tree nodes stored individually with _hash as identifier
// Parent nodes reference children via hash array
{
  _hash: 'abc123',
  meta: { type: 'directory', name: 'src' },
  children: ['def456', 'ghi789'] // References to child nodes
}

// Loading requires recursive fetching via _fetchTreeRecursively()
// Don't query once and expect all nodes - follow child references
```

### CleanTarget Behavior

The `cleanTarget: true` option removes files/directories not in the tree:

```typescript
// Restore with cleanTarget
await agent.restore(tree, undefined, { cleanTarget: true });

// What happens:
// 1. Collects expected paths from tree
// 2. Restores all files/directories from tree
// 3. Recursively removes anything not in expected sets
// 4. Useful for renames, moves, deletions

// Without cleanTarget (default):
// - Only writes files from tree
// - Leaves extra files untouched (stale data remains)
```

Tree keys MUST end with "Tree":

```typescript
const treeKey = 'projectFilesTree'; // ✅
const treeKey = 'files'; // ❌ Invalid
```

### Bidirectional Sync Loop Prevention

FsAgent uses pause/resume to prevent infinite loops:

```typescript
// syncToDb watches filesystem changes
const stopToDb = await agent.syncToDb(db, connector, treeKey);

// syncFromDb watches database changes
const stopFromDb = await agent.syncFromDb(db, connector, treeKey, {
  cleanTarget: true, // Remove files not in tree
});

// Automatic pause/resume prevents fs→db→fs loops
```

### File Ignore Patterns

Common patterns from [README.public.md](README.public.md):

```typescript
ignore: ['node_modules', '.git', 'dist', 'coverage', '*.log', 'tmp/**'];
```

## Package Manager

Uses **pnpm** (v10.11.0). Commands:

- `pnpm install` - Install deps
- `pnpm update --latest` - Update all deps (part of dev workflow)

## Important Files

- [README.architecture.md](README.architecture.md): Full architectural rules with rationale
- [README.contributors.md](README.contributors.md): Dev workflow (branch creation, PR process)
- [README.public.md](README.public.md): Public API documentation with examples
- [doc/fast-coding-guide.md](doc/fast-coding-guide.md): VS Code shortcuts (Cmd+P, Ctrl+D)
- [ROOT-CAUSE.md](ROOT-CAUSE.md): Documents discovered bugs/issues

## Coding Style

- **TypeScript**: ESM modules (`"type": "module"`)
- **Node version**: >=22.14.0
- **License headers**: Required in all source files (see existing files)
- **Test framework**: Vitest with `describe()`, `it()`, `expect()`
- **Dispose pattern**: Always provide cleanup (`stopSync()`, `agent.dispose()`)

## Commit Messages

When asked to provide commit messages, **write them directly in the chat** (not in a file) using conventional commit format:

- **Keywords**: Use `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `perf:`, `style:`, `ci:`, `build:`
- **Style**: Comprehensive but not extensive - clear, concise, descriptive
- **Format**: `<type>: <description>` (lowercase description, no period at end)

**Examples**:

```
feat: add bidirectional sync support with cleanTarget option
fix: resolve route mismatch in client-server communication
test: add coverage for deprecated constructor patterns
docs: update copilot-instructions with commit message guidelines
refactor: replace SocketMock with DirectionalSocketMock pattern
```

## Common Pitfalls

1. **Mismatched routes**: Most client-server issues stem from route mismatches
2. **Direct server access**: Never access `serverBs`, `serverIo`, `serverDb` from clients
3. **Missing tree key suffix**: Tree keys must end with "Tree"
4. **Self-broadcast loops**: Remember connectors receive own messages locally
5. **Golden updates**: Run `pnpm updateGoldens` after intentional output changes

## Scripts & Automation

Located in [scripts/](scripts/):

- `create-branch.js`: Creates feature branch with PR title
- `update-dna.js`: Propagates common patterns across RLJSON repos
- `run-in-all-repos.js`: Runs commands across all @rljson/\* repos
- `publish-to-npm.js`: NPM publishing workflow

Use with: `node scripts/<script-name>.js`

## Documentation Structure

README files serve different audiences:

- `README.md`: Navigation hub (you are here)
- `README.public.md`: End users (npm package docs)
- `README.contributors.md`: Developers (workflow, commands)
- `README.architecture.md`: Deep architectural rules
- `README.trouble.md`: Error solutions
