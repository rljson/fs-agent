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

import { createHash, randomBytes } from 'crypto';
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'vitest';

import { runClientServerSetup } from '../src/client-server-setup.ts';
import { FsAgent } from '../src/fs-agent.ts';

async function setupServer() {
  const route = Route.fromFlat('fsagent.demo.test');
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();
  const serverBs = new BsMem();
  const server = new Server(route, serverIo, serverBs);
  await server.init();
  const sharedDb = new Db(serverIo);
  const treeCfg = createTreesTableCfg('sharedTree');
  await sharedDb.core.createTableWithInsertHistory(treeCfg);
  return { server, sharedDb };
}

async function setupClient(server: Server) {
  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);
  const localIo = new IoMem();
  await localIo.init();
  await localIo.isReady();
  const client = new Client(socket, localIo, new BsMem());
  await client.init();
  return { client };
}

async function createTempFolders() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'fs-agent-demo-'));
  const folderA = join(tempRoot, 'folder-a');
  const folderB = join(tempRoot, 'folder-b');
  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });
  return { tempRoot, folderA, folderB };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

describe('client-server setup helper', () => {
  test('runs end-to-end and cleans up', async () => {
    const tempBase = await mkdtemp(join(tmpdir(), 'fs-agent-setup-'));
    const { folderA, folderB, contentB, cleanup } = await runClientServerSetup({
      baseDir: tempBase,
    });

    const helloPathA = join(folderA, 'hello.txt');
    const helloPathB = join(folderB, 'hello.txt');

    // Validate synced content and existence
    expect(contentB).toBe('Hello from Client A');
    expect(await readFile(helloPathA, 'utf8')).toBe('Hello from Client A');
    expect(await readFile(helloPathB, 'utf8')).toBe('Hello from Client A');

    await cleanup();
  });
});

