// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';

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
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 20},
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

    // A peer's edit that ends in the state this folder is already in.
    await writeFile(join(peerDir, 'shared.txt'), 'shared');
    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['shared.txt'],
      previous: [agent.ownHead as string],
    });
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: peer.announcement,
    });
    await new Promise((r) => setTimeout(r, 1_500));

    // Adopted — so the test did reach the apply — and not said again.
    expect(agent.ownHead).toBe(peer.head);
    expect(sent).not.toContain(peer.head);

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
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 600));
    const root = agent.ownHead as string;

    // Only we have this one.
    await writeFile(join(dir, 'ours-alone.txt'), 'ours');
    await new Promise((r) => setTimeout(r, 600));
    sent.length = 0;

    // The peer moved on from the same root without it: a fork, merged here
    // into a superset — our file plus theirs.
    await writeFile(join(peerDir, 'shared.txt'), 'shared');
    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['theirs.txt'],
      previous: [root],
    });
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: peer.announcement,
    });
    await new Promise((r) => setTimeout(r, 2_000));

    // Something went out, and it was not simply the peer's own head handed
    // back: the merge, which holds both.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(peer.head);
    expect(existsSync(join(dir, 'theirs.txt'))).toBe(true);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The third outcome, and the one a real fleet measured. A node in the middle
  // of catching up holds a SUBSET of the sender's tree, and announcing that is
  // how a burst turns into a rollback: trees arrived at the writer carrying
  // 1008 files, then 892, then 907, every one stamped newestFromSender=true —
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
    const own = agent.ownHead as string;
    const peerTree = await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract();
    const peer = await announceAsPeer(db, 'fsTree', {
      tree: peerTree,
      changed: [0, 1, 2, 3, 4].map((i) => `theirs-${i}.txt`),
      previous: [own],
    });
    const unreachable = [...peerTree.trees.values()].find(
      (node) => node.meta?.relativePath === 'theirs-4.txt',
    )?.meta?.blobId as string;

    // Make the restore fall short, exactly as a timeout or a slow link does:
    // one blob is unreachable, so the folder ends up a strict subset.
    const realStream = bs.getBlobStream.bind(bs);
    (bs as unknown as { getBlobStream: unknown }).getBlobStream = async (
      id: string,
    ) => {
      if (id === unreachable) throw new Error('blob unreachable');
      return realStream(id);
    };

    sent.length = 0;
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: peer.announcement,
    });
    await new Promise((r) => setTimeout(r, 2_000));

    // Some of it landed — so the apply ran — and the head was not adopted.
    expect(existsSync(join(dir, 'theirs-0.txt'))).toBe(true);
    expect(agent.ownHead).toBe(own);
    // Nothing announced: what landed is the peer's work, not this node's.
    expect(sent).toEqual([]);

    // Once the blob is reachable, the next time the hub says the head, the
    // rest lands and the head is adopted.
    (bs as unknown as { getBlobStream: unknown }).getBlobStream = realStream;
    socket.emit(stateBeaconEvent(connector.route.flat), { r: peer.head });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(existsSync(join(dir, 'theirs-4.txt'))).toBe(true);
    expect(agent.ownHead).toBe(peer.head);
    expect(sent).toEqual([]);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The insert used to notify on its own, so every ref went out TWICE: once by
  // the connector, carrying whatever predecessors it happened to hold, and once
  // by the agent with the right ones. Receivers kept the first and dropped the
  // second as already-received, so every push arrived one parent behind.
  //
  // measured on a real fleet, sender against receivers:
  //   sent 6guj63Ox parent yNAJN-wC | seen parent CtAgdd1w
  //   sent UBl35ZQQ parent 6guj63Ox | seen parent yNAJN-wC
  //
  // The watcher's last pass can have run while an apply was still writing. A
  // node that authored from it read its own write as missing, and the version
  // before it as a local edit — and announced a REVERT. Measured as the
  // multi-megabyte field case (F9): two receivers re-authored the partial
  // version of the file the writer had just completed, and the deletion that
  // followed came back from them as residue.
  it('authors from the folder as it is now, never from the last watcher pass', async () => {
    const { db, connector, agent, sent, socket, bs } = await wire();

    await writeFile(join(dir, 'doc.txt'), 'v1');
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 300));
    const before = agent.scanner.tree;

    await writeFile(join(peerDir, 'doc.txt'), 'v2');
    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
      changed: ['doc.txt'],
      previous: [agent.ownHead as string],
    });
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: peer.announcement,
    });
    for (let i = 0; i < 100 && agent.ownHead !== peer.head; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(agent.ownHead).toBe(peer.head);
    // Let the watcher's own pass over the write finish, then hold the
    // scanner still, so nothing refreshes the pass staged below.
    await new Promise((r) => setTimeout(r, 300));
    agent.scanner.stopWatch();
    sent.length = 0;

    // The pass that ran before the write landed, and the event that follows.
    (agent.scanner as unknown as { _tree: unknown })._tree = before;
    await (
      agent.scanner as unknown as {
        _notifyChange(c: { type: string; path: string }): Promise<void>;
      }
    )._notifyChange({ type: 'modified', path: 'doc.txt' });
    await new Promise((r) => setTimeout(r, 400));

    expect(readFileSync(join(dir, 'doc.txt'), 'utf8')).toBe('v2');
    expect(agent.ownHead).toBe(peer.head);
    expect(sent).toEqual([]);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // In 0.2.0 the ancestry is the chain's, so each announcement is an entry
  // and the second one's `previous` is the first.
  it('announces each state once, with its own ancestry', async () => {
    const { db, connector, agent, sent } = await wire();

    await writeFile(join(dir, 'first.txt'), 'one');
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 600));
    sent.length = 0;

    await writeFile(join(dir, 'second.txt'), 'two');
    await new Promise((r) => setTimeout(r, 1_200));
    await writeFile(join(dir, 'third.txt'), 'three');
    await new Promise((r) => setTimeout(r, 1_200));

    // One emission per state, not two.
    expect(sent.length).toBe(new Set(sent).size);
    expect(sent.length).toBe(2);

    // And the second entry was made from the first.
    const chain = new FsEditChain(db, 'fsTree');
    expect((await chain.entry(sent[1]))?.previous).toEqual([sent[0]]);

    stopTo();
    agent.scanner.stopWatch();
  });

  // The opposite failure to everything else in this file, and the last one the
  // field report found: not a stale tree deleting current work, but a CURRENT
  // tree deleting NEWER work.
  //
  // Measured on four machines with 1200 files converged — a file was created
  // and vanished from every node including the one that created it, one run in
  // four. After convergence each peer's state descends from the writer's
  // THE "COULD PEERS KNOW ABOUT THIS FILE?" GUARD IS GONE, and its test with
  // it. What it protected is now protected by there being nothing to protect
  // against.
  //
  // It kept a prune from deleting a file written after this node's last
  // announcement — invisible to every sender, so a tree lacking it was not
  // deleting it. Measured on four machines: with 1 200 files converged, a file
  // was created and vanished from EVERY node including the one that created
  // it, one run in four.
  //
  // That prune ran on the peer-apply path, and the peer-apply path no longer
  // prunes: an absence is not a deletion, and a real one arrives stated in the
  // chain. The only caller left is a deliberate `restore({ cleanTarget: true
  // })` — somebody saying "make this folder be exactly this tree" — and
  // second-guessing that with a guard about what peers know would be answering
  // a question nobody asked. The test below covers what that caller gets.
  it('prunes exactly what the tree lacks, for a caller who asked for that', async () => {
    const bs = new BsMem();
    await writeFile(join(dir, 'announced.txt'), 'peers know about this');
    await writeFile(join(dir, 'just-written.txt'), 'written a moment ago');
    await writeFile(join(peerDir, 'only-theirs.txt'), 'theirs');

    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1},
    });

    const incoming = await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract();
    await agent.restore(incoming, undefined, { cleanTarget: true });

    // Both go. Neither is in the tree, and the caller asked for the tree.
    expect(existsSync(join(dir, 'announced.txt'))).toBe(false);
    expect(existsSync(join(dir, 'just-written.txt'))).toBe(false);
    expect(existsSync(join(dir, 'only-theirs.txt'))).toBe(true);

    agent.scanner.stopWatch();
  });

  // An agent that has never announced cannot tell "written since" from "always
  // here", and must not withhold pruning on a distinction it cannot make.
  it('still prunes normally before it has announced anything', async () => {
    const bs = new BsMem();
    await writeFile(join(dir, 'gone.txt'), 'gone');
    await writeFile(join(peerDir, 'only-theirs.txt'), 'theirs');

    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1},
    });

    const incoming = await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract();
    await agent.restore(incoming, undefined, { cleanTarget: true });

    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);

    agent.scanner.stopWatch();
  });
});
