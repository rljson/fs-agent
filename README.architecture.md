<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Architecture

How `@rljson/fs-agent` keeps a folder the same on several machines, and why it
is built the way it is. For the API and the options, read
[README.public.md](README.public.md); for what is proven and how, read
[README.tests.md](README.tests.md).

## The design in one page

**There is no master copy.** Every machine watches its own folder and announces
what changed. A hub relays and never arbitrates — it holds no opinion about what
the folder should contain. A decision therefore has to be reachable, identically,
on every machine, from data every machine has.

**A folder is a tree, identified by its content.** The scanner produces an RLJSON
tree whose ref is a content hash. Two machines holding the same bytes compute the
same ref — which needs a canonical child order, and mtime *outside* the identity.

**A change is an entry in one shared chain, and the chain is the only order.**
An entry records what changed, what was removed, and which entries it was made
from. It is written only where the change was made and adopted — never
re-authored — by a receiver. **The filesystem is an event source only**: the
watcher says something happened; what it means is answered from the chain.

**An absence is not a deletion.** A tree lacks a path because its author removed
it or because its author never had it, and a content hash cannot tell them
apart. So a deletion is applied for exactly one reason: the head that lacks the
file **descends from this node's own** — its author held this state and chose not
to have the file. Everywhere else an absence reaches the folder only through a
three-way merge, where the common ancestor says what each side did.

**Two concurrent versions are ordered by the hub, not by clocks.** When two
machines change one file at once, both versions are kept, and the one that
reached the fleet later keeps the name — later by the hub's **stamp** on the
announcement that carried it. No machine's clock is compared to another's,
anywhere.

**What is transferred is a decision, not a payload.** A machine announces the
address of an entry. A receiver resolves it and fetches only the tree rows and
blobs it is missing, so its cost is proportional to what changed rather than to
how long it was away.

**Everything is bounded.** Every async step has a timeout, every growing
structure has a cap, and every walk has a budget — an unbounded step is a silent
hang and an unbounded list is tomorrow's memory ceiling.

## How to read this document

