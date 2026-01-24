<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Architecture

## Architectural Rules (DO NOT VIOLATE)

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
