// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, ConsoleLogger, Server, SocketIoBridge } from '@rljson/server';

import { mkdir, rm, writeFile } from 'fs/promises';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'path';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';

import { FsAgent } from '../fs-agent.ts';

async function createSharedTreeTable(io: IoMem) {
  const db = new Db(io);
  const treeCfg = createTreesTableCfg('sharedTree');
  await db.core.createTableWithInsertHistory(treeCfg);
}

/**
 * Live demo with Socket.IO: two folders stay in sync through a real Socket.IO server.
 * This uses production-ready networking architecture.
 *
 * Run from repo root:
 *   pnpm exec vite-node src/client-server/live-client-server-socketio.ts
 */
async function main() {
  console.log('Starting live Socket.IO client-server sync demo...');

  const keepExisting = process.argv.includes('--keep-existing');

  // ---------------------------------------------------------------------------
  // Paths
  const baseDir = join(process.cwd(), 'demo', 'live-client-server-socketio');
  const folderA = join(baseDir, 'folder-a');
  const folderB = join(baseDir, 'folder-b');

  if (!keepExisting) {
    await rm(baseDir, { recursive: true, force: true });
  }

  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });

  // Seed same initial content in both folders
  await writeFile(join(folderA, 'shared.txt'), 'Shared initial content', {
    flag: 'w',
  });
  await writeFile(join(folderB, 'shared.txt'), 'Shared initial content', {
    flag: 'w',
  });

  // ---------------------------------------------------------------------------
  // Socket.IO Server Setup
  const httpServer = createServer();
  const socketIoServer = new SocketIoServer(httpServer, {
    cors: { origin: '*' },
  });

  const treeKey = 'sharedTree';
  const route = Route.fromFlat(`/${treeKey}`);

  // Server storage
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();

  const serverBs = new BsMem();

  // Create table schema on server
  await createSharedTreeTable(serverIo);

  const logger = new ConsoleLogger();

  const server = new Server(route, serverIo, serverBs, { logger });
  await server.init();

  // Register Socket.IO connections
  // Auto-disconnect handling is built into the server — no manual listener needed.
  socketIoServer.on('connection', async (socket) => {
    await server.addSocket(new SocketIoBridge(socket));
  });

  // Start HTTP server
  await new Promise<void>((resolve) => {
    httpServer.listen(() => {
      const port = (httpServer.address() as AddressInfo).port;
      console.log(`Socket.IO server listening on http://localhost:${port}`);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;

  // ---------------------------------------------------------------------------
  // Client A Setup (folder A)
  const clientSocketA = SocketIoClient(`http://localhost:${port}`, {
    forceNew: true,
  });

  await new Promise<void>((resolve) => {
    clientSocketA.on('connect', () => {
      console.log('Client A connected');
      resolve();
    });
  });

  const localIoA = new IoMem();
  await localIoA.init();
  await localIoA.isReady();

  // Create table schema on client A's local Io
  await createSharedTreeTable(localIoA);

  const localBsA = new BsMem();
  const clientA = new Client(
    new SocketIoBridge(clientSocketA),
    localIoA,
    localBsA,
    undefined,
    { logger },
  );
  await clientA.init();

  const clientDbA = new Db(clientA.io!);
  const connectorA = new Connector(
    clientDbA,
    route,
    new SocketIoBridge(clientSocketA),
  );

  const agentA = new FsAgent(folderA, clientA.bs);

  // Client A starts syncToDb and syncFromDb
  const stopAtoDb = await agentA.syncToDb(clientDbA, connectorA, treeKey);
  const stopAfromDb = await agentA.syncFromDb(clientDbA, connectorA, treeKey, {
    cleanTarget: true,
  });

  // ---------------------------------------------------------------------------
  // Client B Setup (folder B)
  const clientSocketB = SocketIoClient(`http://localhost:${port}`, {
    forceNew: true,
  });

  await new Promise<void>((resolve) => {
    clientSocketB.on('connect', () => {
      console.log('Client B connected');
      resolve();
    });
  });

  const localIoB = new IoMem();
  await localIoB.init();
  await localIoB.isReady();

  // Create table schema on client B's local Io
  await createSharedTreeTable(localIoB);

  const localBsB = new BsMem();
  const clientB = new Client(
    new SocketIoBridge(clientSocketB),
    localIoB,
    localBsB,
    undefined,
    { logger },
  );
  await clientB.init();

  const clientDbB = new Db(clientB.io!);
  const connectorB = new Connector(
    clientDbB,
    route,
    new SocketIoBridge(clientSocketB),
  );

  const agentB = new FsAgent(folderB, clientB.bs);

  // Start bidirectional sync for Client B
  const stopBtoDb = await agentB.syncToDb(clientDbB, connectorB, treeKey);
  const stopBfromDb = await agentB.syncFromDb(clientDbB, connectorB, treeKey, {
    cleanTarget: true,
  });

  console.log('\n=== Live Sync Active ===');
  console.log(`  Folder A: ${folderA}`);
  console.log(`  Folder B: ${folderB}`);
  console.log(`  Server: http://localhost:${port}`);
  console.log(
    keepExisting
      ? '  Existing files kept (pass without --keep-existing to reset)'
      : '  Folders reset at startup with sample files',
  );
  console.log(
    '\nChanges propagate via Socket.IO server. Press Ctrl+C to exit.',
  );

  const shutdown = async () => {
    console.log('\nShutting down...');
    stopAtoDb();
    stopAfromDb();
    stopBtoDb();
    stopBfromDb();

    await clientA.tearDown();
    await clientB.tearDown();
    await server.tearDown();

    clientSocketA.disconnect();
    clientSocketB.disconnect();

    await new Promise<void>((resolve) => {
      socketIoServer.close(() => {
        console.log('Socket.IO server closed');
        resolve();
      });
    });

    httpServer.close();
    console.log('HTTP server closed. Bye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