| if you want | read |
| --- | --- |
| why refs rather than payloads | [Pull-Based Reference Architecture](#pull-based-reference-architecture) |
| the rules that must not be broken | [Architectural Rules](#architectural-rules-do-not-violate) |
| a change's journey, end to end | [The sync, end to end](#the-sync-end-to-end) |
| what happens when two machines edit at once | [The conflict table](#the-conflict-table) |
| which version keeps the name, and why | [The stamp](#the-stamp) |
| why a big deletion is refused, and how a wiped machine is refilled | [Guards](#guards) |
| what a joining machine does | [Joining a network](#joining-a-network-planjoin) |
| who is recorded as having changed a file | [Authorship](#authorship-a-node-claims-only-what-it-changed) |
| the history itself | [Edit Chain](#edit-chain-srcfs-edit-chaints) |
| what a host application is told | [One channel for everything](#one-channel-for-everything-that-happened-srcfs-signalsts) |
| why a half-written file does not go out | [A Copy in Progress](#a-copy-in-progress-does-not-reach-the-wire-fsscanner-the-settle-rule) |
| which files are skipped | [Ignore Matching](#ignore-matching-srcfs-ignorets) |
| what 0.2.0 removed | [Removed in 0.2.0](#removed-in-020) |
| the signature of anything named here | [README.api.md](README.api.md) |

## Pull-Based Reference Architecture

### Why References Are Required

The @rljson/server architecture implements a **pull-based reference system** where data cannot be retrieved without a reference (hash). This is a fundamental design principle.

**Query Chain When Client B Pulls from Client A:**

```
Client B: db.get(route, { _hash: rootHash })
   ↓
Db constructs where clause: { _hash: rootHash }
   ↓
IoMulti.readRows(table, { _hash: rootHash })
   ↓
Priority 2: IoPeer.readRows({ table, where: { _hash: rootHash } })
   ↓
Socket emits: 'readRows' with { table, where: { _hash: rootHash } }
   ↓
Server's IoPeerBridge receives and forwards to Client A
   ↓
Client A's Io.readRows(table, { _hash: rootHash })
   ↓
Returns matching rows → Server → Client B
```

**Key Point**: `IoPeer.readRows()` requires a `where` clause with the reference:

```typescript
// From rljson-io/src/io-peer.ts
readRows(request: {
  table: string;
  where: { [column: string]: JsonValue | null };  // ← REQUIRED!
}): Promise<Rljson>
```

**You cannot query without knowing what to look for:**
- ❌ `io.readRows('sharedTree', {})` - No way to identify what to pull
- ✅ `io.readRows('sharedTree', { _hash: 'abc123' })` - Specific reference

**This is why Connector notifications are essential:**
1. Client A stores tree locally
2. Client A broadcasts root hash via Connector
3. Client B receives hash and uses it: `db.get(route, { _hash: receivedHash })`
4. Without the hash, Client B cannot pull the data

## Architectural Rules (DO NOT VIOLATE)

### CRITICAL: Socket-Only Communication Between Client and Server

**Clients MUST communicate with the server ONLY through socket connections. Direct access to server resources (Io, Bs, Db) is ABSOLUTELY FORBIDDEN.**

```typescript
// ✅ CORRECT: Client uses its own resources, communicates via socket
const server = new Server(route, serverIo, serverBs);
await server.init();

const socketA = new SocketMock();
socketA.connect();
await server.addSocket(socketA);

const localIoA = new IoMem();
await localIoA.init();
const localBsA = new BsMem();
const clientA = new Client(socketA, localIoA, localBsA);
await clientA.init();

// Use client's own Bs and Io - data syncs through socket automatically
const agentA = new FsAgent(folderA, clientA.bs);
const clientDbA = new Db(clientA.io);
await agentA.syncToDb(clientDbA, connectorA, 'sharedTree');
```

```typescript
// ❌ ABSOLUTELY FORBIDDEN: Client directly accessing server's Bs
const server = new Server(route, serverIo, serverBs);
const clientA = new Client(socketA, localIoA, localBsA);

// WRONG! This violates the client-server boundary
const agentA = new FsAgent(folderA, serverBs); // Using server's Bs directly

// WRONG! Sharing server's Io or Db
const clientDbA = new Db(serverIo); // Using server's Io
```

**Rationale**: The entire architecture is built on the Client-Server pattern where:

- Each client has its own local Io and Bs
- The Client class automatically syncs data with the server through the socket
- Direct access to server resources bypasses this architecture and breaks distributed scenarios
- This pattern is ESSENTIAL for the library to work in real-world distributed deployments

**This is the MOST IMPORTANT architectural rule. Violating it makes the entire implementation meaningless.**

### Connector and Server Route Matching (CRITICAL)

**Connector routes MUST match the Server route for message routing to work. The route MUST be based on the tree table name (treeKey), not arbitrary application names.**

The route represents the data structure path in the database - it's not an application identifier. When creating routes for tree synchronization:

1. The route must derive from the tree table name (treeKey)
2. The Server and all Connectors must use the exact same route
3. Using arbitrary names like 'myapp.sync' or 'fsagent.demo' breaks the data path

When creating Connectors, use the **same route** that was used to initialize the Server. The Server's multicast logic listens on `server.route.flat`, and Connectors send/receive on `connector.route.flat`. If these don't match, messages will never be routed between clients.

```typescript
// ✅ CORRECT: Connector routes match server route (based on tree table name)
const treeKey = 'sharedTree';
const route = Route.fromFlat(`/${treeKey}`);
const server = new Server(route, serverIo, serverBs);
await server.init();

// Both connectors use the SAME route as the server
const connectorA = new Connector(clientDbA, route, socketA);
const connectorB = new Connector(clientDbB, route, socketB);

// Now messages flow: A sends → Server multicasts → B receives
```

```typescript
// ❌ WRONG: Connector routes differ from server route
const treeKey = 'sharedTree';
const serverRoute = Route.fromFlat('myapp.sync'); // Wrong! Not based on treeKey
const server = new Server(serverRoute, serverIo, serverBs);

// WRONG! These routes don't match the server route
const connectorA = new Connector(clientDbA, Route.fromFlat('/dataSync'), socketA);
const connectorB = new Connector(clientDbB, Route.fromFlat('/dataSync'), socketB);

// Messages will NOT be routed! Server listens on '/sharedTree' but connectors use other routes
```

**Why This Matters:**
- The Server's `_multicastRefs()` method registers socket listeners on `this._route.flat`
- When Connector A calls `connector.send(ref)`, it emits on `connector.route.flat`
- If the routes don't match, the Server never receives the message
- Cross-client communication completely breaks

**Best Practice:** Pass the server route to client setup functions or use a shared constant.

### Self-Broadcast Behavior and Filtering

**Connectors receive their own messages via local socket echo. This is EXPECTED behavior.**

When a Connector sends a message via `connector.send(ref)`, two things happen:

1. **Local Socket Echo**: The connector's own `listen()` callback is immediately triggered because sockets emit to all listeners (standard EventEmitter behavior)
2. **Server Multicast**: The server receives the message and broadcasts it to OTHER clients (the sender is filtered out via `clientIdA !== clientIdB` in `@rljson/server`)

```typescript
// This is NORMAL behavior:
const connector = new Connector(clientDb, route, socket);

connector.listen((ref) => {
  console.log('Received ref:', ref);
});

connector.send('my-ref-123');
// Output: "Received ref: my-ref-123"  ← Local echo happens IMMEDIATELY
```

**Server-Side Filtering:**

`@rljson/server` filters out the sender when multicasting:

```typescript
// Inside Server._multicastRefs():
for (const [clientIdB, { socket: socketB }] of this._clients.entries()) {
  if (clientIdA !== clientIdB) {  // ← Sender is excluded from multicast
    const forwarded = Object.assign({}, payload, { __origin: clientIdA });
    socketB.emit(this._route.flat, forwarded);
  }
}
```

This means Client A will NOT receive its message back from the server, but it WILL receive it via local socket echo.

**What the agent does with its own echo:** nothing special. Its own head
arriving back is in sync by definition — `receive` authors local work first and
then finds the head it holds — and the Connector drops a payload carrying its
own origin before the agent sees it.

### Client-Server Pattern

**ALWAYS use `Server` and `Client` classes from `@rljson/server` directly.**

```typescript
// ✅ CORRECT: Let Server and Client handle internal BsMulti/BsPeer setup
const server = new Server(route, serverIo, serverBs);
await server.init();

const socket = new SocketMock();
socket.connect();
await server.addSocket(socket);

const localIo = new IoMem();
await localIo.init();
const localBs = new BsMem();

const client = new Client(socket, localIo, localBs);
await client.init();

// Use client.bs for all operations
const agent = new FsAgent(folderPath, client.bs);
```

```typescript
// ❌ WRONG: Never manually construct BsMulti with BsPeer
// This works around library issues instead of fixing them at the source
const localBs = new BsMem();
const peerBs = new BsPeer(socket);
const clientBs = new BsMulti([
  { bs: localBs, priority: 1, read: true, write: true },
  { bs: peerBs, priority: 2, read: true, write: true },
]);
const client = new Client(socket, localIo, clientBs);
```

**Rationale**: If the `Server` or `Client` classes don't work correctly for our use case, we must fix the issue in `@rljson/server` package, not work around it in tests or application code. Tests should reflect real-world usage patterns, not paper over library deficiencies.

### Database Access Pattern

**ALWAYS create client-specific `Db` instances using `client.io`, never share server's `Db`.**

```typescript
// ✅ CORRECT: Each client creates its own Db with client.io
const server = new Server(route, serverIo, serverBs);
await server.init();

// Server creates table structure (one-time setup)
const serverDb = new Db(serverIo);
await serverDb.core.createTableWithInsertHistory(treeCfg);

// Each client gets its own Db
const clientA = new Client(socketA, localIoA, localBsA);
await clientA.init();
const clientDbA = new Db(clientA.io); // Uses client.io, not serverIo

const clientB = new Client(socketB, localIoB, localBsB);
await clientB.init();
const clientDbB = new Db(clientB.io); // Uses client.io, not serverIo

// Use client-specific Db instances
await agentA.storeInDb(clientDbA, 'sharedTree');
await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
```

```typescript
// ❌ WRONG: Sharing server's Db directly with clients
const serverDb = new Db(serverIo);
await serverDb.core.createTableWithInsertHistory(treeCfg);

// Both clients use the same Db - bypasses Client/Server architecture
await agentA.storeInDb(serverDb, 'sharedTree');
await agentB.loadFromDb(serverDb, 'sharedTree', rootRef);
```

**Rationale**: The `Client` class creates an internal `IoMulti` that combines local `Io` with a server peer. By using `client.io`, database operations automatically go through this multi-layer structure, maintaining proper client-server separation. Sharing the server's `Db` directly violates this architecture and bypasses the Client/Server pattern entirely.

## The sync, end to end

### What travels

One thing: the **head** of the edit chain — the ref of an `EditHistory` row —
and, from a hub that stamps, the head's **stamp**. A node announces its head on
the route whenever it moves; the hub relays it to every other client, stamps it
on the way, and says its latest head again on the bootstrap a connecting client
gets and on its state beacon. Nothing else is on the wire for the fs route: no
tree refs, no file lists, no prefixes.

A receiver resolves the head to a row, the row to a tree, the tree to the rows
and blobs it is missing — by hash, through the peers ([Pull-Based
Reference Architecture](#pull-based-reference-architecture)).

### Sending: a change becomes an entry

The watcher says *something happened*; nothing more. After a debounce the agent
takes the lock, **scans afresh** (`FsScanner.scanFresh` — a pass that started
after the request, never the watcher's last pass, which can have run while an
apply was still writing) and asks `planAuthoring` (`fs-send.ts`) what the folder
did since its own head:

- **unchanged** — nothing to author;
- **changed** — the paths written and the paths removed;
- **refused** — the sender's honesty guard ([Guards](#guards)).

A removal is authored only once the path is really gone from disk: a scan can
lag the disk, and authoring the absence of a file the agent wrote a moment ago
would delete it everywhere. Then the tree is stored, an entry is appended with
`previous: [ownHead]`, the head moves, and it is announced.

The first state of a folder with no history is its **root**: `previous: []`,
nothing stated, and a `timeId` derived from the tree (`0:<treeRef>`) — so two
nodes that start from the same content write the *same* root, and no fleet ever
begins as one lineage per node. A folder with files and no history first waits
to be told ([Joining a network](#joining-a-network-planjoin)).

### Receiving: what a node does with a head

`receive` (`fs-receive.ts`) is the whole decision:

1. No own head yet → it is a join, not a receive.
2. **Author local work first.** Anything the folder holds beyond the own head is
   authored before the arrived head is judged, so a head that never saw that
   work cannot overwrite it — it turns what would have been `behind` into a
   `fork`.
3. Relate the two heads (`FsEditChain.relate`) and act:

| relation | meaning | action |
| --- | --- | --- |
| `same` | the one head | nothing |
| `behind` | theirs descends from ours | **apply** their tree — write what differs, delete what it lacks — and **adopt** their head |
| `ahead` | ours descends from theirs | announce ours |
| `fork`, same tree | one state under two names | every node keeps the **smaller** ref; no merge entry |
| `fork` | both sides have work | **merge** against the base ([The conflict table](#the-conflict-table)) |
| `incomplete` | an entry cannot be read and no descent was found | nothing; `repair/blocked`, retried on the next beacon |

**Deleting on `behind` is correct by construction.** Whoever made that head held
this node's state and chose not to have the file. An absence in a tree that does
*not* descend from ours is never a deletion: it reaches the folder only through
a merge, where the base says what each side did.

An apply touches only what changed between the two heads, and only while the
folder still holds the own head's version of it. A path the user changed since
stops the apply; the work is authored, and the head is received again — as a
fork, which merges.

### Healing: the hub says its head again

There is no separate repair mechanism. A lost announcement is healed by the next
time the hub says its head — the **state beacon** (every 30 s in the host client)
and the **bootstrap** on connect. A node that hears the hub's head receives it
like any announcement, and the decision above is the repair: a node that is
behind applies, a node that is ahead announces, a fork merges.
`antiEntropyStatus` reports what the last head from the hub made this node do.

### One lock

Authoring and receiving take the same lock and never interleave. An apply is
bounded by `timeouts.restore`: a blob nobody serves would otherwise hold the lock
that authoring needs too, and the node would go silent about its own work. A
timed-out apply is not adopted; the lock is released, and the head is tried again
the next time the hub says it.

## The conflict table

A fork is merged path by path against the **base** — the common ancestor
`relate` names: one that no other common ancestor descends from, the smallest
ref when there are several, so every node merging the same two heads merges
against the same base. `merge3` (`fs-merge.ts`) decides each path; nothing
compares two machines' clocks, and no version is ever dropped:

| row | situation | outcome | signal |
| --- | --- | --- | --- |
| C1 | one side changed the path | that side's value | — |
| C2 | different paths, or the same change on both sides | both kept | — |
| C3 | both changed one file differently | **both kept**: the version whose introducing entry has the higher stamp keeps the name, the other becomes `<name> (conflicted copy <hub>-<n>)<ext>`, named by its own stamp | `conflict/arbitrary` (review) |
| C4 | one side deleted, the other edited | **the edit stays**; the deletion is reported, not applied | `conflict/arbitrary` (review) |
| C5 | a directory on one side, a file on the other | **both kept**: the directory keeps the path, the file becomes a conflicted copy | `collision/type` (**required**) |
| C6 | the history cannot answer | nothing | `repair/blocked` (review) |

Only a **concurrent** change is a collision: one side turning a directory into a
file while the other left the directory and everything in it alone is an
ordinary C1 edit.

**The merge entry** names both heads (`previous`, sorted) and a `timeId` derived
from them and the merged tree, so two nodes merging the same two heads write the
*same* entry, and concurrent merges converge rather than fork again. It names as
changed every path whose merged value differs from either side — which makes it
the nearest entry to name such a path for `lastEditOf`.

Every node that merges says so, one signal per contested path; a node that
applies somebody else's merge applies it like any `behind` head.

## The stamp

### Who stamps, and how a node learns its own

A hub configured with `stamp: { domain, hub }` (`@rljson/server`) gives every
ref it relays a `RefStamp` — `(domain, epoch, hub, n)`, compared in that order —
on the payload, in the ref log and on the bootstrap. The hub keeps no stamp
table: it persists only its epoch (`stateFile`), takes the next one on every
start — above any epoch it has relayed, and above `minEpoch`, the highest a node
heard as a client before it took office (the agent records it as `stampEpochs`
in `.fsagent-state.json`) — and counts `n` within it. **Fan-out
skips the sender**, so the hub tells the author its stamp on `${route}:stamp`,
and again when a re-announcement is held back as a duplicate.

### A version's stamp

**A version's stamp is the stamp of the announcement that first carried it to
the fleet** (`FsStamps`, `fs-stamps.ts`). A stamped head arrives; the entries
below it that no earlier announcement carried — the edits a node made offline,
say — reached the fleet with it, so they get it too. The walk stops at the first
entry that already has one; an entry keeps the first stamp it was given. Kept in
the route's own database (`${treeKey}EditStamps`), because a conflict can be
about a version introduced long ago.

C3 compares the stamps of the two versions' **introducing entries**
(`lastEditOf`), which makes the verdict a function of the shared history and of
nothing else: every node that merges the same two versions picks the same name.

### A walk that stops short

A walk can stop at a row it cannot read yet, or at its budget. The entry it
stopped at stays **open** — stamped, its ancestors not yet — and is persisted as
such. A merge that lacks a stamp resumes the open walks, earliest stamp first,
so an ancestor two walks reach still gets the earlier announcement's stamp. Not
on every announcement: an unreadable row can cost a blocked read each time it is
asked for.

### Waiting for a stamp

C3 decides only when both stamps are known. Otherwise the merge is **deferred**
and nothing changes. A node whose own version lacks a stamp has a head the hub
never stamped — authored while it was cut off — so it announces its head again:
at once, then less and less often (`STAMP_ASK_MIN_MS` doubling to
`STAMP_ASK_MAX_MS`). The first wait is routine; a second wait for the same merge
is signalled `repair/blocked`, because then the hub does not stamp.

### What the stamp cannot know

Two limits of deriving stamps from payloads alone. Neither loses data, and both
converge:

- **A node that missed an announcement derives a later stamp** for the entries
  it carried, from the first announcement it did hear. Its C3 verdict can then
  differ from a peer's; the two merges fork, and merging those — which is
  deterministic — converges with one redundant conflicted copy.
- **A merge entry is the introducer of what it took from one side**, so a
  version that passed through a merge carries the merge's stamp. In a three-way
  race the name can go to a version whose original edit reached the fleet
  earlier.

## Guards

### At the sender

`planAuthoring` refuses an edit when files **disappeared** beyond the floors —
more than `MASS_DELETE_MIN_FILES` (100) **and** more than `MASS_DELETE_MAX_RATIO`
(0.3) of the folder, or all but `ALL_GONE_MIN_FILES` (10) of a larger one. A file
disappeared when it is gone, its content is nowhere else in the folder, and the
watcher did not see it go. That is the shape of a failed mount or a wiped drive,
never of a person: nothing is authored, the folder keeps its head, and
`deletion/refused` (**required**) says why. A deletion the watcher saw, a folder
renamed while the agent was down, and a few files deleted while it was down are
all ordinary edits.

### At the receiver

An apply that would **lose** more than the same floors — content the target tree
holds nowhere else — keeps those files. Everything else applies, the head is
adopted, and the kept files are authored again on top of it. That edit is what
refills a machine that lost its folder: the fleet does not follow it down, and
it does not stay empty either. `deletion/refused` (**required**) says what was
kept.

### An apply that stops partway

A locked file or an unreachable blob stops an apply after it wrote some files.
The head is not adopted. What did land is recorded, path → blob, until the own
head moves: authoring does not claim it — it is somebody else's work — and the
next apply recognises it instead of mistaking it for a local edit. A locked
file's old bytes are never claimed either, since they are what the own head
already says; so every merge keeps the peer's version of it.

## Joining a network (`planJoin`)

A folder with files and no history does not speak first: it waits up to
`joinWaitMs` (default `DEFAULT_JOIN_WAIT_MS`) for the network's head. With a head
in hand, `planJoin` puts every path in **at most one** of four lists, deciding
each against the chain and never against the disk:

| list | the path is | action |
| --- | --- | --- |
| `write` | in the head, not on disk | write it |
| `announce` | on disk, never named anywhere in the history | new local work — authored on top of the head |
| `recover` | on disk, and REMOVED by the history | a stale copy: moved into `.fsagent-recovered/`, nothing said |
| `conflict` | live on both sides, different bytes | the head's bytes win; the local copy is kept aside as `<name> (conflicted copy <UTC time> local)<ext>` |

`recover` is what makes a restored backup safe: nothing is resurrected and
nothing is destroyed. If no head arrives within the wait, the folder is the
origin of its own history. An empty head is a fact, not an absence: a fleet that
agreed the folder is empty states exactly that.

## Authorship: a node claims only what it changed

**An edit exists only where the change was made.** A receiver adopts and never
authors; otherwise a machine catching up records itself as the author of
somebody else's file, and then — through `lastEditOf` — carries the name in a
conflict it never took part in. What keeps it true:

1. A `behind` head is **adopted**, never re-authored.
2. Local work is authored **before** a head is judged, against the own head.
3. Authoring scans **afresh** under the lock, so a pass taken while an apply was
   writing never reads as a local edit.
4. What a cut-short apply wrote is not claimed.
5. A merge entry is derived from both heads, so it is the same entry wherever it
   is written.

**Tested by** `fs-agent-authorship.spec.ts`, `fs-agent-no-laundering.spec.ts`,
`fs-agent-own-echo.spec.ts` and `fs-agent-locked-file.spec.ts`.

## Edit Chain (`src/fs-edit-chain.ts`)

Three tables per tree key — `${treeKey}EditHistory`, `${treeKey}MultiEdits`,
`${treeKey}Edits` — written by hand rather than through `MultiEditManager`,
because a merge entry has two parents, which is the one shape it refuses. An
entry records the tree ref, the paths it changed and removed (sorted, so the same
change writes the same row on every node), `previous`, and a `timeId`. The agent
says what every entry is made from: a table several nodes write has no tip of
its own, and the agent keeps its head in `.fsagent-state.json`.

| method | answers |
| --- | --- |
| `append` | writes one entry |
| `entry` | reads one back; `undefined` when no peer can resolve it |
| `relate` | how two heads stand, and a fork's base |
| `lastEditOf` | the nearest entry that changed or removed a path — the introducer C3 asks about |
| `collectRemovals` | the net removals and changes between a head and a state this node knows; what a join uses to tell a stale copy from new work |

**A hole and a budget are different truncations.** A walk that meets an entry it
cannot read answers `incomplete`: the ref it looks for may be inside the part it
cannot reach. A walk that exhausts `DEFAULT_MAX_WALK` with everything readable
answers `fork` — less precise than the truth, never destructive. Conflating them
once made every node 500 pushes into its own history stop healing, silently.

`timeId` orders nothing in a decision. It breaks a tie between two entries at
the same distance in `lastEditOf`, and that is all.

## One folder, one ref — the canonical child order

A tree ref is a function of the folder's content: the scanner emits children in
a canonical (sorted) order, and mtime is outside the identity. Two machines
holding byte-identical content derive the same ref — which is what lets a fork
of one state converge on the smaller ref without a merge, and what makes the
tree ref comparable across machines at all.

**Tested by** `test/fs-ref-vs-content.spec.ts`: two scans of equivalent content
agree on the ref and on the content map the apply and the merge work from.

## One channel for everything that happened (`src/fs-signals.ts`)

Everything that touches a user's folder is reported here, and only here: a
conflict a merge settled, a refused deletion, a joining machine moving files
aside, a path the filesystem rejected, a divergence nothing could decide. A host
cannot grep a log on a machine it is not running on.

Every signal says **what** happened and to **which paths**, **who decided**
(`chain`, `stamp` or `guard`), and whether a **person** has to act:

| `action` | meaning |
| --- | --- |
| `none` | resolved; nothing to do |
| `review` | resolved, but somebody may want to know — a kept copy, a name decided by the order the fleet heard two versions |
| `required` | **not** resolved, or a person must decide — a refused deletion, a directory/file collision, a path this filesystem will never accept |

`SIGNAL_LOG_MAX` (200) signals are kept; the per-kind counters are not bounded,
so a folder that produced two thousand refusals still says so. One signal names
at most `SIGNAL_PATHS_MAX` (20) paths and counts the rest. `addOnce` keys are
bounded too (`SIGNAL_ONCE_MAX`); `repair/blocked` is keyed on the **pair** of
heads it is between. The log is persisted to `SIGNAL_LOG_FILE`
(`.fsagent-signals.json`) inside the synced folder and read back lazily, without
firing subscribers. `.sync-errors.log` stays the record of internal failures —
exceptions, which are not signals.

## What grows, and what bounds it

| structure | growth | bound |
| --- | --- | --- |
| the chain | one entry per authored edit — the debounce coalesces a burst | walks are bounded by `DEFAULT_MAX_WALK` |
| the stamps (`${treeKey}EditStamps`) | one row per entry heard, two while its walk is open | as the chain |
| the signal log | one per signal | `SIGNAL_LOG_MAX`, `SIGNAL_ONCE_MAX` |
| what a cut-short apply wrote | the paths of one apply | cleared when the own head moves |
| what restore wrote, per path | one per file written | `RESTORED_BLOB_MEMORY_MAX` |
| receiving a head again after the folder moved | per own head | `RECEIVE_AGAIN_MAX` |

## A Copy in Progress Does Not Reach the Wire (`FsScanner`, the settle rule)

A watcher fires while a large file is still being written, and a scan that reads
it then publishes a truncated file that every peer accepts as the whole thing.
The scanner therefore defers a file rather than reading it, and the deferral is a
promise to come back: `_unsettledDuringScan` reuses the previous node for that
path and arms a follow-up scan, so a deferred file is late and never lost.

Three signals defer, and the file waits if any of them fires:

| signal | what it catches |
| --- | --- |
| `mtime > scanStartedAt` | the file changed **while this scan ran** — free, no window, cannot race |
| `growing` — the size moved since the last scan | a writer whose gaps are wider than one read |
| `firstSight` — never read, and either touched inside `settleMs` or seen for the first time | a copy already in progress when the scanner met it |

**`firstSight` is two conditions on purpose, and neither replaces the other.**
"touched inside `settleMs`" is strong while a copy is actively writing, because
its timestamp keeps moving; its hole is a writer that stalls past the window and
is then seen "cold". "Seen for the first time" closes that hole with no clock
term at all, and terminates through `growing` rather than through a window — the
first sight records the size, so the next scan reads the file once the size has
stopped moving. Keeping only the clock-free half was measured and is worse: an
active copy is then protected by the size comparison alone, and one stalled
`fsync` between two scans gets through.

**A future timestamp is not evidence of anything.** Both clock-based halves read
a timestamp ahead of now as "touched just now" — `mtime > scanStartedAt` is
permanently true and `now - mtime` is negative — so a file dated one day ahead
was invisible to the tree for good. An archive carries whatever it likes, a file
copied from a machine running fast arrives dated ahead, and a BIOS clock can be
years out; none of those is a file being written. `inTheFuture` excludes all
three.

**Only while watching.** A one-shot `extract()` or `storeInDb()` has no
follow-up scan, so deferring there does not delay a file, it drops one — and
`extract()` is public API. And nothing the agent decides reads a pass that may
have run while it was writing: authoring scans afresh under the lock
(`scanFresh`), after any apply has finished.

**Never the agent's own writes.** What the agent writes whole — a restore, a
merge's conflicted copy — it tells the scanner (`noteWrite`), and the next scan
takes the file as written. Without that, a write in the second half of the
millisecond a scan starts in reads as "changed during this scan" — Node rounds
an mtime to the nearest millisecond, `Date.now()` truncates — so the scan
reuses the version before it, and a receiver authors that older version as an
edit, which reverts the writer's own copy everywhere.

What no rule over `stat` can decide is a writer that pauses for a long time, and
`README.public.md` → "Known constraints" says what that costs.

**Tested by** `test/fs-clock-skew.spec.ts` (6) for the clock half and
`test/fs-slow-copy.spec.ts` (3) for the deferral itself.

## Ignore Matching (`src/fs-ignore.ts`)

Which files the sync never sees. Glob syntax — `*`, `?`, `**`, folders with
`/`, anchored at the root, `!` exceptions with last-match-wins,
case-insensitive, `/` equivalent to `\`.

The rule before was `name === pattern || name.startsWith(pattern)`, which
cannot express an extension: `*.exe` matched nothing, because no file is called
`*.exe` and none begins with it.

**The compatibility rule is load-bearing.** A pattern with none of `*`, `?`,
`/` or `\`, not starting with `!` and not ending with `/` keeps its old
prefix meaning. That is not courtesy to old configuration files: `~$` and
`.~lock.` are the Office and LibreOffice lock-file prefixes, and
`ATOMIC_TMP_PREFIX` (`.fsagent-tmp-`) is how the agent hides its own
in-progress writes from its own watcher. Read as globs all three would match
only a file named exactly that, every atomic write would return as a change
event, and the debounce that batches a push would be reset before it could
fire — a defect this package has already had.

The matcher is compiled once per agent, because a scan of a real catalogue asks
this question once per file.

**Tested by** `test/fs-ignore.spec.ts` (28), whose first block is one case per
pattern that appears in the shipped configuration or in the agent's own list —
that being the half which can break a running fleet.

## Removed in 0.2.0

No compatibility with 0.1.x: every mechanism that existed to tolerate, migrate
from or diagnose it is gone, with its tests. Bucket sync and the manifest; the
tombstone log; the stated-removal gate (`planRemovals`) and the per-path edit
times; the no-chain heuristics and the anti-entropy module; the `~H~` prefix and
bare tree refs on the wire; `onConflict`, `refusedDeletions` and the conflict
log; the `resolveConflicts` option (the merge always runs); the old resolver and
its clock- and hash-based winners; `classify` and the tree-ref lookups; the
`conflict/merged`, `conflict/overwritten` and `config/degraded` signals.

## Known Constraints

### macOS Finder Paste and Rename

Bidirectional sync relies on Node.js `fs.watch` (FSEvents on macOS). This works
reliably for programmatic file operations (Node.js `writeFile`/`copyFile`,
terminal commands, editor saves) but **not** for macOS Finder's paste-and-rename
workflow.

Finder generates rapid, non-atomic, multi-step event sequences (create temp →
write → rename → delete temp) that FSEvents may coalesce, reorder, or split
unpredictably. This causes intermediate filesystem states to be scanned and
broadcast before the operation completes, leading to sync conflicts.

**This is a known limitation and is not supported.** Use programmatic operations
or terminal commands instead of Finder drag-and-drop or paste-and-rename for
files in synced folders.
