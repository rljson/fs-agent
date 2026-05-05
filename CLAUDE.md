# CLAUDE.md — @rljson/fs-agent

Synchronizes filesystem changes with RLJSON databases using tree structures and content-addressed blob storage. Depends on all lower layers.

---

## Non-Negotiable Constraints

- **Never commit directly to `main`.** Always work on a feature branch.
- **Never modify the `scripts` section in `package.json`** without explicit user permission.
- **ESLint pinned to `~9.39.2`.** ESLint 10+ breaks the build.
- **100% test coverage** on all new/modified `src/` files (Statements, Branches, Functions, Lines).

---

## Commit Discipline (MANDATORY — NEVER SKIP)

- **Commit small and often** — one logical unit = one commit. Never accumulate more than ~5 changed files before committing.
- `git status --short` must return **nothing** at session end. Never leave uncommitted changes behind.
- **Check state at every session start**: `git status --short`, `git branch`, `git log --oneline -3`.

### Pre-commit checklist (in order, no exceptions)

1. **Update docs FIRST** — update README.public.md, README.architecture.md, CLAUDE.md for any API/behavior change **before** proposing a commit. A feature is NOT complete until documentation matches.
2. **Fix TypeScript/lint errors** in every touched file (use IDE error checker).
3. **`pnpm exec eslint <changed-files>`** to catch lint violations.
4. **`pnpm test`** — must pass at 100% coverage. Fix all errors before moving on.

### Version bump = separate commit

```bash
pnpm version patch --no-git-tag-version
git commit -am"Increase version"
```

---

## Full Ticket Workflow (exact order — complete all steps before starting next ticket)

```bash
# 1. Start clean
git checkout main && git fetch && git pull

# 2. Feature branch
node scripts/create-branch.js "<description>"

# 3. Update deps (verify eslint stays on 9.x)
pnpm update --latest && pnpm ls eslint

# 4. Develop, write tests, update docs

# 5. Commit every ≤5-file logical unit
git add . && git commit -am"<description>"

# 6. Version bump
pnpm version patch --no-git-tag-version && git commit -am"Increase version"

# 7. Build (runs tests via prebuild)
pnpm run build

# 8. Rebase
git rebase main

# 9. Push
node scripts/push-branch.js

# 10. Create PR + auto-merge
gh pr create --base main --title "<title>" --body " "
gh pr merge --auto --squash

# 11. Wait
node scripts/wait-for-pr.js

# 12. Cleanup
node scripts/delete-feature-branch.js
```

**`pnpm link` is acceptable during development for local cross-repo dependencies. Before PR/merge: remove all `pnpm.overrides` using `link:../...` and restore published versions.**

---

## Git Scripts Reference

| Script | Guard |
|---|---|
| `node scripts/create-branch.js "desc"` | Kebab-case; fails without input |
| `node scripts/push-branch.js` | Refuses dirty tree; refuses push to `main` |
| `node scripts/wait-for-pr.js` | Polls until MERGED/CLOSED |
| `node scripts/delete-feature-branch.js` | Requires clean tree + merged |
| `node scripts/is-clean-repo.js` | Prints ✅/❌ |

Never bypass these with raw git commands.

---

## Pre-existing Coverage Failures

Pre-existing failures (in files NOT touched in this ticket) do not block a commit, but:
- Prove pre-existing: `git stash && pnpm test; git stash pop`
- Document in the commit message
- Never add NEW failures in modified files

---

## Coverage Requirements

- **All metrics MUST be 100%**: Statements, Branches, Functions, Lines.
- Coverage validates automatically in `pnpm test`. Build fails below 100%.
- **Never** use `/* v8 ignore */` to avoid writing tests for reachable code.

### Vitest 4.0 semantic ignore hints (MANDATORY)

All hints MUST include `-- @preserve` to survive esbuild transpilation.

| Pattern | Meaning |
|---|---|
| `/* v8 ignore if -- @preserve */` | Ignore the if-branch |
| `/* v8 ignore else -- @preserve */` | Ignore the else-branch |
| `/* v8 ignore next -- @preserve */` | Ignore next statement/expression |
| `/* v8 ignore file -- @preserve */` | Ignore entire file |
| `/* v8 ignore start -- @preserve */` ... `/* v8 ignore stop -- @preserve */` | Ignore a range |

