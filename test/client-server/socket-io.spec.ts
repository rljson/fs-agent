// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server, SocketIoBridge } from '@rljson/server';

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';

import { FsAgent } from '../../src/fs-agent.ts';
import { defineProductionSyncTests } from './shared-sync-tests.ts';

// =============================================================================
// Socket.IO Setup Factory
// =============================================================================

defineProductionSyncTests(
  'Client-Server Sync (SocketIO)',
  async ({ folderA, folderB }) => {
    const treeKey = 'sharedTree';
    const route = Route.fromFlat(`/${treeKey}`);
    const treeCfg = createTreesTableCfg(treeKey);

    // --- HTTP + Socket.IO Server ---
    const httpServer = createServer();
    const socketIoServer = new SocketIoServer(httpServer, {
      cors: { origin: '*' },
    });

    const serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();
    const serverBs = new BsMem();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);

    const server = new Server(route, serverIo, serverBs);
    await server.init();

    socketIoServer.on('connection', async (socket) => {
      await server.addSocket(new SocketIoBridge(socket));
    });

    // Start HTTP server on random port
    await new Promise<void>((resolve) => {
      httpServer.listen(() => resolve());
    });
    const port = (httpServer.address() as AddressInfo).port;

    // --- Client A (Socket.IO) ---
    const clientSocketA = SocketIoClient(`http://localhost:${port}`, {
      forceNew: true,
    });
    await new Promise<void>((resolve) => {
      clientSocketA.on('connect', () => resolve());
    });

    const localIoA = new IoMem();
    await localIoA.init();
    await localIoA.isReady();
    await new Db(localIoA).core.createTableWithInsertHistory(treeCfg);
    const localBsA = new BsMem();
    const clientA = new Client(
      new SocketIoBridge(clientSocketA),
      localIoA,
      localBsA,
    );
    await clientA.init();
    const dbA = new Db(clientA.io!);
    const connectorA = new Connector(
      dbA,
      route,
      new SocketIoBridge(clientSocketA),
    );
    const agentA = new FsAgent(folderA, clientA.bs);

    // --- Client B (Socket.IO) ---
    const clientSocketB = SocketIoClient(`http://localhost:${port}`, {
      forceNew: true,
    });
    await new Promise<void>((resolve) => {
      clientSocketB.on('connect', () => resolve());
    });

    const localIoB = new IoMem();
    await localIoB.init();
    await localIoB.isReady();
    await new Db(localIoB).core.createTableWithInsertHistory(treeCfg);
    const localBsB = new BsMem();
    const clientB = new Client(
      new SocketIoBridge(clientSocketB),
      localIoB,
      localBsB,
    );
    await clientB.init();
    const dbB = new Db(clientB.io!);
    const connectorB = new Connector(
      dbB,
      route,
      new SocketIoBridge(clientSocketB),
    );
    const agentB = new FsAgent(folderB, clientB.bs);

    // Wrap server tearDown to also shut down Socket.IO + HTTP
    const originalTearDown = server.tearDown.bind(server);
    const enhancedServer = {
      tearDown: async () => {
        await originalTearDown();
        clientSocketA.disconnect();
        clientSocketB.disconnect();
        await new Promise<void>((resolve) => {
          socketIoServer.close(() => resolve());
        });
        httpServer.close();
      },
    };

    return {
      treeKey,
      server: enhancedServer,
      clientA,
      clientB,
      dbA,
      dbB,
      connectorA,
      connectorB,
      agentA,
      agentB,
    };
  },
);
