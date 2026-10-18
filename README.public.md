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
- [Knowing what happened to the folder](#knowing-what-happened-to-the-folder)
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
content hash cannot tell the two apart. So a machine deletes a file for one
reason only: the edit that lacks it **descends from what this machine holds** —
its author had the file and chose not to. Anywhere else an absence reaches the
folder only through a three-way merge, which knows what each side did.

Consequences worth knowing before you start:

|  |  |
| --- | --- |
| **A deletion is a fact, not a gap** | so it survives a partition, a restart, and a peer who never heard about it |
| **A receiver never claims authorship** | so a machine catching up cannot out-order the person who actually typed |
| **A conflict keeps both versions** | the version that reached the fleet later keeps the name — by the hub's stamp, never by a clock — the other is kept as a renamed copy, and the conflict is reported |
| **Nothing is pruned on a peer's authority** | only an edit that descends from this machine's own state can delete anything here |
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

  // Told, not discovered: everything a person might care about, from a
  // conflict to a refused deletion.
  onSignal: (signal) => console.warn(signal.kind, signal.paths),

  // So a restart does not re-read and re-hash the whole folder.
  scanCachePath: '.cache/fs-agent-scan.json',
});

// --- the transport ------------------------------------------------------
const socket = new SocketMock();
const route = Route.fromFlat(`/${treeKey}`);
const connector = new Connector(db, route, socket, {
  // `includeClientIdentity` lets the hub tell a machine saying its head
  // again from an echo; `causalOrdering` gives the hub a log to fill gaps from.
  causalOrdering: true,
  includeClientIdentity: true,
});

// The HUB must stamp what it relays — `new Server(route, io, bs,
// { stamp: { domain, hub } })` in `@rljson/server`. The stamp is what decides
// which of two versions of one file keeps its name; without it such a
// conflict waits, both versions kept, and says so as `repair/blocked`.

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
defaults `causalOrdering` and `includeClientIdentity` to `true`, because that is
the only mode this package measures end to end. Your own values still win if
you pass them.

`new FsAgent(...)` keeps the primitive defaults — it is the building block, and
the quick start above sets them explicitly for exactly that reason.

```typescript
const agent = await FsAgent.fromClient(folder, treeKey, client, socket, {
  ignore,
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
| `syncFromDb(db, connector, treeKey)` | receiving — acting on the heads the network says | a `stop()` |
| `syncToDb(db, connector, treeKey)` | sending — watching the folder, authoring and announcing | a `stop()` |
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
| `joinWaitMs` | `1500` | How long a folder with files and no history waits for the network before speaking. `0` means "this folder is its own origin" |
| `syncConfig` | **`causalOrdering` and `includeClientIdentity` default to `true` via `fromClient`** | Forwarded to the `Connector` `fromClient` builds. Without `includeClientIdentity` the hub cannot tell a machine saying its head again from an echo, and holds the re-announcement back |
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
| `debounceMs` | 300 ms |

`debounceMs` coalesces a burst of filesystem events into one edit. Raise it on a
folder under constant churn, lower it to make a single save feel immediate.
`restore` bounds every apply: sending and receiving share one lock, so an apply
waiting on a blob nobody serves would keep this machine from recording its own
work. A timed-out apply is tried again the next time the hub says its head. A
large catalogue wants a larger `extract` and `restore` than the defaults.

### `restoreOptions.cleanTarget` — read this before setting it

`cleanTarget: true` makes `restore()` prune anything not in the tree. **The sync
never uses it**: an apply deletes exactly what an edit descending from this
machine's state removed, and nothing else. It is honoured only by a direct
`restore()` or `loadFromDb()` call, where *you* are asserting the tree is the
whole truth.

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

## Knowing what happened to the folder

**Start here, and read one thing:** `agent.signalsNeedingAction`. It is the list
of things this machine could not resolve and will not resolve — a deletion the
guard refused, a path this filesystem rejects. If it is empty, the folder has
dealt with everything it met.

```ts
const agent = await FsAgent.fromClient(folder, 'fileTree', client, socket, {
  onSignal: (signal) => {
    if (signal.action === 'required') alertSomebody(signal.detail);
  },
});