**NEVER use:**

```typescript
/* v8 ignore next 3 -- @preserve */  // ❌ line-counting — fragile, breaks on refactoring
/* v8 ignore next */                  // ❌ missing @preserve — esbuild strips the comment
/* v8 ignore end */                   // ❌ 'end' not 'stop'
```

---

## Package Manager

Uses **pnpm**. **Never modify the `scripts` section in `package.json`** without explicit user permission.

---

## Dependency Pinning (MANDATORY)

```jsonc
"eslint": "~9.39.2"   // ✅ CORRECT — pin to 9.x
"eslint": "^10.0.0"   // ❌ WRONG — ESLint 10 breaks the build
```

After `pnpm update --latest`, always verify: `pnpm ls eslint`.

Also:
- **TypeScript**: ESM modules (`"type": "module"`)
- **Node**: >=22.14.0
- **License headers**: Required in all source files
- **Test framework**: Vitest with `describe()`, `it()`, `expect()`

---

## Testing

| Command | Purpose |
|---|---|
| `pnpm test` | All tests + lint + coverage |
| `pnpm run build` | Full build (prebuild runs tests) |
| `pnpm updateGoldens` | Regenerate golden snapshot files |
| Debug in VS Code | Open test file → set breakpoint → Alt+click play button in Test Explorer |

Tests require `cross-env NODE_OPTIONS=--max-old-space-size=8192` for heap-intensive operations.

---

## Publish Workflow (MANDATORY)

### Pre-publish checklist

1. Remove all `pnpm.overrides` using `link:../...`, restore `package.json` + `pnpm-lock.yaml`.
2. `pnpm install` — reinstall with published versions.
3. `pnpm test` — must pass at 100%.
4. `pnpm run build`.
5. `pnpm version patch --no-git-tag-version && git commit -am"Increase version"`.
6. Commit ALL files including `package.json` and `pnpm-lock.yaml`.

### Merge & publish

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

**Always use exactly `pnpm publish` — no flags, no piping.**

### Cross-repo publish order (bottom-up)

| Order | Package | Depends on |
|---|---|---|
| 1 | `@rljson/rljson` | — (Layer 0) |
| 1 | `@rljson/network` | — (Layer 0) |
| 2 | `@rljson/io` | `@rljson/rljson` |
| 3 | `@rljson/bs` | `@rljson/rljson`, `@rljson/io` |
| 3 | `@rljson/db` | `@rljson/rljson`, `@rljson/io` |
| 4 | `@rljson/server` | `@rljson/rljson`, `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/network` |
| 5 | `@rljson/fs-agent` | all of the above |

After publishing an upstream package, downstream packages must run `pnpm update --latest` before their own publish.

---

## Architecture: Critical Rules (NEVER VIOLATE)

### 1. Socket-Only Client-Server Communication

**Clients MUST communicate via sockets ONLY — never access server resources directly.**

```typescript
// ✅ CORRECT: Client uses own Io/Bs, syncs via socket
const client = new Client(socket, localIo, localBs);
const agent = new FsAgent(folderA, client.bs);

// ❌ FORBIDDEN: Direct server resource access
const agent = new FsAgent(folderA, serverBs); // WRONG
```

### 2. Connector Route Matching

**Connector routes MUST match Server route exactly.** Route must be based on the tree table name (treeKey).

```typescript
// ✅ CORRECT
const treeKey = 'sharedTree';
const route = Route.fromFlat(`/${treeKey}`);
const server = new Server(route, serverIo, serverBs);
const connectorA = new Connector(clientDbA, route, socketA);

// ❌ WRONG
const route = Route.fromFlat('myapp.sync'); // not based on treeKey
const route = Route.fromFlat(`/${treeKey}+`); // unnecessary suffix
```

### 3. Use Server/Client Classes Directly

Never manually construct `BsMulti` with `BsPeer` or `IoMulti` with `IoPeer`. Use `Server` and `Client` from `@rljson/server`.

### 4. Self-Broadcast Filtering

Connectors receive their own messages via local socket echo. FsAgent filters using `_lastSentRef`:

