<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent — API reference

Every symbol the package exports, grouped by the module it comes from, with what
it is for and what it costs. **100 exports across 12 modules.**

Most consumers need only the first section. The rest is the protocol, exported
because the sync is assembled from parts that are separately testable — not
because every caller is expected to reach for them.

| if you want | read |
| --- | --- |
| to sync a folder | [The agent](#the-agent) |
| to know what the agent is doing | [Observability](#observability) |
| the history itself | [The edit chain](#the-edit-chain) |
| the repair protocol | [Bucket sync](#bucket-sync-the-wire) and [The manifest](#the-manifest-reconciliation) |
| conflict resolution internals | [Conflicts](#conflicts) |
| the design behind any of it | [README.architecture.md](README.architecture.md) |

---

## The agent

### `class FsAgent`

One folder, one agent. Construct it, then start one or both directions.

```ts
new FsAgent(rootPath: string, bs?: Bs, options?: FsAgentOptions)
```

`bs` defaults to a fresh `BsMem`, which is **local only**. For a synced folder
pass `client.bs` — an agent with a bare `BsMem` can store its own blobs and
never fetch a peer's, so every restore fails on its first file. Prefer
`FsAgent.fromClient`, which wires this correctly.

| member | returns | what it does |
| --- | --- | --- |
| `static fromClient(client, rootPath, options?)` | `Promise<FsAgent>` | the production path: takes `client.io`/`client.bs`, turns on conflict resolution and the sync config the fleet needs |
| `syncToDb(db, connector, treeKey, storageOptions?)` | `Promise<() => void>` | **sending.** Watches the folder, appends an Edit per change, announces its head. Returns `stop()` |
| `syncFromDb(db, connector, treeKey, restoreOptions?)` | `Promise<() => void>` | **receiving.** Resolves announcements, applies Edits, heals. Returns `stop()` |
| `dispose()` | `void` | releases the watcher and **abandons a pending join** |
| `extract()` | `Promise<FsTree>` | scan the folder into a tree, without storing or announcing |
| `restore(tree, targetDir?, options?)` | `Promise<void>` | write a tree to disk. See `RestoreOptions.cleanTarget` |
| `storeInDb(db, treeKey, options?)` | `Promise<string>` | scan and store, returning the tree ref |
| `loadFromDb(db, treeKey, ref, targetDir?)` | `Promise<void>` | fetch a tree by ref and write it out |
| `getTree()` | `FsTree \| null` | the last scanned tree, or `null` before the first scan |
| `hasBlob(blobId)` | `Promise<boolean>` | is this blob available locally |
| `getFileContent(blobId)` | `Promise<Buffer>` | the bytes behind a blob id |

Both `syncToDb` and `syncFromDb` return a `stop()`. Calling `stop()` ends that
direction; `dispose()` releases the agent.

### `interface FsAgentOptions`

Everything optional. See
[README.public.md § Configuration](README.public.md#configuration) for defaults
and what each one costs — this table is the shape, that one is the advice.

| field | type | |
| --- | --- | --- |
| `resolveConflicts` | `boolean` | reconcile two edits of one file, keeping the loser as a renamed copy. Off, the resolver is not even constructed |
| `onConflict` | `(reports) => void` | called as conflicts are resolved; without it they are resolved silently |
| `joinWaitMs` | `number` | how long a folder with files and no history waits for the network before speaking. `0` means "this folder is its own origin" |
| `bucketSync` | `boolean` | repair a divergence by comparing manifests instead of replacing a folder |
| `antiEntropy` | `AntiEntropyOptions` | the periodic comparison that heals a lost announcement |
| `syncConfig` | `SyncConfig` | forwarded to every `Connector`. Without `causalOrdering` the wire carries no predecessors and no conflicting edit can be merged |
| `clientIdentity` | `ClientIdentity` | who this machine is, on the wire |
| `timeouts` | `TimeoutConfig` | every async step is bounded; see below |
| `logName` | `string` | tags this agent's log lines. Four agents in one process produced three identical lines with nothing saying who |
| `ignore` | `string[]` | patterns not to sync; globs supported |
| `followSymlinks` | `boolean` | |
| `settleMs` / `settleMinBytes` | `number` | how long a large file must stop growing before it is hashed |

### `interface TimeoutConfig`

Every field optional; defaults shown.

```ts
{ dbQuery: 10_000, fetchTree: 20_000, extract: 15_000, restore: 15_000,
  syncCallback: 25_000, debounceMs: 300, processRefRetries: 3,
  processRefRetryDelayMs: 5_000, recoveryRetries: 10 }
```

### `interface RestoreOptions`

`cleanTarget` deletes anything the incoming tree does not contain. **The sync
never sets it.** Read
[README.public.md](README.public.md#restoreoptionscleantarget--read-this-before-setting-it)
before you do.

---

## Signals — what happened to the folder

**The channel a host application should read.** Everything else in this section
reports one thing each; this reports everything a person might care about,
through one type, and is the only surface that says whether somebody still has
to act.

| member | type | |
| --- | --- | --- |
| `agent.signals` | `readonly FsSignal[]` | everything signalled, oldest first. Seeded from disk on first read, so a host that starts late still sees it |
| `agent.signalsNeedingAction` | `readonly FsSignal[]` | only `action: 'required'` — the list a UI should surface |
| `agent.signalTotals` | `Record<string, number>` | how many of each kind EVER happened, dropped ones included |
| `agent.onSignal(cb)` | `() => void` | subscribe; returns an unsubscribe |
| `FsAgentOptions.onSignal` | `(signal) => void` | the same channel, from the constructor |
| `SIGNAL_LOG_FILE` | `'.fsagent-signals.json'` | where it persists, inside the synced folder |
| `SIGNAL_LOG_MAX` | `200` | signals kept |
| `SIGNAL_PATHS_MAX` | `20` | paths one signal names before it only counts them |
| `SIGNAL_ONCE_MAX` | `500` | distinct "report once" keys remembered |

### `interface FsSignal`

| field | type | |
| --- | --- | --- |
| `kind` | `FsSignalKind` | what happened |
| `at` | `number` | epoch ms |
| `paths` | `readonly string[]` | affected paths, sorted, at most `SIGNAL_PATHS_MAX` |
| `pathCount` | `number` | how many were affected, which may exceed `paths.length` |
| `action` | `'none' \| 'review' \| 'required'` | whether a person has to do something |
| `decidedBy` | `'chain' \| 'clock' \| 'claim' \| 'hash' \| 'guard'` | how the outcome was chosen |
| `copyPath` | `string` | where the version that lost the path was kept |
| `timeId` | `string` | the edit this belongs to |
| `detail` | `string` | one sentence for a person. Never a stack trace |

### The kinds, and what a host should do with each

| `kind` | `action` | what it means |
| --- | --- | --- |
| `conflict/merged` | `review` | two machines edited one file; both versions kept, the newer edit keeps the path |
| `conflict/arbitrary` | `review` | both kept, but nothing could say which edit came last — **the one worth asking a person about** |
| `conflict/overwritten` | `review` | one version won and the other was not kept. Only reachable with `resolveConflicts` off |
| `deletion/refused` | **`required`** | the mass-delete guard refused. The deletion will not arrive and nothing will resolve it |
| `join/recovered` | `review` | a rejoining machine moved files the network had deleted into `.fsagent-recovered/` |
| `join/conflicted` | `review` | a rejoining machine kept its own edit beside the network's |
| `repair/blocked` | `review` | a divergence the history cannot settle. Retried as more history arrives |
| `path/unwritable` | **`required`** | a path this filesystem rejects. It will not arrive until renamed |
| `config/degraded` | `review` | this agent is configured to keep less than it could. Reported once per agent |

**`action` is the field to build on.** `review` means the agent dealt with it and
a person may want to know; `required` means **nothing in this package will ever
resolve it**. Only two kinds earn `required`, deliberately — a list that cries
wolf gets ignored, and these two are the ones a user can actually act on.

**`decidedBy` is not a detail.** `'chain'` is a fact about which edit came after
which. `'hash'` converges and is otherwise arbitrary: the winner has nothing to
do with who edited last. Two defects hid in exactly that distinction, both
converging on the superseded version about half the time they arose, and neither
visible from outside the package. A host that can see `'hash'` can ask; one that
cannot has to trust a coin flip.

### The supporting types

| export | |
| --- | --- |
| `FsSignalKind` | the union of kinds in the table above |
| `FsSignalAction` | `'none' \| 'review' \| 'required'` |
| `FsSignalDecidedBy` | `'chain' \| 'clock' \| 'claim' \| 'hash' \| 'guard'`, ordered by how much it is worth trusting |
| `FsSignalInput` | what a producer passes before the sink stamps `at` and counts `paths` |
| `FsSignalLog` | the persisted shape: `{ signals, totals }` |
| `FsSignals` | the sink itself — bounded, countable, subscribable, and does no I/O |

`FsSignals` is exported because it is useful on its own: a host that aggregates
several agents can own one and feed it from each `onSignal`. It holds no
filesystem state, so the agent writes the file and this stays testable without
one.

### Migrating from 0.1.0

Nothing is removed and nothing changes behaviour — `onConflict`,
`refusedDeletions`, `.fsagent-conflicts.json` and `.sync-errors.log` all work
exactly as before, and the tests that pin them are still in the suite. The
signal channel is a superset:

| if you read | you can now read | and you additionally get |
| --- | --- | --- |
| `onConflict` | `onSignal` / `signals` | bucket-round conflicts, join outcomes, refusals, unwritable paths, configuration problems |
| `refusedDeletions` | `signalsNeedingAction` | the same refusals plus anything else a person must act on, in one list |
| `.sync-errors.log` (parsing) | `signals` | a typed record instead of text, with `action` and `decidedBy` |

A minimal host needs one subscription and one list:

```ts
const agent = await FsAgent.fromClient(folder, 'fileTree', client, socket, {
  onSignal: (signal) => inbox.push(signal),
});

// …and on start, for anything that happened while the UI was down:
for (const signal of agent.signalsNeedingAction) inbox.push(signal);
```

`ReconcilePlan` gains `conflictDecidedBy` (a `path → verdict` map). `conflict`
keeps its shape, so a caller reading it is unaffected.

## Observability

| member | type | |
| --- | --- | --- |
| `agent.antiEntropyStatus` | `AntiEntropyStatus \| null` | whether this machine agrees with the hub, since when, and what it last did |
| `agent.refusedDeletions` | `readonly RefusedDeletion[]` | deletions the mass-delete guard refused, newest last |
| `agent.stageTimings` | `Record<string, number>` | milliseconds per stage of the **last** cycle. A total says a run was slow; this says where |
| `agent.scanner.onChange(cb)` | `() => void` | every filesystem event the scanner accepted |
| `SYNC_ERROR_FILE` | `'.sync-errors.log'` | keyed, append-only record of every refusal and failure |
| `REFUSED_DELETION_LOG_MAX` | `20` | how many refusals `refusedDeletions` keeps |

### `interface RefusedDeletion`

```ts
{ atMs: number;
  route: 'restore' | 'bucketSync' | 'removals';
  wouldRemove: number;
  held: number;
  paths: readonly string[]; }
```

The guard refuses on **every** machine, so a deliberate mass deletion stalls the
whole fleet and the only other trace is a line in each machine's log — which a
UI on another machine cannot read. `route` matches the sync-error key. `paths`
holds the first ten, which is enough to name the folder and ask the user.

### `interface AntiEntropyStatus`

`diverged`, `divergedSince`, `hubRef`, `localRef`, `differingPaths`, `repairs`,
`lastRepair`.

`diverged` is a **latch** — a difference has persisted long enough to repair.
`differingPaths` is what a content comparison actually found. They can disagree,
and the known case is in
[README.public.md § Known constraints](README.public.md#known-constraints).

---

## The edit chain

`src/fs-edit-chain.ts` — the history every decision is made from.

### `class FsEditChain`

```ts
new FsEditChain(db: Db, treeKey: string)
```

| member | returns | |
| --- | --- | --- |
| `init()` | `Promise<void>` | create the tables if absent, load the head |
| `head` | `string \| undefined` | this node's current head |
| `ready` | `boolean` | whether the chain can be used |
| `append(opts)` | `Promise<FsChainEntry>` | write one Edit |
| `entry(head)` | `Promise<FsChainEntry \| undefined>` | read an Edit by its address |
| `entryForTreeRef(treeRef)` | `Promise<FsChainEntry \| undefined>` | the newest Edit that landed on a state. **Ambiguous by nature** — a folder returning to earlier content produces a second Edit with the same tree ref — which is why `~H~` is the primary and this is the fallback |
| `oldestEntryForTreeRef(treeRef)` | `Promise<FsChainEntry \| undefined>` | the other end of that ambiguity |
| `refreshHead()` | `Promise<string \| undefined>` | re-read the tip from the table |
| `classify(ourHead, theirHead)` | `Promise<Reachability>` | `behind` · `ahead` · `fork` · `incomplete` |
| `lastEditOf(head, path, maxWalk?)` | `Promise<FsChainEntry \| undefined>` | the newest Edit mentioning a path, in `changed` **or** `removed`. Nearest to the head wins; ties break on `timeId` |
| `collectRemovals(...)` | `Promise<…>` | the removals stated between two points |

Supporting types: `FsAppendOptions` (`{ treeRef, changed?, removed?, previous? }`
— what `append` takes), `FsEditData` (`{ treeRef, changed, removed }` — what is
stored inside the Edit row), `RemovalQuestion` (what `planRemovals` is asked:
the sender's `removed`, its `timeId`, what this node holds, `localTimeIds` and
`chainTimeIds`), and `FS_EDIT_ACTION`, the action name every Edit row carries.

### `interface FsChainEntry`

```ts
{ head: string; timeId: string; treeRef: string;
  previous: string[]; changed: string[]; removed: string[]; }
```

`changed` does not distinguish an addition from a modification. `removed` is
separate because only a removal needs an author.

### `compareTimeId(a, b): number`

Total order over `<millis>:<nanoid>`, computed identically on every machine.
Minted once by the author of a change, never re-stamped by a receiver.

### `planRemovals(question): RemovalPlan`

Given a sender's stated removals and what this node knows, which to apply,
which to refuse as stale, and which are a mass deletion. Takes `localTimeIds`
and `chainTimeIds` — a path this node authored, and a path only the chain can
speak for.

### `createFsChainTables(db, treeKey)`

Idempotent. **The agent creates its own tables**, so a host one release behind
cannot break it.

---

## Bucket sync (the wire)

`src/fs-bucket-sync.ts` — a four-message round that repairs a divergence
additively.

| | |
| --- | --- |
| `BQ` `BR` `BG` `BE` | the four prefixes: ask roots, reply roots, ask entries, reply entries |
| `BUCKET_SYNC_PREFIXES` | all four |
| `isBucketSync(ref)` | is this a control message rather than a state |
| `encodeRoots` / `decodeRoots` | roots message |
| `encodeWanted` / `decodeWanted` | which buckets differ |
| `encodeEntries` / `decodeEntries` | the entries in those buckets |
| `class FsBucketSync` | `start()`, `receive(ref)` |
| `interface BucketSyncHost` | what the agent supplies: `manifest()`, `claimed()`, `editTimes()`, `apply(plan)`, `ready()`, `send(ref)`, `agreed()` |

Bodies are JSON because a POSIX filename may contain any byte except `/` and
NUL. A control message **names no tree**, which is why it must never reach the
anti-entropy as if it were a state.

---

## The manifest (reconciliation)

`src/fs-manifest.ts` — what two folders compare, and what they conclude.

### `type ManifestEntry`

```ts
readonly [path: string, blobId: string, claimed?: 0 | 1, editedAt?: string]
```

`claimed` says **who** edited; `editedAt` says **when** — the `timeId` of the
newest Edit for that path, so a tombstone can be ordered against the write it
claims to supersede. Absent means "the sender did not say", and the rules that
predate the field decide. Neither is part of `digestOf`: bucket roots must
depend on content alone, or a node sees differences that are not there.

### `reconcile(ours, theirs, claimed?): ReconcilePlan`

`{ fetch, drop, redelete, conflict }`. Both sides compute it from the same two
inputs and reach the same verdict, which is what convergence requires.

A tombstone older than our write is refused; our tombstone older than their
write makes us fetch. Without the second half each side holds its position for
ever.

| | |
| --- | --- |
| `BUCKET_COUNT` · `bucketOf(path)` | how paths are divided |
| `bucketRoots(manifest)` · `differingBuckets(a, b)` · `BucketRoots` | O(differences), not O(size) |
| `entriesInBuckets(manifest, buckets, claimed?, editTimes?)` | the entries for an exchange |
| `TOMBSTONE_BLOB` | a deletion travels as an **entry**, not an absence |

---

## Anti-entropy

`src/fs-anti-entropy.ts` — healing when no announcement arrives.

| | |
| --- | --- |
| `class FsAntiEntropy` | `observe(hub)`, `agreedOn(ref)`, `status`, `dispose()` |
| `antiEntropyDecision(hub, view, attempt?)` | `in-sync` · `unknown` · `blocked` · `pull` · `push` · `merge` |
| `DEFAULT_ANTI_ENTROPY` | the tuning a production fleet runs |
| `type Reachability` | `behind` · `ahead` · `fork` · `incomplete` |
| `interface HubAnnouncement` | `{ ref, origin?, predecessors?, reachability? }` |
| `interface AntiEntropyView` | what the agent reports about itself: `origin`, `currentRef`, `lastAppliedRef`, `lastPushedRef`, `reachability?` |
| `interface AntiEntropyDeps` | what the agent supplies: `view()`, `busy()`, `sameContent?()`, `repair()`, `now?()`, `log?()` |
| `type AntiEntropyAction` | `pull` · `push` · `merge` — what a repair does |
| `type AntiEntropyDecision` | an `AntiEntropyAction`, or `in-sync` · `unknown` · `blocked` |

`antiEntropyDecision` switches on `reachability` **before** any heuristic, and
`blocked` is a real answer: nothing applied, nothing latched, retried.

---

## Conflicts

`src/fs-conflict-resolver.ts` — two people edited one file.

| | |
| --- | --- |
| `class FsConflictResolver` | `resolve(conflict)` |
| `threeWayMerge(o, ours, theirs, winnerSide, loserClientId, loserTimestamp, winnerFor?)` | the merge table. `winnerFor` is the **per-path chain verdict**, which outranks the branch order |
| `findCommonAncestor(...)` | the `o` of the three |
| `compareTips(...)` · `decideWinner(...)` | branch order, used only where the chain cannot speak |
| `conflictCopyName(...)` · `formatConflictTimestamp(...)` | the losing version's name |
| `fsTreeToContentMap(tree)` · `ContentMap` · `DIR_MARKER` | |
| `MergePlan` · `ConflictCopy` · `BranchTip` | the plan, a renamed loser, and one side of a fork |
| `interface ConflictResolverDeps` | what the agent supplies: the history readers, `writeFileAt`, `deleteFileAt`, `scan`, `storeMerge`, `lastEditOfPath`, and the `announce` the merge revision needs — **required**, because the merge store suppresses the connector's own broadcast |

**The loser's bytes are never dropped** — they become a renamed copy, which is
why either verdict is safe.

---

## Scanner, adapters, utilities

| module | exports |
| --- | --- |
| `fs-scanner.ts` | `FsScanner`, `FsTree`, `FsNodeMeta`, `FsChange`, `FsChangeType`, `FsChangeCallback`, `FsScanOptions` |
| `fs-blob-adapter.ts` | `FsBlobAdapter`, `FileBlobMeta`, `FileToBlobOptions`, `BlobToFileOptions` |
| `fs-db-adapter.ts` | `FsDbAdapter`, `StoreFsTreeOptions` |
| `fs-atomic-write.ts` | `atomicWriteFile`, `atomicWriteStream`, `atomicTmpPath`, `ATOMIC_TMP_PREFIX` |
| `fs-ignore.ts` | `compileIgnore`, `globToRegExp`, `IgnoreMatcher` |
| `client-server/client-server-setup.ts` | `runClientServerSetup`, `ClientServerSetupOptions`, `ClientServerSetupResult` |

**Write through `fs-atomic-write`, always.** Three copies of "write a file"
existed and two of them corrupted content: `writeFile` truncates then writes, so
two concurrent writes of one path interleave as truncate, truncate, write, write
and produce bytes nobody wrote. Measured at 1520 blended pairs in 2000.

---

## Further reading

| | |
| --- | --- |
| [README.public.md](README.public.md) | install, production configuration, what each option costs, troubleshooting |
| [README.architecture.md](README.architecture.md) | the mechanism, and why each rule exists |
| [README.tests.md](README.tests.md) | what the suite proves, and what it cannot |
