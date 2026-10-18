// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { AGENT_STATE_FILE, FsAgent } from '../src/fs-agent.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

// A node that is offline while a file is created used to DELETE that file from
// every other node when it returned. Not a failure to catch up — the file
// arrived everywhere and was then pruned by the one that missed it.
//
// Measured on four machines before this was fixed: a file reached all three
// connected nodes and was gone from all three two seconds later, as the fourth
// reconnected and its stale tree was applied as authoritative. In 0.2.0 a
// state arrives as a chain head, and only a head that descends from this
// node's own can delete anything here.
describe('FsAgent — a peer that reconnects with a stale tree', () => {
  const sourceDir = join(process.cwd(), 'test-temp-stale-source');
  const targetDir = join(process.cwd(), 'test-temp-stale-target');

  beforeEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  /** A db with the tree table ready. */
  const makeDb = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    return db;
  };

  const makeConnector = (db: Db) => {
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    return Object.assign(connector, {
      simulateIncoming: (
        ref: string,
        predecessorRefs?: string[],
        extra?: Record<string, unknown>,
      ) =>
        socket.emit(connector.events.ref, {
          o: 'remote-peer',
          r: ref,
          p: predecessorRefs,
          ...extra,
        }),
    });
  };
  // A deletion is applied because the sender held this node's state and
  // chose not to have the file — which its entry, descending from this
  // node's head, says and nothing else could.
  it('applies a deletion the sender STATES', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');

    const agent = new FsAgent(targetDir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    const connector = makeConnector(db);
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');

    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract(),
      removed: ['gone.txt'],
      previous: [agent.ownHead as string],
    });
    connector.simulateIncoming(peer.announcement);
    for (let i = 0; i < 200 && agent.ownHead !== peer.head; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(agent.ownHead).toBe(peer.head);
    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);
    expect(await readFile(join(targetDir, 'shared.txt'), 'utf-8')).toBe(
      'shared',
    );

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });
  it('allows syncFromDb to be started before syncToDb', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const agent = new FsAgent(targetDir, bs, { timeouts: { debounceMs: 1 } });
    const connector = makeConnector(db);

    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    // The order that used to throw.
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    expect(agent.scanner.isWatching).toBe(true);

    stopFrom();
    stopTo();
    agent.scanner.stopWatch();
  });

  it('still allows the other order', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const agent = new FsAgent(targetDir, bs, { timeouts: { debounceMs: 1 } });
    const connector = makeConnector(db);

    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    expect(agent.scanner.isWatching).toBe(true);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // A node returning from a disconnect says the state it held before it left.
  // Its head is an ancestor of this node's: applying its FILES would undo a
  // deletion made since, by addition; applying its ABSENCES would be data
  // loss. It does neither — this node is ahead, and says its own.
  describe('a head this node has already moved past', () => {
    it('neither adds nor deletes', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'base.txt'), 'base');

      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        timeouts: { debounceMs: 1 },
      });
      const connector = makeConnector(db);
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');

      // The sender's older state holds a file its newer state deleted.
      await writeFile(join(sourceDir, 'base.txt'), 'base');
      await writeFile(join(sourceDir, 'deleted-later.txt'), 'doomed');
      const older = await announceAsPeer(db, 'fsTree', {
        tree: await new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract(),
        changed: ['deleted-later.txt'],
        previous: [agent.ownHead as string],
      });
      await rm(join(sourceDir, 'deleted-later.txt'));
      await writeFile(join(sourceDir, 'survivor.txt'), 'survivor');
      const newer = await announceAsPeer(db, 'fsTree', {
        tree: await new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract(),
        changed: ['survivor.txt'],
        removed: ['deleted-later.txt'],
        previous: [older.head],
      });

      connector.simulateIncoming(newer.announcement);
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(join(targetDir, 'survivor.txt'))).toBe(true);

      // The straggler: the sender's PRE-deletion state.
      connector.simulateIncoming(older.announcement);
      await new Promise((r) => setTimeout(r, 400));

      // The deleted file does NOT come back, and nothing current goes.
      expect(existsSync(join(targetDir, 'deleted-later.txt'))).toBe(false);
      expect(existsSync(join(targetDir, 'survivor.txt'))).toBe(true);
      expect(agent.ownHead).toBe(newer.head);

      stopTo();
      stopFrom();
      agent.scanner.stopWatch();
    });

    it('cannot delete anything when it shares no history with this node', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'gone.txt'), 'gone');
      await writeFile(join(targetDir, 'shared.txt'), 'shared');

      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        timeouts: { debounceMs: 1 },
      });
      const connector = makeConnector(db);
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');

      // A history of its own, which never held `gone.txt`.
      await writeFile(join(sourceDir, 'shared.txt'), 'shared');
      await writeFile(join(sourceDir, 'theirs.txt'), 'theirs');
      const stranger = await announceAsPeer(db, 'fsTree', {
        tree: await new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract(),
        changed: ['theirs.txt'],
      });
      connector.simulateIncoming(stranger.announcement);
      await new Promise((r) => setTimeout(r, 600));

      // Merged: what it added arrived, and nothing it never held was removed.
      expect(existsSync(join(targetDir, 'theirs.txt'))).toBe(true);
      expect(existsSync(join(targetDir, 'gone.txt'))).toBe(true);
      expect(existsSync(join(targetDir, 'shared.txt'))).toBe(true);

      stopTo();
      stopFrom();
      agent.scanner.stopWatch();
    });
  });

  // The head a node stands on outlives a restart, or the next edit it makes
  // would start a history of its own.
  it('records the head it is at, and resumes from it after a restart', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const first = new FsAgent(targetDir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    const stop1 = await first.syncToDb(db, makeConnector(db), 'fsTree');
    await new Promise((r) => setTimeout(r, 200));
    stop1();
    first.scanner.stopWatch();
    const head = first.ownHead as string;
    expect(existsSync(join(targetDir, AGENT_STATE_FILE))).toBe(true);

    // A brand-new agent over the same folder — the restart.
    const restarted = new FsAgent(targetDir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    const c2 = makeConnector(db);
    const sent: string[] = [];
    const realSend = c2.send.bind(c2);
    c2.send = (ref: string, ...rest) => {
      sent.push(ref);
      return realSend(ref, ...rest);
    };
    const stop2 = await restarted.syncToDb(db, c2, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));

    expect(restarted.ownHead).toBe(head);
    expect(sent).toContain(head);

    stop2();
    restarted.scanner.stopWatch();
  });

  // A hub taking office on this machine continues above every epoch the
  // fleet has used — and it reads that from this file, because the hub and
  // the folder's agent run in different processes.
  it('records the highest stamp epoch it heard, beside its head', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const agent = new FsAgent(targetDir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    const connector = makeConnector(db);
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    const state = () =>
      JSON.parse(readFileSync(join(targetDir, AGENT_STATE_FILE), 'utf-8'));
    expect(state()).toEqual({ ownHead: agent.ownHead, stampEpochs: {} });

    // Its own head, said back by a hub of epoch 7.
    connector.simulateIncoming(agent.ownHead as string, undefined, {
      stamp: { domain: 'office', epoch: 7, hub: 'hub-a', n: 3 },
    });
    for (let i = 0; i < 100 && !state().stampEpochs.office; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state()).toEqual({
      ownHead: agent.ownHead,
      stampEpochs: { office: 7 },
    });

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // Every unusable shape answers the same way: this process cannot vouch for
  // what it descends from. A state file is a convenience, never a dependency.
  for (const [label, contents] of [
    ['unparseable', 'not json at all'],
    ['valid JSON but not an object', 'null'],
    ['an object without the field', '{}'],
    ['an empty head', '{"ownHead":""}'],
    ['a head of the wrong type', '{"ownHead":42}'],
    ['a head nothing holds', '{"ownHead":"nobody-holds-this"}'],
  ] as const) {
    it(`treats ${label} as "no head"`, async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'a.txt'), 'a');
      await writeFile(join(targetDir, AGENT_STATE_FILE), contents);

      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        timeouts: { debounceMs: 1 },
      });
      const stop = await agent.syncToDb(db, makeConnector(db), 'fsTree');
      await new Promise((r) => setTimeout(r, 200));

      // Degrades quietly: the folder becomes the origin of a history.
      expect(agent.ownHead).toBeDefined();
      expect(agent.ownHead).not.toBe('nobody-holds-this');

      stop();
      agent.scanner.stopWatch();
    });
  }

  it('never syncs its own state file', async () => {
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');
    await writeFile(
      join(targetDir, AGENT_STATE_FILE),
      JSON.stringify({ ownHead: 'abc' }),
    );

    const tree = await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).extract();
    const paths = Array.from(tree.trees.values())
      .map((t) => (t.meta as { relativePath?: string } | null)?.relativePath)
      .filter(Boolean);

    expect(paths).toContain('a.txt');
    expect(paths).not.toContain(AGENT_STATE_FILE);
  });
});
