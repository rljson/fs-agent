// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Receiving, when a part of it fails.
//
// Every failure here leaves the folder as it was and says so — in the status,
// in `.sync-errors.log`, or by waiting — and the next head the hub says tries
// again. None of them may adopt a head it could not apply, and none may stop
// the agent from hearing the next one.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route, type RefStamp } from '@rljson/rljson';

import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_STATE_FILE,
  FsAgent,
  RECEIVE_AGAIN_MAX,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';
import { SAFETY_RESCAN_INTERVAL_MS } from '../src/fs-scanner.ts';
import { FsStamps } from '../src/fs-stamps.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const TREE = 'fsTree';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `check` holds — for longer than one safety rescan.
 *
 * Most waits here end on a watcher event, and a watcher may miss one: on
 * macOS, one started as another test's closed was measured hearing nothing for
 * seconds. The safety rescan is what the agent relies on then, so a wait must
 * outlast it, or the test measures the watcher instead of the agent.
 * @param check - The condition.
 * @param what - What is awaited, for the failure message.
 */
const until = async (
  check: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + SAFETY_RESCAN_INTERVAL_MS + 3_000;
  while (Date.now() < deadline && !(await check())) await sleep(10);
  expect(await check(), `timed out waiting: ${what}`).toBe(true);
};

const stamp = (n: number): RefStamp => ({
  domain: 'office',
  epoch: 1,
  hub: 'hub-a',
  n,
});

