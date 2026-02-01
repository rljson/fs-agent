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

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { FsAgent } from '../fs-agent.ts';

async function createSharedTreeTable(io: IoMem) {
  const db = new Db(io);
  const treeCfg = createTreesTableCfg('sharedTree');
  await db.core.createTableWithInsertHistory(treeCfg);
}

/**
 * Live demo: two folders stay in sync through an in-process rljson server.
 * No real networking required (SocketMock). Keeps running so you can edit files
 * in folder A/B and watch them propagate.
 *
 * Run from repo root:
 *   pnpm exec vite-node src/live-client-server.ts
 */
async function main() {
  console.log('Starting live client-server sync demo...');

  const keepExisting = process.argv.includes('--keep-existing');

  // ---------------------------------------------------------------------------
  // Paths (leave existing content; create if missing)
  const baseDir = join(process.cwd(), 'demo', 'live-client-server');
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
  // Server setup (local Io/Bs)
  const treeKey = 'sharedTree';
  const route = Route.fromFlat(`/${treeKey}`);
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();

  const serverBs = new BsMem();

  // Create table schema on server
  await createSharedTreeTable(serverIo);

  const server = new Server(route, serverIo, serverBs);
  await server.init();

  // ---------------------------------------------------------------------------
  // Client A (folder A)
  const [serverSocketA, clientSocketA] = createSocketPair();
  serverSocketA.connect();
  await server.addSocket(serverSocketA);

  const localIoA = new IoMem();
  await localIoA.init();
  await localIoA.isReady();

  // Create table schema on client A's local Io
  await createSharedTreeTable(localIoA);

  const localBsA = new BsMem();
  const clientA = new Client(clientSocketA, localIoA, localBsA);
  await clientA.init();

  const clientDbA = new Db(clientA.io!);
  const connectorA = new Connector(clientDbA, route, clientSocketA);

  const agentA = new FsAgent(folderA, clientA.bs);

  // Client A starts syncToDb and syncFromDb immediately
  const stopAtoDb = await agentA.syncToDb(clientDbA, connectorA, treeKey, {
    notify: true,
  });
  const stopAfromDb = await agentA.syncFromDb(clientDbA, connectorA, treeKey, {
    cleanTarget: true,
  });

  // ---------------------------------------------------------------------------
  // Client B (folder B)
  const [serverSocketB, clientSocketB] = createSocketPair();
  serverSocketB.connect();
  await server.addSocket(serverSocketB);

  const localIoB = new IoMem();
  await localIoB.init();
  await localIoB.isReady();

  // Create table schema on client B's local Io
  await createSharedTreeTable(localIoB);

  const localBsB = new BsMem();
  const clientB = new Client(clientSocketB, localIoB, localBsB);
  await clientB.init();

  const clientDbB = new Db(clientB.io!);
  const connectorB = new Connector(clientDbB, route, clientSocketB);

  const agentB = new FsAgent(folderB, clientB.bs);

  // Start bidirectional sync for Client B
  const stopBtoDb = await agentB.syncToDb(clientDbB, connectorB, treeKey, {
    notify: true,
  });
  const stopBfromDb = await agentB.syncFromDb(clientDbB, connectorB, treeKey, {
    cleanTarget: true,
  });
  console.log(`  Folder A: ${folderA}`);
  console.log(`  Folder B: ${folderB}`);
  console.log(
    keepExisting
      ? 'Existing files kept (pass without --keep-existing to reset)'
      : 'Folders reset at startup with sample files',
  );
  console.log(
    'Changes propagate both ways via shared DB + server Bs. Press Ctrl+C to exit.',
  );

  const shutdown = () => {
    stopAtoDb();
    stopAfromDb();
    stopBtoDb();
    stopBfromDb();
    console.log('Stopped watchers. Bye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
