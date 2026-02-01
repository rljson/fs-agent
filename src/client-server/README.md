<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Client-Server Architecture for FsAgent

This directory contains implementations demonstrating how to use `FsAgent` in a distributed client-server architecture using the `@rljson/server` package.

## Architecture Overview

### Core Principles (DO NOT VIOLATE)

#### 1. Server and Client Classes

**ALWAYS use `Server` and `Client` classes from `@rljson/server` directly.**

The Server and Client classes handle all the internal complexity of:

- Multi-layer storage aggregation (BsMulti with local + peer)
- Multi-layer I/O aggregation (IoMulti with local + peer)
- Socket-based communication between client and server
- Automatic synchronization of data between layers

```typescript
// ✅ CORRECT Pattern
const server = new Server(route, serverIo, serverBs);
await server.init();

const client = new Client(socket, localIo, localBs);
await client.init();

// Use client.bs and client.io for all operations
const agent = new FsAgent(folder, client.bs);
const clientDb = new Db(client.io);
```

**Never manually construct `BsMulti` with `BsPeer` or `IoMulti` with `IoPeer`.** If the Client/Server classes don't work for your use case, fix the issue in `@rljson/server`, not in application code.

#### 2. Database Access Pattern

**Each client creates its own `Db` instance using `client.io`.**

The `client.io` property provides an `IoMulti` that combines:

- Local I/O (priority 1, read/write)
- Server peer I/O (priority 2, read-only by default)

This ensures that database operations automatically go through the proper client-server architecture:

- Writes go to local I/O first
- Reads check local first, then fall back to server
- The server aggregates all clients' data

```typescript
// ✅ CORRECT: Each client has its own Db
const clientA = new Client(socketA, localIoA, localBsA);
await clientA.init();
const clientDbA = new Db(clientA.io); // Uses client's multi-layer I/O

const clientB = new Client(socketB, localIoB, localBsB);
await clientB.init();
const clientDbB = new Db(clientB.io); // Separate Db instance

// Operations on clientDbA and clientDbB are independent but sync through server
await agentA.storeInDb(clientDbA, 'sharedTree');
await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
```

❌ **WRONG:** Sharing the server's Db directly bypasses the Client/Server architecture.

#### 3. Connector Route Matching (CRITICAL)

**Connectors MUST use the same route as the Server for message routing to work.**

The Server's multicast logic listens on the server route, and Connectors send/receive on their route. If these don't match, messages will never be routed between clients.

```typescript
// ✅ CORRECT: All connectors use server route (based on tree table name)
const treeKey = 'sharedTree';
const route = Route.fromFlat(`/${treeKey}`);
const server = new Server(route, serverIo, serverBs);
await server.init();

// Pass the SAME route to all connectors
const connectorA = new Connector(clientDbA, route, socketA);
const connectorB = new Connector(clientDbB, route, socketB);
```

```typescript
// ❌ WRONG: Connector routes differ from server route
const treeKey = 'sharedTree';
const serverRoute = Route.fromFlat('myapp.sync'); // Wrong! Not based on treeKey
const server = new Server(serverRoute, serverIo, serverBs);

// These routes don't match - messages will NOT be routed!
const connectorA = new Connector(clientDbA, Route.fromFlat('/sync'), socketA);
const connectorB = new Connector(clientDbB, Route.fromFlat('/sync'), socketB);
```

**Why:** The Server listens on `server.route.flat` and only processes messages sent to that exact route. If Connectors use different routes, the Server never receives their messages, and cross-client communication fails.

#### 4. Self-Broadcast Filtering

**Connectors receive their own messages via local socket echo - this is expected behavior.**

When a Connector sends a message, it immediately triggers its own listeners due to EventEmitter's local echo. The Server (v0.0.4+) filters the sender from multicast, but cannot prevent local echo.

**Application code must filter out self-broadcasts:**

```typescript
// In FsAgent - self-filtering example:
private _lastSentRef?: string;

// Track sent ref before broadcasting
this._lastSentRef = ref;
connector.send(ref);

// Skip processing own messages when received
if (treeRef === this._lastSentRef) {
  return; // Don't process self-broadcast
}
```