describe('FsAgent — receiving, when a part of it fails', () => {
  let nth = 0;
  let dir = '';
  let peerDir = '';
  let stops: Array<() => void> = [];
  let agents: FsAgent[] = [];

  beforeEach(async () => {
    nth++;
    dir = join(process.cwd(), `test-temp-receive-degrade-${nth}`);
    peerDir = `${dir}-peer`;
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
    stops = [];
    agents = [];
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    for (const agent of agents) agent.scanner.stopWatch();
    vi.restoreAllMocks();
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  const errors = (): string => {
    const file = join(dir, SYNC_ERROR_FILE);
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  };

  /**
   * An agent syncing `dir`, and ways to play the network.
   * @param options - Agent options beyond the fixture's.
   * @returns The agent and the means to talk to it.
   */
  const start = async (options: Record<string, unknown> = {}) => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${TREE}`), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string, opts?: Parameters<typeof realSend>[1]) => {
      sent.push(ref);
      return realSend(ref, opts);
    };
    const bs = new BsMem();
    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
      ...options,
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, TREE));
    stops.push(await agent.syncFromDb(db, connector, TREE));
    return {
      agent,
      db,
      bs,
      sent,
      /** A peer's announcement, with a stamp when given. */
      say: (head: string, by?: RefStamp) =>
        socket.emit(connector.events.ref, {
          o: 'remote-peer',
          r: head,
          ...(by ? { stamp: by } : {}),
        }),
      /** The hub's beacon. */
      beacon: (head: string) =>
        socket.emit(stateBeaconEvent(connector.route.flat), { r: head }),
      /** The hub telling this node the stamp of its own head. */
      stampOwn: (head: string, by: RefStamp) =>
        socket.emit(connector.events.stamp, { r: head, stamp: by }),
    };
  };

  /** An entry naming a tree nobody stored. */
  const unreadable = async (db: Db, previous: string[]) =>
    new FsEditChain(db, TREE).append({
      treeRef: 'NO_SUCH_TREE',
      changed: ['phantom.txt'],
      previous,
    });

  // ...........................................................................
  it('does not adopt a descending head whose tree cannot be read', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    const own = agent.ownHead as string;
    const head = (await unreadable(db, [own])).head;

    beacon(head);
    await until(
      () => agent.antiEntropyStatus?.lastRepair?.action === 'blocked',
      'the apply was refused',
    );
    expect(agent.ownHead).toBe(own);
  });

  it('does not merge a fork whose tree cannot be read', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    const root = agent.ownHead as string;
    await writeFile(join(dir, 'b.txt'), 'b');
    await until(() => agent.ownHead !== root, 'b.txt was authored');
    const own = agent.ownHead as string;
    const head = (await unreadable(db, [root])).head;

    beacon(head);
    await until(
      () => agent.antiEntropyStatus?.lastRepair?.action === 'blocked',
      'the merge was refused',
    );
    expect(agent.ownHead).toBe(own);
  });

  // ...........................................................................
  it('keeps a directory a head removes while it still holds a file the sync ignores', async () => {
    await mkdir(join(dir, 'd'), { recursive: true });
    await writeFile(join(dir, 'd', 'doc.txt'), 'doc');
    await writeFile(join(dir, 'keep.txt'), 'keep');
    const { agent, db, bs, say } = await start({ ignore: ['*.tmp'] });
    await writeFile(join(dir, 'd', 'scratch.tmp'), 'not synced');

    await writeFile(join(peerDir, 'keep.txt'), 'keep');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      removed: ['d', 'd/doc.txt'],
      previous: [agent.ownHead as string],
    });
    say(peer.announcement);
    await until(
      () => !existsSync(join(dir, 'd', 'doc.txt')),
      'the deletion was applied',
    );

    // The directory stays: it is not empty. It is this folder's again, so it
    // is authored back — an empty directory, which is what peers can see.
    expect(existsSync(join(dir, 'd', 'scratch.tmp'))).toBe(true);
    expect(errors()).toBe('');
  });

  // ...........................................................................
  it('starts as a joiner when the head it recorded cannot be read', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const first = await start();
    const recorded = first.agent.ownHead as string;
    for (const stop of stops.splice(0)) stop();
    first.agent.scanner.stopWatch();

    vi.spyOn(FsEditChain.prototype, 'entry').mockRejectedValueOnce(
      new Error('db down'),
    );
    const again = await start();
    // The folder is the origin of its history again — the same root, because
    // a root is named by its content.
    expect(again.agent.ownHead).toBe(recorded);
  });

  // ...........................................................................
  it('writes what it holds of a tree that lacks a node, and only that', async () => {
    // A tree fetched through peers can lack a node nobody could serve.
    const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(agent);
    await writeFile(join(peerDir, 'a.txt'), 'a');
    await writeFile(join(peerDir, 'b.txt'), 'b');
    const tree = await new FsAgent(peerDir, agent.bs, ORIGIN_FIXTURE).extract();
    const missing = [...tree.trees].find(
      ([, node]) => node.meta?.relativePath === 'b.txt',
    )?.[0];
    const holed = {
      rootHash: tree.rootHash,
      trees: new Map([...tree.trees].filter(([hash]) => hash !== missing)),
    };

    await (
      agent as unknown as {
        _restorePaths(t: typeof holed, p: string[]): Promise<void>;
      }
    )._restorePaths(holed, ['a.txt', 'b.txt']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });

  // ...........................................................................
  it('records an edit it could not author, and authors the next one', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent } = await start();
    const before = agent.ownHead;
    vi.spyOn(FsEditChain.prototype, 'append').mockRejectedValueOnce(
      new Error('disk gone'),
    );

    await writeFile(join(dir, 'b.txt'), 'b');
    await until(() => errors().includes('disk gone'), 'the failure was recorded');
    expect(errors()).toContain('syncToDb');
    expect(agent.ownHead).toBe(before);

    await writeFile(join(dir, 'c.txt'), 'c');
    await until(() => agent.ownHead !== before, 'the next edit was authored');
  });

  // ...........................................................................
  describe('a join', () => {
    /** A history that once held `old.txt`, then removed it. */
    const history = async (db: Db, bs: BsMem) => {
      await writeFile(join(peerDir, 'old.txt'), 'old');
      await writeFile(join(peerDir, 'keep.txt'), 'keep');
      const root = await announceAsPeer(db, TREE, {
        tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      });
      await rm(join(peerDir, 'old.txt'));
      return announceAsPeer(db, TREE, {
        tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
        removed: ['old.txt'],
        previous: [root.head],
      });
    };

    it('that fails is recorded, and the agent keeps hearing', async () => {
      // An empty folder waits to be told; the head it hears is a join.
      const { agent, db, bs, say, beacon } = await start();
      const head = await history(db, bs);
      vi.spyOn(agent, 'restore').mockRejectedValueOnce(new Error('no space'));

      say(head.announcement);
      await until(() => errors().includes('no space'), 'the failure was recorded');
      expect(errors()).toContain('join');
      expect(agent.ownHead).toBeUndefined();

      // Said again — by the hub, as it says its head on every beacon.
      beacon(head.head);
      await until(() => agent.ownHead === head.head, 'the second join worked');
    });

    it('that fails after waiting for the network is recorded too', async () => {
      await writeFile(join(dir, 'mine.txt'), 'mine');
      const { agent, db, bs, beacon } = await start({ joinWaitMs: 5_000 });
      const head = await history(db, bs);
      vi.spyOn(agent, 'restore').mockRejectedValueOnce(new Error('no space'));

      beacon(head.head);
      await until(() => errors().includes('no space'), 'the failure was recorded');
      expect(errors()).toContain('join');
    });

    for (const [label, walk] of [
      ['cannot read what the history removed', () => Promise.reject(new Error('gone'))],
      [
        'reads only part of what the history removed',
        () => Promise.resolve({ removed: ['old.txt'], changed: [], complete: false }),
      ],
    ] as const) {
      it(`that ${label} treats nothing as a stale copy`, async () => {
        await writeFile(join(dir, 'old.txt'), 'old');
        const { agent, db, bs, beacon } = await start({ joinWaitMs: 5_000 });
        const head = await history(db, bs);
        vi.spyOn(FsEditChain.prototype, 'collectRemovals').mockImplementationOnce(
          walk as never,
        );

        beacon(head.head);
        await until(() => agent.ownHead !== undefined, 'the join completed');
        // Kept where it was and authored as this node's work, rather than
        // set aside on the strength of a history that could not be read.
        expect(readFileSync(join(dir, 'old.txt'), 'utf-8')).toBe('old');
        expect(existsSync(join(dir, '.fsagent-recovered'))).toBe(false);
      });
    }
  });

  // ...........................................................................
  it('records a stamp it could not file, and still receives the head', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, bs, say } = await start();
    vi.spyOn(FsStamps.prototype, 'heard').mockRejectedValueOnce(
      new Error('stamps unreadable'),
    );
    await writeFile(join(peerDir, 'a.txt'), 'a');
    await writeFile(join(peerDir, 'b.txt'), 'b');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['b.txt'],
      previous: [agent.ownHead as string],
    });

    say(peer.announcement, stamp(5));
    await until(() => errors().includes('stamps unreadable'), 'recorded');
    expect(errors()).toContain('stamps/heard');
    await until(() => agent.ownHead === peer.head, 'the head was applied');
  });

  // ...........................................................................
  it('waits for a peer’s stamp without asking the hub for its own', async () => {
    // Only the OTHER version's stamp is missing. Announcing this node's head
    // again cannot bring it, so it does not.
    await writeFile(join(dir, 'doc.txt'), 'base');
    const { agent, db, bs, say, stampOwn, sent } = await start();
    const root = agent.ownHead as string;
    await writeFile(join(dir, 'doc.txt'), 'mine');
    await until(() => agent.ownHead !== root, 'the edit was authored');
    stampOwn(agent.ownHead as string, stamp(2));

    await writeFile(join(peerDir, 'doc.txt'), 'theirs');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['doc.txt'],
      previous: [root],
    });
    await sleep(100);
    sent.length = 0;

    say(peer.announcement); // no stamp
    await sleep(300);
    expect(sent).toEqual([]);
    expect(readFileSync(join(dir, 'doc.txt'), 'utf-8')).toBe('mine');
  });

  // ...........................................................................
  it('records a state file it could not write, and still adopts the head', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, bs, say } = await start();
    // A directory where the state file belongs: every write of it fails.
    await rm(join(dir, AGENT_STATE_FILE), { force: true });
    await mkdir(join(dir, AGENT_STATE_FILE));

    await writeFile(join(peerDir, 'a.txt'), 'a');
    await writeFile(join(peerDir, 'b.txt'), 'b');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['b.txt'],
      previous: [agent.ownHead as string],
    });
    say(peer.announcement);
    await until(() => agent.ownHead === peer.head, 'the head was adopted');
    expect(readFileSync(join(dir, 'b.txt'), 'utf-8')).toBe('b');
    expect(errors()).toContain('state/write');
  });

  // ...........................................................................
  describe('a folder that moves under the apply', () => {
    // A receive authors the folder's own work first, so an apply only ever
    // meets a change that landed after that scan. It writes over nothing it
    // has not read: it stops, and the head is received again — the change is
    // then this node's work, and the head a fork to merge.

    /**
     * Lets the next authoring scan run, then makes `edit` — as a save landing
     * between that scan and the apply would.
     * @param agent - The node.
     * @param edit - The change.
     */
    const editAfterTheScan = (agent: FsAgent, edit: () => Promise<void>) => {
      const scan = agent.scanner.scanFresh.bind(agent.scanner);
      vi.spyOn(agent.scanner, 'scanFresh').mockImplementationOnce(async () => {
        const tree = await scan();
        await edit();
        return tree;
      });
    };

    /** Spies on the agent receiving a head again. */
    const receivedAgain = (agent: FsAgent) =>
      vi.spyOn(
        agent as unknown as { _receiveAgain(head: string): void },
        '_receiveAgain',
      );

    /** Whether `head` descends from `ancestor`. */
    const descends = async (db: Db, head: string | undefined, ancestor: string) =>
      head !== undefined &&
      (await new FsEditChain(db, TREE).relate(head, ancestor)).verdict === 'ahead';

    it('does not apply a head over a save it has not read', async () => {
      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'b.txt'), 'b');
      const { agent, db, bs, say } = await start();
      // No watcher: the save below reaches this node only through the scans
      // its receive makes.
      agent.scanner.stopWatch();

      await writeFile(join(peerDir, 'b.txt'), 'b');
      const peer = await announceAsPeer(db, TREE, {
        tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
        removed: ['a.txt'],
        previous: [agent.ownHead as string],
      });
      editAfterTheScan(agent, () => writeFile(join(dir, 'a.txt'), 'saved'));
      const again = receivedAgain(agent);

      say(peer.announcement);
      await until(() => descends(db, agent.ownHead, peer.head), 'the head was merged');
      expect(again).toHaveBeenCalledWith(peer.head);
      // The save stands: an edit beats a concurrent deletion.
      expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('saved');
    });

    it('does not merge a head over a save it has not read', async () => {
      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'b.txt'), 'b');
      const { agent, db, bs, say } = await start();
      const root = agent.ownHead as string;
      await writeFile(join(dir, 'b.txt'), 'b, mine');
      await until(() => agent.ownHead !== root, 'b.txt was authored');
      agent.scanner.stopWatch();

      await writeFile(join(peerDir, 'a.txt'), 'a, theirs');
      await writeFile(join(peerDir, 'b.txt'), 'b');
      const peer = await announceAsPeer(db, TREE, {
        tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
        changed: ['a.txt'],
        previous: [root],
      });
      // The merge would write `a.txt`; a person deletes it first.
      editAfterTheScan(agent, () => rm(join(dir, 'a.txt')));
      const again = receivedAgain(agent);

      say(peer.announcement);
      await until(() => descends(db, agent.ownHead, peer.head), 'the head was merged');
      expect(again).toHaveBeenCalledWith(peer.head);
      // Merged again with the deletion as this node's work: the edit wins.
      expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('a, theirs');
      expect(readFileSync(join(dir, 'b.txt'), 'utf-8')).toBe('b, mine');
      // Written over, the deletion would be on record nowhere.
      const chain = new FsEditChain(db, TREE);
      const merge = await chain.entry(agent.ownHead as string);
      const mine = await Promise.all(
        (merge?.previous ?? [])
          .filter((p) => p !== peer.head)
          .map((p) => chain.entry(p)),
      );
      expect(mine.flatMap((e) => e?.removed ?? [])).toEqual(['a.txt']);
    });

    it('stops receiving again while its scan cannot catch up, and tries the next time the head is said', async () => {
      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'b.txt'), 'b');
      const { agent, db, bs, say, beacon } = await start();
      agent.scanner.stopWatch();
      const before = await agent.scanner.scanFresh();

      await writeFile(join(peerDir, 'b.txt'), 'b');
      const peer = await announceAsPeer(db, TREE, {
        tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
        removed: ['a.txt'],
        previous: [agent.ownHead as string],
      });
      // Every scan misses the save: a cache that never catches up.
      const scans = vi.spyOn(agent.scanner, 'scanFresh').mockResolvedValue(before);
      await writeFile(join(dir, 'a.txt'), 'saved');
      const again = receivedAgain(agent);
      const own = agent.ownHead;

      say(peer.announcement);
      await until(
        () => again.mock.calls.length > RECEIVE_AGAIN_MAX,
        'it received the head again, up to the bound',
      );
      await sleep(100);
      expect(again).toHaveBeenCalledTimes(RECEIVE_AGAIN_MAX + 1);
      expect(agent.ownHead).toBe(own);
      expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('saved');

      // Once the folder reads true, the hub saying the head again is enough.
      scans.mockRestore();
      beacon(peer.announcement);
      await until(() => descends(db, agent.ownHead, peer.head), 'the head was merged');
      expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('saved');
    });
  });
});
