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
  copyFile,
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
import { describe, expect, it } from 'vitest';

import { runClientServerSetup } from '../src/client-server/client-server-setup.ts';
import { FsAgent } from '../src/fs-agent.ts';

async function createSharedTreeTable(io: IoMem) {
  const db = new Db(io);
  const treeCfg = createTreesTableCfg('sharedTree');
  await db.core.createTableWithInsertHistory(treeCfg);
}

async function setupServer() {
  const route = Route.fromFlat('fsagent.demo.test');
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();

  // Create table schema on server
  await createSharedTreeTable(serverIo);

  const serverBs = new BsMem();
  const server = new Server(route, serverIo, serverBs);
  await server.init();

  return { server };
}

async function setupClient(server: Server) {
  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);

  const localIo = new IoMem();
  await localIo.init();
  await localIo.isReady();

  // Create table schema on client's local Io
  await createSharedTreeTable(localIo);

  const localBs = new BsMem();
  const client = new Client(socket, localIo, localBs);
  await client.init();

  const clientDb = new Db(client.io!);

  return { client, clientDb };
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

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

describe('client-server setup helper', () => {
  it('runs end-to-end and cleans up', async () => {
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
  }, 10000);
});

describe('client-server folder sync', () => {
  it('syncs file from A to B', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();

    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const helloPathA = join(folderA, 'hello.txt');
    await writeFile(helloPathA, 'Hello from Client A');

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree', {
      notify: false,
    });
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const contentB = await readFile(join(folderB, 'hello.txt'), 'utf8');
    expect(contentB).toBe('Hello from Client A');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('syncs back from B to A', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();

    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    await writeFile(join(folderA, 'seed.txt'), 'seed');
    const seedRoot = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', seedRoot);

    await writeFile(join(folderB, 'reply.txt'), 'Hello from Client B');
    const rootRef = await agentB.storeInDb(clientDbB, 'sharedTree');
    await agentA.loadFromDb(clientDbA, 'sharedTree', rootRef);

    const contentA = await readFile(join(folderA, 'reply.txt'), 'utf8');
    expect(contentA).toBe('Hello from Client B');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('updates existing files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const filePath = join(folderA, 'note.txt');
    await writeFile(filePath, 'v1');
    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    await writeFile(filePath, 'v2');
    const freshAgentA = new FsAgent(folderA, clientA.bs);
    const updatedRef = await freshAgentA.storeInDb(clientDbA, 'sharedTree');

    // Mimic a fresh restore (FsAgent.restore does not delete extraneous files)
    await rm(folderB, { recursive: true, force: true });
    await mkdir(folderB, { recursive: true });
    await agentB.loadFromDb(clientDbB, 'sharedTree', updatedRef);

    const contentB = await readFile(join(folderB, 'note.txt'), 'utf8');
    expect(contentB).toBe('v2');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('does not currently propagate deletions (documented behavior)', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const keepPath = join(folderA, 'keep.txt');
    const dropPath = join(folderA, 'drop.txt');
    await writeFile(keepPath, 'keep');
    await writeFile(dropPath, 'drop');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    await rm(dropPath);

    const updatedRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', updatedRef);

    expect(await fileExists(join(folderB, 'keep.txt'))).toBe(true);
    // FsAgent.restore does not delete extra files; current behavior retains stale files
    expect(await fileExists(join(folderB, 'drop.txt'))).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('handles nested directories', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const deepDir = join(folderA, 'level1', 'level2');
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'nested.txt'), 'nested content');
    await writeFile(join(folderA, 'root.txt'), 'root content');

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const nestedB = await readFile(
      join(folderB, 'level1', 'level2', 'nested.txt'),
      'utf8',
    );
    const rootB = await readFile(join(folderB, 'root.txt'), 'utf8');

    expect(nestedB).toBe('nested content');
    expect(rootB).toBe('root content');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('syncs binary files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const binPath = join(folderA, 'blob.bin');
    const data = randomBytes(1024);
    await writeFile(binPath, data);

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const dataB = await readFile(join(folderB, 'blob.bin'));
    expect(dataB.equals(data)).toBe(true);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('removes stale files when cleanTarget is enabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const keepPath = join(folderA, 'keep.txt');
    const dropPath = join(folderA, 'drop.txt');
    const staleDir = join(folderA, 'stale-dir');
    const staleFile = join(staleDir, 'stale.txt');
    await writeFile(keepPath, 'keep');
    await writeFile(dropPath, 'drop');
    await mkdir(staleDir, { recursive: true });
    await writeFile(staleFile, 'stale');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    await rm(dropPath);
    await rm(staleDir, { recursive: true, force: true });
    const updatedRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', updatedRef, undefined, {
      cleanTarget: true,
    });

    expect(await fileExists(join(folderB, 'keep.txt'))).toBe(true);
    expect(await fileExists(join(folderB, 'drop.txt'))).toBe(false);
    expect(await fileExists(join(folderB, 'stale-dir'))).toBe(false);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('propagates renames/moves when cleanTarget is enabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const originalPath = join(folderA, 'old.txt');
    await writeFile(originalPath, 'v1');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    const movedPath = join(folderA, 'moved', 'renamed.txt');
    await mkdir(join(folderA, 'moved'), { recursive: true });
    await rename(originalPath, movedPath);

    const updatedRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', updatedRef, undefined, {
      cleanTarget: true,
    });

    expect(await fileExists(join(folderB, 'moved', 'renamed.txt'))).toBe(true);
    expect(await fileExists(join(folderB, 'old.txt'))).toBe(false);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('syncs zero-byte files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const emptyPath = join(folderA, 'empty.txt');
    await writeFile(emptyPath, '');

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const content = await readFile(join(folderB, 'empty.txt'), 'utf8');
    expect(content).toBe('');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('syncs hidden files', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);
    const hiddenPath = join(folderA, '.env.local');
    await writeFile(hiddenPath, 'SECRET=1');

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const content = await readFile(join(folderB, '.env.local'), 'utf8');
    expect(content).toBe('SECRET=1');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('syncs large files with checksum verification', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const largePath = join(folderA, 'large.bin');
    const data = randomBytes(2 * 1024 * 1024); // 2MB
    await writeFile(largePath, data);

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const hashA = await hashFile(largePath);
    const hashB = await hashFile(join(folderB, 'large.bin'));
    expect(hashB).toBe(hashA);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('last writer wins on conflicting edits', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const conflictPath = join(folderA, 'conflict.txt');
    await writeFile(conflictPath, 'seed');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    await writeFile(conflictPath, 'A2');
    await writeFile(join(folderB, 'conflict.txt'), 'B2');

    const bRef = await agentB.storeInDb(clientDbB, 'sharedTree');
    await agentA.loadFromDb(clientDbA, 'sharedTree', bRef);

    const contentA = await readFile(conflictPath, 'utf8');
    expect(contentA).toBe('B2');

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('preserves mtime when restoring', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const filePath = join(folderA, 'timestamped.txt');
    await writeFile(filePath, 'time');
    const fixedDate = new Date('2020-01-01T00:00:00Z');
    await utimes(filePath, fixedDate, fixedDate);

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);

    const stats = await stat(join(folderB, 'timestamped.txt'));
    expect(Math.abs(stats.mtime.getTime() - fixedDate.getTime())).toBeLessThan(
      1500,
    );

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('restore is idempotent for the same root ref', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const filePath = join(folderA, 'note.txt');
    await writeFile(filePath, 'one');

    const rootRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
    const firstHash = await hashFile(join(folderB, 'note.txt'));

    // Second restore should leave file untouched
    await agentB.loadFromDb(clientDbB, 'sharedTree', rootRef);
    const secondHash = await hashFile(join(folderB, 'note.txt'));

    expect(secondHash).toBe(firstHash);

    await rm(tempRoot, { recursive: true, force: true });
  }, 10000);

  it('live sync propagates copied files with watchers', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const sourcePath = join(folderA, 'hello.txt');
    await writeFile(sourcePath, 'hello');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef, undefined, {
      cleanTarget: true,
    });

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree', {
      cleanTarget: true,
    });

    const copyPath = join(folderA, 'copy.txt');
    await copyFile(sourcePath, copyPath);

    await waitFor(async () => {
      try {
        const content = await readFile(join(folderB, 'copy.txt'), 'utf8');
        return content === 'hello';
      } catch {
        return false;
      }
    }, 10000);

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 15000);

  it('live sync propagates copied files without cleanTarget (stale allowed)', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const sourcePath = join(folderA, 'hello.txt');
    await writeFile(sourcePath, 'hello');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree');

    const copyPath = join(folderA, 'copy.txt');
    await copyFile(sourcePath, copyPath);

    await waitFor(async () => {
      try {
        const content = await readFile(join(folderB, 'copy.txt'), 'utf8');
        return content === 'hello';
      } catch {
        return false;
      }
    }, 10000);

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 20000);

  it('live sync removes deletions when cleanTarget is enabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const filePath = join(folderA, 'to-delete.txt');
    await writeFile(filePath, 'bye');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef, undefined, {
      cleanTarget: true,
    });

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree', {
      cleanTarget: true,
    });

    await rm(filePath);

    await waitFor(async () => {
      return !(await fileExists(join(folderB, 'to-delete.txt')));
    }, 10000);

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 15000);

  it('live sync propagates renames with cleanTarget', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const oldPath = join(folderA, 'old.txt');
    const newPath = join(folderA, 'new.txt');
    await writeFile(oldPath, 'rename-me');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef, undefined, {
      cleanTarget: true,
    });

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree', {
      cleanTarget: true,
    });

    await rename(oldPath, newPath);

    await waitFor(async () => {
      const existsNew = await fileExists(join(folderB, 'new.txt'));
      if (!existsNew) return false;
      const content = await readFile(join(folderB, 'new.txt'), 'utf8');
      return content === 'rename-me';
    }, 15000);

    await waitFor(async () => {
      return !(await fileExists(join(folderB, 'old.txt')));
    }, 15000);

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 20000);

  it('live sync keeps stale deletions when cleanTarget is disabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const filePath = join(folderA, 'stale.txt');
    await writeFile(filePath, 'stale-content');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef, undefined, {
      cleanTarget: false,
    });

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree');

    await rm(filePath);

    await waitFor(async () => {
      // Without cleanTarget, stale file should remain
      return await fileExists(join(folderB, 'stale.txt'));
    }, 15000);

    const content = await readFile(join(folderB, 'stale.txt'), 'utf8');
    expect(content).toBe('stale-content');

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 20000);

  it('live sync keeps renamed source when cleanTarget is disabled', async () => {
    const { tempRoot, folderA, folderB } = await createTempFolders();
    const { server } = await setupServer();
    const { client: clientA, clientDb: clientDbA } = await setupClient(server);
    const { client: clientB, clientDb: clientDbB } = await setupClient(server);

    const agentA = new FsAgent(folderA, clientA.bs);
    const agentB = new FsAgent(folderB, clientB.bs);

    const oldPath = join(folderA, 'old.txt');
    const newPath = join(folderA, 'new.txt');
    await writeFile(oldPath, 'rename-me');

    const baseRef = await agentA.storeInDb(clientDbA, 'sharedTree');
    await agentB.loadFromDb(clientDbB, 'sharedTree', baseRef);

    const stopAtoDb = await agentA.syncToDb(clientDbA, 'sharedTree', {
      notify: true,
    });
    const stopBfromDb = await agentB.syncFromDb(clientDbB, 'sharedTree');

    await rename(oldPath, newPath);

    await waitFor(async () => {
      const existsNew = await fileExists(join(folderB, 'new.txt'));
      if (!existsNew) return false;
      const content = await readFile(join(folderB, 'new.txt'), 'utf8');
      return content === 'rename-me';
    }, 15000);

    await waitFor(async () => {
      // Without cleanTarget, old file should remain
      return await fileExists(join(folderB, 'old.txt'));
    }, 15000);

    stopAtoDb();
    stopBfromDb();
    await rm(tempRoot, { recursive: true, force: true });
  }, 20000);
});