// On start, for whatever happened while this process was not running:
for (const signal of agent.signalsNeedingAction) alertSomebody(signal.detail);
```

|  |  |
| --- | --- |
| `agent.signals` | everything that happened to this folder worth telling somebody, oldest first. Survives a restart: it is read back from `.fsagent-signals.json` the first time you ask |
| `agent.signalsNeedingAction` | only the ones a **person** has to act on |
| `agent.signalTotals` | how many of each kind ever happened — unbounded, so "and 1 240 more" stays answerable after the list has dropped the oldest |
| `agent.onSignal(cb)` | subscribe at any time; returns an unsubscribe |

Each signal says what happened (`kind`), to what (`paths`, `pathCount`), who
decided (`decidedBy`), and whether somebody has to act (`action`). Three of the
seven kinds are `required` — a refused deletion, a directory and a file at one
path, and an unwritable path — because those wait for a person.

**The one to read is `conflict/arbitrary`.** Two machines changed one file at
once: both versions were kept, and the one that reached the fleet later keeps
the name. That is the order the hub heard them in, not who edited last — which
nobody can know without trusting two machines' clocks.

The full table of kinds and the field reference are in
[README.api.md § Signals](README.api.md#signals).

## Reading what the agent is doing

|  |  |
| --- | --- |
| `agent.stageTimings` | milliseconds per stage of the **last** cycle — scan, announce, fetch, write. A total says a run was slow; this says where |
| `agent.ownHead` | the chain entry this folder stands on |
| `agent.antiEntropyStatus` | what the last head the hub said made this machine do — `diverged`, since when, and the last action (`pull`, `push`, `merge` or `blocked`) |
| `agent.scanner.onChange(cb)` | every filesystem event the scanner accepted |
| `SYNC_ERROR_FILE` | `.sync-errors.log` in the folder: a keyed, append-only record of internal failures — a locked file, an unfetchable blob, an impossible path. A refused mass deletion is a signal, not an error |
| `.fsagent-signals.json` | every signal, bounded, plus the per-kind totals that are not |
| `.fsagent-recovered/` | files a join kept but deliberately did not announce |
| `.fsagent-state.json` | what this machine remembers across restarts: the chain entry it stands on, and the highest stamp epoch it has heard — which a hub taking office on this machine continues above (`minEpoch`) |

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
  wrong clock and a peer whose history cannot be read — each failing only
  itself;
- cost one blob to catch up on twenty missed saves of one file, not twenty.

**It does not:**

- **split a large file into blocks.** A file transfers whole, so the transport's
  message limit is the per-file ceiling;
- **let you approve a mass deletion.** One that looks like a loss is refused
  and reported as a `deletion/refused` signal marked `required`; there is no
  override yet;
- **collect garbage.** Every superseded version stays on every machine;
- **promise a latency.** Nothing in the suite asserts an arrival deadline, so
  nothing here should be read as one;
- **repair a folder reverted under a running agent.** Restoring a backup while
  the agent is stopped is handled; doing it underneath a live one is not
  decidable from the history, and the reasoning is in the test;
- **follow a whole folder disappearing that it did not watch go.** A deletion
  made while the agent was stopped is recorded at the next start like any
  edit — unless it looks like a lost folder: more than the floors (a hundred
  files and 30 % of the folder, or all but ten) gone without the watcher seeing
  it. That is the shape of a failed mount or a wiped drive, never of a person,
  so nothing is recorded and a `deletion/refused` signal asks somebody to
  decide. **Delete large amounts with the client running.**

---

## Troubleshooting

**Two versions of one file wait instead of being settled.** Their conflict needs
the hub's stamp and the hub does not give one: a `repair/blocked` signal says
so, and both machines keep their own version. Configure the hub with
`stamp: { domain, hub }`.

**An ignore pattern does nothing.** With no `*`, `?` or `/` it is a *prefix*,
not a glob: `exe` ignores files starting with `exe`, while `*.exe` is what
ignores the extension. Check it with `compileIgnore`.

**A change arrives late rather than not at all.** A machine that missed an
announcement catches up the next time the hub says its head — on the state
beacon, every 30 s in the host client. The failure mode is *delayed*, not
*silently dropped*.

**A whole-folder deletion was refused.** The mass-delete guard, at the machine
that would have recorded it or at one that would have applied it. A
`deletion/refused` signal names the count and the threshold. There is no
override yet.

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

**Upgrading from 0.0.x changes every ref in the fleet.** 0.2.0 announces chain
heads only, orders conflicts by the hub's stamp, and keeps no compatibility with
older wire formats — deliberately: one flag would select two consistency models.
A machine on 0.2.0 and one on an older release cannot sync. **Upgrade a domain
together, while it is in sync**, and configure its hubs to stamp; a machine
whose state file names no head it can read starts as a joiner.

**A deliberate mass deletion does not arrive.** Deleting most of a folder is
refused, and nothing asks the user — see "what it does not do" above. Read
`agent.signalsNeedingAction` to find out it happened: the guard cannot tell a
person deleting a project from a machine that lost its disk, and the second is
why the guard exists. A machine that did lose its folder is refilled: the fleet
keeps the files and records them again on top of the deletion.

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

**Two limits of ordering by the hub.** Neither loses data, and both converge.
A machine that missed an announcement derives a later stamp for the versions it
carried, so its verdict on a same-file conflict can differ from a peer's; the
two merges then merge once more, leaving one redundant conflicted copy. And a
version that passed through a merge carries the merge's stamp, so in a
three-way race the name can go to a version first edited earlier.

**What to watch in production.** `agent.antiEntropyStatus`: `hubRef` is the head
the hub said last and `localRef` this machine's head now. They differ for a
moment after every edit; `diverged` for a long time, with `lastRepair.action`
`blocked`, is the case to look at.

---

## Further reading

| document | what is in it |
| --- | --- |
| [README.architecture.md](README.architecture.md) | the design: why references rather than payloads, the edit chain, the conflict table, the stamp, the guards |
| [README.api.md](README.api.md) | every export, grouped by module — the shape, where this document gives the advice |
| [README.tests.md](README.tests.md) | the 721 scenarios this package ships, by what they prove |

Related packages: `@rljson/rljson` (trees), `@rljson/db` (database and
`Connector`), `@rljson/io` (sockets and storage), `@rljson/bs` (blobs),
`@rljson/server` (hub and client), `@rljson/mongo-agent` (the same idea for
documents).

## License

See [LICENSE](LICENSE).
