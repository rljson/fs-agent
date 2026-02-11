// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * Example: Simplified FsAgent usage with fromClient() factory method
 *
 * This demonstrates the streamlined API where db, connector, and treeKey
 * are configured once and sync methods don't require repetitive parameters.
 */

import { createServer } from 'node:http';
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Client, Server, SocketIoBridge } from '@rljson/server';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';
import { FsAgent } from '../fs-agent.ts';

async function main() {
  // -------------------------------------------------------------------------
  // Server Setup
  // -------------------------------------------------------------------------
  const httpServer = createServer();
  const socketIoServer = new SocketIoServer(httpServer, {
    cors: { origin: '*' },
  });

  const route = Route.fromFlat('/sharedTree');
  const serverIo = new IoMem();
  await serverIo.init();

  const server = new Server(route, serverIo, new BsMem());
  await server.init();

  socketIoServer.on('connection', async (socket) => {
    console.log(`Client connected: ${socket.id}`);
    await server.addSocket(new SocketIoBridge(socket));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const port = (httpServer.address() as any).port;
      console.log(`Server listening on http://localhost:${port}`);
      resolve();
    });
  });

  const port = (httpServer.address() as any).port;

  // -------------------------------------------------------------------------
  // Client Setup with fromClient() - Simplified API
  // -------------------------------------------------------------------------
  const clientSocket = SocketIoClient(`http://localhost:${port}`, {
    forceNew: true,
  });

  await new Promise<void>((resolve) => {
    clientSocket.on('connect', () => {
      console.log('Client connected');
      resolve();
    });
  });

  const localIo = new IoMem();
  await localIo.init();

  const client = new Client(
    new SocketIoBridge(clientSocket),
    localIo,
    new BsMem(),
  );
  await client.init();

  // ✨ NEW: Use fromClient factory method for simplified setup
  const agent = await FsAgent.fromClient(
    './demo-folder', // File path
    'sharedTree', // Tree key (route will be /sharedTree)
    client, // Client instance
    new SocketIoBridge(clientSocket), // Socket for connector
  );

  console.log('FsAgent created with fromClient()');

  // ✨ NEW: Simplified sync methods - no db/connector/treeKey parameters!
  const stopToDb = await agent.syncToDbSimple({ notify: true });
  const stopFromDb = await agent.syncFromDbSimple({ cleanTarget: true });

  console.log('✓ Bidirectional sync active with simplified API');
  console.log('  syncToDbSimple() - watches filesystem → syncs to database');
  console.log('  syncFromDbSimple() - watches database → syncs to filesystem');

  // Traditional API still works
  // await agent.syncToDb(db, connector, 'sharedTree', { notify: true });
  // await agent.syncFromDb(db, connector, 'sharedTree', { cleanTarget: true });

  // Cleanup after a few seconds
  setTimeout(() => {
    stopToDb();
    stopFromDb();
    clientSocket.close();
    httpServer.close();
    console.log('\\n✓ Cleanup complete');
    process.exit(0);
  }, 3000);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
