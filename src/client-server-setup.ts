// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { FsAgent } from './fs-agent.ts';

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
  const route = Route.fromFlat('fsagent.demo');
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();
  const serverBs = new BsMem();
  const server = new Server(route, serverIo, serverBs);
  await server.init();
  const sharedDb = new Db(serverIo);
  await sharedDb.core.createTableWithInsertHistory(
    createTreesTableCfg(treeKey),
  );

  // Clients
  const socketA = new SocketMock();
  socketA.connect();
  await server.addSocket(socketA);
  const localIoA = new IoMem();
  await localIoA.init();
  await localIoA.isReady();
  const clientA = new Client(socketA, localIoA, new BsMem());
  await clientA.init();
  const agentA = new FsAgent(folderA, server.bs);

  const socketB = new SocketMock();
  socketB.connect();
  await server.addSocket(socketB);
  const localIoB = new IoMem();
  await localIoB.init();
  await localIoB.isReady();
  const clientB = new Client(socketB, localIoB, new BsMem());
  await clientB.init();
  const agentB = new FsAgent(folderB, server.bs);

  // Write + sync
  const helloPathA = join(folderA, 'hello.txt');
  await writeFile(helloPathA, 'Hello from Client A');
  const rootRef = await agentA.storeInDb(sharedDb, treeKey, { notify: false });
  await agentB.loadFromDb(sharedDb, treeKey, rootRef);
  const contentB = await readFile(join(folderB, 'hello.txt'), 'utf8');

  const cleanup = async () => {
    await rm(baseDir, { recursive: true, force: true });
  };

  return { baseDir, folderA, folderB, contentB, cleanup };
}
