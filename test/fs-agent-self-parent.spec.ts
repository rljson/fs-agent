// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// A push that names ITSELF as its own parent.
//
// Captured on four machines, 5 of 38 pushes in one run:
//
//   pushing ref=P5pEmrvZ… parent=P5pEmrvZ files=129
//   pushing ref=dLeK2Ssa… parent=dLeK2Ssa files=3
//
// ...and, on every peer that was not already in that state:
//
//   ref=P5pEmrvZ… descends from P5pEmrvZ, not from a state this node is in
//   — applying additively, not pruning.
//
// A receiver prunes only for a sender that names a state the RECEIVER is in.
// A push that names itself can never do that, so every deletion it carries is
// refused by everyone it reaches. When the state being announced is the result
// of a deletion, the deletion simply does not arrive — which is what the
// folder-delta recipe reports as "was deleted but is still on NB-21624".
//
// **The obvious mechanism is NOT the one.** The push takes its parent from
// `_currentRef`, captured before the store, so an agent that has just applied
// an incoming tree and then re-scanned the folder it was given would derive
// that same ref and push it with itself as parent. That is what this test
// stages — apply a peer's tree, let the watcher re-scan — and it does not
// happen: the content-key check suppresses the push before it is built.
//
// So this is an INVARIANT test, not a reproduction. It holds the one property
// that must be true of every push, on the one path where it can be driven
// end-to-end, and it rules out the first hypothesis. The lab's five
// self-parented pushes in thirty-eight came from somewhere else, and finding
// it needs the sender's own state logged at the moment it decides — which is
// the next step, not a guess dressed as a fix.
describe('FsAgent — a push that parents itself', () => {
  const dir = join(process.cwd(), 'test-temp-self-parent');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const makeDb = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    return db;
  };

  it('does not happen when this node has news of its own', async () => {
    // **The trigger, found by reading rather than guessing.** In the apply
    // path, `_currentRef` is set to the post-restore ref unconditionally —
    // but `_lastSentContentKey` is only set when the node has NO news of its
    // own. Hold one file the incoming tree lacks and that branch is skipped,
    // so the echo suppression is looking at a stale content key. The watcher
    // then re-scans the folder it has just been given, derives the very ref
    // `_currentRef` already names, and pushes it — with itself as parent.
    //
    // That is the shape the lab produced 5 times in 38 pushes, and every peer
    // not already in that state refused its deletions.
    const db = await makeDb();
    const bs = new BsMem();
    const adapter = new FsDbAdapter(db, 'fsTree');

    // A peer's tree, holding a file this agent does not have.
    const sourceDir = join(process.cwd(), 'test-temp-self-parent-news-src');
    await rm(sourceDir, { recursive: true, force: true, maxRetries: 10 });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'from-peer.txt'), 'peer');
    const peerRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );

    // ...and a file of OUR OWN that the peer's tree does not know about. This
    // is what makes `hasNewsOfOurOwn` true.
    await writeFile(join(dir, 'ours.txt'), 'ours');

    const agent = new FsAgent(dir, bs, {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket, {
      causalOrdering: true,
      includeClientIdentity: true,
    });

    const sent: Array<{ r: string; p?: string[] }> = [];
    socket.on(connector.events.ref, (payload: { r: string; p?: string[] }) => {
      sent.push(payload);
    });

    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');

    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 900));

    const selfParented = sent.filter((one) => one.p?.includes(one.r));
    expect(
      selfParented,
      `self-parented pushes: ${JSON.stringify(selfParented)}`,
    ).toEqual([]);

    stopFrom();
    stopTo();
    agent.scanner.stopWatch();
    await rm(sourceDir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('never happens: the state it would announce is the one it just adopted', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    const adapter = new FsDbAdapter(db, 'fsTree');

    // A peer's tree, holding one file this agent does not have yet.
    const sourceDir = join(process.cwd(), 'test-temp-self-parent-src');
    await rm(sourceDir, { recursive: true, force: true, maxRetries: 10 });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'from-peer.txt'), 'peer');
    const peerRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );

    const agent = new FsAgent(dir, bs, {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket, {
      causalOrdering: true,
      includeClientIdentity: true,
    });

    // Everything this agent puts on the wire.
    const sent: Array<{ r: string; p?: string[] }> = [];
    socket.on(connector.events.ref, (payload: { r: string; p?: string[] }) => {
      sent.push(payload);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');

    // The peer's state arrives and is applied: the agent adopts `peerRef` and
    // the folder now holds exactly what that tree describes.
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 700));

    // The watcher has seen the written file and re-scanned by now. Whatever it
    // decided to say, it must not have said "this state descends from itself".
    const selfParented = sent.filter((one) => one.p?.includes(one.r));
    expect(
      selfParented,
      `self-parented pushes: ${JSON.stringify(selfParented)}`,
    ).toEqual([]);

    // ...and the log the lab reads must not show one either.
    const pushes = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('pushing ref='));
    for (const line of pushes) {
      const m = /pushing ref=(\S+)… parent=(\S+) /.exec(line);
      if (m) expect(m[1], line).not.toBe(m[2]);
    }

    stopFrom();
    stopTo();
    agent.scanner.stopWatch();
    logSpy.mockRestore();
    await rm(sourceDir, { recursive: true, force: true, maxRetries: 10 });
  });
});
