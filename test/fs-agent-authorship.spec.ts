// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WHO AUTHORED A CHANGE, asked deterministically.
//
// **The filesystem is an event source and nothing more.** It can say "something
// happened at this path"; it cannot say whether that was an edit made here or a
// delivery from a peer. Every such question is answered against the edit chain
// and the trees it names, and only then does an action follow.
//
// `changed` on a chain entry is the one place that distinction is written down,
// and it used to be a pure content diff of the folder against this node's last
// announcement — so a node claimed every path that differed, including the ones
// it had merely received. The entry it authored was then a real edit with a
// correct stamp for the moment of authoring, and that is exactly why it won an
// ordering it should never have entered.
//
// Tested HERE rather than through the mesh. The mesh scenario that first showed
// this (`fs-mesh-invariants.spec.ts`) has too much run-to-run variance to judge
// a fix by: the same code state measured 3 of 8 and 7 of 8 on different
// eight-run samples, and a change was briefly credited with an improvement that
// sample could not support. These assertions are about one node and one
// delivery, and they are the same every time.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const TREE = 'fsTree';

describe('a node claims only what it changed', () => {
  let nth = 0;
  let dir = '';
  let peerDir = '';

  beforeEach(async () => {
    nth++;
    dir = join(process.cwd(), `test-temp-authorship-${nth}`);
    peerDir = join(process.cwd(), `test-temp-authorship-peer-${nth}`);
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  /** A node wired to a mock socket, plus the shared blob store. */
  const wire = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${TREE}+`), socket);
    const bs = new BsMem();
    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 20},
    });
    return { db, connector, agent, socket, bs };
  };

  /**
   * What the entries this node authored name: every entry on its lineage
   * except the peer's.
   * @param db - The node's database.
   * @param head - The node's head.
   * @param peer - The heads the peer authored.
   * @returns The paths changed and removed by this node's own entries.
   */
  const claimed = async (
    db: Db,
    head: string | undefined,
    peer: ReadonlySet<string>,
  ) => {
    const chain = new FsEditChain(db, TREE);
    const changed = new Set<string>();
    const removed = new Set<string>();
    const seen = new Set<string>();
    const stack = head ? [head] : [];
    while (stack.length > 0) {
      const ref = stack.pop() as string;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const entry = await chain.entry(ref);
      if (!entry) continue;
      if (!peer.has(ref)) {
        for (const path of entry.changed) changed.add(path);
        for (const path of entry.removed) removed.add(path);
      }
      stack.push(...entry.previous);
    }
    return { changed: [...changed].sort(), removed: [...removed].sort() };
  };

  /**
   * Waits until a node's head has moved past `from`.
   * @param agent - The node.
   * @param from - Its head before.
   */
  const moved = async (agent: FsAgent, from: string | undefined) => {
    for (let i = 0; i < 100 && agent.ownHead === from; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(agent.ownHead, 'the node never moved').not.toBe(from);
  };

  // ...........................................................................
  it('does not claim a file it received', async () => {
    const { db, connector, agent, socket, bs } = await wire();

    // The folder's first state is its root and names nothing; every claim
    // after it is an edit.
    await writeFile(join(dir, 'seed.txt'), 'seed');
    const stopTo = await agent.syncToDb(db, connector, TREE);
    const stopFrom = await agent.syncFromDb(db, connector, TREE);

    // One file of its own, written here, after the node is live.
    let head = agent.ownHead;
    await writeFile(join(dir, 'mine.txt'), 'mine');
    await moved(agent, head);

    // A peer that held this node's state adds `theirs.txt`. It arrives here;
    // this node writes nothing of its own.
    const held = { 'seed.txt': 'seed', 'mine.txt': 'mine', 'theirs.txt': 'theirs' };
    for (const [name, content] of Object.entries(held)) {
      await writeFile(join(peerDir, name), content);
    }
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['theirs.txt'],
      previous: [agent.ownHead as string],
    });
    head = agent.ownHead;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peer.announcement });
    await moved(agent, head);

    const paths = await claimed(db, agent.ownHead, new Set([peer.head]));
    expect(paths.changed, 'its own edit went unclaimed').toEqual(['mine.txt']);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // ...........................................................................
  it('still claims a file it wrote itself after receiving one', async () => {
    // The control. A rule that stops claiming received paths must not stop
    // claiming real ones, or the chain says nothing about anybody's work.
    const { db, connector, agent, socket, bs } = await wire();

    await writeFile(join(dir, 'seed.txt'), 'seed');
    const stopTo = await agent.syncToDb(db, connector, TREE);
    const stopFrom = await agent.syncFromDb(db, connector, TREE);

    await writeFile(join(peerDir, 'seed.txt'), 'seed');
    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['theirs.txt'],
      previous: [agent.ownHead as string],
    });
    let head = agent.ownHead;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peer.announcement });
    await moved(agent, head);

    // And now a genuine local edit, on top of a received folder.
    head = agent.ownHead;
    await writeFile(join(dir, 'later.txt'), 'written here');
    await moved(agent, head);

    const paths = await claimed(db, agent.ownHead, new Set([peer.head]));
    expect(paths.changed).toEqual(['later.txt']);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // ...........................................................................
  it('does not claim a deletion a peer stated', async () => {
    // The other half of the delta, and the same rule: applying somebody's
    // deletion is not performing one.
    const { db, connector, agent, socket, bs } = await wire();

    await writeFile(join(dir, 'keep.txt'), 'keep');
    await writeFile(join(dir, 'doomed.txt'), 'doomed');
    const stopTo = await agent.syncToDb(db, connector, TREE);
    const stopFrom = await agent.syncFromDb(db, connector, TREE);

    // The peer holds only `keep.txt` and STATES that it removed the other.
    await writeFile(join(peerDir, 'keep.txt'), 'keep');
    const peer = await announceAsPeer(db, TREE, {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      removed: ['doomed.txt'],
      previous: [agent.ownHead as string],
    });
    const head = agent.ownHead;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peer.announcement });
    await moved(agent, head);

    const paths = await claimed(db, agent.ownHead, new Set([peer.head]));
    expect(paths.removed, 'claimed a deletion it was told about').toEqual([]);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // ...........................................................................
  it('does not claim the absence of a file its scan has not caught up with', async () => {
    // A scan can lag behind the disk: a file it has not read yet is skipped
    // until it settles. Authoring that absence would delete the file on every
    // node, so the node waits for a scan that has caught up.
    const { db, connector, agent, bs } = await wire();
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'x.txt'), 'x');
    const stopTo = await agent.syncToDb(db, connector, TREE);

    await writeFile(join(peerDir, 'a.txt'), 'a');
    const lagging = await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract();
    vi.spyOn(agent.scanner, 'scanFresh').mockResolvedValueOnce(lagging);
    const head = agent.ownHead;
    await writeFile(join(dir, 'y.txt'), 'y');
    await moved(agent, head);

    const paths = await claimed(db, agent.ownHead, new Set());
    expect(paths.removed).toEqual([]);
    expect(paths.changed).toEqual(['y.txt']);
    expect(existsSync(join(dir, 'x.txt'))).toBe(true);

    stopTo();
    agent.scanner.stopWatch();
    vi.restoreAllMocks();
  });
});
