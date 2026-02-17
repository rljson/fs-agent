// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { FsAgent } from '../../src/fs-agent.ts';
import { defineProductionSyncTests } from './shared-sync-tests.ts';

// =============================================================================
// SocketMock Setup Factory
// =============================================================================

defineProductionSyncTests(
  'Client-Server Sync (SocketMock)',
  async ({ folderA, folderB }) => {
    const treeKey = 'sharedTree';
    const route = Route.fromFlat(`/${treeKey}`);
    const treeCfg = createTreesTableCfg(treeKey);

    // --- Server ---
    const serverIo = new IoMem();
    await serverIo.init();
    const serverBs = new BsMem();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    const server = new Server(route, serverIo, serverBs);
    await server.init();

    // --- Client A ---
    const [serverSocketA, clientSocketA] = createSocketPair();
    serverSocketA.connect();
    await server.addSocket(serverSocketA);

    const localIoA = new IoMem();
    await localIoA.init();
    await localIoA.isReady();
    await new Db(localIoA).core.createTableWithInsertHistory(treeCfg);
    const localBsA = new BsMem();
    const clientA = new Client(clientSocketA, localIoA, localBsA);
    await clientA.init();
    const dbA = new Db(clientA.io!);
    const connectorA = new Connector(dbA, route, clientSocketA);
    const agentA = new FsAgent(folderA, clientA.bs);

    // --- Client B ---
    const [serverSocketB, clientSocketB] = createSocketPair();
    serverSocketB.connect();
    await server.addSocket(serverSocketB);

    const localIoB = new IoMem();
    await localIoB.init();
    await localIoB.isReady();
    await new Db(localIoB).core.createTableWithInsertHistory(treeCfg);
    const localBsB = new BsMem();
    const clientB = new Client(clientSocketB, localIoB, localBsB);
    await clientB.init();
    const dbB = new Db(clientB.io!);
    const connectorB = new Connector(dbB, route, clientSocketB);
    const agentB = new FsAgent(folderB, clientB.bs);

    return {
      treeKey,
      server,
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
