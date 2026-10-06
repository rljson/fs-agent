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
what changed. A hub relays and never arbitrates — it holds no opinion about
what the folder should contain. That is the constraint everything else follows
from: a decision has to be reachable, identically, on every machine, from data
every machine has.

**A folder is a tree, identified by its content.** The scanner produces an
RLJSON tree whose ref is a content hash. Two machines holding the same bytes
compute the same ref — which requires a canonical child order and requires
mtime to be *outside* the identity, because mtimes do not survive a restore and
on Windows regularly do not.

**A change is an edit, in one shared chain.** The chain records what changed,
what was removed, when, and which state it followed. It is identical on every
machine, written only where the change was made, and adopted — never re-authored
— by a receiver. **The filesystem is an event source only.** The watcher says
something happened; what it means is answered from the chain.

**An absence is not a deletion.** This is the whole reason the chain exists. A
tree lacks a path because the sender removed it, or because the sender never
had it, and a content hash cannot distinguish them. Four separate rules were
built to infer it and all four were withdrawn, costing 155 files of measured
drift across four machines and a file deleted from 3 642 that came back moments
later. A removal is therefore **stated**, by the machine that performed it, and
nothing is pruned on a peer's authority.

**What is transferred is a decision, not a payload.** A machine announces the
ADDRESS OF AN EDIT — not its folder, not a file list, not a tree. A receiver
resolves the address, reads the Edit, and fetches only the tree rows and blobs
it is missing. That makes a receiver's cost proportional to what actually
changed rather than to how long it was away: twenty saves of one document are
twenty small row reads and one blob.

**Everything is bounded.** Every async step has a timeout, every growing
structure has a cap, and every walk has a budget — because an unbounded step is
a silent hang and an unbounded list is tomorrow's memory ceiling.

## How to read this document

