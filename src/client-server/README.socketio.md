# Socket.IO Production Architecture

This document describes the production-ready Socket.IO implementation for real-time filesystem synchronization using `@rljson/fs-agent`.

## Overview

The Socket.IO architecture uses real networking with HTTP server and Socket.IO connections, making it suitable for production deployments where clients run on different machines or processes.

## Architecture

```
┌─────────────┐         Socket.IO          ┌─────────────┐
│  Client A   │◄─────────────────────────►│   Server    │
│  (Folder A) │      HTTP + WebSocket      │   (HTTP)    │
└─────────────┘                            └─────────────┘
                                                  ▲
                                                  │
                                           Socket.IO
                                                  │
                                                  ▼
┌─────────────┐         Socket.IO          ┌─────────────┐
│  Client B   │◄─────────────────────────►│             │
│  (Folder B) │      HTTP + WebSocket      └─────────────┘
└─────────────┘
```

### Key Components

1. **HTTP Server** (`node:http`): Provides the transport layer
2. **Socket.IO Server** (`socket.io`): Manages WebSocket connections
3. **Socket.IO Client** (`socket.io-client`): Connects to server
4. **SocketIoBridge** (`@rljson/server`): Adapts Socket.IO to `@rljson/io` Socket interface
5. **Server** (`@rljson/server`): Aggregates client connections and multicasts refs
6. **Client** (`@rljson/server`): Merges local and server storage via IoMulti/BsMulti

## Files

- **[live-client-server-socketio.ts](live-client-server-socketio.ts)**: Production Socket.IO demo
- **[live-client-server.ts](live-client-server.ts)**: In-memory SocketMock demo (development/testing)

## Running the Demo

From the repository root:

```bash
# Start the Socket.IO live sync demo
pnpm exec vite-node src/client-server/live-client-server-socketio.ts

# Keep existing files (don't reset folders)
pnpm exec vite-node src/client-server/live-client-server-socketio.ts --keep-existing
```

### What Happens

1. **Server starts** on random port (e.g., `http://localhost:62773`)
2. **Client A connects** via Socket.IO, watches `folder-a`, syncs to database
3. **Client B connects** via Socket.IO, watches `folder-b`, syncs to database
4. **Live sync begins**: Changes in either folder propagate to the other

Try it:

```bash
# In one terminal
pnpm exec vite-node src/client-server/live-client-server-socketio.ts

# In another terminal, make changes:
echo "Hello from A" > demo/live-client-server-socketio/folder-a/test.txt
# Watch it appear in folder-b!

echo "Hello from B" > demo/live-client-server-socketio/folder-b/other.txt
# Watch it appear in folder-a!
```

## Production Deployment Patterns

### Separate Server and Clients

In production, run the server and clients in separate processes:

**server.ts**:

```typescript
import { createServer } from 'node:http';
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Server, SocketIoBridge } from '@rljson/server';
import { Server as SocketIoServer } from 'socket.io';

const httpServer = createServer();
const socketIoServer = new SocketIoServer(httpServer, {
  cors: { origin: '*' }, // Configure appropriately for production
});

const route = Route.fromFlat('/sharedTree');
const serverIo = new IoMem(); // Use IoPg or other persistent storage
await serverIo.init();

const server = new Server(route, serverIo, new BsMem());
await server.init();

socketIoServer.on('connection', async (socket) => {
  console.log(`Client connected: ${socket.id}`);
  await server.addSocket(new SocketIoBridge(socket));

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(3000, () => {
  console.log('Server listening on http://localhost:3000');
});
```

**client.ts**:

```typescript
import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Client, SocketIoBridge } from '@rljson/server';
import { io as SocketIoClient } from 'socket.io-client';
import { FsAgent } from '@rljson/fs-agent';

const socket = SocketIoClient('http://localhost:3000', {
  forceNew: true,
});

await new Promise<void>((resolve) => {
  socket.on('connect', () => {
    console.log('Connected to server');
    resolve();
  });
});

const localIo = new IoMem();
await localIo.init();

const client = new Client(new SocketIoBridge(socket), localIo, new BsMem());
await client.init();

// Simplified approach using fromClient factory method
const agent = await FsAgent.fromClient(
  './my-folder',
  'sharedTree',
  client,
  new SocketIoBridge(socket),
);

// Simple sync methods - no db/connector/treeKey needed!
await agent.syncToDbSimple({ notify: true });
await agent.syncFromDbSimple({ cleanTarget: true });

console.log('Client syncing...');
```

