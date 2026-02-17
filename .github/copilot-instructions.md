# Copilot Instructions for @rljson/fs-agent

## Project Overview

`@rljson/fs-agent` synchronizes filesystem changes with RLJSON databases using tree structures and content-addressed blob storage. It's part of the RLJSON ecosystem (`@rljson/bs`, `@rljson/db`, `@rljson/io`, `@rljson/rljson`, `@rljson/server`).

## Critical Architecture Rules (NEVER VIOLATE)

### 0. Package.json Scripts Section

**NEVER modify the scripts section in package.json without explicit user permission.**

The scripts configuration is carefully designed and tested. Any changes to build, test, lint, or other scripts can break CI/CD pipelines and local development workflows.

```json
// ❌ FORBIDDEN: Changing scripts without permission
"lint": "pnpm exec eslint ."  // Don't change to this
"lint": "eslint ."            // Or this

// ✅ CORRECT: Keep existing configuration
"lint": "pnpx eslint"         // Leave as-is unless user explicitly asks
```

**If you encounter issues with scripts:**

1. Explain the problem to the user
2. Propose solutions that DON'T modify scripts (e.g., clearing caches)
3. If script modification is necessary, ASK for permission first

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
2. Use v8 ignore hints ONLY for truly unreachable defensive code
3. Verify coverage with `pnpm test --coverage`

**MANDATORY: Vitest 4.0 Ignore Patterns (ast-v8-to-istanbul)**

Since Vitest 4.0, coverage uses `ast-v8-to-istanbul` which supports **semantic** ignore hints.
**ALWAYS use semantic hints. NEVER use the old `next N` line-counting pattern.**

All comments MUST include `-- @preserve` to survive esbuild transpilation.

**Allowed patterns:**

| Pattern                                                                      | Meaning                              |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| `/* v8 ignore if -- @preserve */`                                            | Ignore the if-branch                 |
| `/* v8 ignore else -- @preserve */`                                          | Ignore the else-branch               |
| `/* v8 ignore next -- @preserve */`                                          | Ignore the next statement/expression |
| `/* v8 ignore file -- @preserve */`                                          | Ignore the entire file               |
| `/* v8 ignore start -- @preserve */` ... `/* v8 ignore stop -- @preserve */` | Ignore a range of lines              |

**FORBIDDEN patterns (NEVER use):**

```typescript
// ❌ WRONG: Line counting — fragile, breaks on refactoring
/* v8 ignore next 3 -- @preserve */
/* v8 ignore next 5 -- @preserve */

// ❌ WRONG: Missing @preserve — esbuild strips the comment
/* v8 ignore next */
/* v8 ignore start */

// ❌ WRONG: 'end' instead of 'stop'
/* v8 ignore end */
```

**Correct examples:**

