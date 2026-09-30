// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Can a PEER read a chain entry?
//
// This is the load-bearing assumption of the whole design, and it is worth one
// cheap test before anything is built on it. §13.5 decided that a node
// announces its chain HEAD and a receiver resolves head → row → tree ref →
// the existing tree fetch. Every step after that — the `previous` walk (WP3),
// deciding from reachability (WP4), a delete that wins (WP2b) — assumes a peer
// can turn a head it has never seen into a row.
//
// If it cannot, announcing the head is not merely risky, it is impossible, and
// the design has to change before any of it is written. The plan's WP0 applies
// the same discipline one level up ("one site asks for a row only the other
// holds; watch it arrive"); this is that question on the LAN, where it has to
// work first.
//
// Real `Server`, real `Client`, real socket pair, real `IoMulti` — the wiring
// the One Client ships. A stub that served rows from a shared store would
// answer the wrong question.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { afterEach, describe, expect, it } from 'vitest';

import { FsEditChain } from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('the chain crosses the wire', () => {
  let teardown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  /**
   * Two clients on one server, wired as production wires them.
   * @returns A chain per node, over that node's own `Db`.
   */
  const twoNodes = async (): Promise<{ a: FsEditChain; b: FsEditChain }> => {
    const route = Route.fromFlat(`/${TREE}`);
    const treeCfg = createTreesTableCfg(TREE);

    const serverIo = new IoMem();
    await serverIo.init();
    const serverDb = new Db(serverIo);
    await serverDb.core.createTableWithInsertHistory(treeCfg);
    // THE HUB GETS NO CHAIN TABLES, deliberately, and it still works.
    //
    // Measured both ways: with the tables and without, a peer resolves a head
    // it has never seen. Resolution goes client → relay → the OTHER client,
    // not through the hub's own store — the pull architecture, where the relay
    // holds no bodies. So a hub one release behind does not block chain reads
    // between clients, which is one less thing for the migration to carry.
    void serverDb;
    const server = new Server(route, serverIo, new BsMem());
    await server.init();

    const clients: Client[] = [];
    const chains: FsEditChain[] = [];
    for (let i = 0; i < 2; i++) {
      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      await server.addSocket(serverSocket);

      const localIo = new IoMem();
      await localIo.init();
      await localIo.isReady();
      await new Db(localIo).core.createTableWithInsertHistory(treeCfg);

      const client = new Client(clientSocket, localIo, new BsMem());
      await client.init();
      clients.push(client);

      const db = new Db(client.io!);
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      chains.push(chain);
    }

    teardown = async () => {
      for (const c of clients) await c.tearDown();
      await server.tearDown();
    };

    return { a: chains[0], b: chains[1] };
  };

  // ...........................................................................
  it('a peer resolves a head it has never seen', async () => {
    const { a, b } = await twoNodes();

    const written = await a.append({
      treeRef: 'T1',
      changed: ['a.txt'],
      removed: ['gone.txt'],
    });

    // B never wrote this and never received it — it has only the hash.
    const read = await b.entry(written.head);

    expect(read, 'a peer could not resolve a chain head by hash').toBeTruthy();
    expect(read?.treeRef).toBe('T1');
    expect(read?.removed).toEqual(['gone.txt']);
    expect(read?.changed).toEqual(['a.txt']);
  }, 30_000);

  // ...........................................................................
  it('a peer walks `previous` back through entries it never held', async () => {
    // WP3's whole mechanism, at its smallest: given a head, reach the ancestor
    // chain by hash alone. If only the head resolves and its parents do not,
    // the walk can never terminate anywhere but at a hole.
    const { a, b } = await twoNodes();

    const first = await a.append({ treeRef: 'T1' });
    const second = await a.append({ treeRef: 'T2' });
    const third = await a.append({ treeRef: 'T3' });

    const walked: string[] = [];
    let cursor: string | undefined = third.head;
    while (cursor) {
      const entry = await b.entry(cursor);
      if (!entry) break;
      walked.push(entry.treeRef);
      cursor = entry.previous[0];
    }

    expect(walked, 'the walk stopped short of the root').toEqual([
      'T3',
      'T2',
      'T1',
    ]);
    expect(second.head).toBeTruthy();
    expect(first.head).toBeTruthy();
  }, 30_000);

  // ...........................................................................
  it('an unknown head answers undefined rather than throwing', async () => {
    // A ref nobody holds is the ordinary case during a partition, not an
    // error, and the walk has to be able to report it as a hole.
    const { b } = await twoNodes();
    expect(await b.entry('a-head-nobody-ever-wrote')).toBeUndefined();
  }, 30_000);

  // ...........................................................................
  it('can a peer find an entry by its TREE REF, not by hash?', async () => {
    // Settles a migration question rather than a design one, and it was
    // rejected early on an assumption worth checking.
    //
    // Announcing `~H~<head>` is unintelligible to a build that predates it: an
    // older node tries to fetch a tree by that hash and fails, so a new node's
    // pushes are invisible to it. The whole branch therefore needs a LOCKSTEP
    // rollout. If a peer can instead find the chain entry from the tree ref it
    // already announces — `dataRef` is exactly that field — then the wire
    // format never has to change and one of the two lockstep requirements
    // disappears.
    //
    // A hash read is a hash read; this is a QUERY, and whether a relay serves
    // one is not something to assume in either direction.
    const { a, b } = await twoNodes();
    const written = await a.append({
      treeRef: 'T-findable',
      removed: ['gone.txt'],
    });

    const db = b['_db'] as {
      getEditHistories: (
        k: string,
        where: unknown,
      ) => Promise<Array<Record<string, unknown>>>;
    };
    let rows: Array<Record<string, unknown>> = [];
    let threw: string | undefined;
    try {
      rows = await db.getEditHistories(TREE, { dataRef: 'T-findable' });
    } catch (e) {
      threw = String(e);
    }

    // Recorded either way — the answer is what matters, not which way it went.
    console.log(
      `QUERY-ACROSS-RELAY rows=${rows.length} threw=${threw ?? 'no'}`,
    );
    expect(written.head).toBeTruthy();
  }, 30_000);
});
