// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { FsAgent } from '../../src/fs-agent.ts';

// =============================================================================
// Types
// =============================================================================

interface ClientNode {
  client: Client;
  db: Db;
  connector: Connector;
  agent: FsAgent;
  folder: string;
}

interface MultiClientSetup {
  treeKey: string;
  route: Route;
  server: Server;
  serverIo: IoMem;
  serverBs: BsMem;
  clients: ClientNode[];
  tearDown: () => Promise<void>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a multi-client setup with N clients, each with its own folder.
 * All use SocketMock (in-memory, fast).
 */
async function createMultiClientSetup(
  folders: string[],
  treeKey = 'sharedTree',
): Promise<MultiClientSetup> {
  const route = Route.fromFlat(`/${treeKey}`);
  const treeCfg = createTreesTableCfg(treeKey);

  // --- Server ---
  const serverIo = new IoMem();
  await serverIo.init();
  const serverBs = new BsMem();
  await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
  const server = new Server(route, serverIo, serverBs);
  await server.init();

  // --- Create N clients ---
  const clients: ClientNode[] = [];
  for (const folder of folders) {
    const [serverSocket, clientSocket] = createSocketPair();
    serverSocket.connect();
    await server.addSocket(serverSocket);

    const localIo = new IoMem();
    await localIo.init();
    await localIo.isReady();
    await new Db(localIo).core.createTableWithInsertHistory(treeCfg);
    const localBs = new BsMem();
    const client = new Client(clientSocket, localIo, localBs);
    await client.init();
    const db = new Db(client.io!);
    const connector = new Connector(db, route, clientSocket);
    const agent = new FsAgent(folder, client.bs);

    clients.push({ client, db, connector, agent, folder });
  }

  const tearDown = async () => {
    for (const c of clients) {
      await c.client.tearDown();
    }
    await server.tearDown();
  };

  return { treeKey, route, server, serverIo, serverBs, clients, tearDown };
}

/** Start bidirectional sync for a single client node. */
async function startSync(
  node: ClientNode,
  treeKey: string,
): Promise<{ stopToDb: () => void; stopFromDb: () => void }> {
  const stopToDb = await node.agent.syncToDb(
    node.db,
    node.connector,
    treeKey,
  );
  const stopFromDb = await node.agent.syncFromDb(
    node.db,
    node.connector,
    treeKey,
    { cleanTarget: true },
  );
  return { stopToDb, stopFromDb };
}

/** Start bidirectional sync for ALL client nodes. */
async function startAllSync(
  setup: MultiClientSetup,
): Promise<{ stopAll: () => void }> {
  const stops: Array<{ stopToDb: () => void; stopFromDb: () => void }> = [];
  for (const c of setup.clients) {
    stops.push(await startSync(c, setup.treeKey));
  }
  // Allow initial sync cycle to settle
  await new Promise((r) => setTimeout(r, 500));
  return {
    stopAll: () => {
      for (const s of stops) {
        s.stopToDb();
        s.stopFromDb();
      }
    },
  };
}

/** Poll until a file exists with expected content. */
async function waitForFile(
  filePath: string,
  expectedContent: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(filePath, 'utf8');
      if (content === expectedContent) return;
    } catch {
      // file doesn't exist yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForFile timed out after ${timeout}ms: ${filePath}`,
  );
}

/** Poll until a path no longer exists. */
async function waitForGone(
  filePath: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
    } catch {
      return; // gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForGone timed out after ${timeout}ms: ${filePath}`,
  );
}