```typescript
// Defensive null check — use 'if' to ignore the entire if-block
/* v8 ignore if -- @preserve */
if (!meta) {
  continue;
}

// Error catch blocks — use 'start'/'stop' for multi-line ranges
try {
  result = await db.get(route, { _hash: currentHash });
} catch {
  /* v8 ignore start -- @preserve */
  // Node not found - might be deleted
  continue;
}
/* v8 ignore stop -- @preserve */

// Ignore one expression
/* v8 ignore next -- @preserve */
if (this._db && this._treeKey) {
  // ...
}

// Ignore else-branch only
/* v8 ignore else -- @preserve */
if (isConnected) {
  handleConnection();
} else {
  // defensive fallback
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
7. **Coverage shortcuts**: Don't use `/* v8 ignore */` to avoid writing tests - only for truly unreachable defensive code. **NEVER use `/* v8 ignore next N */` line-counting** — use semantic hints (`if`, `else`, `start`/`stop`) instead
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

## Post-Edit Validation (MANDATORY)

**ALWAYS run these checks after editing ANY file. No exceptions.**

1. **Check for TypeScript / lint errors** in every file you touched (use the IDE error checker)
2. **Run `pnpm exec eslint <changed-files>`** to catch lint violations
3. **Run `pnpm test`** to verify tests pass and coverage stays at 100%
4. **Fix all errors before moving on** — never leave red squiggles behind

This applies to source files AND test files. A change is not complete until all diagnostics are clean.

## Git Workflow (MANDATORY)

- **NEVER commit directly to `main`.** Always work on a feature branch.
- When proposing commits, provide a commit message, wait for user approval, then commit.
- **`pnpm link` is acceptable** during development for local cross-repo dependencies.
- **Before PR/merge**: unlink all local overrides (`git restore package.json pnpm-lock.yaml`, remove `pnpm.overrides`), verify tests still pass with published versions.

## Publish Workflow (MANDATORY)

All `@rljson/*` packages share the same publish workflow documented in `doc/develop.md` (or `doc/workflows/develop.md`). **Follow these steps in exact order:**

### Pre-publish checklist

1. **Unlink local overrides** — Remove all `pnpm.overrides` entries that use `link:../...` and restore `package.json` and `pnpm-lock.yaml` to use published versions:
   ```bash
   # Remove overrides from package.json (set "overrides": {})
   # Then reinstall to get published versions:
   pnpm install
   ```
2. **Run tests with published deps** — `pnpm test` must pass with 100% coverage using published (not linked) dependencies.
3. **Rebuild** — `pnpm run build` (which runs tests via `prebuild`).
4. **Increase version** — `pnpm version patch --no-git-tag-version` then `git commit -am"Increase version"`.
5. **Commit ALL files** — including `package.json` and `pnpm-lock.yaml`. Nothing should be left uncommitted.

### Merge & publish steps

```bash
git rebase main
node scripts/push-branch.js
gh pr create --base main --title "<PR title>" --body " "
gh pr merge --auto --squash
node scripts/wait-for-pr.js
node scripts/delete-feature-branch.js
git checkout main && git pull
pnpm login
pnpm publish
```

### Cross-repo publish order

Packages MUST be published bottom-up by dependency order. A downstream package can only be published after its upstream dependency is on npm.

| Order | Package          | Depends on                              |
|-------|------------------|-----------------------------------------|
| 1     | `@rljson/rljson` | — (Layer 0, no `@rljson` deps)          |
| 2     | `@rljson/io`     | `@rljson/rljson`                        |
| 3     | `@rljson/bs`     | `@rljson/rljson`, `@rljson/io`          |
| 4     | `@rljson/db`     | `@rljson/rljson`, `@rljson/io`          |
| 5     | `@rljson/server` | `@rljson/rljson`, `@rljson/io`, `@rljson/bs`, `@rljson/db` |
| 6     | `@rljson/fs-agent` | all of the above                      |

After publishing an upstream package, downstream packages must `pnpm update --latest` to pick up the new version before their own publish.

## Dependency Pinning (MANDATORY)

- **ESLint**: Pin to `~9.39.2`. ESLint 10+ breaks the build. Never allow `pnpm update --latest` to bump eslint beyond 9.x.
  ```jsonc
  // ✅ CORRECT
  "eslint": "~9.39.2"

  // ❌ WRONG — will pull in v10 which breaks everything
  "eslint": "^10.0.0"
  ```
- After running `pnpm update --latest`, **always verify** eslint stayed on 9.x: `pnpm ls eslint`.

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

## API Design Principles (Learned from Development)

### 1. Preserve Backward Compatibility - Always Prefer Additive Changes

**CRITICAL**: When considering API changes, ALWAYS prefer adding new features over modifying existing interfaces.

**Real Example from Development**:

- ❌ **Wrong approach**: Tried to change FsAgent constructor signature to take `(rootPath, treeKey, clientIo, clientBs, socket, options)`
- ✅ **Correct approach**: Added `FsAgent.fromClient()` static factory method instead, keeping original constructor intact

**Lesson**: If user says "stop here" or "mindshift" during refactoring, IMMEDIATELY revert changes. Don't try to salvage partial work - clean revert is faster and safer.

```typescript
// ❌ WRONG: Breaking change to existing API
class FsAgent {
  constructor(
    rootPath: string,
    treeKey: string, // NEW REQUIRED PARAM - BREAKS EXISTING CODE
    clientIo: Io, // NEW REQUIRED PARAM
    clientBs: Bs, // CHANGED FROM OPTIONAL
    socket: Socket, // NEW REQUIRED PARAM
    options?: FsAgentOptions,
  ) {}
}

// ✅ CORRECT: Additive change with factory method
class FsAgent {
  // Original constructor unchanged - existing code still works
  constructor(rootPath: string, bs?: Bs, options?: FsAgentOptions) {}

  // NEW: Factory method for simplified setup
  static async fromClient(
    filePath: string,
    treeKey: string,
    client: Client,
    socket: Socket,
    options?: FsAgentOptions,
  ): Promise<FsAgent> {
    // Returns enhanced agent with syncToDbSimple/syncFromDbSimple
  }
}
```

### 2. Factory Methods for Complex Setup Patterns

When users need simplified APIs, use **static factory methods** that return enhanced instances:

```typescript
// Pattern: Factory method returns instance with additional methods
static async fromClient(...): Promise<FsAgent & {
  syncToDbSimple: (options?) => Promise<() => void>;
  syncFromDbSimple: (options?) => Promise<() => void>;
}> {
  const agent = new FsAgent(...);
  // Add simplified methods to instance
  agent.syncToDbSimple = async (options) => {
    return agent.syncToDb(db, connector, treeKey, options);
  };
  return agent;
}
```

**Benefits**:

- Reduces boilerplate for common use cases
- Maintains full flexibility of detailed API
- Type-safe with enhanced return types
- Zero breaking changes

### 3. Client-Centric Architecture

**The `Client` instance from `@rljson/server` is the central object** for all client-server operations:

```typescript
// Client provides:
// - client.io: IoMulti (local + server storage)
// - client.bs: BsMulti (local + server blobs)

const client = new Client(socket, localIo, localBs);
await client.init();

// Everything derives from client:
const db = new Db(client.io!); // Database uses client's io
const agent = new FsAgent(path, client.bs); // Agent uses client's bs
const connector = new Connector(db, route, socket); // Connector for sync
```

**Key Point**: Always pass `client.io` and `client.bs` (not `localIo` and `localBs` directly) to ensure proper multi-layer behavior.

### 4. Route/TreeKey Relationship is Fundamental

**ALWAYS derive Route from treeKey**: `Route.fromFlat(\`/${treeKey}\`)`

This is NOT arbitrary - the route must match the database table name:

```typescript
// Correct pattern
const treeKey = 'sharedTree'; // Database table: 'sharedTree'
const route = Route.fromFlat(`/${treeKey}`); // Route: '/sharedTree'

// Server uses this route
const server = new Server(route, serverIo, serverBs);

// All clients MUST use the same route
const connector = new Connector(db, route, socket);
```

**Why this matters**: Routes are how the system routes messages between clients through the server. A mismatch means messages never arrive.

### 5. Method Signature Patterns for Dual APIs

When providing both simple and detailed APIs, use parameter overloading carefully:

```typescript
// Option A: Different method names (PREFERRED - clearer)
async syncToDb(db: Db, connector: Connector, treeKey: string, options?) { }
async syncToDbSimple(options?) { /* uses stored db/connector/treeKey */ }

