<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/fs-agent

> **Keeps a folder on several machines the same, without a central authority
> deciding what the folder contains.**

Each machine watches its own folder, writes down what changed, and tells the
others. There is no master copy: a hub relays, it does not arbitrate. Two
people editing at once get one agreed result with both versions kept, and a
machine switched off for a week catches up without replaying the week.

- [What it is, in one page](#what-it-is-in-one-page)
- [Install](#install)
- [Quick start](#quick-start)
- [Starting and stopping](#starting-and-stopping)
- [Configuration](#configuration)
- [Ignore patterns](#ignore-patterns)
- [Reading what the agent is doing](#reading-what-the-agent-is-doing)
- [Using it without sync](#using-it-without-sync)
- [What it guarantees — and what it does not](#what-it-guarantees--and-what-it-does-not)
- [Troubleshooting](#troubleshooting)
- [Known constraints](#known-constraints)
- [Further reading](#further-reading)

---

## What it is, in one page

Three things, and the third is the one that matters.

**A folder becomes a tree.** The scanner walks the folder and produces an
RLJSON tree: one node per directory, one entry per file, each file's bytes in
content-addressed blob storage. Two files with the same bytes are stored once,
anywhere in the fleet. The tree has a **ref** — a content hash — and two
machines holding the same bytes compute the same ref. A file's modification
time is deliberately *not* part of that identity, because it does not survive a
restore byte for byte and on Windows regularly does not.

**A change becomes an edit.** Every change a machine makes is written into an
**edit chain**: what changed, what was removed, when, and which state it
followed. The chain is one shared history, identical on every machine, and it
is the only thing that answers a question. The filesystem is an *event source
only* — the watcher says something happened, and what that means is read from
the chain.

**That is why a deletion works.** An absence is not a deletion. A tree lacks a
path because the sender removed it, or because the sender never had it, and a
content hash cannot tell the two apart. So a removal is **stated** by the
machine that performed it, and a receiver applies what is stated rather than
inferring from what is missing. Every attempt to guess it instead cost data —
see [Known constraints](#known-constraints).

Consequences worth knowing before you start:

|  |  |
| --- | --- |
| **A deletion is a fact, not a gap** | so it survives a partition, a restart, and a peer who never heard about it |
| **A receiver never claims authorship** | so a machine catching up cannot out-order the person who actually typed |
| **A conflict keeps both versions** | one wins deterministically on every machine, the loser is kept as a renamed copy, and the conflict is reported |
| **Nothing is pruned on a peer's authority** | a tree you receive can add and overwrite; only a stated removal deletes |
| **A joining machine applies the history first** | and a file the history deliberately deleted is moved aside, not resurrected and not destroyed |

---

## Install

```bash
npm install @rljson/fs-agent
```

Peers: `@rljson/rljson`, `@rljson/db`, `@rljson/io`, `@rljson/bs`,
`@rljson/server`. Node 22 or newer.

---

## Quick start

**This is the production configuration.** Every option is here for the reason
named beside it; a setup without them runs, and quietly gives up guarantees you
probably want.

```typescript
import { FsAgent } from '@rljson/fs-agent';
import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

// --- the database the folder is mirrored through -------------------------
const io = new IoMem();
await io.init();
const db = new Db(io);

// The table name MUST end in `Tree`. That suffix is what selects the
// filesystem engine at runtime — it is not a naming convention.
const treeKey = 'projectFilesTree';
await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

// --- the agent ----------------------------------------------------------
const agent = new FsAgent('./my-project', new BsMem(), {
  ignore: ['node_modules', '.git', 'dist', '*.log'],

  // Reconciles two edits to one file and keeps both versions. The host
  // application
  // sets this; a hub deliberately leaves it off to stay a dumb relay. Off,
  // a conflicting edit is never merged.
  resolveConflicts: true,

  // Told, not discovered: where a conflict is reported to a user.
  onConflict: (reports) => console.warn('conflict', reports),

  // So a restart does not re-read and re-hash the whole folder.
  scanCachePath: '.cache/fs-agent-scan.json',
});

// --- the transport ------------------------------------------------------
const socket = new SocketMock();
const route = Route.fromFlat(`/${treeKey}`);
const connector = new Connector(db, route, socket, {
  // A REQUIREMENT, not a tuning option: the predecessor refs this puts on
  // the wire are what let a conflicting edit be merged at all. The agent
  // warns, once and loudly, if it is missing.
  causalOrdering: true,
  includeClientIdentity: true,
});

// --- start: RECEIVE FIRST, then push ------------------------------------
// A machine that announces before it can hear speaks about a state it may be
// about to replace.
const stopFromDb = await agent.syncFromDb(db, connector, treeKey);
const stopToDb = await agent.syncToDb(db, connector, treeKey);

// ... later
stopToDb();
stopFromDb();
agent.dispose();
```

### Against a `Client` from `@rljson/server`

What the host application does, and **the path that defaults to the
configuration above**. `fromClient` builds the `Db`, the `Connector` and the
blob store from an initialised client, adds two convenience wrappers, and
defaults `resolveConflicts`, `causalOrdering` and `includeClientIdentity` to
`true`, because that is the only mode this package measures end to end. Your own
values still win if you pass them.

`new FsAgent(...)` keeps the primitive defaults — it is the building block, and
the quick start above sets them explicitly for exactly that reason.

```typescript
const agent = await FsAgent.fromClient(folder, treeKey, client, socket, {
  ignore,
  resolveConflicts: true,
  scanCachePath,
});

const stopFromDb = await agent.syncFromDbSimple();
const stopToDb = await agent.syncToDbSimple();
```

---

## Starting and stopping

Three calls, and they are not interchangeable.

| call | starts | returns |
| --- | --- | --- |
| `syncFromDb(db, connector, treeKey, restoreOptions?)` | receiving — applying what peers announce | a `stop()` |
| `syncToDb(db, connector, treeKey, storageOptions?)` | sending — watching the folder and announcing | a `stop()` |
| `dispose()` | — | nothing; **abandons a pending join** |

**Start receiving first.** A machine that pushes before it can receive
announces a state it may be about to replace, and on an established fleet that
is how a stale folder becomes the newest claim.

**Each `stop()` stops its own direction** — the watcher, the debounce, the
poll. Call both.

**`dispose()` is not the stopper.** It cancels a join this agent is still
waiting on. A folder that starts with files and no history defers its first
announcement and asks the network for its state repeatedly until a bounded wait
expires, and no `stop()` ends that — so a machine shut down mid-join keeps
asking a transport that is being torn down. Call it last, after both stops.

### What happens in the first few seconds

Worth knowing, because it looks like a stall and is not.

1. **The folder is scanned.** A cold scan of a large catalogue is minutes, not
   milliseconds. Pass `scanCachePath`.
2. **If the folder has files but no history, the agent says nothing yet.** It
   asks the network for its state first (`joinWaitMs`, default 1 500 ms). This
   is what stops a restored backup pushing a month of deleted files back to the
   fleet.
3. **If a head arrives**, the agent reconciles against it: writes what it
   lacks, keeps its own new work, moves anything the history deliberately
   deleted into `.fsagent-recovered/`, and keeps a locally edited file as a
   conflict copy.
4. **If nothing arrives** within the wait, this folder is the origin of its own
   history and announces normally.

If your folder *is* the origin — a fixture, a test, a brand-new network — set
`joinWaitMs: 0` and skip the wait honestly.

---

## Configuration

Everything `FsAgentOptions` accepts, its default, and what choosing otherwise
costs.

### Sync behaviour

| option | default | what it does |
| --- | --- | --- |
| `resolveConflicts` | `false` on the constructor, **`true` via `fromClient`** | Reconciles two edits to one file, keeping the loser as a renamed copy. Off, a conflicting edit is never merged — the resolver is not even constructed. The constructor keeps the primitive default because a hub may relay without arbitrating |
| `onConflict` | — | Called with the conflict reports. Without it a conflict is resolved and nobody is told |
| `joinWaitMs` | `1500` | How long a folder with files and no history waits for the network before speaking. `0` means "this folder is its own origin" |
| `bucketSync` | `true` | Repairs a divergence by comparing manifests and fetching only what is missing, instead of replacing a folder |
| `antiEntropy` | `DEFAULT_ANTI_ENTROPY` | The periodic comparison that heals a lost announcement. A machine that is behind **asks**, rather than waiting to be told |
| `syncConfig` | **`causalOrdering` and `includeClientIdentity` default to `true` via `fromClient`** | Forwarded to every `Connector` the agent builds. Without `causalOrdering` the wire carries no predecessor refs, so no conflicting edit can be merged — the agent warns once, loudly |
| `clientIdentity` | — | Who this machine is, on the wire |

### Scanning

| option | default | what it does |
| --- | --- | --- |
| `ignore` | `[]` | Patterns not to sync — see [Ignore patterns](#ignore-patterns) |
| `maxDepth` | unlimited | Stop descending after N levels |
| `followSymlinks` | `false` | Follow links out of the folder. Leave it off unless you mean it |
| `scanCachePath` | — | Where to persist file hashes between runs. **Pass this.** Without it every restart re-reads and re-hashes the whole folder |

### Timeouts (`timeouts`)

Every async step is bounded, because an unbounded one is a silent hang.

| field | default |
| --- | --- |
| `dbQuery` | 10 000 ms |
| `fetchTree` | 20 000 ms |
| `extract` | 15 000 ms |
| `restore` | 15 000 ms |
| `syncCallback` | 25 000 ms |
| `debounceMs` | 300 ms |
| `processRefRetries` | 3 |
| `processRefRetryDelayMs` | 5 000 ms |
| `recoveryRetries` | 10 |

`debounceMs` coalesces a burst of filesystem events into one sync cycle. Raise
it on a folder under constant churn, lower it to make a single save feel
immediate. A large catalogue wants a larger `extract` and `restore` than the
defaults.

### `restoreOptions.cleanTarget` — read this before setting it

`cleanTarget: true` makes `restore()` prune anything not in the tree. **The
sync path ignores it and always applies additively**, because pruning on a
received tree is precisely how an absence becomes a deletion. It is honoured
only by a direct `restore()` call, where *you* are asserting the tree is the
whole truth. Passing it to `syncFromDb` is harmless and has no effect.

---

## Ignore patterns

Glob syntax, matched case-insensitively, with `/` and `\` equivalent in both
the path and the pattern.

|  |  |
| --- | --- |
| `*` | any run of characters within one path segment |
| `?` | one character within one segment |
| `**` | crosses separators. A leading `**/` also matches at the root, so `**/tmp` means `tmp` anywhere |
| `/` in the pattern | matches the whole path, **anchored at the folder root** — `build/out.txt` is the top-level one, not every `build` |
| trailing `/` | names a directory, and covers its contents |
| leading `!` | an exception, rescuing what an earlier line ignored |

**Order matters: the last matching line decides.** `['*.log', '!keep.log']`
keeps `keep.log`; reversed, it does not. A scan does not descend into an
ignored directory, so an `!` line cannot rescue a file inside one.

Blank lines and `#` comments are allowed.

### The compatibility rule

**A pattern containing none of `*`, `?`, `/` or `\`, not starting with `!` and
not ending with `/` keeps its older meaning: equal to, or a prefix of, any path
segment.**

That is deliberate and load-bearing, not politeness to old configuration files.
`~$` is Word's lock-file prefix and `.~lock.` is LibreOffice's — neither is a
fixed name — and `.fsagent-tmp-` is how this agent hides its own in-progress
writes from its own watcher. Read as globs they would match only a file named
exactly that.

```typescript
ignore: [
  'node_modules',    // prefix: also matches anything starting with it
  '~$',              // every Word lock file
  '*.log',           // every log file, at any depth
  'build/',          // the top-level build folder and its contents
  '**/tmp',          // tmp anywhere
  '!build/keep.txt', // ...except this one
]
```

`compileIgnore` is exported, so a UI can validate or preview a list before
saving it:

```typescript
import { compileIgnore } from '@rljson/fs-agent';

const matcher = compileIgnore(patterns);
matcher.ignores('src/server.log'); // true
```

---

## Reading what the agent is doing

|  |  |
| --- | --- |
| `agent.stageTimings` | milliseconds per stage of the **last** cycle — scan, hash, store, announce, fetch, write, re-derive. A total says a run was slow; this says where |
| `agent.antiEntropyStatus` | whether this machine agrees with the hub, and what it last did about it |
| `agent.refusedDeletions` | deletions the mass-delete guard **refused**, newest last — `{ atMs, route, wouldRemove, held, paths }`. Read this to answer "why did my deletion not arrive": the guard refuses on every machine, so a deliberate mass deletion stalls the whole fleet and the only other trace is a line in each machine's log. Bounded at `REFUSED_DELETION_LOG_MAX`, in memory, and it refills on the next announcement |
| `agent.scanner.onChange(cb)` | every filesystem event the scanner accepted |
| `onConflict` | conflicts, as they are resolved |
| `SYNC_ERROR_FILE` | `.sync-errors.log` in the folder: a keyed, append-only record of every refusal and failure — a locked file, an unfetchable blob, an impossible path, a refused mass deletion |
| `.fsagent-conflicts.json` | resolved conflicts, bounded |
| `.fsagent-recovered/` | files a join kept but deliberately did not announce |
| `.fsagent-state.json` | what this machine remembers across restarts: the state it was last at, the paths it deleted, and **when each path was last edited**. The edit times are what let a peer's tombstone be ordered against the write it claims to supersede — a machine that has forgotten them sends no time, and the comparison has one operand |

All of these live inside the synced folder and all are ignored by the scanner —
otherwise the notification would itself be content, propagate, and be rewritten
by every peer.

---

## Using it without sync

The scanner and the tree are useful on their own.

```typescript
const agent = new FsAgent('./folder', new BsMem());

// Folder -> tree (+ blobs)
const tree = await agent.extract();

// Tree -> folder, additively
await agent.restore(tree, './elsewhere');

// Tree -> folder, exactly: prune anything not in the tree
await agent.restore(tree, './elsewhere', { cleanTarget: true });
```

A restore writes only what differs. Re-restoring the same tree over a folder
that already matches writes nothing — which is what keeps one new file from
rewriting a whole catalogue.

---

## What it guarantees — and what it does not

**It does:**

- converge — every machine ends on the same content, or reports why not;
- never lose a user's edit to a merge, a catch-up or a reconnect;
- propagate a deletion made while partitioned or unheard-of by a peer, and
  keep it deleted;
- keep both sides of a conflict, and say there was one;
- survive a locked file, an impossible path, a full disk, a vanishing entry, a
  wrong clock and a peer on the previous wire format — each failing only
  itself;
- cost one blob to catch up on twenty missed saves of one file, not twenty.

**It does not:**

- **split a large file into blocks.** A file transfers whole, so the transport's
  message limit is the per-file ceiling;
- **let you approve a mass deletion.** One that looks like a loss is refused
  and reported through `agent.refusedDeletions`; there is no override yet;
- **collect garbage.** Every superseded version stays on every machine;
- **promise a latency.** Nothing in the suite asserts an arrival deadline, so
  nothing here should be read as one;
- **repair a folder reverted under a running agent.** Restoring a backup while
  the agent is stopped is handled; doing it underneath a live one is not
  decidable from the history, and the reasoning is in the test;
- **promise that a deletion made while the agent was NOT RUNNING propagates.**
  **Delete files with the client running.** One deleted while it is stopped may
  come back from the history on the next sync.

  This is a deliberate trade, and the reason is worth knowing. A removal is
  only ever announced for a file the agent WATCHED being deleted — never for
  any file merely missing from the folder. Announcing an absence is the same "an
  absence is a deletion" inference the edit chain exists to remove, just moved
  to the sending side, and the chain would then carry that guess as a stated,
  ordered, authoritative removal that every peer obeys — correctly, because
  obeying a stated removal is the whole design. A node whose idea of its own
  last state had drifted could tell the entire fleet to delete files nobody had
  touched.

  So the asymmetry is chosen on purpose: a file that comes back is visible and
  recoverable — delete it again with the client running and it propagates
  properly — while a file deleted across every machine on a mistaken statement
  is neither. In practice the offline case is often still caught, but it is not
  promised here, and nothing in this package should be read as promising it.

---

## Troubleshooting

**Nothing syncs and the log says `carries no ancestry`.**
`syncConfig.causalOrdering` is not `true`, so conflicting edits will not be
merged. Set it on the `Connector`.

**A conflict happened and nobody was told.** `resolveConflicts` defaults to
`false`. Set it `true` and pass `onConflict`.

**An ignore pattern does nothing.** With no `*`, `?` or `/` it is a *prefix*,
not a glob: `exe` ignores files starting with `exe`, while `*.exe` is what
ignores the extension. Check it with `compileIgnore`.

**A deletion is slow rather than lost.** A removal travels as a statement, and
a walk that cannot complete yet does nothing and waits for the next
announcement. The failure mode is *delayed*, not *silently dropped*, and that
is deliberate.

**A whole-folder deletion was refused.** The mass-delete guard.
`.sync-errors.log` names the count and the threshold. There is no override yet.

**A machine sits empty after its folder was wiped.** Above a hundred files the
agent recognises the loss and re-joins. Between eleven and ninety-nine it
announces the emptiness, the fleet correctly refuses it, and that machine is
not refilled — no data is lost anywhere, but it needs a restart.

**The first start takes minutes.** A cold scan reads and hashes every file.
Pass `scanCachePath`.

**Files appear in `.fsagent-recovered/`.** A join found files the shared
history had deliberately deleted. They are kept, not announced and not
destroyed. Usually it means that folder was restored from a backup.

**A big restore times out.** Blob transfer is streamed, but a 15-second
`restore` budget is not enough for a catalogue. Raise `timeouts.restore` and
`timeouts.extract`.

---

## Known constraints

**macOS Finder paste and rename.** Sync relies on Node's `fs.watch` (FSEvents
on macOS), which is reliable for programmatic operations and ordinary editor
saves — but Finder's paste and in-place rename do not always emit an event. A
periodic safety rescan catches these, so the gap is the rescan interval rather
than forever. See [doc/safety-rescan.md](doc/safety-rescan.md).

**Windows file locks are covered on one machine only.** The behaviour is right
— a locked file blocks itself and nothing else, and a half-applied state is not
advertised — but no mesh test runs on Windows, so this wants a Windows CI
runner.

**An upgrade changes every tree ref in the fleet.** Content identity now
excludes mtime and fixes a canonical child order, so the same bytes hash
differently than in older releases. Nothing is destroyed, but the fleet reads
divergent until every machine has re-scanned. **Upgrade machines together** —
there is no longer a switch for speaking the previous wire format, because
nothing is deployed that needs one.

**A deliberate mass deletion does not arrive.** Deleting most of a folder is
refused on every machine, and nothing asks the user — see "what it does not do"
above. Read `agent.refusedDeletions` to find out it happened: the guard cannot
tell a person deleting a project from a machine that was wiped telling the fleet
to wipe, and the second one is why the guard exists.

**On Linux, deleting a whole directory may leave its files behind.** `rm -r`
unlinks the children and then the directory; when the watched directory goes,
inotify removes its watch and the queued child events are lost. A removal is
only stated for a deletion the agent **watched** — an absence is not a deletion,
which is what stops a folder that failed to mount from wiping the fleet — so an
unobserved child is not merely unpropagated: a peer still holding it announces
it back and the folder is restored. Measured on Linux CI across four runs, a
different subset surviving each time. macOS reports every child deletion and is
unaffected. Deleting the files individually, or deleting the directory a second
time, propagates normally.

**A file still being written cannot be recognised with certainty.** The settle
rule holds a file back on the first sight of it and for as long as its size keeps
moving, which covers a copy in progress whatever the machine's clock says. What
no rule over `stat` can decide is a writer that pauses for a long time: a file
whose timestamp looks finished and whose size has not moved between two scans is
indistinguishable from one that was written and closed. If that happens the file
is hashed and distributed truncated, and a reader of the shared folder sees the
truncated version until the copy finishes — at which point the size and timestamp
change, the file is re-read, and the complete version propagates. Nothing is
corrupted permanently.

**Under heavy churn a re-created file can be lost from the whole fleet.** The
fuzzer's own log shows a path written, deleted, then written again — and the
re-creation absent from every machine afterwards. The signature is all machines
agreeing on a tree with **six entries while holding four files on disk**: the
path is in everybody's tree, on nobody's disk, and no blob error is reported.
Because every machine agrees, nothing reports a divergence and nothing repairs
it.

Measured at roughly one run in two, and **one in four on the code as it stood
before 0.1.0** — so this release did not introduce it; it is the first release
that looks for it. Nothing asserted it before, which is why it was never
reported.

It is not gated in CI, deliberately: a fuzzer that fails half the time teaches
people to re-run the build, which is worse than no gate. Reinstating the
assertion needs a seeded scenario that fails every time. The assertion itself is
written down in `mesh/fs-mesh-invariants.spec.ts`, beside what it caught.

**A machine can finish heavy churn one file short.** Under sustained random
writing, deleting and partitioning, a machine can end up holding one file fewer
than the fleet. It reports the divergence and names the path, so nothing is lost
silently, and it does not catch up inside the test's window. The cause is
recorded: its scan disagrees with its disk, so it is in sync with its own wrong
tree.

---

## Further reading

| document | what is in it |
| --- | --- |
| [README.architecture.md](README.architecture.md) | the design: why references rather than payloads, the edit chain, additive reconciliation, anti-entropy |
| [README.api.md](README.api.md) | every export, grouped by module — the shape, where this document gives the advice |
| [README.tests.md](README.tests.md) | the 810 scenarios this package ships, by what they prove |

Related packages: `@rljson/rljson` (trees), `@rljson/db` (database and
`Connector`), `@rljson/io` (sockets and storage), `@rljson/bs` (blobs),
`@rljson/server` (hub and client), `@rljson/mongo-agent` (the same idea for
documents).

## License

See [LICENSE](LICENSE).