This prevents infinite loops where a client processes its own broadcast, triggers a change, broadcasts again, etc.

#### 5. Table Schema Setup

Before clients can use a table, the table schema must exist in both:

1. Server's I/O layer (for server-side data storage)
2. Each client's local I/O layer (for client-side operations)

This is a **bootstrap/setup** step that happens before normal operations:

```typescript
async function createSharedTreeTable(io: IoMem) {
  const db = new Db(io);
  const treeCfg = createTreesTableCfg('sharedTree');
  await db.core.createTableWithInsertHistory(treeCfg);
}

// Server setup
await serverIo.init();
await createSharedTreeTable(serverIo); // Create table on server
const server = new Server(route, serverIo, serverBs);

// Client setup
await localIo.init();
await createSharedTreeTable(localIo); // Create table on client
const client = new Client(socket, localIo, localBs);
```

In production, this would typically be handled by:

- Database migrations
- Schema synchronization protocols
- Initial bootstrap scripts

## System Design

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Server                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Server(route, serverIo, serverBs)                  │   │
│  │                                                      │   │
│  │  - Aggregates all clients                           │   │
│  │  - Internal IoMulti: aggregates all client IoPeers  │   │
│  │  - Internal BsMulti: aggregates all client BsPeers  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          ↕ socket
┌─────────────────────────────────────────────────────────────┐
│                      Client A                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Client(socketA, localIoA, localBsA)                │   │
│  │                                                      │   │
│  │  client.io = IoMulti([                              │   │
│  │    { io: localIoA, priority: 1, R/W },             │   │
│  │    { io: IoPeer(socketA), priority: 2, R-only }    │   │
│  │  ])                                                  │   │
│  │                                                      │   │
│  │  client.bs = BsMulti([                              │   │
│  │    { bs: localBsA, priority: 1, R/W },             │   │
│  │    { bs: BsPeer(socketA), priority: 2, R-only }    │   │
│  │  ])                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  FsAgent(folderA, client.bs)                        │   │
│  │  Db(client.io)                                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          ↕ socket
┌─────────────────────────────────────────────────────────────┐
│                      Client B                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Client(socketB, localIoB, localBsB)                │   │
│  │                                                      │   │
│  │  client.io = IoMulti (same pattern as Client A)     │   │
│  │  client.bs = BsMulti (same pattern as Client A)     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  FsAgent(folderB, client.bs)                        │   │
│  │  Db(client.io)                                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

#### Writing Data (Client A → Server → Client B)

1. **Client A writes file to filesystem**

   ```typescript
   await writeFile(join(folderA, 'hello.txt'), 'Hello from A');
   ```

2. **FsAgent scans and stores to Db**

   ```typescript
   const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
   ```

   - File content → `client.bs` (stored in localBsA and BsPeer to server)
   - Tree structure → `clientDbA` (using `client.io`: localIoA + IoPeer to server)

3. **Server aggregates the data**
   - Server's internal `BsMulti` now includes Client A's blobs via `BsPeer`
   - Server's internal `IoMulti` now includes Client A's tree data via `IoPeer`

4. **Client B loads from Db**

   ```typescript
   await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
   ```

   - Tree structure read from `clientDbB` (using `client.io`)
   - Since local doesn't have it, reads from server peer
   - Blob content read from `client.bs`
   - Since local doesn't have it, reads from server peer's BsMulti
   - Server's BsMulti includes Client A's blobs
   - Blobs flow: Client A's local → Server → Client B's peer → Client B's local

5. **File appears in Client B's folder**

   ```typescript
   // folderB/hello.txt now contains 'Hello from A'
   ```

#### Live Bidirectional Sync

With watchers enabled on both clients:

```typescript
// Client A: Watch filesystem → sync to DB
const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', { notify: true });

// Client B: Watch DB → sync to filesystem
const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree');
```

Now changes flow automatically:

- Edit file in folderA → agentA detects → stores to clientDbA → notifies subscribers
- clientDbB receives notification → agentB loads → updates folderB
- Works bidirectionally for both A→B and B→A

## Files in This Directory

### client-server-setup.ts

**Purpose:** One-shot demonstration of client-server sync.

**What it does:**

1. Creates a server with in-memory I/O and blob storage
2. Sets up two clients (A and B) with their own local storage
3. Writes a file in folder A
4. Syncs from A to the shared database
5. Syncs from database to B
6. Returns results showing both folders have the same content

**Use case:** Testing, examples, demonstrations of the basic pattern.

```typescript
import { runClientServerSetup } from './client-server/client-server-setup.ts';

const { folderA, folderB, contentB, cleanup } = await runClientServerSetup({
  baseDir: '/tmp/my-demo',
  treeKey: 'sharedTree'
});

console.log(contentB); // "Hello from Client A"
await cleanup();
```

### live-client-server.ts

**Purpose:** Long-running demonstration with live filesystem watching.

**What it does:**

1. Creates server and two clients (same as setup)
2. Seeds initial files in both folders
3. Starts bidirectional live sync with filesystem watchers
4. Keeps running until you press Ctrl+C
5. Any edit in folderA automatically propagates to folderB and vice versa

**Use case:** Development, debugging, understanding live sync behavior.

**Run it:**

```bash
# Start with fresh folders
pnpm exec vite-node src/client-server/live-client-server.ts

# Keep existing content
pnpm exec vite-node src/client-server/live-client-server.ts --keep-existing
```

**Try it:**

1. Open two terminal windows side by side
2. Run `watch ls -la demo/live-client-server/folder-a` in one
3. Run `watch ls -la demo/live-client-server/folder-b` in the other
4. Edit files in either folder
5. Watch them appear in the other folder automatically

## Testing

The comprehensive test suite in `test/client-server/full-sync-test.spec.ts` validates:

- ✅ One-shot syncs (A→B, B→A)
- ✅ File updates and modifications
- ✅ Nested directory structures
- ✅ Binary file handling
- ✅ Large file transfers with checksum verification
- ✅ Deletion handling with `cleanTarget: true` (removes stale files)
- ✅ Rename/move operations with proper cleanup
- ✅ Nested directory cleanup with `cleanTarget`
- ✅ Hidden files
- ✅ Conflict resolution (last writer wins)
- ✅ Modification time preservation
- ✅ Idempotency (same tree ref → same result)
- ✅ Live sync with filesystem watchers
- ✅ Bidirectional propagation

All tests use the exact same Server/Client pattern documented here.

**Coverage:** The project maintains 100% test coverage across all metrics (statements, branches, functions, lines). Every code path is validated, including error scenarios and edge cases.

## Key Characteristics

### Local-First with Server Sync

Clients prioritize local storage (priority 1) over server peers (priority 2):

- **Reads:** Check local first, fall back to server if not found
- **Writes:** Go to local storage immediately
- **Sync:** Happens asynchronously through the Client/Server architecture

### Socket-Based Communication

All client-server communication happens over sockets:

- In these examples: `DirectionalSocketMock` via `createSocketPair()` (in-memory, same process)
- In production: Real WebSocket, TCP socket, or other socket implementation
- The Server and Client classes abstract away the socket details

**Critical:** Always use `createSocketPair()` from `@rljson/io` to create proper bidirectional socket pairs. Single `SocketMock` instances are deprecated and can cause communication issues.

### Blob Storage Propagation

The `BsMulti` + `BsPeer` architecture ensures blobs flow correctly:

- Client writes blob → stored in local `BsMem` + sent to server via `BsPeer`
- Server aggregates all clients' blobs via its internal `BsMulti`
- Other clients can read blobs from their `BsPeer` → server's `BsMulti` → original client's blob

### Database Operations Through IoMulti

All database operations use `client.io`, which ensures:

- Clients have independent local state
- Server aggregates all clients' changes
- Proper isolation and synchronization
- Consistent view through the multi-layer architecture

## Common Patterns

