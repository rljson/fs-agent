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

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../../src/fs-agent.ts';

/**
 * Three clients, one file, written at the SAME INSTANT.
 *
 * Every existing test of "both clients modify the same file" is sequential on
 * purpose — *A writes, wait for convergence, then B writes* — and says so. So
 * the case the lab actually fails is the one nothing here covers: the
 * `conflict-resolution` recipe writes from every participant at once and then
 * requires that all of them end on the same content, whichever version wins.
 *
 * Measured on four machines, 2026-09-19:
 *
 *     nodes diverged on conflict/shared.txt after 60s: 3 distinct versions
 *     [NB-21624=263d5dab, NB-2505=4ca963ab, NB-2510=19c23d89, NB-2744=19c23d89]
 *
 * — three stable answers, not a race still settling.
 *
 * The configuration below is the one a CARAT One Client ships:
 * `causalOrdering` on, `resolveConflicts` OFF. That gate is deliberate (turning
 * the merge on once dropped the lab to 4 of 11), and what this test exists to
 * establish is what it COSTS: whether simultaneous edits still converge without
 * it, or whether the recipe is red because it is asking for a feature that is
 * switched off.
 */

/**
 * How many times the contest is run.
 *
 * One round converges by luck often enough to mean nothing — the same three
 * writes settle immediately on one run and stick on the next. Five is what
 * separated "slow" from "stuck" when this was measured.
 */
const ROUNDS = 5;

const TREE = 'sharedTree';
const SYNC: SyncConfig = { causalOrdering: true, includeClientIdentity: true };

/** One participant. */
interface Node {
  localIo: IoMem;
  db: Db;
  connector: Connector;
  agent: FsAgent;
  folder: string;
  stops: Array<() => void>;
}

describe.each([
  { merge: true, label: 'with conflict resolution' },
  { merge: false, label: 'without it — as a One Client ships' },
])('three clients writing the same file at once, $label', ({ merge }) => {
  // Its own directory per case: two describes sharing one would have each
  // one's `afterEach` deleting the other's folders.
  const root = join(
    process.cwd(),
    `test-temp-simultaneous-${merge ? 'merge' : 'plain'}`,
  );
  const route = Route.fromFlat(`/${TREE}`);
  let server: Server;
  let nodes: Node[] = [];

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    const treeCfg = createTreesTableCfg(TREE);
    const sharedBs = new BsMem();

    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    server = new Server(route, serverIo, sharedBs, { syncConfig: SYNC });
    await server.init();

    nodes = [];
    for (const name of ['A', 'B', 'C']) {
      const folder = join(root, name);
      await mkdir(folder, { recursive: true });
      const localIo = new IoMem();
      await localIo.init();
      await localIo.isReady();
      await new Db(localIo).core.createTableWithInsertHistory(treeCfg);

      const agent = new FsAgent(folder, sharedBs, {
        resolveConflicts: merge,
        timeouts: { debounceMs: 100, processRefRetryDelayMs: 300 },
      });

      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      await server.addSocket(serverSocket);
      const client = new Client(clientSocket, localIo, sharedBs);
      await client.init();
      const db = new Db(client.io!);
      const connector = new Connector(db, route, clientSocket, SYNC);

      const node: Node = {
        localIo,
        db,
        connector,
        agent,
        folder,
        stops: [],
      };
      node.stops.push(await agent.syncToDb(db, connector, TREE));
      node.stops.push(
        await agent.syncFromDb(db, connector, TREE, { cleanTarget: true }),
      );
      nodes.push(node);
    }
  });

  afterEach(async () => {
    for (const node of nodes) {
      for (const stop of node.stops) stop();
      node.agent.scanner.stopWatch();
    }
    await rm(root, { recursive: true, force: true });
  });

  /**
   * What each node holds of the shared file.
   * @returns One entry per node, in order.
   */
  const held = async (): Promise<string[]> =>
    Promise.all(
      nodes.map(async (node) => {
        try {
          return await readFile(join(node.folder, 'shared.txt'), 'utf8');
        } catch {
          return '<missing>';
        }
      }),
    );

  // **The second case is expected to FAIL, and that is the measurement.**
  // `it.fails` passes while the body does not converge and turns red the day it
  // does — so the cost of shipping with the merge switched off is recorded
  // here rather than rediscovered on four machines, and improving it cannot
  // pass unnoticed.
  const contest = merge ? it : it.fails;

  it('lets one writer\'s second edit win, which is not a conflict at all', async () => {
    // **Not a contest.** One node writes, everybody converges, the SAME node
    // writes again. Nothing else touched the file, so the second version must
    // reach every peer — there is no disagreement to resolve.
    //
    // The lab's `content-variety` recipe does exactly this (`shrink.txt`:
    // "long original content here", converge, then "tiny") and reported, with
    // the merge enabled on the sandbox route:
    //
    //     file "shrink.txt" content mismatch on NB-21624
    //     [NB-21624=other-content, NB-2505=other-content, NB-2744=other-content]
    //
    // Three peers agreeing with each other on the version the writer had
    // already replaced.
    //
    // **It does not reproduce here**, with or without the merge — so whatever
    // the lab hit needs more than two sequential writes. The recipe writes
    // five files first, one of them 200 KB, and the second edit lands while
    // that is still moving. This test stays as the invariant it asserts: a
    // lone writer's second edit must reach every peer, because nothing
    // competed for it. If that ever stops being true in THIS shape, it is a
    // much simpler bug than the one on the lab.
    const writer = nodes[0]!;

    await writeFile(join(writer.folder, 'shared.txt'), 'long original content');
    for (let i = 0; i < 100; i += 1) {
      const seen = await held();
      if (seen.every((one) => one === 'long original content')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await held()).toEqual([
      'long original content',
      'long original content',
      'long original content',
    ]);

    // The second edit, by the same writer, with nobody competing.
    await writeFile(join(writer.folder, 'shared.txt'), 'tiny');

    let seen = await held();
    for (let i = 0; i < 100 && !seen.every((one) => one === 'tiny'); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      seen = await held();
    }

    expect(seen, `peers did not take the writer's second edit`).toEqual([
      'tiny',
      'tiny',
      'tiny',
    ]);
  }, 60_000);

  contest('converges on one version, whichever wins', async () => {
    // Seed, and let every node agree before the contest starts. Without this
    // the test measures the first propagation rather than the conflict.
    await writeFile(join(nodes[0]!.folder, 'shared.txt'), 'seed');
    for (let i = 0; i < 100; i += 1) {
      const seen = await held();
      if (seen.every((one) => one === 'seed')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await held()).toEqual(['seed', 'seed', 'seed']);

    // **Five rounds, not one.** A single contest converges by luck often
    // enough to mean nothing: the same three writes settle immediately on one
    // run and stick on the next. What separates "slow" from "stuck" is doing
    // it repeatedly.
    const stuck: string[][] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      await Promise.all(
        nodes.map((node, i) =>
          writeFile(join(node.folder, 'shared.txt'), `r${round}-version-${i}`),
        ),
      );

      // Polled, not sampled once: convergence after concurrent writes is by
      // definition not instantaneous — the peers have to exchange the
      // competing versions before any of them can settle.
      let seen = await held();
      for (let i = 0; i < 60 && new Set(seen).size !== 1; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await held();
      }
      if (new Set(seen).size !== 1) stuck.push(seen);
    }

    expect(
      stuck,
      `diverged in ${stuck.length} of ${ROUNDS} rounds: ${JSON.stringify(stuck)}`,
    ).toEqual([]);
  }, 120_000);
});
