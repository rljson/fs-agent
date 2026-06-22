// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route, type SyncConfig } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../../src/fs-agent.ts';

const TREE = 'sharedTree';
const SYNC: SyncConfig = { causalOrdering: true, includeClientIdentity: true };

interface Node {
  localIo: IoMem;
  bs: BsMem;
  db: Db;
  connector: Connector;
  agent: FsAgent;
  folder: string;
  stops: Array<() => void>;
}

/** Poll until `fn()` is truthy or timeout. */
async function until<T>(fn: () => Promise<T> | T, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe('end-to-end offline-edit conflict resolution (two clients)', () => {
  const root = join(process.cwd(), 'test-temp-conflict-e2e');
  const route = Route.fromFlat(`/${TREE}`);
  let server: Server;
  let a: Node;
  let b: Node;

  // Open a fresh socket + Client + Connector for a node, reusing its persistent
  // local io/bs/agent. Models a real (re)connect — the agent's ancestry head and
  // local InsertHistory survive across disconnects.
  const connect = async (n: Node) => {
    const [serverSocket, clientSocket] = createSocketPair();
    serverSocket.connect();
    await server.addSocket(serverSocket);
    const client = new Client(clientSocket, n.localIo, n.bs);
    await client.init();
    n.db = new Db(client.io!);
    n.connector = new Connector(n.db, route, clientSocket, SYNC);
  };
  const startSync = async (n: Node) => {
    await connect(n);
    n.stops.push(await n.agent.syncToDb(n.db, n.connector, TREE));
    n.stops.push(
      await n.agent.syncFromDb(n.db, n.connector, TREE, { cleanTarget: true }),
    );
  };
  const stopSync = (n: Node) => {
    for (const s of n.stops) s();
    n.stops = [];
  };

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    const treeCfg = createTreesTableCfg(TREE);

    // One shared blob store across both peers + server. Blob *replication* is
    // a separate, already-tested concern (advanced-sync.spec); sharing it here
    // isolates the conflict-resolution logic so a divergent merge can read
    // both versions' blobs regardless of replication timing.
    const sharedBs = new BsMem();

    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    server = new Server(route, serverIo, sharedBs, { syncConfig: SYNC });
    await server.init();

    const mkNode = async (name: string): Promise<Node> => {
      const folder = join(root, name);
      await mkdir(folder, { recursive: true });
      const localIo = new IoMem();
      await localIo.init();
      await localIo.isReady();
      await new Db(localIo).core.createTableWithInsertHistory(treeCfg);
      // Both peers are clients → both resolve conflicts (the server/hub never
      // runs an FsAgent resolver).
      const agent = new FsAgent(folder, sharedBs, {
        resolveConflicts: true,
        timeouts: { debounceMs: 100, processRefRetryDelayMs: 300 },
      });
      return {
        localIo,
        bs: agent.bs,
        db: undefined as unknown as Db,
        connector: undefined as unknown as Connector,
        agent,
        folder,
        stops: [],
      };
    };

    a = await mkNode('A');
    b = await mkNode('B');
  });

  afterEach(async () => {
    stopSync(a);
    stopSync(b);
    await rm(root, { recursive: true, force: true });
  });

  it('does NOT false-detect conflicts on a clean linear propagation', async () => {
    await startSync(a);
    await startSync(b);
    await new Promise((r) => setTimeout(r, 400));

    await writeFile(join(a.folder, 'doc.txt'), 'v1');
    // B receives it.
    const got = await until(async () => {
      try {
        return (await readFile(join(b.folder, 'doc.txt'), 'utf8')) === 'v1';
      } catch {
        return false;
      }
    });
    expect(got).toBe(true);

    // The linear history must NOT register as a fork on either side.
    expect(await a.db.detectDagBranch(TREE)).toBeNull();
    expect(await b.db.detectDagBranch(TREE)).toBeNull();
  });

  it('resolves a real offline divergent edit, preserving both versions', async () => {
    await startSync(a);
    await startSync(b);
    await new Promise((r) => setTimeout(r, 400));

    // Shared baseline.
    await writeFile(join(a.folder, 'doc.txt'), 'base');
    await until(async () => {
      try {
        return (await readFile(join(b.folder, 'doc.txt'), 'utf8')) === 'base';
      } catch {
        return false;
      }
    });

    // Go offline; both edit the same file differently.
    stopSync(a);
    stopSync(b);
    await writeFile(join(a.folder, 'doc.txt'), 'fromA');
    await writeFile(join(b.folder, 'doc.txt'), 'fromB');

    // Reconnect — the divergence is now a real fork; a client resolves it.
    await startSync(a);
    await startSync(b);

    // Converge: each side ends with both versions present (winner at doc.txt,
    // loser as a Nextcloud conflict copy), and the fork collapses.
    const converged = await until(async () => {
      const namesA = await readdir(a.folder);
      const namesB = await readdir(b.folder);
      const hasCopy = (ns: string[]) =>
        ns.some((n) => n.includes('conflicted copy'));
      const noFork =
        (await a.db.detectDagBranch(TREE)) === null &&
        (await b.db.detectDagBranch(TREE)) === null;
      return hasCopy(namesA) && hasCopy(namesB) && noFork ? { namesA } : false;
    }, 12000);

    expect(converged).toBeTruthy();

    // Nothing lost: both 'fromA' and 'fromB' survive somewhere on A.
    const contents = await Promise.all(
      (converged as { namesA: string[] }).namesA.map((n) =>
        readFile(join(a.folder, n), 'utf8').catch(() => ''),
      ),
    );
    expect(contents).toContain('fromA');
    expect(contents).toContain('fromB');
  });
});