### Setting Up a Client-Server Environment

```typescript
// 1. Server
const serverIo = new IoMem();
await serverIo.init();
await createSharedTreeTable(serverIo);
const server = new Server(route, serverIo, new BsMem());
await server.init();

// 2. Client (use DirectionalSocketMock pair)
const [serverSocket, clientSocket] = createSocketPair();
serverSocket.connect();
await server.addSocket(serverSocket);

const localIo = new IoMem();
await localIo.init();
await createSharedTreeTable(localIo);

const client = new Client(clientSocket, localIo, new BsMem());
await client.init();

// 3. Use client for operations
const clientDb = new Db(client.io);
const agent = new FsAgent(folder, client.bs);
```

### One-Shot Sync

```typescript
// Client A: Store filesystem to database
const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');

// Client B: Load from database to filesystem
await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
```

### Live Bidirectional Sync

```typescript
// Create connectors for both clients
const treeKey = 'sharedTree';
const route = Route.fromFlat(`/${treeKey}`);
const connectorA = new Connector(clientDbA, route, socketA);
const connectorB = new Connector(clientDbB, route, socketB);

// Both clients: watch filesystem → sync to DB
const stopAtoDb = await agentA.syncToDb(clientDbA, connectorA, treeKey, { notify: true });
const stopBtoDb = await agentB.syncToDb(clientDbB, connectorB, treeKey, { notify: true });

// Both clients: watch DB → sync to filesystem (with cleanTarget for deletions)
const stopAfromDb = await agentA.syncFromDb(clientDbA, connectorA, treeKey, { cleanTarget: true });
const stopBfromDb = await agentB.syncFromDb(clientDbB, connectorB, treeKey, { cleanTarget: true });

// Later: cleanup
stopAtoDb();
stopBtoDb();
stopAfromDb();
stopBfromDb();
```

## Production Considerations

### Table Schema Management

In production, you'd typically:

1. Use migrations to create tables on the server
2. Have clients validate/sync their local schema on connection
3. Version schemas and handle upgrades gracefully

### Socket Implementation

Replace `DirectionalSocketMock` (from `createSocketPair()`) with real sockets:

- WebSocket for browser clients
- TCP sockets for Node.js clients
- IPC sockets for same-machine processes

**Note:** Real socket implementations must provide the same bidirectional interface as `DirectionalSocketMock`. The `@rljson/io` package handles the abstraction.

### Storage Backends

Replace `IoMem` and `BsMem` with persistent storage:

- `IoSqlite` for SQL-based I/O
- `BsFile` for file-based blob storage
- Custom implementations for cloud storage

### Error Handling

Add proper error handling for:

- Network failures
- Socket disconnections
- Partial sync failures
- Conflict resolution strategies

### Security

Consider:

- Authentication (who can connect?)
- Authorization (who can access which trees?)
- Encryption (secure socket communication)
- Validation (sanitize incoming data)

## Troubleshooting

### "Table does not exist" Error

**Cause:** Table not created in both server and client local I/O.

**Solution:** Ensure `createSharedTreeTable()` is called for both `serverIo` and each `localIo` before creating Server/Client instances.

### Blobs Not Propagating

**Cause:** Not using `client.bs` correctly, or trying to share server's Bs directly.

**Solution:** Always use `client.bs` for FsAgent operations. The Client class handles the multi-layer blob propagation automatically.

### Changes Not Syncing

**Cause:** Database operations using wrong Db instance (e.g., server's Db instead of client's).

**Solution:** Each client must use its own `Db(client.io)` instance for all operations.

## References

- Main architecture documentation: `../../README.architecture.md`
- FsAgent implementation: `../fs-agent.ts`
- Test suite: `../../test/client-server/full-sync-test.spec.ts`
- Copilot instructions: `../../.github/copilot-instructions.md`
- @rljson/server package: External dependency providing Server/Client classes
- @rljson/bs package: Blob storage abstraction (BsMem, BsMulti, BsPeer, BsServer)
- @rljson/io package: I/O abstraction (IoMem, Socket, SocketMock)