| if you want | read |
| --- | --- |
| why refs rather than payloads | [Pull-Based Reference Architecture](#pull-based-reference-architecture) |
| the rules that must not be broken | [Architectural Rules](#architectural-rules-do-not-violate) |
| a change's journey, end to end | [Data Synchronization Flow](#data-synchronization-flow-how-it-works) |
| why a node does not echo itself | [Bounce-Back Prevention](#bounce-back-prevention) |
| how a lost message heals | [Anti-Entropy](#anti-entropy-srcfs-anti-entropyts) |
| why two folders agree on one ref | [One Folder, One Ref](#one-folder-one-ref--the-canonical-child-order) |
| how a divergence is repaired without replacing a folder | [Additive Reconciliation](#additive-reconciliation-fs-manifestts--fs-bucket-syncts) |
| why a node sometimes gives no verdict about itself | [A Verdict Is Only About This Folder](#a-verdict-is-only-about-this-folder-while-the-head-names-it) |
| how a deletion travels | [A Delete Travels as a Fact](#a-delete-travels-as-a-fact-collectremovals--planremovals) |
| why a big deletion is refused, and how to find out | [Refused Deletions Are Reported](#refused-deletions-are-reported-not-only-logged-fsagentrefuseddeletions) |
| what a restart remembers | [Tombstone Log](#tombstone-log-_pendingdeletes--fsagent-statejson) |
| why an old deletion cannot beat a newer write | [Ordering a Tombstone](#ordering-a-tombstone-against-the-write-it-supersedes-manifestentryeditedat) |
| the history itself | [Edit Chain](#edit-chain-srcfs-edit-chaints) |
| what a joining machine does | [Joining a Network](#joining-a-network-planjoin) |
| who is recorded as having changed a file | [Authorship](#authorship-a-node-claims-only-what-it-changed) |
| which files are skipped | [Ignore Matching](#ignore-matching-srcfs-ignorets) |
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

**Application-Level Self-Filtering:**

Because of local socket echo, **application code MUST filter out its own broadcasts** to prevent infinite loops. This is done in FsAgent using the `_lastSentRef` property:

```typescript
// In FsAgent:
private _lastSentRef?: string;

// When sending:
this._lastSentRef = ref;
connector.send(ref);

// When receiving:
if (treeRef === this._lastSentRef) {
  console.log('[syncFromDb] Skipping self-broadcast');
  return; // Don't process own message
}
```

**Why This Architecture:**
- Socket echo is unavoidable with EventEmitter-based implementations (SocketMock, real sockets)
- Server-side filtering prevents network round-trips but can't prevent local echo
- Application-level filtering is defensive programming and works regardless of socket implementation
- This pattern is necessary for all real-time sync systems

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

## Data Synchronization Flow (How It Works)

**Read this section before any other.** It is the mechanism, and the rest of
the document is the rules that protect it.

### What travels, and what does not

Three things exist, and only one of them is broadcast:

| | what it is | how it moves |
| --- | --- | --- |
| **blob** | the bytes of one file | pulled by id, on demand |
| **tree** | `path → blobId` for a whole folder, as rows | pulled by ref, on demand |
| **Edit** | what changed, what was removed, which Edits it came from, and when | **its address is broadcast** |

An announcement is a short string — `~H~<editHistoryRef>` — plus the sender's
identity and a sequence number. No file content, no path list, no tree. A
receiver resolves the address, reads the Edit, and only then fetches the tree
and the blobs it is missing.

So a message is never "here is my folder". It is **"here is the decision I
made"**, and the folder is what you get by applying it.

### An Edit

```ts
interface FsChainEntry {
  head: string;        // this Edit's identity — what gets announced
  timeId: string;      // fleet-wide order, minted once by its author
  treeRef: string;     // the state the folder ended up at
  previous: string[];  // the Edits this one was made from
  changed: string[];   // paths added OR modified
  removed: string[];   // paths removed — stated, never inferred
}
```

`changed` does not distinguish an addition from a modification, because both
mean the same thing: the bytes at this path are now whatever the tree says.
`removed` is separate because only a removal needs an author — **an absence is
not a deletion**, and a node that merely lacks a file is behind, not
authoritative.

Two links matter. `previous` joins **Edit to Edit** — that is the chain.
`treeRef` joins **Edit to state** — which is how one Edit names a complete
folder rather than only a delta.

### Sending: a local change becomes an Edit

`syncToDb` watches the folder. On a change, in this order:

```
 1  scanner event                        FsScanner.onChange
 2  debounce 300 ms                      coalesce a burst into one push
 3  content key of the scanned tree      _contentKeyFromTree
 4  unchanged?  ──► RETURN               nothing is sent
 5  which state do we descend from       _ancestryPrevious
 6  write blobs + tree rows              storeFsTree({ skipNotification: true })
 7  remember + persist the new ref       _currentRef, .fsagent-state.json
 8  already announced this ref? ─► RETURN
 9  APPEND THE EDIT                      _recordChainEntry  ◄── before the wire
10  announce its head                    _sendRef → `~H~<head>`
```

Three steps are easy to get wrong and are load-bearing:

- **step 4 compares CONTENT, not refs.** A folder that returns to a state it
  held before re-derives that state's exact ref, and a ref-based check would
  call the return an echo. Deleting a file created in the same session is
  exactly that shape — A → B → A — and under a ref check the deletion reached
  no peer at all.
- **step 6 passes `skipNotification: true`.** `Connector` observes local
  inserts and broadcasts the raw `<table>Ref` — a bare tree ref. Writing the
  tree *is* an announcement unless it is suppressed, and an unsuppressed write
  announces a state before the Edit for it exists.
- **step 9 precedes step 10.** The head is the Edit's identity; announcing
  before appending has nothing to announce, and `_announceAs` would fall back
  to the bare ref.

### Receiving: an Edit becomes a folder

`syncFromDb` registers one callback with `connector.listen`. What arrives is an
address, so the first job is to find out what it names:

```
    announcement arrives
            │
   ┌────────┴─────────┐
   │ bucket envelope? │ ~BQ~ ~BR~ ~BG~ ~BE~  ──►  FsBucketSync.receive, return
   └────────┬─────────┘      (a control protocol; it names no tree)
            │
   ┌────────┴──────────┐
   │ starts with ~H~ ? │
   └───┬───────────┬───┘
      no          yes
       │           │
       │     _resolveAnnouncement ──► { treeRef, entry }   (bounded read)
       │           │                        │
       │           │                 park the head         _rememberAnnouncedHead
       │           │                 collect its removals  _collectIncomingRemovals
       │           │
  schedule(ref) ◄──┘        debounced, so N announcements cost one apply
       │
  + ask the chain anyway    _collectRemovalsForTreeRef
```

Then the apply, with the watcher paused for its whole duration:

```
 1  pause the watcher                    so the restore is not read as user edits
 2  apply the sender's STATED removals   _applyIncomingRemovals
 3  fetch the tree by ref                _fetchTreeFromDb   (may reach a peer)
 4  same content already? ─► skip        _treesHaveEquivalentContent
 5  ASK THE CHAIN                        _classifyAnnouncedRef
       ahead     ──► ignore it: we have left that state
       fork      ──► merge               _resolveConflictInline
       behind    ──► restore             additive; prune only under the rules
       incomplete──► do nothing destructive
 6  re-scan, and compare what we derived with what we applied
 7  adopt the sender's head, or park it as a second parent
 8  resume the watcher
```

Step 5 is the whole design. Every other branch in this file exists because the
chain could not answer — and `incomplete` is a real answer, not a failure: a
node whose own head does not name its own folder is not entitled to a verdict
about anybody else's.

### Healing: when no announcement arrives

An announcement can be lost, and nothing above notices — the mechanism is
driven by messages. So `FsAntiEntropy` reads the hub's beacon **directly off
the socket**, not through `listen`, because the connector correctly drops a
heartbeat it has already delivered and that is exactly the repeat that would
reveal a disagreement.

```
hub beacon ──► _reachabilityOf ──► observe({ ref, predecessors, reachability })
                                        │
                              antiEntropyDecision(hub, view, attempt)
                                        │
          in-sync · blocked  ──► nothing
          pull · push · merge ──► repair
                                        │
                        bucket round first, if enabled  ──► additive, cannot destroy
                        otherwise: push = re-announce where we are
                                   pull/merge = schedule the hub's state
```

A node that is behind also **asks** rather than only listening
(`ANTI_ENTROPY_ASK_MS`): it reads the fleet's newest entry locally and offers it
to the anti-entropy as though it had been announced — which is what it would
have been, had the message not been lost.

### Where the hub fits

The hub relays and never arbitrates. `Server._multicastRefs` forwards each ref
to every client except the sender, tagging it with `__origin` so a relay cannot
loop, and `_latestRef` keeps the last ref it relayed — prefix intact — so a
late joiner can be bootstrapped with it.

It stores no folder. Its `Io` and `Bs` exist for its own needs, and a client
that needs a tree or a blob the hub happens to hold reads it the same way it
reads a peer's.

### Key Architectural Components

**`IoMulti` (inside `client.io`)** combines this machine's local `Io` with an
`IoPeer` to the hub. A read checks local first, then asks the peer, and caches
what it gets. Reads are bounded per source and per priority group: a source that
is open but never answers is set aside rather than waited on, because "nobody
has this row" is the common case for an unreplicated ref, not the rare one.

**`BsMulti` (inside `client.bs`)** is the same for blobs. **Hand an agent a bare
`BsMem` and it can store its own blobs and never fetch anybody else's** — every
restore then fails on its first file and nothing propagates, which looks exactly
like a sync defect. Use `client.bs`.

**`Connector`** carries the announcement: `~H~<editHistoryRef>` plus the
sender's identity, a sequence number, and the predecessor TREE refs. It
deduplicates by ref on both sides, which is why `_sendRef` clears a ref the
folder has legitimately returned to.

It also observes local inserts and broadcasts the raw `<table>Ref` of anything
written to the route's root table. That is a **bare tree ref** — an
announcement the chain cannot be asked about — so every write this agent makes
passes `skipNotification: true` and announces for itself.

**`Server`** relays and never arbitrates. `_multicastRefs` forwards each ref to
every client but the sender, tagged with `__origin` so a relay cannot loop, and
`_latestRef` keeps the last ref relayed — prefix intact — to bootstrap a late
joiner. It stores no folder; its own `Io` and `Bs` are for its own needs.

### Why it is built this way

- **no master copy** — every machine owns its folder, and a decision must be
  reachable identically on all of them from data they all have
- **a decision is cheap to send** — an address is a short string; folders are
  not
- **cost follows change, not absence** — coming back after a week costs what
  changed, not what you missed
- **it works across a network** — real sockets, real partitions, not an
  in-process mock

**A client must never read the server's `Io` or `Bs` directly.** It bypasses
`IoMulti`/`BsMulti` entirely, so the code appears to work in one process and
cannot work between machines — and the failure arrives later, as a sync defect
rather than as a wiring error.

## Bounce-Back Prevention

Bidirectional sync creates a potential infinite loop:

```
Client A writes file → syncToDb stores tree → broadcasts ref →
Client B receives ref → syncFromDb restores file → fs watcher fires →
syncToDb stores tree → broadcasts ref → Client A receives ref → ...
```

FsAgent uses three layers of deduplication to break the loop:

1. **Ref-level dedup**: After `syncToDb` stores a tree, it compares the
   resulting ref against `_lastSentRef`. If identical, no broadcast occurs.

2. **Content-key dedup**: Even when refs differ (e.g. different mtimes produce
   different hashes), `syncToDb` computes a content key from file paths +
   blobIds. If the content key matches `_lastSentContentKey`, the broadcast
   is skipped.

3. **Content comparison before restore**: In `syncFromDb`, before restoring
   an incoming tree, FsAgent compares its file content map against the current
   filesystem. If they are equivalent, the restore is skipped entirely,
   preventing the filesystem watcher from firing.

Additionally, all sync callbacks are **debounced** (default 300ms) to coalesce
rapid filesystem events (e.g. multi-file saves, editor autosave) into a single
sync operation.

## Anti-Entropy (`src/fs-anti-entropy.ts`)

Nothing in the message path ever asks whether a message arrived. A lost push is
not resent until the folder changes again; a lost forward is repeated only by
the hub's heartbeat, which the connector drops as a duplicate or delivers as
"not newest". The anti-entropy closes that gap.

**Trigger.** `syncFromDb` subscribes to two events on the connector's socket
directly — `${route}:bootstrap` and the server's state beacon
`stateBeaconEvent(route)` = `${route}:state` — not through `listen`, whose
dedup is exactly what hides the repeat that would show a disagreement. Each
announcement (`r`, `o`, `p`) goes to `FsAntiEntropy.observe()`.

The beacon is the signal to run on. The connector does not listen to it, so it
enters no apply path; the bootstrap heartbeat does, which is why the host
Client runs with it off. The event name comes from `@rljson/db`
(`stateBeaconEvent`), next to the Connector that deliberately ignores it; the
server imports the same function.

**Decision** (`antiEntropyDecision`, pure):

1. `r === _currentRef` → in sync.
2. `_currentRef === _lastPushedRef` and `o` is our connector's origin →
   **push**: the hub holds an earlier push of ours and missed the later one.
3. `p` contains `_currentRef` or `_lastAppliedRef` → **pull**: we missed the
   hub's state.
4. `_currentRef === _lastPushedRef` and `r === _lastAppliedRef` → **push**:
   the hub still holds what our push was made from.
5. otherwise → **merge**.

Rule 4 comes AFTER the ancestry check: a peer that deletes what we added can
return the folder to exactly the state we last applied — same hash, but made
from ours. Measured under load: pushing there put the deleted file back on
every node.

Rule 2 precedes rule 3 because of a collision the hash cannot resolve:
"B deleted the file A created" (hub `S0` made from `S1`, A at `S1`) and "A
deleted its own file and that push was lost" (hub `S1` made from `S0`, A at the
re-derived `S0`) are identical in refs and ancestry. Only the origin of the
hub's state tells them apart, and each wrong answer puts a deleted file back.

`_lastPushedRef` is set only where the agent authors a state (initial push,
debounced push, merge revision) — never by an apply, which can leave the folder
short of what it applied. Re-announcing such a state would roll peers back.

**Repair**, only once this node has been out of step with the hub for
`graceMs` **without its own state moving**, and nothing is pending,
processing or applying. The divergence is keyed on `_currentRef` alone: a node
keeping up with the traffic changes its own state with every forward it
applies, while a node that lost a message sits still. Keying on the hub's
state as well restarted the grace period on every change there, so a node
that missed every forward while another machine kept writing was never
repaired. The repair answers the latest announcement:

- push → `_sendRef(connector, _currentRef, [hubRef])`
- pull → `scheduleProcess(hubRef, …, p)` — the ordinary `processRef`
- merge → the same with `p` on the first attempt, then with `[]`, which makes
  the apply additive (union), after which the next round pushes it

Repeated repairs of one divergence back off exponentially up to
`maxBackoffMs`. `processing` covers the pauses between `processRef` retries,
where `_remoteApplyInFlight` is clear.

**Why not a copy of the mongo anti-entropy.** That one is triggered by noticing
a PEER's root, so a node that receives nothing never starts it, and it applies
a peer tombstone without a recency check. This one is triggered by the hub's
own announcement and never applies anything outside the ordinary rules.

**Tested by** `test/client-server/heals-after-forced-divergence.spec.ts`: three
clients, a real server with heartbeat, one ref message dropped on purpose per
case — including both halves of the collision above — plus a control run with
the repair off that must stay divergent.

## One Folder, One Ref — the canonical child order

A tree ref is supposed to be a function of the folder's content. It was not.

`readdir` (`fs-scanner.ts`) returns directory entries in whatever order the
filesystem chooses, and the ref hashes the resulting `children` array.
`_getFileContentMap` — the apply path's definition of "the same folder" —
ignores order entirely. So **two machines holding byte-identical content could
derive different refs for it**, and the two predicates disagreed:

| predicate | compares | asked by |
| --- | --- | --- |
| the tree ref | the whole tree row hash | anti-entropy: *am I diverged?* |
| `_treesHaveEquivalentContent` | path → blobId, plus directories | the apply path: *is there work to do?* |

When they disagree the system deadlocks against itself by design: the apply
path correctly concludes there is nothing to transfer, the anti-entropy
correctly concludes the refs differ, and neither is wrong.

**Measured on two machines (fs-agent 0.0.81).** After a forced 40 s
partition both sides held 38 identical files with identical hashes, and one
reported `diverged: true` for over **eight minutes** across six merge repairs,
logging *"equivalent content, skipping restore"* every time. It costs nothing in
data and it makes the divergence signal permanently untrustworthy — which is
the signal every repair decision is built on, and a permanent red "weicht ab"
in the UI.

The scan now emits children in a **canonical (sorted) order**, so the ref is a
function of content alone. Asserted on the scanner rather than on an arbitrary
tree, because that is where the guarantee has to live: any two scans of
equivalent content agree by construction, whatever order their filesystems hand
back.

**This changes every tree ref once.** Two machines only agree if both sort, so
it must roll out in lockstep — a node on an older build derives the old ref for
the same folder and looks permanently diverged to a new one. That is the same
constraint the package already has (`pnpm overrides`, exact pins).

**Tested by** `test/fs-ref-vs-content.spec.ts`, including the control: the
canonical-order assertion is red without the sort.

## Additive Reconciliation (`fs-manifest.ts` + `fs-bucket-sync.ts`)

Every reconciliation this agent has is **whole-folder**: `pull` replaces the
folder with the peer's version, `push` asserts ours over everyone's. Every
decision is all-or-nothing, so every wrong decision is maximally destructive —
which is how a copied folder was deleted off the machine that made it, and how
deleted files came back across a fleet, on the same day.

`@rljson/mongo-agent` never does this: *"PULL IS ADDITIVE: the body-pull path
only ever fetches docs the peer has and we lack; it never overwrites live
content."* There is no "whose folder wins". Two nodes compare manifests and each
fetches what it is missing. **That single property is what makes the two
measured failures impossible rather than less likely.**

### The comparison

An fs manifest is `path → blobId` — which `_getFileContentMap` already
produces. Each path falls in one of `BUCKET_COUNT` (4096) buckets by a hash of
the **path only**, so a modification stays in its bucket instead of looking
like a delete in one and an add in another. A bucket's root is the **XOR** of
its entries' digests, so it does not depend on the order a folder was walked in
— the canonical child order's lesson, one level down.

`BUCKET_COUNT` is a fixed constant. Mongo: *"MUST be identical on every node for
the per-bucket roots to be comparable."* Roots are sent **sparsely** (non-empty
buckets only), because a folder is three orders of magnitude smaller than a
mongo collection and 4096 fixed slots would be almost all empty.

**A deletion is an ENTRY**, carried at an empty blob id, so it travels through
the ordinary comparison rather than a side channel. A peer still holding the
file sees something to drop; a peer missing a file it has itself tombstoned
re-advertises the tombstone instead of fetching the file back.

### Four messages, not mongo's six

| | |
| --- | --- |
| `~BQ~` → | ask for the peer's bucket roots |
| `~BR~` ← | the roots, non-empty buckets only |
| `~BG~` → | ask for the entries of these buckets |
| `~BE~` ← | the entries of those buckets |

Mongo needs `AEW`/`AEH` because a document body must be requested and returned.
An fs entry is `path → blobId` and a blob is **already** content-addressed and
already fetchable over the existing path, so a node that knows the peer's
entries fetches the bodies itself.

Nothing here sends file content. Mongo's header records what happens otherwise:
broadcasting bodies made *"a 453 MB backfill balloon the hub to 3.4 GB and crash
it"*. The heaviest message is a list of paths.

**The body is JSON.** Mongo delimits with `|` because a collection name cannot
contain one; a relative PATH has no such guarantee — on POSIX a filename may
contain any byte but `/` and NUL. No delimiter is safe without escaping, and an
escaping bug in a message carrying DELETIONS is the expensive kind.

### Every message carries a round id

Not decoration. `@rljson/db`'s `Connector` dedups by ref on **both** sides, and
a protocol message is byte-identical every time it is sent — `~BQ~` asking for
roots never varies. Marked received once, every later copy is dropped, and the
SECOND reconciliation a node ever attempts goes unanswered for the rest of the
session. Mongo sidesteps this with an `emitRaw` that bypasses dedup; this
`Connector` has no such method, so the messages are made unique instead.

It buys a second thing: a reply can be matched to its request, so a late answer
from an abandoned round is recognisable rather than merely surprising — and
still worth acting on, because its buckets are derivable from the entries and
the round trip is already paid for.

A body that cannot be parsed is **claimed and ignored** — a build speaking a
different dialect is not a reason to stop syncing, and claiming it stops
anything else trying to apply it as a tree ref.

### It is driven, not autonomous

`FsBucketSync` decides what to say and what a reply means. It never touches a
folder, never reads a socket and **cannot delete anything**: a host supplies the
manifest and performs the plan, so the destructive half stays where the
mass-delete guard can see it. That is also why it is testable against a stub
with no sockets, folders or peers — two stubs wired together are a complete
two-node conversation.

`reconcile`'s whole vocabulary is `fetch` / `drop` / `redelete` / `conflict`.
There is no outcome in which one side's folder replaces the other's, and the
enumeration over {absent, live-x, live-y, tombstone}² proves `drop` and
`redelete` appear only where one side holds a tombstone for a path the other
holds live.

A genuine edit conflict is **named, not resolved** — whole-folder replacement
answered that question by guessing, and the guessing is what this plan removes.

### The cold-start gate

`ready()` — mongo's, for mongo's reason: until a baseline is complete the roots
are partial *"and would make a peer see spurious differences"*. A node
mid-cold-start neither answers nor asks, because answering with partial roots is
worse than silence.

### Wired, and ON by default

A divergence the anti-entropy would have answered with `pull` or `merge` runs a
bucket round instead. `bucketSync: false` returns to whole-folder repair and is
kept only as an escape hatch.

It was off for one revision, and the reason given was that such changes "have
been reverted four times for being shipped on reasoning". That was backwards:
those reverts were of changes shipped on reasoning, and this is the only part of
the work shipped on a controlled measurement. Turning it on surfaced three real
gaps — listed below — and fixing them is what the default is worth.

**Making it the default needed three things that were not in the plan:**

| gap | fix |
| --- | --- |
| deletions had to wait for an anti-entropy round, failing 20 tests | the prune is no longer withheld wholesale; the prune RULE is correct instead |
| the inline merge pruned on a tree whose ancestor it could not resolve | its materialisation is additive, and its deletions are targeted at the paths the merge actually resolved away |
| a same-file conflict was named and left — three clients then held three versions for ever | resolved by a rule both sides compute identically |

The third is the one the plan explicitly scoped out: *"It does not decide who
wins when two people edit the same file."* It has to. An additive step cannot
settle a conflict, so leaving it unsettled is not neutrality — it is
non-convergence. The greater blob id wins, both sides see both ids, so each
reaches the same answer with no message. No more arbitrary than the
last-advertisement-wins it replaces, and unlike that one it is the same choice
everywhere.

**Switching the repair was not enough on its own, and the two leftovers are the
interesting part.** Whole-folder replacement lives in three places, not one:

| | |
| --- | --- |
| the anti-entropy repair | `pull` replaces, `merge` applies the hub's tree |
| the ordinary apply | `cleanTarget` prunes whatever the incoming tree lacks |
| the inline merge | materialises a merged tree with `cleanTarget` |

The last two are reached from an ordinary incoming ref, not from a repair, so
with only the repair switched the partitioned node still lost its own new file —
measured, two runs in four, with the bucket round working perfectly alongside.
Under bucket sync all three are off:

- **an absence is never a deletion.** That is the whole point of carrying
  deletions as tombstone entries: a path missing from a peer's tree means the
  peer has not got it, not that the peer deleted it. Deletions arrive as `drop`
  from a round that knows which side deleted.
- **the inline merge is skipped.** It is whole-folder replacement by another
  name, and under bucket sync there is nothing for it to decide: the apply only
  adds, and the round reconciles.

**Measured 8 of 8** on three scenarios — a fork keeping both sides' work (§1.1),
a delete made while partitioned staying deleted (§1.2 / T4), and the three-node
version of both at once. The same scenarios run 5 of 8 without it.

## Rolling Out: what a peer can notice

This release makes two changes a peer can see, and they are not equally hard.

**Every tree ref in the fleet changes.** Two causes, one effect: content
identity now fixes a canonical child order, and mtime has left the identity
altogether — because a modification time does not survive a restore byte for
byte, and on Windows regularly does not, so while it was in the hash the same
bytes gave a different ref per machine and a node's deletions were refused by
everybody.

This is unavoidable and not destructive: `_treesHaveEquivalentContent` sees the
two trees as the same folder, so no data moves. It shows as a red divergence
flag during the rollout window — §2.1b's symptom — and clears once every node
has re-scanned. **Upgrade machines together**, and expect the flag until the
last one has.

**`~H~` is unintelligible to a build that does not speak it**, and there is no
compatibility switch — deliberately. A build that cannot parse `~H~` cannot
parse `~BQ~` either, so such a switch would also have to disable the bucket
protocol: one flag selecting two different consistency models.

So the rollout rule is the simple one: **upgrade machines together.** The ref
change above already requires it.

### Two paths that look like compatibility and are not

Both exist for a runtime condition, not for an older peer:

- **`_ancestryRelation`**, the whole-`InsertHistory` ancestry walk, serves a
  node whose chain failed to **initialise**. That is degradation: a node that
  cannot read its own history still has to sync, it just cannot contribute an
  ordering.
- **the bare-ref receive path**, because a bare ref is what any sender produces
  whose chain could not name the state it is announcing.

Whether the second is still REACHABLE is a measurement rather than an
assumption: the invariant `every announcement carries a chain head` passes
across the whole mesh tier — **zero bare refs**. That is the evidence for
deleting it, whenever it is deleted.

Two facts the path rests on are worth stating, because both are easy to get
wrong. Finding a row BY a field is a query, not a content read, and a relay does
serve one across `IoPeer` — verified against a real `Server`/`Client` pair. And
a tree ref is a content hash, so a folder that returns to earlier content
produces a SECOND entry with the same `dataRef` — §2.1 exactly, the ambiguity the chain exists to remove.
The newest by `timeId` is the right pick and is still a pick, which is why the
head is the primary and the lookup never runs on the apply path.

## What Grows, and What Bounds It

Measured on 400 files created then deleted one at a time, rather than reasoned
about:

| structure | growth | bound |
| --- | --- | --- |
| the chain (`editHistory`/`edits`/`multiEdits`) | one entry per **push**, not per change — 400 deletions produced **7**, because the debounce coalesces them | the walk budget, `DEFAULT_MAX_WALK` |
| `_localPathTimeIds` | one entry per changed path | pruned by the removals it records |
| `_stateHistory` | one per state entered | `STATE_HISTORY_MAX` |
| **the tombstone log** | **one per deletion, for ever** — ~11 bytes each, and the file is rewritten SYNCHRONOUSLY on every deletion | `TOMBSTONE_LOG_MAX` |

The tombstone log was the only unbounded one, and its shape is the bad kind:
the cost of deleting the next file grew with every file already deleted, so a
folder with years of churn turns into a megabyte rewritten per delete. Capped
at 10 000, evicted oldest-first, and **loudly** — evicting a tombstone can
resurrect a file, which is what a tombstone exists to prevent. A sighting in
the field means the log needs a real garbage-collection rule (one that knows
when every peer has seen a deletion), not a bigger number. The cap applies on
READ as well, so a file written by a build without it cannot reintroduce a size
this process has declined to carry.

### A hole and a budget are different truncations

Found by the growth measurement, which was supposed to be about storage.

`classify` walks ancestry, and it can stop for two reasons that look alike and
are not:

- **a hole** — an entry exists and this node cannot read it. The ref being
  looked for may be inside the part it could not reach, so the only honest
  answer is `incomplete`.
- **the budget** — everything asked for WAS readable, and no relation was found
  within `DEFAULT_MAX_WALK` entries.

Conflating them meant any node more than 500 pushes into its own history
answered `incomplete` for ever. The decision turns that into `blocked`, which
never repairs — **a long-lived node would simply stop healing, silently**, and
nothing in the suite would have noticed. A bounded walk now answers `fork`:
both sides keep their work, reconciliation is additive. Less precise than the
truth and never destructive.

`collectRemovals` keeps the strict reading for both cases, because a re-add
hiding below the bound would turn a skipped removal into a deleted live file.

## Deciding From Reachability

A content hash plus ONE generation of ancestry cannot decide this, and §2.2 is
the proof: "a peer deleted what we added" and "a peer forked from an ancestor we
share" arrive at that signature as the **same value**. Narrowing such a rule was
tried twice — it cost a discarded folder the first time and a livelock the
second. **Do not re-derive this decision from that input.**

The chain answers instead, and where it answers no heuristic may overrule it:

| `hub.reachability` | decision |
| --- | --- |
| `behind` — theirs descends from ours | `pull` |
| `ahead` — ours descends from theirs | `push` |
| `fork` — neither descends from the other | `merge` |
| `incomplete` — a walk was truncated | **`blocked`** |
| absent — no chain on either side | the old heuristics, unchanged |

**`ahead` does not require `lastPushedRef` to match**, and must never be
narrowed to it. Authorship is not a stand-in for "a state the other side does
not have yet": a node that ADOPTED a peer's tree and then deleted a file authors
nothing, so under that condition it could never re-announce the deletion and the
delete never propagated. Reachability proves the same thing properly, whoever
wrote it.

**`blocked` is reported and not repaired.** Every action available is
destructive in one direction or the other, and an incomplete walk that answers
"not an ancestor" is indistinguishable from a definite no. So the divergence
stays open, the backoff grows, and the next announcement tries again. It appears
in `lastRepair.action` because a node stuck this way must be diagnosable, and it
is **not** counted in `repairs`, because nothing was repaired.

Absence must never read as `fork`: an older peer, or a node whose chain failed
to initialise, gets exactly the behaviour that shipped before, including its
known limits.

### The keystone: lineages have to be joined

**Reachability on its own makes things WORSE**, and only a measurement catches
it. Every node appends to its OWN lineage, so an entry naming only this node's
previous head can never be reachable from a peer's — `classify` answers `fork`
for every disagreement, and cases a heuristic pushed or pulled correctly all
become merges.

So an entry that applies a peer's state names **that peer's head as a second
parent**. It is the shape `FsEditChain` writes its rows by hand to allow, and it
is what makes one node's history reachable from another's. Consumed once:
naming it on every later entry would claim to descend from it repeatedly and
grow every walk for nothing.

## A Verdict Is Only About This Folder While the Head Names It

`FsEditChain.classify` compares two chain **heads**. A node's head can lag its
own folder — a write is on disk and in `_currentRef` before
`_recordChainEntry` has appended the entry for it, and an apply that re-derives
a different ref leaves the head naming the state it came from.

Asked inside that window the chain answers truthfully about a state the node
has already left:

```
ours=fZ79puL0 theirs=KDeHB45d -> behind
  chainHeadTree=B4-SH9ZX current=hd3PHz1r
```

`behind` was correct about `fZ79puL0` and wrong about the folder, which was at
`hd3PHz1r` and held a file no peer had. The repair read `behind` as `pull`,
replaced the folder, and the divergence reopened — **45 times in 89 seconds**.

So `_classifyAnnouncedRef` answers `incomplete` unless
`_chainHead.treeRef === _currentRef`. `antiEntropyDecision` turns that into
`blocked`: nothing applied, nothing latched, retried. `fork` was tried instead,
on the reasoning that a fork's repair is additive and therefore safe, and
measured **worse** — 3 of 8 churn runs failing against 1 of 8. A merge invented
from a verdict the node is not entitled to is still a merge.

This is the same family as `fork-is-not-a-lag`: a marker that does not mean
"where I am" used as though it did.

### It is what made the agreement memo correctable

`FsAntiEntropy` memoises "the hub's ref X describes the same content as the
state I am in". That is a statement about **two** sides, true only while
neither moves — and it was keyed on X alone, so it survived this node changing
underneath it. A later announcement of X then cleared the divergence with no
content check at all, for ever.

The cost was not a misreported flag. The repair is **gated** on it:

```
A: 11 files  diverged=false  hub=goDX1oLq  local=kderYtfA  differing=[]
B: 10 files  diverged=false  hub=goDX1oLq  local=goDX1oLq  differing=[sub/three.txt]
```

B had deleted `sub/three.txt`, nobody re-created it, and A, C and D all held it
while reporting no divergence — so none of them ever repaired. The fleet did
not heal **and** did not say it needed to.

The key is now the pair, with the local side read from `view` on each call
rather than from `_localRef` — that field is assigned as announcements arrive,
so it lags its own folder and keying on it reintroduces exactly the staleness
the pair removes.

It had been tried twice before and reverted both times, because correcting it
turns the detector back on and the repair behind it was choosing `pull` for a
node that was ahead. Fixing what the repair is **told** had to come first; the
memo is one line at the end of that.

## One Decision Site, and No Prune Authority

**`antiEntropyDecision` is the only place that asks *"has the other side seen a
state I am in?"*** It asks the chain first and falls back to heuristics only for
a peer the chain cannot speak for — see
[Deciding From Reachability](#deciding-from-reachability).

There is deliberately no second site asking whether an incoming tree may
**prune** local files. Such a rule can only read `[currentRef, lastAppliedRef]`
against the other side's declared predecessors, and that input carries the
ambiguity above: one generation of ancestry cannot separate "a peer deleted what
we added" from "a peer forked from an ancestor we share". Narrowing it is what
cost a discarded folder once and a livelock the second time.

So **nothing prunes on a peer's authority at all.** A received tree may add and
may overwrite; a file disappears only when some machine has *stated* its removal
in the chain, and that statement is applied by `_applyIncomingRemovals` —
ordered by `timeId`, bounded by the mass-delete guard, and walked back through
`previous` so a deletion made during a partition is still found.

The `causalOrdering` warning is therefore not about data loss. The predecessor
refs it names are what let the merge gate fire, so a transport without them
reconciles no conflicting edit — that, and only that, is what it reports.

## A Delete Travels as a Fact (`collectRemovals` + `planRemovals`)

A tree records what a folder holds, so a deletion reaches a peer only as an
**absence** — and an absence is indistinguishable from a state that merely
predates the file.

That difference was once inferred from ancestry, which works only while the
ancestor can be resolved. A partitioned node's cannot, and that is where the
data loss was measured: 155 files of drift across four machines, and a file
deleted from 3 642 that was back moments later. Four rules were built on that
inference and all four were withdrawn; the one that is left is **not to
infer**. See [One Decision Site](#one-decision-site-and-no-prune-authority).

The chain carries the removal instead, as something the sender **states**.

### Reading the head is not enough

A removal is stated ONCE, in the entry that made it. A node partitioned at that
moment states it in an entry nobody received — and its next entry, computed
against its own last announcement, says nothing about the deletion. So a peer
reading only the head learns nothing.

`FsEditChain.collectRemovals(head, stopAt)` walks `previous` back to a state the
receiver knows and replays the range **oldest-first**, so a re-add cancels an
earlier removal. Order is the whole correctness: taking the union of `removed`
would delete a live file.

The stop entry is excluded entirely. A receiver that knows `T1` already holds
the state in which those paths are gone, and including its `timeId` would let an
old removal out-order the receiver's newer work.

**`complete: false` is the contract that matters most.** An unresolved entry
means its ancestry — and any re-add hiding in it — is unknown, so the answer is
**discarded rather than applied in part**. Truncation comes from a hole or from
the walk bound; mongo states the rule as *"a caller must not latch the head;
ancestors beyond the missing row would otherwise be lost forever"*.

### Bounded twice, because it deletes without asking the ancestry rule

`planRemovals` decides what to act on:

| bound | rule |
| --- | --- |
| recency | `timeId`, minted once by the author, so every node orders the same pair identically. A removal older than this node's own newest edit to that path is refused. |
| volume | the mass-delete circuit breaker, blocked **wholesale** — a partial mass delete leaves the folder in a state neither side asked for. |

The ratio is judged on what would ACTUALLY be deleted, so paths this node does
not hold and paths refused as stale cannot trip the breaker on a message that
removes almost nothing. A missing or malformed `timeId` is **not comparable**,
never "older": judging silence as untrustworthy refused every deletion across
twenty tests when it was last tried.

### Why a deletion gets out at all

The deleting node has to be able to **re-announce** its own deletion, and two
properties are what make that possible.

**`ahead` does not require authorship.** A node that has applied a peer's tree
no longer authors its current state; if `ahead` meant "a state I authored", such
a node could only `pull` or `merge` and its deletion would never go out.
Reachability proves "the other side is behind" whoever wrote the state.

**A node that is behind ASKS**, rather than waiting to be told. That is what
refills a machine whose folder was wiped, and what holds the fleet-level
invariant *every node ends on the last save*.

T4 — *a delete made while cut off is not resurrected on rejoin* — is an ordinary
assertion in `test/mesh/fs-mesh.spec.ts`, measured **8 of 8** under
`bucketSync`.

## Refused Deletions Are Reported, Not Only Logged (`FsAgent.refusedDeletions`)

The mass-delete guard refuses any incoming deletion that would remove most of a
folder, on three routes — an incoming whole tree, a bucket round's drop list,
and a peer's stated removals. It refuses on **every** node, so a user who
deletes 10 000 files on purpose ends up with one machine short of them and the
rest unchanged, and no further message closes that gap.

The guard is right anyway, because the two cases are indistinguishable from
inside this package: a machine that was wiped telling the fleet to wipe, and a
person deleting a project. Both arrive as "most of the folder is gone". The
guard exists because the first one happened — a peer that had been emptied
produced a round dropping **39 of 40** files, and before the floors covered
that shape, 39 files were deleted on every node with no refusal logged at all.

What changed is that the refusal is now **readable**. One place
(`_refuseDeletion`) reports it three ways, so they cannot drift apart as the
three copies had:

| where | what it carries |
| --- | --- |
| the log | `MASS DELETE REFUSED on <folder>: <route> would remove N of M files.` |
| `.sync-errors.log` | the key `restore/`, `bucketSync/` or `removals/massDeleteGuard` |
| the API | `FsAgent.refusedDeletions` — `{ atMs, route, wouldRemove, held, paths }` |

A UI cannot grep a log on a machine it is not running on, and *"why did my
deletion not arrive"* is exactly the question it has to answer. Fixing it
properly is a product decision — an approval path — and until that exists the
refusal is the correct behaviour and the gap is a missing dialog.

## Tombstone Log (`_pendingDeletes` + `.fsagent-state.json`)

**What this node deleted, remembered past the push.**

A deleted file is simply absent from the next tree, so nothing in the content
says the absence was deliberate. `_restoreTree` consults `_pendingDeletes` —
"never re-create a file deleted here and not yet announced" — and the set is
**persisted** in `.fsagent-state.json` beside `currentRef`, reloaded on start.

Clearing it on the next announcement is one push too early: "once peers have
been told, a file's absence is theirs to know about" holds only for a peer that
HEARD. A partitioned node's deletion reaches nobody, and on rejoin the fleet's
tree still contains the file.

| trigger | effect |
| --- | --- |
| local `deleted`, path in `_announcedFiles` | record a tombstone, persist |
| local `added` / `modified` for a tombstoned path | forget it, persist |
| restore about to write a tombstoned path | skip the write |

**Only an announced FILE may be tombstoned**, because the watcher's path is not
trustworthy on its own: deleting one nested file on macOS emits two deletions,
the first naming the root folder itself, and directories arrive as `modified`.
`_announcedFiles` is the set the prune rule already uses for "a file peers could
know about", and it excludes the root, directories, and files deleted before
anyone was told — the last of which need no tombstone, because no peer can push
them back.

**This is half a mechanism.** Measured: it stops a node resurrecting its own
deletion, reliably. It does not make the deletion win on a peer that never heard
it, so the residual failure is a permanent divergence rather than a data loss.
The other half needs the edit chain below.

**Not yet bounded.** Deleting a large folder writes one tombstone per file and
keeps them. `@rljson/mongo-agent` routes tombstone application through the same
mass-delete circuit breaker that bounds a prune; fs does not yet.

## Ordering a Tombstone Against the Write It Supersedes (`ManifestEntry.editedAt`)

A bucket round compares two manifests. A manifest says what a node **holds**;
until this release it never said **when the node decided**. So `reconcile` took
a peer's tombstone as authority on its own:

```ts
if (theirsIsTombstone) {
  plan.drop.push(path);   // no comparison with the write that superseded it
}
```

A deletion made *before* a re-creation therefore still won, and the file was
lost on every node that heard the older side. Measured by `I7b: a delivered
deletion does not beat a later re-creation` — B deletes `flip.txt` while
connected, is cut off, C re-creates it, and B's rejoin round dropped it from
everybody.

`reconcile` already knew this about itself. Its comment on the conflict branch
says the conflict resolver *"had the same defect — winners were chosen by
content hash — and was fixed by ordering on the chain; this rule survived
because it is the one that must work with no history at all."* That holds for
the hash tie-break, which is the fallback for two nodes sharing no history. It
does not hold for a tombstone, where a history exists and says plainly which
came first.

### The fix: the Edit's own identity travels

`ManifestEntry` gains a fourth element:

```ts
readonly [path: string, blobId: string, claimed?: 0 | 1, editedAt?: string]
```

`editedAt` is the `timeId` of the newest edit known for that path — the write
that produced the blob, or the removal that produced the tombstone. It is not a
wall-clock reading taken at send time; it is the identity of an Edit, minted
once by whoever made it, so **both sides of a round order it identically**.

Both tombstone branches then became symmetric, and the mirror matters as much
as the rule:

- their tombstone older than our write → **keep** the file
- our tombstone older than their write → **fetch** it, rather than re-asserting
  a deletion the fleet has moved past

Without the second half each side holds its own position for ever and the round
never converges.

Absent means "the sender did not say", exactly as for `claimed`, and the rules
that predate the field decide — which is also what happens after a restart
until edits have been noted again. `editedAt` is read from `_pathEditTimes`,
persisted in `.fsagent-state.json` beside the tombstones: without that the
defect returns on every restart, because a node that cannot date its edits
sends no time and the comparison has one operand.

### What was tried first, and why it cannot work

A receiver-side rule: refuse a drop whenever this node's own chain has a newer
write for the path. It fixed `I7b` and broke three deletion deliveries —
*delivers a deletion a peer never received*, *does not undo a peer deletion it
missed*, and the churn fuzzer.

The reason is structural. A node that has never **heard** a deletion has
exactly the same local history as one whose write superseded it. Its own chain
cannot tell the two apart, and in `I7b` it provably cannot: B was partitioned
when C re-created the path, so C's write is unreachable from B's head. The
ordering has to come from the side that holds the fact, which is why it travels.

## Edit Chain (`src/fs-edit-chain.ts`)

**Written, and read by nobody. That is deliberate.**

A tree ref is a content hash of the whole folder, so a folder that returns to a
state it held earlier re-derives that state's exact ref. "We returned to an old
state" and "we never left it" are the same string — which is why two data-loss
failures in opposite directions were measured on one day, and why neither is
fixable by reading `antiEntropyDecision` more cleverly.

The chain gives every change its own identity. One entry per folder-changing
scan:

| field | |
| --- | --- |
| `dataRef` | the tree ref the folder ended up at |
| `previous` | the entries it was made from — **two** for a merge |
| `timeId` | `<millis>:<nanoid>`, minted once, a fleet-wide order |
| `changed` | relative paths added or modified |
| `removed` | relative paths removed — **what a tree cannot express** |

`removed` is the point of carrying more than a ref. A tree records what a folder
holds; only this records what it deliberately stopped holding.

### What writes it

`FsAgent` appends one entry per state it pushes — the initial push, every
debounced push, and a merge revision. The chain is created on the first
`syncToDb`, which is where a `Db` and a `treeKey` first exist together, and
`init()` continues the lineage a previous process left behind rather than
starting a new root.

**Best-effort throughout.** Creating the chain, and every append, is recorded
via `_writeSyncError` and swallowed — the same discipline as
`_persistCurrentRef`. A folder must never stop syncing because its history
could not be written. Nothing reads the chain yet, so a gap costs nothing; when
something does, a gap is what `complete: false` is for.

`changed` and `removed` come from comparing the pushed tree's content map with
the one announced before it (`_announcedContent`). The FIRST announcement
records neither: everything would count as changed, which on a real folder
makes the opening entry list 1 200 paths, and the tree ref already says what
the baseline is. Only the deltas after it are worth recording.

### What goes on the wire

**The chain HEAD, marked `~H~`** — not the tree ref.

A receiver holding a tree ref cannot find the chain row for it by hash, only by
query, so nothing could walk ancestry. Announcing the head makes every
announcement resolvable to an entry, which is what the `previous` walk needs in
order to exist at all. It also makes each announcement UNIQUE: an A → B → A
deletion produces three entries with three heads, so a returning content state
is news by construction rather than by clearing the connector's dedup for it.

The marker matters. A tree ref is a content hash and never starts with `~`, so
the two are unambiguous on one channel — the trick `@rljson/mongo-agent` uses
for its own protocol refs. Without it a receiver would have to TRY resolving
every ref it hears, and a miss goes to the network.

| | |
| --- | --- |
| `r` on the payload | `~H~<editHistory ref>` |
| `p` on the payload | **tree refs, unchanged** |

The predecessors stay tree refs deliberately. A receiver's prune rule compares
them against `[_currentRef, _lastAppliedRef]`, which are tree refs, so
translating them here would break the one rule that separates a deletion from a
straggler. The head is an additional identity for the announced state, not a
replacement for the ancestry already on the payload. A receiver that resolves
the head gets the chain's own `previous` for free, and that is the ancestry the
walk will use.

**Three rules this cost a red run each to learn:**

1. **An unmarked ref is scheduled SYNCHRONOUSLY.** Making the receive callback
   `async` deferred the schedule by a microtask even for a tree ref, and that
   was enough to lose a late joiner's bootstrap — it never received a file that
   already existed. The connector's bookkeeping runs around that call; an await
   between hearing a ref and queuing it reorders the two. The same applies to
   the anti-entropy's socket read, where three tests read the status straight
   after a beacon.
2. **The chain is created in `syncFromDb` too.** A node that only receives — a
   late joiner starts `syncFromDb` alone, because scanning its empty folder
   would push emptiness over everyone's data — still has to resolve the heads
   its peers announce. Created on the send path only, it dropped every
   announcement it heard. The chain is per-route state, not per-direction.
3. **A head that cannot be resolved answers `undefined`**, and nothing is
   concluded from it. Not even divergence: reporting a disagreement this node
   cannot describe is how the §2.1b symptom arrives by a second route.

**Mixed fleet: this must roll out in lockstep.** An older build receiving
`~H~…` would try to fetch a tree by that hash and fail. The canonical child
order above already imposes the same constraint, so the package as a whole
needs the exact-pin discipline it already has.

A merge revision's chain entry is still LINEAR. It is the one state with two
parents — the shape these rows are written by hand to allow — and naming both
means mapping two tree refs to two chain heads, which nothing resolves yet.

### Three tables, no cake

`<treeKey>Edits`, `<treeKey>MultiEdits`, `<treeKey>EditHistory` — and
`createEditHistoryTableCfg(treeKey)` already declares `dataRef` as a reference
to `treeKey`, which for fs IS the trees table. The fit is exact.

**fs-agent creates them itself**, idempotently, via `createFsChainTables`.
`@rljson/db`'s `createTable` is `createOrExtendTable`, so an init may run on
every start. The host application creates the trees table (in its own server and
client entry points); an agent expecting tables its host had never created fails
at runtime on any node whose host is one release behind, which is exactly the
mixed-version case a rollout guarantees. Creating our own removes the coupling
rather than versioning it — the reason `@rljson/mongo-agent` could evolve its
schema without release-locking its host.

### Why the rows are written by hand

`MultiEditManager` is the ordinary way to append an edit and is not usable here:

- it refuses more than one `previous` (*"has multiple previous refs. Not
  supported"*), and an fs **merge revision has two parents** by design
  (`StoreFsTreeOptions.previous`) — so the chain could not express the one
  revision shape that matters most; and
- it is inseparable from the cake model: `edit()` needs a `cakeRef` and a
  `MultiEditProcessor` that applies edits onto a cake. fs has no components.
  Its content is the tree, already in the trees table. Only the history was
  missing.

`EditHistory.previous` is `string[]` in the type and `jsonArray` in the table,
so multiple parents are representable — it is only the manager that will not
walk them.

### The head, and why it is not a single slot

A chain that is only written has no use for more than one head, nor for a walk.
A chain that **decides** needs both, in three ways:

- **A head is parked per announced tree ref, not held in one slot.** When an
  announcement arrives, the sender's head is remembered against the tree ref it
  described (`_announcedHeads`, bounded by `ANNOUNCED_HEAD_MAX`, oldest first)
  and promoted only when that state is actually applied. The slot version made
  a node claim a lineage descending from a state it had merely *heard about* —
  **hearing a head is not holding its state**.
- **`classify` walks, with a budget.** It answers `behind` / `ahead` / `fork` /
  `incomplete` by walking `previous`, bounded by `DEFAULT_MAX_WALK`, with a
  lineage cache. A truncated walk answers `incomplete`, never `fork` — acting
  on a truncated walk is how a node decides it is ahead of a peer it is behind.
- **Per-path ancestry, where a branch verdict was wrong.** `lastEditOf` answers
  "who last edited *this path*" by walking generation by generation and sorting
  within a generation. Taking the greatest `timeId` was not enough: two edits
  in the same millisecond break on a random tail, so it could name an entry its
  own successor had superseded.

`@rljson/mongo-agent` holds per-node lineages for the same reason: a single
`_lastApplied` slot there lost updates.

**Tested by** `test/fs-edit-chain.spec.ts` (20), `test/fs-classify.spec.ts`
(11), `test/fs-collect-removals.spec.ts` (31),
`test/fs-agent-announced-heads.spec.ts` (the cap) and
`test/fs-chain-crosses-the-wire.spec.ts` (a peer walking `previous` through
entries it never held).

## Conflicts: two people saved the same file (`src/fs-conflict-resolver.ts`)

Everything else in this document is about folders that disagree because a
message was lost or late. This is the case where both machines are right: two
people edited one path while neither could see the other.

Enabled by `resolveConflicts`. With it off the resolver is not constructed, and
a conflicting edit is never merged — which is correct for a hub, since a hub
relays and must not arbitrate.

### The three-way merge

`FsConflictResolver.resolve` is given a `dagBranch` conflict — two tips of one
table — and works out one result:

1. **`findCommonAncestor`** walks both lineages for the newest state they share.
   That is the `o` of the three-way. It tolerates a dangling predecessor and a
   diamond, and returns `null` when there is no shared ancestor at all.
2. **`threeWayMerge(o, ours, theirs, …)`** decides per path:

   | `ours` vs `theirs` | result |
   | --- | --- |
   | equal | keep it (including both-absent and both-added-identically) |
   | only theirs diverged from `o` | take theirs |
   | only ours diverged from `o` | take ours |
   | both diverged, differently | **a conflict** — including edit-vs-delete |

3. For a real conflict, one side keeps the path and **the other side's bytes are
   preserved under a renamed copy.** That is the property that makes either
   verdict safe: no answer loses content.

### Which side keeps the path

By the chain, per path — not by which branch is "newer".

`winnerFor` is built from `lastEditOfPath` on both tips and compared with
`compareTimeId`. A side that touched the path beats a side that did not; where
both touched it, the later edit of **that path** wins; where the chain cannot
speak for either, the branch order stands.

The branch order alone was the whole rule once, and it is the defect the chain
was brought in to remove: it ordered a *tip*, so a tip could win files it never
opened. Measured — a machine came back from being offline, wrote one unrelated
file, and that newer tip took `doc.txt` with it, moving the writer's own folder
from v8 back to v5. "Cannot say" is never read as "did not touch it".

### The name of the losing copy

```
document.txt  →  document (conflicted copy <machine> 2026-06-18 091500).txt
```

Inserted before the final extension; appended when there is none; a leading-dot
name is treated as extensionless. Repeats get a numeric suffix, and the
candidate is checked against every real path **and** every copy already planned,
so a copy can never collide.

The identity and timestamp come from the **losing revision**, not from the clock
of the machine doing the merge — so every peer computes the identical name and
the copy does not itself become a conflict. Where no identity is available the
marker degrades to the timestamp plus a short ref rather than printing an empty
one: `(conflicted copy  2026-…)` with a double space is the kind of detail a
user reports as a bug.

### What the merge revision is

One state with **two parents** — the only shape in the chain that has them. It
is announced as a chain head like any other state, and
`_resolveConflictInline` adopts the incoming side's head first, so the Edit
names both branches.

That ordering is load-bearing. A merge that resolves both branches but descends
from one is classified `fork` by the very peer whose branch it merged, for ever
— announcing such a head converts a finished merge into a standing
disagreement.

### And a merge claims only what it made

Choosing between two versions is not writing one. A merge that resolves
`doc.txt` by keeping one side's existing bytes has not edited `doc.txt`, and
claiming it would make this machine the newest author of content it did not
write — which then out-ranks the real writer. So the claim is filtered to the
paths whose merged bytes came from neither side: the conflict copies, which this
machine genuinely made.

### Telling somebody

`onConflict` fires with the reports as they are resolved, for a UI that is
running now. `.fsagent-conflicts.json` records them, bounded, for one that
starts later. Both, not either — a conflict nobody hears about is the thing this
exists to prevent, so it does not depend on anyone having subscribed.

## Joining a Network (`planJoin`)

The case the chain exists for, and the one a folder's contents cannot decide.

If a joining node authored a lineage root from its own contents and pushed it as
the network's newest claim, that would be one defect with two faces: every node
gets its own root, so `classify` answers `fork` to every announcement ever made;
and a machine restored from a backup pushes a month of deletions back to the
whole fleet.

**The chain applies first, and the filesystem only then.** A folder with files
and no history does not speak: it defers its first announcement and asks the
network for a head, every `JOIN_ASK_INTERVAL_MS`, until a bounded
`joinWaitMs` expires. That default is **on, on every route** — a joiner that
cannot be told must ask, and keep asking.

With a head in hand, `planJoin` puts every path in **at most one** of four
buckets, deciding each against the chain and never against the disk:

| bucket | the path is | action |
| --- | --- | --- |
| `write` | in the head, not on disk | write it |
| `announce` | on disk, never named anywhere in the history | new local work — announce it |
| `recover` | on disk, and REMOVED by the history | a stale copy: rename aside, say nothing |
| `conflict` | live on both sides, different bytes | the head's bytes win, the local copy is kept aside |

`recover` is what makes a restored backup safe. The files are moved into
`.fsagent-recovered/`, which the scanner ignores — because a tree ref carries
content, so a "kept but not announced" file cannot exist *inside* the synced
folder. Nothing is resurrected and nothing is destroyed.

If no head arrives within the wait, this folder is the origin of its own
history and announces normally. An empty head is a **fact**, not an absent
one: a fleet that has agreed the folder is empty states exactly that, and each
local path is still judged as new work or as a stale copy. Conflating the two
is what would make an emptied network un-joinable.

**Tested by** `test/fs-plan-join.spec.ts` (9 decision cases, including that
every path lands in at most one bucket) and at mesh tier by
`fs-mesh-matrix.spec.ts` **J4+J5** and **J9** twice — the latter using a
stopped PROCESS rather than a broken network, because that is what a restart
is.

## Authorship: a node claims only what it changed

The standing design rule, and the one most easily violated in a single branch:
**an edit exists only where the change was made.** A receiver adopts and never
authors. Without it, a machine catching up records itself as the author of
somebody else's file, and then correctly out-orders the person who actually
typed.

Four places broke it, and each is now a test:

1. **A merge claimed too much.** `storeMerge` recorded an entry claiming every
   path whose bytes differed from what that node had last *announced* — so a
   receiver merging against a late announcement wrote itself down as the author
   of a file it had never edited, 28 seconds after the real edit. A merge now
   claims only the paths whose merged bytes differ from **both** inputs: the
   ones it genuinely synthesised.
2. **A received path was claimed.** `_recordReceived` records only what
   actually ARRIVED, measured against the state before the apply — without the
   before-state, a node's own bytes returning from a peer drop its claim.
3. **The first local edit was authorless.** "Have I announced before" is not
   "is what I announced empty": `previous.size === 0` is true both for a node
   that has never spoken and for one that has announced an empty folder, which
   is every fresh client. The first real file written on a new node was never
   claimed.
4. **A re-derived state got a stale identity.** Returning to a content state is
   a NEW entry, not the old one.

**The practical rule for anyone adding a guard to the push path:** check
whether the signal it reads is populated *before* or *after* the push. Claims
are recorded by `_recordChainEntry` **after** the state being judged, so a node
is a stranger to its own newest work at that moment — which is why three
attempts at a restore detector each suppressed ordinary work instead (a
rename's target, an atomic save, a create/delete/recreate are all unclaimed at
that instant). And a guard that needs an `await` in the push path is already
wrong: the yield between "this is what I am announcing" and "this is the entry
for it" lets another apply land in the middle.

**Tested by** `test/fs-agent-authorship.spec.ts`,
`fs-agent-no-laundering.spec.ts`, `fs-agent-own-echo.spec.ts`,
`fs-agent-self-parent.spec.ts`, `fs-agent-inbound-verdict.spec.ts` and
`fs-agent-stale-reconnect.spec.ts`.

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