```typescript
this._lastSentRef = ref;
connector.send(ref);
// In listener:
if (treeRef === this._lastSentRef) return; // Skip self-broadcast
```

---

## Core Components

| Component | Purpose |
|---|---|
| `FsScanner` | Scans filesystem, builds tree structures with hash-based nodes |
| `FsBlobAdapter` | Converts files ↔ blobs with content-addressed storage |
| `FsDbAdapter` | Stores/loads tree structures in database with insert history |
| `FsAgent` | Orchestrates scanning, syncing (fs→db and db→fs), watching |

---

## Client-Server Test Setup

```typescript
const { server, clientA, clientDbA, connectorA } = await runClientServerSetup({ numClients: 2 });
const agentA = new FsAgent(folderA, clientA.bs);
await agentA.syncToDb(clientDbA, connectorA, 'sharedTree');
```

**Socket Architecture**: Always use `createSocketPair()` from `@rljson/io`:

```typescript
// ✅ CORRECT: DirectionalSocketMock with createSocketPair
const [serverSocketA, clientSocketA] = createSocketPair();
serverSocketA.connect();
await server.addSocket(serverSocketA);
const clientA = new Client(clientSocketA, localIoA, localBsA);

// ❌ WRONG: Single SocketMock (causes issues)
const socket = new SocketMock();
```

---

## Key Patterns

### TreeKey Rules
- Tree keys MUST end with "Tree": `'projectFilesTree'` ✅ · `'files'` ❌
- Route derives from treeKey: `Route.fromFlat(\`/${treeKey}\`)` (no `+` suffix)

### Correct Initialization Order
```typescript
const client = new Client(socket, localIo, localBs);
await client.init(); // FIRST — sets up client.io as IoMulti
const db = new Db(client.io!); // THEN — now has correct IoMulti reference
```

### Deprecated Constructor Pattern
```typescript
// ❌ DEPRECATED: Auto-sync via constructor
new FsAgent(folder, bs, { db, treeKey: 'myTree', bidirectional: true });

// ✅ CORRECT: Use syncToDb/syncFromDb methods
const agent = new FsAgent(folder, bs);
await agent.syncToDb(db, connector, treeKey);
```

### CleanTarget Behavior
`cleanTarget: true` removes files/directories not in the tree:
```typescript
await agent.restore(tree, undefined, { cleanTarget: true });
```

### Always Clean Up Watchers
```typescript
const stopSync = await agent.syncToDb(db, connector, treeKey);
// ... do work ...
stopSync(); // Stops file watching
agent.dispose(); // Cleans up remaining resources
```

---

## Common Pitfalls

1. **Mismatched routes**: Most client-server issues stem from route mismatches — always derive route from treeKey
2. **Direct server access**: Never access `serverBs`, `serverIo`, `serverDb` from clients
3. **Missing tree key suffix**: Tree keys must end with "Tree"
4. **Self-broadcast loops**: Connectors receive own messages locally — filter with `_lastSentRef`
5. **Golden updates**: Run `pnpm updateGoldens` after intentional output changes
6. **Wrong socket pattern**: Use `createSocketPair()` for tests, not single `SocketMock`
7. **Route `+` suffix**: NEVER add `+` suffix to routes — causes routing mismatches
8. **syncFromDb without initial tree**: Must call `storeInDb()` first, then `syncFromDb()` responds to updates
9. **Forgetting dispose**: File watchers keep the process alive — must explicitly stop them

---

## API Design Principles

### Preserve Backward Compatibility — Always Prefer Additive Changes

```typescript
// ❌ WRONG: Breaking change
class FsAgent {
  constructor(rootPath: string, treeKey: string, clientIo: Io, ...) {} // BREAKS existing
}

// ✅ CORRECT: Additive factory method
class FsAgent {
  constructor(rootPath: string, bs?: Bs, options?: FsAgentOptions) {} // UNCHANGED
  static async fromClient(filePath: string, treeKey: string, client: Client, ...): Promise<FsAgent> {}
}
```

If a refactoring is going wrong: `git status --short` → `git restore <files>` → start fresh. Clean reverts are faster than salvaging broken refactors.