Alternatively, use the traditional approach:

```typescript
// Traditional approach (still supported)
const db = new Db(client.io!);
const route = Route.fromFlat('/sharedTree');
const connector = new Connector(db, route, new SocketIoBridge(socket));

const agent = new FsAgent('./my-folder', client.bs);

// Bidirectional sync with explicit parameters
await agent.syncToDb(db, connector, 'sharedTree', { notify: true });
await agent.syncFromDb(db, connector, 'sharedTree', { cleanTarget: true });

console.log('Client syncing...');
```

### Production Considerations

1. **Persistent Storage**: Replace `IoMem` with `IoPg` (PostgreSQL) or other persistent Io implementation
2. **Authentication**: Add Socket.IO authentication middleware
3. **CORS**: Configure appropriate CORS settings for your domain
4. **SSL/TLS**: Use HTTPS and WSS in production
5. **Error Handling**: Add reconnection logic and error handlers
6. **Monitoring**: Log connection/disconnection events
7. **Scaling**: Use Socket.IO Redis adapter for multi-server deployments

### Socket.IO Configuration

```typescript
const socketIoServer = new SocketIoServer(httpServer, {
  cors: {
    origin: 'https://yourdomain.com',
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for large files
  pingTimeout: 60000,
  pingInterval: 25000,
});
```

### Client Reconnection

```typescript
const socket = SocketIoClient('http://localhost:3000', {
  forceNew: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity,
});

socket.on('reconnect', (attemptNumber) => {
  console.log(`Reconnected after ${attemptNumber} attempts`);
  // Reinitialize sync if needed
});

socket.on('reconnect_error', (error) => {
  console.error('Reconnection failed:', error);
});
```

## Comparison: SocketMock vs Socket.IO

| Feature          | SocketMock (Development) | Socket.IO (Production)          |
| ---------------- | ------------------------ | ------------------------------- |
| **Transport**    | In-memory EventEmitter   | HTTP + WebSocket                |
| **Network**      | No network required      | Real networking                 |
| **Processes**    | Single process           | Multiple processes/machines     |
| **Use Case**     | Testing, development     | Production deployment           |
| **Setup**        | `createSocketPair()`     | HTTP server + Socket.IO         |
| **Performance**  | Fastest (no I/O)         | Network latency                 |
| **Dependencies** | `@rljson/io` only        | `socket.io`, `socket.io-client` |

## Architecture Benefits

1. **Local-First**: All writes happen locally, reads cascade from local → server
2. **Pull-Based**: Only references (hashes) are broadcast; data is pulled on demand
3. **Server as Proxy**: Server doesn't store client data unless explicitly configured
4. **Unified Interface**: `Client.io`/`Client.bs` provide transparent multi-layer access

## Testing Strategy

- **Unit Tests**: Use SocketMock with `createSocketPair()` for fast, isolated tests
- **Integration Tests**: Use Socket.IO with real HTTP server for realistic scenarios
- **Production**: Deploy with Socket.IO, persistent storage, and appropriate scaling

## Related Documentation

- [README.md](README.md): Main client-server architecture documentation
- [../../README.architecture.md](../../README.architecture.md): Critical architecture rules
- [@rljson/server README](https://github.com/rljson/server/blob/main/README.public.md): Server package documentation
- [Socket.IO Documentation](https://socket.io/docs/v4/): Official Socket.IO docs

## Example Output

```
Starting live Socket.IO client-server sync demo...
Socket.IO server listening on http://localhost:62773
Client connected: rDCCnwZgbsnDGL2HAAAB
Client A connected
Client connected: qmTqJzGyTB4-vyiKAAAD
Client B connected

=== Live Sync Active ===
  Folder A: /path/to/folder-a
  Folder B: /path/to/folder-b
  Server: http://localhost:62773
  Folders reset at startup with sample files

Changes propagate via Socket.IO server. Press Ctrl+C to exit.
```

Changes made to files in either folder will automatically sync to the other folder through the Socket.IO server.