// Option B: Parameter overloading (more complex)
async syncToDb(
  dbOrOptions?: Db | StoreFsTreeOptions,
  connector?: Connector,
  treeKey?: string,
  options?: StoreFsTreeOptions
): Promise<() => void> {
  // Detect which signature was used
  if (dbOrOptions && typeof (dbOrOptions as any).get === 'function') {
    // Old signature: (db, connector, treeKey, options)
    return this._syncToDbLegacy(...);
  }
  // New signature: (options)
  return this._syncToDbLegacy(this._configuredDb, ...);
}
```

**Lesson**: Different method names (`syncToDbSimple`) are clearer than parameter overloading for TypeScript/JavaScript.

### 6. Socket Management in Tests vs Production

**Tests**: Use `createSocketPair()` from `@rljson/io` for in-memory sockets:

```typescript
const [serverSocket, clientSocket] = createSocketPair();
serverSocket.connect();
```

**Production**: Use real Socket.IO with `SocketIoBridge`:

```typescript
import { io as SocketIoClient } from 'socket.io-client';
import { SocketIoBridge } from '@rljson/server';

const socket = SocketIoClient('http://localhost:3000');
const client = new Client(new SocketIoBridge(socket), localIo, localBs);
```

### 7. Revert Strategy - When Things Go Wrong

**If a refactoring feels wrong or user hesitates**:

1. **Immediately check git status**: `git status --short`
2. **Revert without hesitation**: `git restore <files>`
3. **Remove temp files**: `rm -f migrate-*.js count-*.js test/setup/test-*-helper.ts`
4. **Verify tests pass**: `pnpm test`
5. **Start fresh with new approach**

**Real example from our session**:

```bash
# User said "stop here, mindshift, revert everything"
git restore src/fs-agent.ts test/fs-agent.spec.ts
rm -f count-instances.js migrate-tests*.js test/setup/test-agent-helper.ts
# All changes reverted in seconds, zero damage
```

**Lesson**: Clean reverts are FASTER than trying to salvage broken refactorings. Git is your friend.

### 8. Documentation Updates Must Match Code

**Always update documentation when adding new APIs**:

1. Update README files with examples
2. Add JSDoc comments with `@example` tags
3. Create example files in `src/client-server/example-*.ts`
4. Update copilot-instructions.md with new patterns

**Real example**:

```typescript
// Added FsAgent.fromClient() → Updated:
// - src/client-server/README.socketio.md (API examples)
// - src/client-server/example-from-client.ts (runnable demo)
// - .github/copilot-instructions.md (this file!)
```

### 9. Simplified vs Detailed API - When to Use Each

**Use `fromClient()` + `syncToDbSimple()` when**:

- Working with client-server architecture
- Want minimal boilerplate
- Don't need to customize Db/Connector setup
- Following standard patterns

**Use traditional API when**:

- Need fine-grained control over Db configuration
- Using custom Io/Bs implementations (not IoMem/BsMem)
- Building testing utilities that need explicit mocks
- Integrating with existing code that creates its own Db/Connector

```typescript
// Simplified - good for typical client-server apps
const agent = await FsAgent.fromClient(
  './folder',
  'sharedTree',
  client,
  socket,
);
await agent.syncToDbSimple({ notify: true });

