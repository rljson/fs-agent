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
// ordering it should never have entered: see `orders a BRANCH, not a path` in
// `fs-conflict-resolver.spec.ts`.
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

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';

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
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    return { db, connector, agent, socket, bs };
  };

  /** Every path this node has ever claimed to have changed. */
  const claimed = async (db: Db): Promise<string[]> => {
    const chain = new FsEditChain(db, TREE);
    await chain.init();
    const out = new Set<string>();
    let head = chain.head;
    const seen = new Set<string>();
    while (head && !seen.has(head)) {
      seen.add(head);
      const entry = await chain.entry(head);
      if (!entry) break;
      for (const path of entry.changed) out.add(path);
      head = entry.previous[0];
    }
    return [...out].sort();
  };

  // ...........................................................................
  it('does not claim a file it received', async () => {
    const { db, connector, agent, socket, bs } = await wire();

    // Sync starts on an EMPTY folder, so the root entry is empty and every
    // claim after it is an edit. A file already present when a node starts is
    // part of the state it began in, not something it did — which is why the
    // first push states nothing at all.
    const stopTo = await agent.syncToDb(db, connector, TREE);
    const stopFrom = await agent.syncFromDb(db, connector, TREE, {
      cleanTarget: true,
    });
    await new Promise((r) => setTimeout(r, 400));

    // One file of its own, written here, after the node is live.
    await writeFile(join(dir, 'mine.txt'), 'mine');
    await new Promise((r) => setTimeout(r, 600));

    // A peer sends a tree holding both files. `theirs.txt` arrives here; this
    // node writes nothing.
    await writeFile(join(peerDir, 'mine.txt'), 'mine');
    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peerRef = await new FsDbAdapter(db, TREE).storeFsTree(
      await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
    );
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 1_200));

    const paths = await claimed(db);
    expect(paths, 'the file never arrived, so the test proves nothing').toEqual(
      expect.arrayContaining(['mine.txt']),
    );
    expect(
      paths,
      'claimed a file it only received — an edit where no change was made',
    ).not.toContain('theirs.txt');

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // ...........................................................................
  it('still claims a file it wrote itself after receiving one', async () => {
    // The control. A rule that stops claiming received paths must not stop
    // claiming real ones, or the chain says nothing about anybody's work.
    const { db, connector, agent, socket, bs } = await wire();

    const stopTo = await agent.syncToDb(db, connector, TREE);
    const stopFrom = await agent.syncFromDb(db, connector, TREE, {
      cleanTarget: true,
    });
    await new Promise((r) => setTimeout(r, 400));

    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peerRef = await new FsDbAdapter(db, TREE).storeFsTree(
      await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
    );
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 900));

    // And now a genuine local edit, on top of a received folder.
    await writeFile(join(dir, 'later.txt'), 'written here');
    await new Promise((r) => setTimeout(r, 900));

    const paths = await claimed(db);
    expect(paths, 'a real local edit went unclaimed').toContain('later.txt');
    expect(paths).not.toContain('theirs.txt');

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
    const stopFrom = await agent.syncFromDb(db, connector, TREE, {
      cleanTarget: true,
    });
    await new Promise((r) => setTimeout(r, 400));

    // The peer holds only `keep.txt` and STATES that it removed the other.
    await writeFile(join(peerDir, 'keep.txt'), 'keep');
    const peerTree = await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract();
    const peerRef = await new FsDbAdapter(db, TREE).storeFsTree(peerTree);
    const peerChain = new FsEditChain(db, TREE);
    await peerChain.init();
    const peerEntry = await peerChain.append({
      treeRef: peerRef,
      removed: ['doomed.txt'],
    });
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: `~H~${peerEntry.head}`,
    });
    await new Promise((r) => setTimeout(r, 1_200));

    const chain = new FsEditChain(db, TREE);
    await chain.init();
    const removedByThisNode = new Set<string>();
    let head = chain.head;
    const seen = new Set<string>();
    while (head && !seen.has(head)) {
      seen.add(head);
      const entry = await chain.entry(head);
      if (!entry) break;
      // The peer's own entry is in this db too; only entries this node
      // authored are in its lineage, and the peer's is not one of them.
      if (entry.head !== peerEntry.head) {
        for (const path of entry.removed) removedByThisNode.add(path);
      }
      head = entry.previous[0];
    }

    expect(
      [...removedByThisNode],
      'claimed a deletion it was told about',
    ).not.toContain('doomed.txt');

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });
});