describe('client-server folder sync', () => {
  test('syncs file from A to B', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();

    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const helloPathA = join(folderA, 'hello.txt');
    await writeFile(helloPathA, 'Hello from Client A');

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree', {
      notify: false,
    });
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const contentB = await readFile(join(folderB, 'hello.txt'), 'utf8');
    expect(contentB).toBe('Hello from Client A');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('syncs back from B to A', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();

    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    await writeFile(join(folderA, 'seed.txt'), 'seed');
    const seedRoot = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', seedRoot);

    await writeFile(join(folderB, 'reply.txt'), 'Hello from Client B');
    const rootRef = await agentB.storeInDb(sharedDb, 'sharedTree');
    await agentA.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const contentA = await readFile(join(folderA, 'reply.txt'), 'utf8');
    expect(contentA).toBe('Hello from Client B');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('updates existing files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const filePath = join(folderA, 'note.txt');
    await writeFile(filePath, 'v1');
    const baseRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', baseRef);

    await writeFile(filePath, 'v2');
    const freshAgentA = new FsAgent(folderA, server.bs);
    const updatedRef = await freshAgentA.storeInDb(sharedDb, 'sharedTree');

    // Mimic a fresh restore (FsAgent.restore does not delete extraneous files)
    await rm(folderB, { recursive: true, force: true });
    await mkdir(folderB, { recursive: true });
    await agentB.loadFromDb(sharedDb, 'sharedTree', updatedRef);

    const contentB = await readFile(join(folderB, 'note.txt'), 'utf8');
    expect(contentB).toBe('v2');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('does not currently propagate deletions (documented behavior)', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const keepPath = join(folderA, 'keep.txt');
    const dropPath = join(folderA, 'drop.txt');
    await writeFile(keepPath, 'keep');
    await writeFile(dropPath, 'drop');

    const baseRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', baseRef);

    await rm(dropPath);

    const updatedRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', updatedRef);

    expect(await fileExists(join(folderB, 'keep.txt'))).toBe(true);
    // FsAgent.restore does not delete extra files; current behavior retains stale files
    expect(await fileExists(join(folderB, 'drop.txt'))).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('handles nested directories', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const deepDir = join(folderA, 'level1', 'level2');
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'nested.txt'), 'nested content');
    await writeFile(join(folderA, 'root.txt'), 'root content');

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const nestedB = await readFile(
      join(folderB, 'level1', 'level2', 'nested.txt'),
      'utf8',
    );
    const rootB = await readFile(join(folderB, 'root.txt'), 'utf8');

    expect(nestedB).toBe('nested content');
    expect(rootB).toBe('root content');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('syncs binary files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const binPath = join(folderA, 'blob.bin');
    const data = randomBytes(1024);
    await writeFile(binPath, data);

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const dataB = await readFile(join(folderB, 'blob.bin'));
    expect(dataB.equals(data)).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('removes stale files when cleanTarget is enabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const keepPath = join(folderA, 'keep.txt');
    const dropPath = join(folderA, 'drop.txt');
    const staleDir = join(folderA, 'stale-dir');
    const staleFile = join(staleDir, 'stale.txt');
    await writeFile(keepPath, 'keep');
    await writeFile(dropPath, 'drop');
    await mkdir(staleDir, { recursive: true });
    await writeFile(staleFile, 'stale');

    const baseRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', baseRef);

    await rm(dropPath);
    await rm(staleDir, { recursive: true, force: true });
    const updatedRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', updatedRef, undefined, {
      cleanTarget: true,
    });

    expect(await fileExists(join(folderB, 'keep.txt'))).toBe(true);
    expect(await fileExists(join(folderB, 'drop.txt'))).toBe(false);
    expect(await fileExists(join(folderB, 'stale-dir'))).toBe(false);

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('propagates renames/moves when cleanTarget is enabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const originalPath = join(folderA, 'old.txt');
    await writeFile(originalPath, 'v1');

    const baseRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', baseRef);

    const movedPath = join(folderA, 'moved', 'renamed.txt');
    await mkdir(join(folderA, 'moved'), { recursive: true });
    await rename(originalPath, movedPath);

    const updatedRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', updatedRef, undefined, {
      cleanTarget: true,
    });

    expect(await fileExists(join(folderB, 'moved', 'renamed.txt'))).toBe(true);
    expect(await fileExists(join(folderB, 'old.txt'))).toBe(false);

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('syncs zero-byte files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const emptyPath = join(folderA, 'empty.txt');
    await writeFile(emptyPath, '');

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const content = await readFile(join(folderB, 'empty.txt'), 'utf8');
    expect(content).toBe('');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('syncs hidden files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const hiddenPath = join(folderA, '.env.local');
    await writeFile(hiddenPath, 'SECRET=1');

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const content = await readFile(join(folderB, '.env.local'), 'utf8');
    expect(content).toBe('SECRET=1');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('syncs large files with checksum verification', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const largePath = join(folderA, 'large.bin');
    const data = randomBytes(2 * 1024 * 1024); // 2MB
    await writeFile(largePath, data);

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const hashA = await hashFile(largePath);
    const hashB = await hashFile(join(folderB, 'large.bin'));
    expect(hashB).toBe(hashA);

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('last writer wins on conflicting edits', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const conflictPath = join(folderA, 'conflict.txt');
    await writeFile(conflictPath, 'seed');

    const baseRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', baseRef);

    await writeFile(conflictPath, 'A2');
    await writeFile(join(folderB, 'conflict.txt'), 'B2');

    const bRef = await agentB.storeInDb(sharedDb, 'sharedTree');
    await agentA.loadFromDb(sharedDb, 'sharedTree', bRef);

    const contentA = await readFile(conflictPath, 'utf8');
    expect(contentA).toBe('B2');

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('preserves mtime when restoring', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const filePath = join(folderA, 'timestamped.txt');
    await writeFile(filePath, 'time');
    const fixedDate = new Date('2020-01-01T00:00:00Z');
    await utimes(filePath, fixedDate, fixedDate);

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);

    const stats = await stat(join(folderB, 'timestamped.txt'));
    expect(Math.abs(stats.mtime.getTime() - fixedDate.getTime())).toBeLessThan(
      1500,
    );

    await rm(tempRoot, { recursive: true, force: true });
  });

  test('restore is idempotent for the same root ref', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server, sharedDb } = await setupServer();
    await setupClient(server);
    await setupClient(server);

    const agentA = new FsAgent(folderA, server.bs);
    const agentB = new FsAgent(folderB, server.bs);

    const filePath = join(folderA, 'note.txt');
    await writeFile(filePath, 'one');

    const rootRef = await agentA.storeInDb(sharedDb, 'sharedTree');
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);
    const firstHash = await hashFile(join(folderB, 'note.txt'));

    // Second restore should leave file untouched
    await agentB.loadFromDb(sharedDb, 'sharedTree', rootRef);
    const secondHash = await hashFile(join(folderB, 'note.txt'));

    expect(secondHash).toBe(firstHash);

    await rm(tempRoot, { recursive: true, force: true });
  });
});
