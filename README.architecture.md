<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Architecture

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
2. **Server Multicast**: The server receives the message and broadcasts it to OTHER clients (sender is filtered out via `clientIdA !== clientIdB` in `@rljson/server@0.0.4+`)

```typescript
// This is NORMAL behavior:
const connector = new Connector(clientDb, route, socket);

connector.listen((ref) => {
  console.log('Received ref:', ref);
});

connector.send('my-ref-123');
// Output: "Received ref: my-ref-123"  ← Local echo happens IMMEDIATELY
```

**Server-Side Filtering (v0.0.4+):**

The `@rljson/server` package (v0.0.4 and later) correctly filters out the sender when multicasting:

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

### The Peer-to-Peer Architecture with Central Server Coordination

The fs-agent implements a distributed peer-to-peer synchronization pattern where:

1. **Each client stores data locally** in its own `Io` (database) and `Bs` (blob storage)
2. **References are broadcast** through the server via Connector
3. **Data is pulled on-demand** when a client needs data it doesn't have
4. **The server coordinates** but doesn't own the data - it routes requests between clients

### Step-by-Step Sync Flow: Client A → Client B

**Message Routing via Connector:**

```
Client A                          Server                          Client B
--------                          ------                          --------

1. File changes detected
   ↓
2. FsAgent extracts tree
   ↓
3. connector.send(treeRef)
   │
   ├─→ Local Socket Echo                6. Server._multicastRefs()
   │   (Client A's listener triggered)      filters sender
   │                                        ↓
   └─→ socket.emit(route, {r: ref})       7. Checks: clientIdA !== clientIdB
             ↓                                 ↓
       Server receives on                  8. Broadcasts to OTHER clients
       socket.on(route, ...)                  (Client A excluded)
                                               ↓
                                          socketB.emit(route, {
                                            r: ref,
                                            __origin: clientIdA
                                          })
                                                    ↓
                                                    → Client B
                                                      ↓
                                                    9. Client B's connector
                                                       .listen() triggered
                                                       ↓
                                                    10. syncFromDb callback
                                                        processes ref
```

**Key Points:**
- Client A's connector receives its own message via **local socket echo** (step 1 branch)
- FsAgent's `_lastSentRef` filtering prevents processing this echo
- Server receives the message and broadcasts to **all OTHER clients** (step 6-8)
- The `__origin` field prevents infinite forwarding loops in the server
- Client B receives the message and pulls data via IoMulti/BsMulti (see below)

**Data Pull Flow (when Client B needs data):**

```
Client A                          Server                          Client B
--------                          ------                          --------

1. File changes detected
   ↓
2. FsAgent extracts tree
   ↓
3. Blobs stored in clientA.bs (local BsMem)
   ↓
4. Tree stored in clientDbA (local IoMem)
   via storeInDb()
   ↓
5. connector.send(treeRootRef)
   ↓ socket →→→
                              6. Server receives ref
                                 ↓
                                 7. Multicasts to all clients
                                         ↓ socket →→→
                                                            8. connectorB receives ref
                                                               ↓
                                                            9. syncFromDb callback triggered
                                                               ↓
                                                            10. loadFromDb(treeRef) called
                                                                ↓
                                                            11. Query clientDbB for tree data
                                                                ↓
                                                            12. clientDbB.io (IoMulti) checks:
                                                                - localIoB: NOT FOUND
                                                                - IoPeer: Query server
                                         ← socket ←←
                              13. Server routes to Client A
          ← socket ←←
14. Client A's Io returns tree data
          → socket →→
                              15. Data flows back to Server
                                         → socket →→
                                                            16. Tree data arrives at Client B
                                                                ↓
                                                            17. Tree data stored in localIoB
                                                                ↓
                                                            18. For each file in tree:
                                                                clientB.bs.getBlob(blobId)
                                                                ↓
                                                            19. clientB.bs (BsMulti) checks:
                                                                - localBsB: NOT FOUND
                                                                - BsPeer: Query server
                                         ← socket ←←
                              20. Server routes to Client A
          ← socket ←←
21. Client A's Bs returns blob
          → socket →→
                              22. Blob flows back to Server
                                         → socket →→
                                                            23. Blob arrives at Client B
                                                                ↓
                                                            24. Blob stored in localBsB
                                                                ↓
                                                            25. File written to filesystem
                                                                ↓
                                                            26. Sync complete!
```

### Key Architectural Components

**IoMulti (inside client.io):**

- Combines local IoMem with IoPeer (server connection)
- When data is requested: first checks local, then queries peer via socket
- Automatically caches retrieved data locally
- Transparent to the application - just use `client.io`

**BsMulti (inside client.bs):**

- Combines local BsMem with BsPeer (server connection)
- When blob is requested: first checks local, then queries peer via socket
- Automatically caches retrieved blobs locally
- Transparent to the application - just use `client.bs`

**Connector:**

- Broadcasts tree references (not full data) via socket
- Triggers `syncFromDb` callbacks on receiving clients
- Minimal bandwidth - only sends references

**Server:**

- Routes data requests between clients
- Maintains connections to all clients via sockets
- Does NOT store client data - purely acts as coordinator/router
- Has its own serverIo and serverBs for server-specific needs only

### Why This Architecture Matters

This peer-to-peer pattern with server coordination enables:

✅ **Distributed storage**: Each client owns its data locally
✅ **Bandwidth efficiency**: Only references broadcast, data pulled on-demand
✅ **Scalability**: Server doesn't store all client data
✅ **Offline capability**: Clients can work with locally cached data
✅ **Real-world deployment**: Works across networks, not just in-memory mocks

**This is why clients must NEVER access server Io/Bs directly** - it would bypass the entire peer-to-peer mechanism and make the system only work in single-process scenarios.
