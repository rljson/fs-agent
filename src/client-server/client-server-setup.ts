// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { FsAgent } from '../fs-agent.ts';

async function createSharedTreeTable(io: IoMem, treeKey: string) {
  const db = new Db(io);
  const treeCfg = createTreesTableCfg(treeKey);
  await db.core.createTableWithInsertHistory(treeCfg);
}

export interface ClientServerSetupOptions {
  baseDir?: string;
  treeKey?: string;
}

export interface ClientServerSetupResult {
  baseDir: string;
  folderA: string;
  folderB: string;
  contentB: string;
  cleanup: () => Promise<void>;
}

/**
 * One-shot client/server setup that writes a file in folder A, stores it to a
 * shared Db, loads into folder B, and returns the synced content.
 * @param opts - Optional overrides (baseDir, treeKey)
 */
export async function runClientServerSetup(
  opts: ClientServerSetupOptions = {},
): Promise<ClientServerSetupResult> {
  const baseDir = opts.baseDir || join(process.cwd(), 'demo', 'client-server');
  const folderA = join(baseDir, 'folder-a');
  const folderB = join(baseDir, 'folder-b');
  const treeKey = opts.treeKey || 'sharedTree';

  // Reset folders
  await rm(baseDir, { recursive: true, force: true });
  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });

  // Server
  const route = Route.fromFlat(`/${treeKey}`);
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();

  const { BsMem } = await import('@rljson/bs');

  const serverBsMem = new BsMem();

  // Create table schema on server
  await createSharedTreeTable(serverIo, treeKey);

  const server = new Server(route, serverIo, serverBsMem);
  await server.init();

  // Client A setup - use DirectionalSocketMock for proper client/server separation
  const [serverSocketA, clientSocketA] = createSocketPair();
  serverSocketA.connect();
  await server.addSocket(serverSocketA);
  const localIoA = new IoMem();
  await localIoA.init();
  await localIoA.isReady();

  // Create table schema on client A's local Io
  await createSharedTreeTable(localIoA, treeKey);

  const localBsA = new BsMem();
  const clientA = new Client(clientSocketA, localIoA, localBsA);
  await clientA.init();
  const clientDbA = new Db(clientA.io!);
  const agentA = new FsAgent(folderA, clientA.bs);

  // Client B setup - use DirectionalSocketMock for proper client/server separation
  const [serverSocketB, clientSocketB] = createSocketPair();
  serverSocketB.connect();
  await server.addSocket(serverSocketB);
  const localIoB = new IoMem();
  await localIoB.init();
  await localIoB.isReady();

  // Create table schema on client B's local Io
  await createSharedTreeTable(localIoB, treeKey);

  const localBsB = new BsMem();
  const clientB = new Client(clientSocketB, localIoB, localBsB);
  await clientB.init();
  const clientDbB = new Db(clientB.io!);
  const agentB = new FsAgent(folderB, clientB.bs);

  // Write + sync
  const helloPathA = join(folderA, 'hello.txt');
  await writeFile(helloPathA, 'Hello from Client A');
  const rootRef = await agentA.storeInDb(clientDbA, treeKey, { notify: false });
  await agentB.loadFromDb(clientDbB, treeKey, rootRef);
  const contentB = await readFile(join(folderB, 'hello.txt'), 'utf8');

  const cleanup = async () => {
    await rm(baseDir, { recursive: true, force: true });
  };

  return { baseDir, folderA, folderB, contentB, cleanup };
}