// Detailed - good for tests, custom setups, advanced use cases
const db = new Db(customIo);
const connector = new Connector(db, route, mockSocket);
const agent = new FsAgent('./folder', customBs);
await agent.syncToDb(db, connector, 'sharedTree', { notify: true });
```

## Misleading Patterns to Avoid

### 1. "treeKey" Does NOT Mean "Application Name"

**WRONG mental model**: "I'm building an app called 'myapp', so treeKey should be 'myapp'"

**CORRECT mental model**: "treeKey is the database table name where trees are stored"

```typescript
// ❌ WRONG: Using application name
const treeKey = 'myapp'; // No 'Tree' suffix
const route = Route.fromFlat('/myapp.sync'); // Arbitrary route

// ✅ CORRECT: Using database table name
const treeKey = 'projectFilesTree'; // Must end with 'Tree'
const route = Route.fromFlat(`/${treeKey}`); // Route = /projectFilesTree
```

**Why this matters**: The system uses treeKey to query database tables. If the table doesn't exist or names don't match, queries fail silently.

### 2. Creating Db/Connector BEFORE Client is Initialized

**WRONG order**: Create Db before calling `client.init()`

```typescript
// ❌ WRONG: Db created too early
const client = new Client(socket, localIo, localBs);
const db = new Db(client.io!); // client.io might be undefined!
await client.init(); // Too late - Db already has wrong reference
```

**CORRECT order**: Always call `client.init()` first

```typescript
// ✅ CORRECT: Init client first
const client = new Client(socket, localIo, localBs);
await client.init(); // Sets up client.io as IoMulti
const db = new Db(client.io!); // Now has correct IoMulti reference
```

### 3. Thinking "Simplified API" Means "Less Capable"

The simplified API (`fromClient()` + `syncToDbSimple()`) is NOT a subset - it provides the SAME functionality as the detailed API, just with less boilerplate.

```typescript
// Both do the EXACT SAME THING internally:

// Simplified
const agent = await FsAgent.fromClient('./folder', 'tree', client, socket);
await agent.syncToDbSimple({ notify: true });