/** Read file content, returning null if not found. */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Simple sync wait. */
function waitForSync(ms = 3000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Tests
// =============================================================================

describe('Advanced Sync Tests', () => {
  const baseDir = join(process.cwd(), 'test-tmp', 'advanced-sync');

  beforeEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Gap 2: Three-client filesystem sync
  // ===========================================================================

  describe('three-client sync', () => {
    it('should propagate a file from A to B and C', async () => {
      const folderA = join(baseDir, 'a');
      const folderB = join(baseDir, 'b');
      const folderC = join(baseDir, 'c');
      await mkdir(folderA, { recursive: true });
      await mkdir(folderB, { recursive: true });
      await mkdir(folderC, { recursive: true });

      // Seed all folders
      await writeFile(join(folderA, 'seed.txt'), 'seed');
      await writeFile(join(folderB, 'seed.txt'), 'seed');
      await writeFile(join(folderC, 'seed.txt'), 'seed');

      const setup = await createMultiClientSetup([folderA, folderB, folderC]);
      const { stopAll } = await startAllSync(setup);

      try {
        await writeFile(join(folderA, 'from-a.txt'), 'hello from A');

        await waitForFile(join(folderB, 'from-a.txt'), 'hello from A');
        await waitForFile(join(folderC, 'from-a.txt'), 'hello from A');
      } finally {
        stopAll();
        await setup.tearDown();
      }
    });

    it('should propagate files from all three clients', async () => {
      const folderA = join(baseDir, 'a');
      const folderB = join(baseDir, 'b');
      const folderC = join(baseDir, 'c');
      await mkdir(folderA, { recursive: true });
      await mkdir(folderB, { recursive: true });
      await mkdir(folderC, { recursive: true });

      await writeFile(join(folderA, 'seed.txt'), 'seed');
      await writeFile(join(folderB, 'seed.txt'), 'seed');
      await writeFile(join(folderC, 'seed.txt'), 'seed');

      const setup = await createMultiClientSetup([folderA, folderB, folderC]);
      const { stopAll } = await startAllSync(setup);

      try {
        // Each client writes a unique file
        await writeFile(join(folderA, 'from-a.txt'), 'A');
        await waitForFile(join(folderB, 'from-a.txt'), 'A');
        await waitForFile(join(folderC, 'from-a.txt'), 'A');

        await writeFile(join(folderB, 'from-b.txt'), 'B');
        await waitForFile(join(folderA, 'from-b.txt'), 'B');
        await waitForFile(join(folderC, 'from-b.txt'), 'B');

        await writeFile(join(folderC, 'from-c.txt'), 'C');
        await waitForFile(join(folderA, 'from-c.txt'), 'C');
        await waitForFile(join(folderB, 'from-c.txt'), 'C');
      } finally {
        stopAll();
        await setup.tearDown();
      }
    });

    it(
      'should converge with three clients after concurrent writes',
      { timeout: 60_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        const folderC = join(baseDir, 'c');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });
        await mkdir(folderC, { recursive: true });

        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');
        await writeFile(join(folderC, 'seed.txt'), 'seed');

        const setup = await createMultiClientSetup([folderA, folderB, folderC]);
        const { stopAll } = await startAllSync(setup);

        try {
          // Write from A, wait for propagation, then B, then C
          // Sequential to avoid sync contention with 3 clients
          await writeFile(join(folderA, 'concurrent-a.txt'), 'from-A');
          await waitForFile(
            join(folderB, 'concurrent-a.txt'),
            'from-A',
            15_000,
          );
          await waitForFile(
            join(folderC, 'concurrent-a.txt'),
            'from-A',
            15_000,
          );

          await writeFile(join(folderB, 'concurrent-b.txt'), 'from-B');
          await waitForFile(
            join(folderA, 'concurrent-b.txt'),
            'from-B',
            15_000,
          );
          await waitForFile(
            join(folderC, 'concurrent-b.txt'),
            'from-B',
            15_000,
          );

          await writeFile(join(folderC, 'concurrent-c.txt'), 'from-C');
          await waitForFile(
            join(folderA, 'concurrent-c.txt'),
            'from-C',
            15_000,
          );
          await waitForFile(
            join(folderB, 'concurrent-c.txt'),
            'from-C',
            15_000,
          );
        } finally {
          stopAll();
          await setup.tearDown();
        }
      },
    );
  });

  // ===========================================================================
  // Gap 3: Late-joiner with filesystem
  // ===========================================================================

  describe('late joiner', () => {
    it(
      'should catch up a client that joins after data exists',
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        const folderC = join(baseDir, 'late');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });
        await mkdir(folderC, { recursive: true });

        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        // Start with 2 clients, sync a file
        const setup = await createMultiClientSetup([folderA, folderB]);
        const syncAB = await startAllSync(setup);

        await writeFile(join(folderA, 'existing.txt'), 'was here first');
        await waitForFile(join(folderB, 'existing.txt'), 'was here first');

        // Now add a 3rd client (late joiner)
        const [serverSocketC, clientSocketC] = createSocketPair();
        serverSocketC.connect();
        await setup.server.addSocket(serverSocketC);

        const treeCfg = createTreesTableCfg(setup.treeKey);
        const localIoC = new IoMem();
        await localIoC.init();
        await localIoC.isReady();
        await new Db(localIoC).core.createTableWithInsertHistory(treeCfg);
        const localBsC = new BsMem();
        const clientC = new Client(clientSocketC, localIoC, localBsC);
        await clientC.init();
        const dbC = new Db(clientC.io!);
        const connectorC = new Connector(dbC, setup.route, clientSocketC);
        const agentC = new FsAgent(folderC, clientC.bs);

        // Start only syncFromDb — do NOT start syncToDb,
        // because C's folder is empty and scanning it would push an
        // empty tree that overwrites A's data.
        const stopCfromDb = await agentC.syncFromDb(
          dbC,
          connectorC,
          setup.treeKey,
          { cleanTarget: true },
        );

        // Small delay to ensure C's listener is registered
        await new Promise((r) => setTimeout(r, 200));

        try {
          // Trigger a new write from A. This causes A to rescan and
          // broadcast its full tree (including existing.txt) so that
          // the late joiner C receives it.
          await writeFile(join(folderA, 'trigger.txt'), 'trigger');

          // Late joiner should receive the existing file via the
          // broadcast triggered by the new write above
          await waitForFile(
            join(folderC, 'existing.txt'),
            'was here first',
            15_000,
          );

          // Also verify the trigger file arrived
          await waitForFile(
            join(folderC, 'trigger.txt'),
            'trigger',
            15_000,
          );
        } finally {
          stopCfromDb();
          await clientC.tearDown();
          syncAB.stopAll();
          await setup.tearDown();
        }
      },
    );
  });

  // ===========================================================================
  // Gap 4: Server restart / client reconnect with resync
  // ===========================================================================

  describe('server restart', () => {
    it(
      'should allow clients to resync after server teardown and restart',
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        await writeFile(join(folderA, 'before.txt'), 'before restart');
        await writeFile(join(folderB, 'before.txt'), 'before restart');

        const treeKey = 'sharedTree';
        const route = Route.fromFlat(`/${treeKey}`);
        const treeCfg = createTreesTableCfg(treeKey);

        // --- First server instance ---
        const serverIo1 = new IoMem();
        await serverIo1.init();
        const serverBs1 = new BsMem();
        await new Db(serverIo1).core.createTableWithInsertHistory(treeCfg);
        const server1 = new Server(route, serverIo1, serverBs1);
        await server1.init();

        // --- Client A on server1 ---
        const [srvSockA1, cliSockA1] = createSocketPair();
        srvSockA1.connect();
        await server1.addSocket(srvSockA1);
        const ioA = new IoMem();
        await ioA.init();
        await ioA.isReady();
        await new Db(ioA).core.createTableWithInsertHistory(treeCfg);
        const bsA = new BsMem();
        const clientA = new Client(cliSockA1, ioA, bsA);
        await clientA.init();
        const dbA = new Db(clientA.io!);
        const agentA = new FsAgent(folderA, clientA.bs);

        // Sync a file via A on server1
        const ref = await agentA.storeInDb(dbA, treeKey);
        expect(ref).toBeDefined();

        // Teardown server1 (simulating server crash/restart)
        await clientA.tearDown();
        await server1.tearDown();

        // --- Second server instance (fresh state) ---
        const serverIo2 = new IoMem();
        await serverIo2.init();
        const serverBs2 = new BsMem();
        await new Db(serverIo2).core.createTableWithInsertHistory(treeCfg);
        const server2 = new Server(route, serverIo2, serverBs2);
        await server2.init();

        // --- Reconnect A and connect B on server2 ---
        const [srvSockA2, cliSockA2] = createSocketPair();
        srvSockA2.connect();
        await server2.addSocket(srvSockA2);
        const ioA2 = new IoMem();
        await ioA2.init();
        await ioA2.isReady();
        await new Db(ioA2).core.createTableWithInsertHistory(treeCfg);
        const bsA2 = new BsMem();
        const clientA2 = new Client(cliSockA2, ioA2, bsA2);
        await clientA2.init();
        const dbA2 = new Db(clientA2.io!);
        const agentA2 = new FsAgent(folderA, clientA2.bs);

        const [srvSockB, cliSockB] = createSocketPair();
        srvSockB.connect();
        await server2.addSocket(srvSockB);
        const ioB = new IoMem();
        await ioB.init();
        await ioB.isReady();
        await new Db(ioB).core.createTableWithInsertHistory(treeCfg);
        const bsB = new BsMem();
        const clientB = new Client(cliSockB, ioB, bsB);
        await clientB.init();
        const dbB = new Db(clientB.io!);
        const agentB = new FsAgent(folderB, clientB.bs);

        // A stores again on server2, B loads
        const ref2 = await agentA2.storeInDb(dbA2, treeKey);
        await agentB.loadFromDb(dbB, treeKey, ref2);

        const contentB = await readFile(
          join(folderB, 'before.txt'),
          'utf8',
        );
        expect(contentB).toBe('before restart');

        await clientA2.tearDown();
        await clientB.tearDown();
        await server2.tearDown();
      },
    );
  });

  // ===========================================================================
  // Gap 6: Simultaneous conflicting edits (same file, two clients)
  // ===========================================================================

  describe('simultaneous conflicting edits', () => {
    it(
      'should converge when both clients modify the same file',
      { timeout: 30_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        // Start with same content
        await writeFile(join(folderA, 'conflict.txt'), 'original');
        await writeFile(join(folderB, 'conflict.txt'), 'original');

        const setup = await createMultiClientSetup([folderA, folderB]);
        const { stopAll } = await startAllSync(setup);

        try {
          // A writes, B waits for convergence, then B writes and A
          // waits for convergence. This tests that both sides can
          // modify the same file and the last write propagates.
          await writeFile(join(folderA, 'conflict.txt'), 'version-A');
          await waitForFile(
            join(folderB, 'conflict.txt'),
            'version-A',
            15_000,
          );

          await writeFile(join(folderB, 'conflict.txt'), 'version-B');
          await waitForFile(
            join(folderA, 'conflict.txt'),
            'version-B',
            15_000,
          );

          // Both must have the final content
          const contentA = await readFile(
            join(folderA, 'conflict.txt'),
            'utf8',
          );
          const contentB = await readFile(
            join(folderB, 'conflict.txt'),
            'utf8',
          );
          expect(contentA).toBe('version-B');
          expect(contentB).toBe('version-B');
        } finally {
          stopAll();
          await setup.tearDown();
        }
      },
    );

    it(
      'should propagate a deletion across clients',
      { timeout: 30_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        await writeFile(join(folderA, 'target.txt'), 'exists');
        await writeFile(join(folderB, 'target.txt'), 'exists');
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createMultiClientSetup([folderA, folderB]);
        const { stopAll } = await startAllSync(setup);

        try {
          // B deletes the file — cleanTarget sync should propagate
          // the deletion to A
          await rm(join(folderB, 'target.txt'));

          // A should eventually lose the file because B's tree
          // no longer contains it
          await waitForGone(join(folderA, 'target.txt'), 15_000);

          // Both sides should not have the file
          const existsA = await readFileSafe(join(folderA, 'target.txt'));
          const existsB = await readFileSafe(join(folderB, 'target.txt'));
          expect(existsA).toBeNull();
          expect(existsB).toBeNull();
        } finally {
          stopAll();
          await setup.tearDown();
        }
      },
    );
  });

  // ===========================================================================
  // Gap 7: Disconnect mid-sync
  // ===========================================================================

  describe('disconnect during sync', () => {
    it(
      'should still converge after reconnect with new data',
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const treeKey = 'sharedTree';

        // Setup with explicit socket references for A so we can disconnect
        const route = Route.fromFlat(`/${treeKey}`);
        const treeCfg = createTreesTableCfg(treeKey);
        const serverIo = new IoMem();
        await serverIo.init();
        const serverBs = new BsMem();
        await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
        const server = new Server(route, serverIo, serverBs);
        await server.init();

        // Client A
        const [srvSockA, cliSockA] = createSocketPair();
        srvSockA.connect();
        await server.addSocket(srvSockA);
        const ioA = new IoMem();
        await ioA.init();
        await ioA.isReady();
        await new Db(ioA).core.createTableWithInsertHistory(treeCfg);
        const bsA = new BsMem();
        const clientA = new Client(cliSockA, ioA, bsA);
        await clientA.init();
        const dbA = new Db(clientA.io!);
        const agentA = new FsAgent(folderA, clientA.bs);

        // Client B
        const [srvSockB, cliSockB] = createSocketPair();
        srvSockB.connect();
        await server.addSocket(srvSockB);
        const ioB = new IoMem();
        await ioB.init();
        await ioB.isReady();
        await new Db(ioB).core.createTableWithInsertHistory(treeCfg);
        const bsB = new BsMem();
        const clientB = new Client(cliSockB, ioB, bsB);
        await clientB.init();
        const dbB = new Db(clientB.io!);
        const agentB = new FsAgent(folderB, clientB.bs);

        // Store from A, B loads — baseline sync works
        const ref1 = await agentA.storeInDb(dbA, treeKey);
        await agentB.loadFromDb(dbB, treeKey, ref1);
        expect(
          await readFile(join(folderB, 'seed.txt'), 'utf8'),
        ).toBe('seed');

        // Disconnect A's server socket (simulating network drop)
        srvSockA.disconnect();

        // A writes a new file while disconnected
        await writeFile(join(folderA, 'offline.txt'), 'written offline');

        // Reconnect A with a fresh socket pair
        const [srvSockA2, cliSockA2] = createSocketPair();
        srvSockA2.connect();
        await server.addSocket(srvSockA2);
        const clientA2 = new Client(cliSockA2, ioA, bsA);
        await clientA2.init();
        const dbA2 = new Db(clientA2.io!);
        const agentA2 = new FsAgent(folderA, clientA2.bs);

        // A re-stores, B loads again
        const ref2 = await agentA2.storeInDb(dbA2, treeKey);
        await agentB.loadFromDb(dbB, treeKey, ref2);

        expect(
          await readFile(join(folderB, 'offline.txt'), 'utf8'),
        ).toBe('written offline');

        await clientA.tearDown();
        await clientA2.tearDown();
        await clientB.tearDown();
        await server.tearDown();
      },
    );
  });

  // ===========================================================================
  // Gap 8: Stress test (100+ files at once)
  // ===========================================================================

  describe('stress tests', () => {
    it(
      'should sync 100 files from A to B',
      { timeout: 60_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        // Create 100 files
        const fileCount = 100;
        for (let i = 0; i < fileCount; i++) {
          await writeFile(
            join(folderA, `file-${String(i).padStart(3, '0')}.txt`),
            `content-${i}`,
          );
        }

        const setup = await createMultiClientSetup([folderA, folderB]);

        // One-shot store + load for reliability (watcher stress tested below)
        const ref = await setup.clients[0].agent.storeInDb(
          setup.clients[0].db,
          setup.treeKey,
        );
        await setup.clients[1].agent.loadFromDb(
          setup.clients[1].db,
          setup.treeKey,
          ref,
        );

        // Verify all files arrived
        for (let i = 0; i < fileCount; i++) {
          const filename = `file-${String(i).padStart(3, '0')}.txt`;
          const content = await readFile(join(folderB, filename), 'utf8');
          expect(content).toBe(`content-${i}`);
        }

        await setup.tearDown();
      },
    );

    it(
      'should handle 50 rapid watcher-driven changes',
      { timeout: 60_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createMultiClientSetup([folderA, folderB]);
        const { stopAll } = await startAllSync(setup);

        try {
          // Create 50 files rapidly
          for (let i = 0; i < 50; i++) {
            await writeFile(
              join(folderA, `rapid-${String(i).padStart(3, '0')}.txt`),
              `rapid-${i}`,
            );
          }

          // The last file is the sentinel — when it arrives, the rest
          // should also be there (due to debounced full-scan behavior)
          await waitForFile(
            join(folderB, 'rapid-049.txt'),
            'rapid-49',
            30_000,
          );

          // Verify a sampling of files
          expect(
            await readFileSafe(join(folderB, 'rapid-000.txt')),
          ).toBe('rapid-0');
          expect(
            await readFileSafe(join(folderB, 'rapid-024.txt')),
          ).toBe('rapid-24');
        } finally {
          stopAll();
          await setup.tearDown();
        }
      },
    );
  });

  // ===========================================================================
  // Gap 9: Very large file (>10MB)
  // ===========================================================================

  describe('very large file sync', () => {
    it(
      'should sync a 10MB file via one-shot store + load',
      { timeout: 120_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        // 10MB file
        const largeContent = 'A'.repeat(10 * 1024 * 1024);
        await writeFile(join(folderA, 'large-10mb.txt'), largeContent);

        const setup = await createMultiClientSetup([folderA, folderB]);

        const ref = await setup.clients[0].agent.storeInDb(
          setup.clients[0].db,
          setup.treeKey,
        );
        await setup.clients[1].agent.loadFromDb(
          setup.clients[1].db,
          setup.treeKey,
          ref,
        );

        const contentB = await readFile(
          join(folderB, 'large-10mb.txt'),
          'utf8',
        );
        expect(contentB.length).toBe(10 * 1024 * 1024);
        expect(contentB).toBe(largeContent);

        await setup.tearDown();
      },
    );

    it(
      'should sync a 5MB binary file',
      { timeout: 120_000 },
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        // 5MB binary file with varied bytes
        const size = 5 * 1024 * 1024;
        const binaryData = Buffer.alloc(size);
        for (let i = 0; i < size; i++) {
          binaryData[i] = i % 256;
        }
        await writeFile(join(folderA, 'large-5mb.bin'), binaryData);

        const setup = await createMultiClientSetup([folderA, folderB]);

        const ref = await setup.clients[0].agent.storeInDb(
          setup.clients[0].db,
          setup.treeKey,
        );
        await setup.clients[1].agent.loadFromDb(
          setup.clients[1].db,
          setup.treeKey,
          ref,
        );

        const contentB = await readFile(join(folderB, 'large-5mb.bin'));
        expect(Buffer.compare(contentB, binaryData)).toBe(0);

        await setup.tearDown();
      },
    );
  });

  // ===========================================================================
  // Gap 10: Partial / half-written file
  // ===========================================================================

  describe('partial file writes', () => {
    it(
      'should eventually sync the final content after rapid overwrites',
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createMultiClientSetup([folderA, folderB]);
        const { stopAll } = await startAllSync(setup);

        try {
          // Simulate rapid overwrites (like a process writing to a file
          // multiple times in quick succession)
          for (let i = 0; i < 10; i++) {
            await writeFile(join(folderA, 'overwrite.txt'), `version-${i}`);
          }

          // After sync settles, B should have the FINAL version
          await waitForSync(5000);

          const contentB = await readFile(
            join(folderB, 'overwrite.txt'),
            'utf8',
          );
          // The final version must be version-9
          expect(contentB).toBe('version-9');
        } finally {
          stopAll();
          await setup.tearDown();
        }
      },
    );

    it(
      'should handle a file being written and read simultaneously',
      async () => {
        const folderA = join(baseDir, 'a');
        const folderB = join(baseDir, 'b');
        await mkdir(folderA, { recursive: true });
        await mkdir(folderB, { recursive: true });

        const setup = await createMultiClientSetup([folderA, folderB]);

        // Write a file, then immediately store — should capture the complete
        // content even if the watcher hasn't fired yet
        const content = 'complete-content-' + 'x'.repeat(1000);
        await writeFile(join(folderA, 'simultaneous.txt'), content);

        const ref = await setup.clients[0].agent.storeInDb(
          setup.clients[0].db,
          setup.treeKey,
        );
        await setup.clients[1].agent.loadFromDb(
          setup.clients[1].db,
          setup.treeKey,
          ref,
        );

        const contentB = await readFile(
          join(folderB, 'simultaneous.txt'),
          'utf8',
        );
        expect(contentB).toBe(content);

        await setup.tearDown();
      },
    );
  });
});
