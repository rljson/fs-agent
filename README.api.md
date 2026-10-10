<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent — API reference

Every symbol the package exports, grouped by what it is for. **46 exports.**

Most consumers need only the first section. The rest is exported because a host
builds on it — a scanner to watch a folder, the chain to show a history, an
atomic write to touch a synced folder safely — not because a caller is expected
to reach for every part.

| if you want | read |
| --- | --- |
| to sync a folder | [The agent](#the-agent) |
| to know what the agent did | [Signals](#signals) · [Observability](#observability) |
| the history itself | [The edit chain](#the-edit-chain) |
| to scan, store or restore a folder yourself | [Scanner and adapters](#scanner-and-adapters) |
| to write into a synced folder | [Utilities](#utilities) |
| the design behind any of it | [README.architecture.md](README.architecture.md) |

---

## The agent

### `class FsAgent`

One folder, one agent. Construct it, then start both directions.

```ts
new FsAgent(rootPath: string, bs?: Bs, options?: FsAgentOptions)
```

`bs` defaults to a fresh `BsMem`, which is **local only**: an agent with a bare
`BsMem` can store its own blobs and never fetch a peer's. For a synced folder
pass `client.bs`, or use `FsAgent.fromClient`, which wires this correctly.

| member | returns | what it does |
| --- | --- | --- |
| `static fromClient(rootPath, treeKey, client, socket, options?)` | `Promise<FsAgent & …>` | the production path: takes `client.io`/`client.bs` and a `Connector` with the sync config the fleet needs; adds `syncToDbSimple()` and `syncFromDbSimple()` |
| `syncToDb(db, connector, treeKey)` | `Promise<() => void>` | **sending.** Watches the folder, authors an entry per change, announces its head. Returns `stop()` |
| `syncFromDb(db, connector, treeKey)` | `Promise<() => void>` | **receiving.** Hears the heads the network says and applies, adopts, announces or merges. Returns `stop()` |
| `ownHead` | `string \| undefined` | the chain entry this folder stands on; persisted in `.fsagent-state.json` |
| `dispose()` | `void` | releases the watcher and abandons a pending join |
| `extract()` | `Promise<FsTree>` | scans the folder into a tree, without storing or announcing it |
| `restore(tree, targetPath?, options?)` | `Promise<void>` | writes a tree to disk. See [`RestoreOptions`](#interface-restoreoptions) |
| `storeInDb(db, treeKey, options?)` | `Promise<string>` | scans and stores, returning the tree ref |
| `loadFromDb(db, treeKey, rootRef, targetPath?, options?)` | `Promise<void>` | fetches a tree by ref and writes it out |
| `getTree()` | `FsTree \| null` | the last scanned tree |
| `hasBlob(blobId)` · `getFileContent(blobId)` | `Promise<boolean>` · `Promise<Buffer>` | the blob store, as this agent sees it |
| `rootPath` · `bs` · `scanner` · `adapter` · `timeouts` | | what the agent was built with |

Both `sync*` methods return a `stop()`. Stopping the receive side also clears
`antiEntropyStatus`, unless a newer receive side replaced it.

### `interface FsAgentOptions`

Everything optional. [README.public.md](README.public.md#configuration) says
what each one costs; this is the shape.

| field | type | |
| --- | --- | --- |
| `joinWaitMs` | `number` | how long a folder with files and no history waits for the network's head before it becomes the origin of its own. `0` means at once |
| `syncConfig` | `SyncConfig` | forwarded to the `Connector` `fromClient` builds. `includeClientIdentity` lets the hub tell a re-announcement from an echo |
| `clientIdentity` | `ClientId` | who this machine is on the wire |
| `onSignal` | `(signal: FsSignal) => void` | the [signal](#signals) channel, from the constructor |
| `timeouts` | [`TimeoutConfig`](#interface-timeoutconfig) | every async step is bounded |
| `logName` | `string` | tags this agent's log lines |
| `ignore` | `string[]` | patterns not to sync; globs, see [`compileIgnore`](#compileignorepatterns) |
| `maxDepth` · `followSymlinks` · `scanCachePath` | | forwarded to the [`FsScanner`](#class-fsscanner) |

### `interface TimeoutConfig`

Every field optional; defaults shown.

```ts
{ dbQuery: 10_000, fetchTree: 20_000, extract: 15_000, restore: 15_000,
  debounceMs: 300 }
```

`restore` bounds every apply: the sending and receiving sides share one lock, so
an apply that hung on a blob nobody serves would keep the folder's own work from
being authored. `debounceMs` coalesces a burst of filesystem events into one
edit.

### `interface RestoreOptions`

`cleanTarget` deletes anything the tree does not contain. **The sync never sets
it**: an apply deletes only what a descending head removed. Read
[README.public.md](README.public.md#restoreoptionscleantarget--read-this-before-setting-it)
before you do.

### `SYNC_ERROR_FILE`

`'.sync-errors.log'` — the keyed, append-only record of internal failures, in
the synced folder and never synced. A refusal is a [signal](#signals), not an
error.

---

## Signals

**The channel a host application should read.** It reports everything a person
might care about, through one type, and is the only surface that says whether
somebody still has to act.

| member | type | |
| --- | --- | --- |
| `agent.signals` | `readonly FsSignal[]` | everything signalled, oldest first; seeded from disk on first read |
| `agent.signalsNeedingAction` | `readonly FsSignal[]` | only `action: 'required'` — the list a UI should surface |
| `agent.signalTotals` | `Record<string, number>` | how many of each kind ever happened, dropped ones included |
| `agent.onSignal(cb)` | `() => void` | subscribe; returns an unsubscribe |

### `class FsSignals`

The sink itself: bounded, countable, subscribable, and no I/O. Exported because
a host aggregating several agents can own one and feed it from each `onSignal`.

### `interface FsSignal`

| field | type | |
| --- | --- | --- |
| `kind` | `FsSignalKind` | what happened |
| `at` | `number` | epoch ms |
| `paths` | `readonly string[]` | affected paths, sorted, at most `SIGNAL_PATHS_MAX` |
| `pathCount` | `number` | how many were affected, which may exceed `paths.length` |
| `action` | `FsSignalAction` | whether a person has to do something |
| `decidedBy` | `FsSignalDecidedBy` | who chose the outcome |
| `copyPath` | `string` | where the version that lost the path was kept |
| `detail` | `string` | one sentence for a person; never a stack trace |

### `type FsSignalKind`

| `kind` | `action` | what it means |
| --- | --- | --- |
| `conflict/arbitrary` | `review` | two machines changed one file at once, or one deleted what the other edited. Both versions were kept (`copyPath`), or the edit was; which keeps the name follows the order the fleet heard them in |
| `collision/type` | **`required`** | a directory and a file at one path: the directory keeps it, the file is at `copyPath` |
| `deletion/refused` | **`required`** | a deletion beyond the guard's floors was not made — not authored at the sender, not applied at a receiver |
| `join/recovered` | `review` | a joining machine moved files the history had removed into `.fsagent-recovered/` |
| `join/conflicted` | `review` | a joining machine kept its own version of a path beside the network's |
| `repair/blocked` | `review` | nothing could be decided — a history that cannot be read, or a stamp the hub never sent. Retried |
| `path/unwritable` | **`required`** | a path this filesystem rejects. It will not arrive until renamed |

### `type FsSignalAction`

`'none' | 'review' | 'required'`. `review`: the agent dealt with it and a person
may want to know. `required`: nothing in this package will resolve it.

### `type FsSignalDecidedBy`

`'chain' | 'stamp' | 'guard'` — the edit chain (which edit came after which),
the hub's stamps (which version reached the fleet later), or a guard that
refused, so nothing was chosen. None of them compares two machines' clocks.

### `type FsSignalInput`

What a producer passes before the sink stamps `at` and counts `paths`.

### `type FsSignalLog`

The persisted shape: `{ signals, totals }`.

### `SIGNAL_LOG_FILE`

`'.fsagent-signals.json'` — where the log persists, inside the synced folder.

### `SIGNAL_LOG_MAX`

`200` signals kept. The per-kind totals are not bounded.

### `SIGNAL_PATHS_MAX`

`20` paths named by one signal before it only counts them.

### `SIGNAL_ONCE_MAX`

`500` distinct "report once" keys remembered.

---

## Observability

| member | type | |
| --- | --- | --- |
| `agent.antiEntropyStatus` | `AntiEntropyStatus \| null` | what the last head the hub said made this node do |
| `agent.stageTimings` | `Record<string, number>` | milliseconds per stage of the last cycle: `push.scan`, `push.announce`, and the `apply.*` stages |
| `agent.scanner.onChange(cb)` | `() => void` | every filesystem event the scanner accepted |

### `interface AntiEntropyStatus`

| field | |
| --- | --- |
| `diverged` | whether this node's head was not the hub's after receiving it |
| `divergedSince` | since when, epoch ms by this node's clock |
| `hubRef` | the head the hub said last |
| `localRef` | this node's head now |
| `repairs` | how often the hub's head made this node act |
| `lastRepair` | `{ action: 'pull' \| 'push' \| 'merge' \| 'blocked', at, hubRef, localRef, attempt }` — `attempt` counts how often in a row the same hub head made it act |

---

## The edit chain

`src/fs-edit-chain.ts` — the history every decision is made from.

### `class FsEditChain`

```ts
new FsEditChain(db: Db, treeKey: string)
```

| member | returns | |
| --- | --- | --- |
| `init()` | `Promise<void>` | creates the tables if absent |
| `append(opts)` | `Promise<FsChainEntry>` | writes one entry |
| `entry(head)` | `Promise<FsChainEntry \| undefined>` | reads one back; `undefined` when no peer can resolve it |
| `relate(ours, theirs, maxWalk?)` | `Promise<{ verdict, base? }>` | `same` · `behind` · `ahead` · `fork` (with the `base` to merge against) · `incomplete` |
| `lastEditOf(head, path, maxWalk?)` | `Promise<FsChainEntry \| undefined>` | the nearest entry that changed or removed a path |
| `collectRemovals(head, ourHead, maxWalk?)` | `Promise<{ removed, changed, complete }>` | the net delta between a head and a state this node knows |

### `interface FsChainEntry`

```ts
{ head: string; timeId: string; treeRef: string;
  previous: string[]; changed: string[]; removed: string[]; }
```

### `interface FsAppendOptions`

`{ treeRef, previous, changed?, removed?, timeId? }`. `previous` is required: the
agent says what every entry was made from. `timeId` is passed for an entry that
must be a function of its content — a merge — and minted otherwise; a root's is
derived from its tree.

### `interface FsEditData`

`{ treeRef, changed, removed }` — what is stored inside the edit row.

### `FS_EDIT_ACTION`

The action name every edit row carries.

### `createFsChainTables(db, treeKey)`

Creates the three chain tables. Idempotent, so the agent creates its own and a
host one release behind cannot break it.

---

## Scanner and adapters

### `class FsScanner`

Scans and watches a folder. `scan()` reads it into an `FsTree`; `scanFresh()`
returns a pass that started after the call, sharing one with anyone else asking
meanwhile — what a caller that acts on the folder must use. `watch()`,
`stopWatch()`, `pauseWatch()`, `onChange(cb)`, `knownFile(path)`.

### `interface FsScanOptions`

`ignore`, `maxDepth`, `followSymlinks`, `scanCachePath`, `settleMs`, `bs`.

### `interface FsTree`

`{ rootHash, trees }` — the RLJSON tree of a folder, by node hash.

### `interface FsNodeMeta`

What a tree node says about its path: `name`, `type`, `relativePath`, and for a
file `blobId` and `size`.

### `interface FsChange`

`{ type, path }` — one event the scanner accepted.

### `type FsChangeType`

`'added' | 'modified' | 'deleted' | 'safety-rescan'`.

### `type FsChangeCallback`

`(change: FsChange) => void | Promise<void>`.

### `class FsBlobAdapter`

Moves file content between the folder and a blob store: `fileToBlob` and
`blobToFile`, streaming large files.

### `interface FileBlobMeta`

What a stored blob says about the file it came from.

### `interface FileToBlobOptions`

How a file is read into the blob store.

### `interface BlobToFileOptions`

How a blob is written out; `preserveMtime`.

### `class FsDbAdapter`

Stores an `FsTree` in a `Db` and reads it back: `storeFsTree(tree, options?)`
returns the tree ref.

### `interface StoreFsTreeOptions`

`skipNotification` — store without the `Connector` announcing the insert. The
agent announces chain heads itself.

---

## Utilities

**Write into a synced folder through `fs-atomic-write`, always.** `writeFile`
truncates and then writes, so two concurrent writes of one path interleave and
produce bytes nobody wrote — measured at 1 520 blended pairs in 2 000.

### `atomicWriteFile(path, content)`

Writes to a temporary file beside the target and renames it into place.

### `atomicWriteStream(path, stream)`

The same, from a stream.

### `atomicTmpPath(path)`

The temporary path `atomicWriteFile` uses for `path`.

### `ATOMIC_TMP_PREFIX`

`'.fsagent-tmp-'` — the prefix of those temporary files, which the scanner
ignores.

### `compileIgnore(patterns)`

Compiles ignore patterns into a matcher once: globs (`*`, `?`, `**`, folders
with `/`, `!` exceptions with last-match-wins), case-insensitive. A pattern with
no glob characters keeps its old prefix meaning — `~$`, `.~lock.` and
`ATOMIC_TMP_PREFIX` depend on it.

### `globToRegExp(pattern)`

One glob as a regular expression.

### `interface IgnoreMatcher`

`{ ignores(relativePath, isDirectory?): boolean }` — `isDirectory` when known,
because a directory-only pattern needs it.

---

## Client-server

### `runClientServerSetup(options?)`

Builds a hub and two clients over socket pairs, syncs a folder from one to the
other, and returns where it all is — a demo of the whole loop, and a smoke test.

### `interface ClientServerSetupOptions`

`{ baseDir?, treeKey? }` — where the two folders go, and the tree table.

### `interface ClientServerSetupResult`

`{ baseDir, folderA, folderB, contentB, cleanup }` — the two folders, what
arrived in the second, and `cleanup()`.

---

## Further reading

| | |
| --- | --- |
| [README.public.md](README.public.md) | install, production configuration, what each option costs, troubleshooting |
| [README.architecture.md](README.architecture.md) | the mechanism, and why each rule exists |
| [README.tests.md](README.tests.md) | what the suite proves, and what it cannot |