// Detailed
const db = new Db(client.io!);
const route = Route.fromFlat('/tree');
const connector = new Connector(db, route, socket);
const agent = new FsAgent('./folder', client.bs);
await agent.syncToDb(db, connector, 'tree', { notify: true });
```

**Lesson**: Choose based on convenience, not capability. Both are equally powerful.

### 4. Forgetting That Trees Are Stored as Separate Rows

**WRONG assumption**: "I can get the whole tree with one query"

```typescript
// ❌ WRONG: Expecting one query to return entire tree
const result = await db.get(route, { _hash: rootHash });
const tree = result; // Only returns ONE node, not the whole tree!
```

**CORRECT approach**: Recursively fetch children

```typescript
// ✅ CORRECT: FsAgent does this internally in _fetchTreeRecursively()
const allNodes = await this._fetchTreeRecursively(db, route, treeKey, rootHash);
// Fetches root, then recursively fetches all children by their hashes
```

**Why**: Trees are normalized in the database. Each directory/file is a separate row with its own `_hash`. Parent nodes reference children via hash arrays.

### 5. Using `new BsMem()` Instead of `client.bs`

**WRONG**: Creating separate BsMem instances for agent and connector

```typescript
// ❌ WRONG: Agent and connector have different blob storage
const agent = new FsAgent('./folder', new BsMem()); // Separate instance
const connector = new Connector(db, route, socket);
// When agent stores blobs, connector can't access them!
```

**CORRECT**: Always use `client.bs` (which is BsMulti)

```typescript
// ✅ CORRECT: Shared blob storage via client
const agent = new FsAgent('./folder', client.bs); // Uses BsMulti
// Blobs are accessible both locally AND via server
```

**Why**: `client.bs` is `BsMulti` which coordinates local and server blob storage. Creating `new BsMem()` bypasses this coordination.

### 6. Assuming Route Suffix `+` is Required

**Misleading pattern from old code**: Some examples showed `Route.fromFlat(\`/${treeKey}+\`)`

```typescript
// ❌ WRONG: Adding '+' suffix to route
const route = Route.fromFlat(`/${treeKey}+`); // Unnecessary suffix

// ✅ CORRECT: Route exactly matches treeKey
const route = Route.fromFlat(`/${treeKey}`); // No suffix needed
```

**Lesson**: The `+` suffix is NOT required and can cause routing mismatches. Always use `/${treeKey}` exactly.

### 7. Expecting `syncFromDb()` to Work Without Initial Tree

**WRONG assumption**: "I can start syncFromDb() on an empty folder and it will auto-populate"

```typescript
// ❌ WRONG: Starting syncFromDb without any tree in database
await agent.syncFromDb(db, connector, treeKey); // Will never trigger
// Waiting... nothing happens...
```

**CORRECT**: syncFromDb() responds to CHANGES, you need initial tree first

```typescript
// ✅ CORRECT: Store initial tree, THEN sync changes
await agent.storeInDb(db, treeKey); // Creates initial tree in database
await agent.syncFromDb(db, connector, treeKey); // Now responds to updates
```

**Why**: `syncFromDb()` listens for `connector.listen(callback)` which fires when new refs are broadcast. No broadcast = no trigger.

### 8. Confusing "filePath" with "rootPath"

Some methods use `rootPath`, others use `filePath`, but they mean the SAME thing:

```typescript
// These are equivalent concepts:
new FsAgent(rootPath: string, ...)     // Constructor parameter
FsAgent.fromClient(filePath: string, ...) // Factory parameter

// Both refer to: "The directory on disk to sync"
```

**Lesson**: Don't overthink naming differences. In FsAgent context, `rootPath` and `filePath` are interchangeable terms.

### 9. Thinking Dispose() is Optional

**WRONG**: Forgetting to call cleanup functions

```typescript
// ❌ WRONG: Starting sync but never stopping
const stopSync = await agent.syncToDb(db, connector, treeKey);
// App exits, file watchers still running in background!
```

**CORRECT**: Always clean up watchers

```typescript
// ✅ CORRECT: Stop sync before exit
const stopSync = await agent.syncToDb(db, connector, treeKey);
// ... do work ...
stopSync(); // Stops file watching, removes callbacks
agent.dispose(); // Extra safety - cleans up any remaining resources
```

**Why**: File watchers (`chokidar`) keep the process alive. Must explicitly stop them to allow graceful shutdown.

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
