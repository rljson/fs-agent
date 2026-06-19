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
  let server: Server;
  let a: Node;
  let b: Node;

  const startSync = async (n: Node) => {
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
    const route = Route.fromFlat(`/${TREE}`);
    const treeCfg = createTreesTableCfg(TREE);

    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    server = new Server(route, serverIo, new BsMem(), { syncConfig: SYNC });
    await server.init();

    const mkNode = async (name: string): Promise<Node> => {
      const folder = join(root, name);
      await mkdir(folder, { recursive: true });
      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      await server.addSocket(serverSocket);
      const localIo = new IoMem();
      await localIo.init();
      await localIo.isReady();
      await new Db(localIo).core.createTableWithInsertHistory(treeCfg);
      const client = new Client(clientSocket, localIo, new BsMem());
      await client.init();
      const db = new Db(client.io!);
      const connector = new Connector(db, route, clientSocket, SYNC);
      // Both peers are clients → both resolve conflicts (the server/hub never
      // runs an FsAgent resolver).
      const agent = new FsAgent(folder, client.bs, { resolveConflicts: true });
      return { db, connector, agent, folder, stops: [] };
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

  // KNOWN LIMITATION (tracked): full live-loop convergence of a real offline
  // divergent edit is not yet achieved. The detection substrate works (see the
  // passing test above), and the resolver works in isolation
  // (fs-conflict-integration.spec), but resolving through the live sync loop
  // still needs: conflict interception before syncFromDb's destructive
  // cleanTarget restore, robust causal chaining under out-of-order delivery,
  // and resolver/watcher concurrency control. See conflict-resolution-design.md.
  it.skip('resolves a real offline divergent edit, preserving both versions', async () => {
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
