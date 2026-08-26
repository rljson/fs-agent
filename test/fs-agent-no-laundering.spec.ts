// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// Traced on four machines during a 1 200-file seed. A node fetched ref
// _RMiGJ-1 at 13:19:43 and emitted that same ref AS ITS OWN six seconds later.
//
// That step is what makes the rollback possible. A stale tree re-advertised by
// a different node arrives as fresh news from a new sender, so the per-sender
// staleness check has nothing to object to; peers that had already moved on
// apply it and prune — 77 files each, far under the mass-delete guard's floor.
// Three of four nodes converged on a tree missing 35 files, including the node
// that had created them.
//
// The stack said `Timeout._onTimeout → _sendRef`: the debounced push, not the
// refusal answer and not the connector relaying. The apply had told the
// CONNECTOR it adopted the state and had not told the AGENT, so the next
// debounce saw a content key that did not match, concluded it had news, and
// re-derived the very ref it had just applied.
describe('FsAgent — a node does not re-advertise what it adopted', () => {
  const dir = join(process.cwd(), 'test-temp-laundering');
  const peerDir = join(process.cwd(), 'test-temp-laundering-peer');

  beforeEach(async () => {
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const wire = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };
    // One blob store for both sides: a peer's tree is only restorable if its
    // blobs are reachable, which on a real network they are.
    const bs = new BsMem();
    const agent = new FsAgent(dir, bs, {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    return { db, connector, agent, sent, socket, bs };
  };

  it('never emits a ref it received when the folder already matches it', async () => {
    const { db, connector, agent, sent, socket, bs } = await wire();

    await writeFile(join(dir, 'shared.txt'), 'shared');
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });
    await new Promise((r) => setTimeout(r, 600));
    sent.length = 0;

    // A peer advertises the state this folder is already in — the bounce-back
    // that takes the equivalent-content path.
    await writeFile(join(peerDir, 'shared.txt'), 'shared');
    const peerRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(peerDir, bs).extract(),
    );
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 1_500));

    expect(sent).not.toContain(peerRef);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The other half of the same condition, and the reason it is a condition
  // rather than a blanket rule: an apply that leaves this folder holding MORE
  // than the sender's tree has something to say, and must still say it.
  it('still announces a state the sender does not have', async () => {
    const { db, connector, agent, sent, socket, bs } = await wire();

    await writeFile(join(dir, 'shared.txt'), 'shared');
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: false,
    });
    await new Promise((r) => setTimeout(r, 600));

    // Only we have this one.
    await writeFile(join(dir, 'ours-alone.txt'), 'ours');
    await new Promise((r) => setTimeout(r, 600));
    sent.length = 0;

    // The peer advertises a tree without it. cleanTarget is off, so the apply
    // leaves a superset — our file plus theirs.
    await writeFile(join(peerDir, 'shared.txt'), 'shared');
    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peerRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(peerDir, bs).extract(),
    );
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 2_000));

    // Something went out, and it was not simply the peer's own ref handed back.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(peerRef);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The third outcome, and the one the lab measured. A node in the middle of
  // catching up holds a SUBSET of the sender's tree, and announcing that is how
  // a burst turns into a rollback: trees arrived at the writer carrying 1008
  // files, then 892, then 907, every one stamped newestFromSender=true —
  // correctly, because they came from different peers, each monotonic for
  // itself. Nothing downstream could tell "still catching up" from "deleted
  // 116 files".
  it('stays quiet when the apply left it behind the sender', async () => {
    const { db, connector, agent, sent, socket, bs } = await wire();

    await writeFile(join(dir, 'shared.txt'), 'shared');
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });
    await new Promise((r) => setTimeout(r, 600));

    // The peer has everything this node has, and more — the ordinary shape of
    // a node that is behind.
    await writeFile(join(peerDir, 'shared.txt'), 'shared');
    for (let i = 0; i < 5; i++) {
      await writeFile(join(peerDir, `theirs-${i}.txt`), `t${i}`);
    }
    const peerRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(peerDir, bs).extract(),
    );

    // Make the restore fall short, exactly as a timeout or a slow link does:
    // one blob is unreachable, so the folder ends up a strict subset.
    const realGet = bs.getBlob.bind(bs);
    (bs as unknown as { getBlob: unknown }).getBlob = async (id: string) => {
      const blob = await realGet(id);
      const text = blob ? Buffer.from(blob).toString('utf-8') : '';
      if (text === 't4') throw new Error('blob unreachable');
      return blob;
    };

    sent.length = 0;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 2_000));

    // Nothing announced: what this node holds is the peer's tree minus what
    // has not landed yet, and saying so would ask everyone to prune to it.
    expect(sent).toEqual([]);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The discriminator the first version of this rule lacked. A folder smaller
  // than the newest known tree is either a node catching up or a node someone
  // deleted from — identical in shape, opposite in what they need.
  describe('smaller than the newest known tree', () => {
    /** Puts the agent in the state a mid-catch-up node is in. */
    const knowsABiggerTree = (agent: FsAgent): void => {
      (
        agent as unknown as { _lastKnownRemoteFiles: Map<string, string> }
      )._lastKnownRemoteFiles = new Map([
        ['a.txt', 'blob-a'],
        ['b.txt', 'blob-b'],
        ['c.txt', 'blob-c'],
        ['d.txt', 'blob-d'],
        ['e.txt', 'blob-e'],
      ]);
    };

    it('stays quiet when nothing here was deleted — that is a gap', async () => {
      const { db, connector, agent, sent } = await wire();

      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'b.txt'), 'b');
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      await new Promise((r) => setTimeout(r, 600));
      sent.length = 0;

      knowsABiggerTree(agent);
      await writeFile(join(dir, 'a.txt'), 'a changed');
      await new Promise((r) => setTimeout(r, 1_200));

      expect(sent).toEqual([]);

      stopTo();
      agent.scanner.stopWatch();
    });

    // Without this, a reset folder and a real mass deletion are silenced too —
    // measured as four lab runs that never delivered anything at all.
    it('speaks when the shrinking was a local deletion', async () => {
      const { db, connector, agent, sent } = await wire();

      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'b.txt'), 'b');
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      await new Promise((r) => setTimeout(r, 600));
      sent.length = 0;

      knowsABiggerTree(agent);
      await rm(join(dir, 'b.txt'), { force: true });
      await new Promise((r) => setTimeout(r, 2_000));

      expect(sent.length).toBeGreaterThan(0);

      stopTo();
      agent.scanner.stopWatch();
    });
  });
});
