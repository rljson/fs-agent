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

import { mkdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../../src/fs-agent.ts';

import type { AntiEntropyOptions } from '../../src/fs-anti-entropy.ts';

/**
 * `heals-after-forced-divergence`: drop one message on purpose, and require
 * the network to agree again with nobody doing anything.
 *
 * Every change reaches a peer as exactly one message, and nothing ever asked
 * afterwards whether it arrived. The lab's defects of the last months — the
 * lost deletion, the node that went quiet, the forward that never landed —
 * all end the same way: two machines on two states, permanently, with nothing
 * saying so. This is the test that would have caught nearly all of them,
 * because it does not care WHICH message went missing.
 *
 * The configuration is the one a CARAT One Client ships: `causalOrdering` and
 * client identity on, and a hub heartbeat — the heartbeat is what carries the
 * hub's state to a node that missed it.
 */

const TREE = 'sharedTree';
const SYNC: SyncConfig = { causalOrdering: true, includeClientIdentity: true };
const HEARTBEAT_MS = 150;
const AE: AntiEntropyOptions = { graceMs: 500, maxBackoffMs: 2_000 };

/** How long a healed network may take, and how long an unhealed one is given. */
const HEAL_BUDGET_MS = 15_000;

/** One participant. */
interface Node {
  name: string;
  folder: string;
  agent: FsAgent;
  stops: Array<() => void>;
  /** Pushes from this node the hub will not receive. */
  dropPushes: number;
  /** Forwards to this node it will not receive. */
  dropForwards: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each([
  { antiEntropy: AE, label: 'with anti-entropy' },
  { antiEntropy: { enabled: false }, label: 'CONTROL: anti-entropy off' },
])('heals-after-forced-divergence, $label', ({ antiEntropy }) => {
  const healing = antiEntropy.enabled !== false;
  const root = join(
    process.cwd(),
    `test-temp-heals-${healing ? 'on' : 'off'}`,
  );
  const route = Route.fromFlat(`/${TREE}`);
  let server: Server;
  let nodes: Node[] = [];

  const node = (name: string) => nodes.find((n) => n.name === name)!;

  /** What every node holds at `path`, `<missing>` where it holds nothing. */
  const held = (path: string): Promise<string[]> =>
    Promise.all(
      nodes.map(async (n) => {
        try {
          return await readFile(join(n.folder, path), 'utf8');
        } catch {
          return '<missing>';
        }
      }),
    );

  /**
   * Polls until every node holds `expected` at `path`.
   * @returns What they held when it gave up, or the agreement.
   */
  const until = async (
    path: string,
    expected: string,
    budgetMs = HEAL_BUDGET_MS,
  ): Promise<string[]> => {
    const deadline = Date.now() + budgetMs;
    let seen = await held(path);
    while (!seen.every((s) => s === expected) && Date.now() < deadline) {
      await sleep(100);
      seen = await held(path);
    }
    return seen;
  };

  const all = (value: string) => nodes.map(() => value);

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    const treeCfg = createTreesTableCfg(TREE);
    const sharedBs = new BsMem();

    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    server = new Server(route, serverIo, sharedBs, {
      syncConfig: { ...SYNC, bootstrapHeartbeatMs: HEARTBEAT_MS },
    });
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
        timeouts: { debounceMs: 100, processRefRetryDelayMs: 300 },
        antiEntropy,
      });

      const [serverSocket, clientSocket] = createSocketPair();
      const n: Node = {
        name,
        folder,
        agent,
        stops: [],
        dropPushes: 0,
        dropForwards: 0,
      };

      // The message loss, on the ref channel only: io, blobs, health and the
      // heartbeat still flow, exactly as when one socket.io packet is lost.
      const toHub = clientSocket.emit.bind(clientSocket);
      clientSocket.emit = ((event: string, ...args: unknown[]) => {
        if (event === route.flat && n.dropPushes > 0) {
          n.dropPushes--;
          return true;
        }
        return toHub(event, ...args);
      }) as typeof clientSocket.emit;
      const toNode = serverSocket.emit.bind(serverSocket);
      serverSocket.emit = ((event: string, ...args: unknown[]) => {
        if (event === route.flat && n.dropForwards > 0) {
          n.dropForwards--;
          return true;
        }
        return toNode(event, ...args);
      }) as typeof serverSocket.emit;

      serverSocket.connect();
      await server.addSocket(serverSocket);
      const client = new Client(clientSocket, localIo, sharedBs);
      await client.init();
      const db = new Db(client.io!);
      const connector = new Connector(db, route, clientSocket, SYNC);

      n.stops.push(await agent.syncToDb(db, connector, TREE));
      n.stops.push(
        await agent.syncFromDb(db, connector, TREE, { cleanTarget: true }),
      );
      nodes.push(n);
    }

    // Agree on a starting point before anything is dropped, so each case
    // measures the loss and not the first propagation.
    await writeFile(join(node('A').folder, 'seed.txt'), 'seed');
    expect(await until('seed.txt', 'seed')).toEqual(all('seed'));
  }, 60_000);

  afterEach(async () => {
    for (const n of nodes) {
      for (const stop of n.stops) stop();
      n.agent.scanner.stopWatch();
    }
    await server.tearDown();
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  if (healing) {
    it('delivers a new file whose push the hub never received', async () => {
      node('A').dropPushes = 1;
      await writeFile(join(node('A').folder, 'lost.txt'), 'arrives anyway');

      expect(await until('lost.txt', 'arrives anyway')).toEqual(
        all('arrives anyway'),
      );
      expect(node('A').agent.antiEntropyStatus?.lastRepair?.action).toBe(
        'push',
      );
    }, 30_000);

    // The dangerous one. Deleting its own file returns A to the exact state
    // before the file existed, and the hub still holds A's earlier push, made
    // FROM that state. Read by ancestry alone, the hub looks ahead of A — and
    // pulling it would put the deleted file back on A itself.
    it('delivers a deletion whose push the hub never received', async () => {
      await writeFile(join(node('A').folder, 'doomed.txt'), 'x');
      expect(await until('doomed.txt', 'x')).toEqual(all('x'));

      node('A').dropPushes = 1;
      await unlink(join(node('A').folder, 'doomed.txt'));

      expect(await until('doomed.txt', '<missing>')).toEqual(
        all('<missing>'),
      );
      // …and it STAYS deleted: nothing comes back once the repair is done.
      await sleep(2_000);
      expect(await held('doomed.txt')).toEqual(all('<missing>'));
    }, 40_000);

    it('delivers a deletion a peer never received', async () => {
      await writeFile(join(node('A').folder, 'doomed.txt'), 'x');
      expect(await until('doomed.txt', 'x')).toEqual(all('x'));

      node('B').dropForwards = 1;
      await unlink(join(node('A').folder, 'doomed.txt'));

      expect(await until('doomed.txt', '<missing>')).toEqual(
        all('<missing>'),
      );
    }, 40_000);

    // A peer deleted what we created, and the forward was lost. The same
    // shape of refs as the case above with the roles swapped — this is the
    // one a repair by hash alone would get backwards.
    it('does not undo a peer deletion it missed', async () => {
      await writeFile(join(node('A').folder, 'doomed.txt'), 'x');
      expect(await until('doomed.txt', 'x')).toEqual(all('x'));

      node('A').dropForwards = 1;
      await unlink(join(node('B').folder, 'doomed.txt'));

      expect(await until('doomed.txt', '<missing>')).toEqual(
        all('<missing>'),
      );
      await sleep(2_000);
      expect(await held('doomed.txt')).toEqual(all('<missing>'));
    }, 40_000);

    it('heals every node when the hub received nothing at all', async () => {
      // Several pushes in a row, none arriving: only the last state matters.
      node('A').dropPushes = 3;
      await writeFile(join(node('A').folder, 'burst-1.txt'), '1');
      await sleep(400);
      await writeFile(join(node('A').folder, 'burst-2.txt'), '2');
      await sleep(400);
      await writeFile(join(node('A').folder, 'burst-1.txt'), '1b');

      expect(await until('burst-1.txt', '1b')).toEqual(all('1b'));
      expect(await until('burst-2.txt', '2')).toEqual(all('2'));
    }, 40_000);

    it('reports the divergence, and that it healed', async () => {
      node('A').dropPushes = 1;
      await writeFile(join(node('A').folder, 'seen.txt'), 'seen');
      expect(await until('seen.txt', 'seen')).toEqual(all('seen'));
      // Give the heartbeat a round to confirm the agreement.
      await sleep(HEARTBEAT_MS * 3);

      const status = node('A').agent.antiEntropyStatus!;
      expect(status.repairs).toBeGreaterThan(0);
      expect(status.diverged).toBe(false);
      expect(status.hubRef).toBe(status.localRef);
    }, 30_000);
  } else {
    // The measurement that makes the rest mean something: the SAME loss,
    // with the repair switched off, stays divergent. If this ever starts to
    // heal on its own, the scenario above has stopped testing anything.
    it('stays divergent after a lost push — the defect this ticket fixes', async () => {
      node('A').dropPushes = 1;
      await writeFile(join(node('A').folder, 'lost.txt'), 'never arrives');

      const seen = await until('lost.txt', 'never arrives', 4_000);
      expect(seen).toEqual(['never arrives', '<missing>', '<missing>']);
      // It still NOTICED — off means "do not repair", not "do not look".
      expect(node('A').agent.antiEntropyStatus?.diverged).toBe(true);
    }, 30_000);
  }
});
