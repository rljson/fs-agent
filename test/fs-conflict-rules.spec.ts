// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// THE CONFLICT TABLE, one row per test, on two real nodes and a stamping hub.
//
// `fs-merge.spec.ts` proves the table on maps. This proves it on disks: what
// each folder holds afterwards, and what each node said. Every test forces its
// order instead of racing for it — B is cut off while both sides change, so B's
// version always reaches the fleet second. That is what makes C3 a fixed
// answer: the version that reached the fleet later keeps the name.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { readFileSync } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

import type { FsSignal } from '../src/fs-signals.ts';

import {
  buildFsMesh,
  whyNot,
  type FsMesh,
  type FsMeshNode,
} from './mesh/fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-rules-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `check` holds.
 * @param check - The condition.
 * @param what - What is awaited, for the failure message.
 * @param timeoutMs - How long to allow.
 */
const until = async (
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(50);
  }
};

describe('the conflict table, on disk', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  /**
   * Two converged nodes holding `files`.
   * @param name - The scenario, for the folder names.
   * @param files - What both folders start with.
   * @returns The nodes.
   */
  const twoNodes = async (name: string, files: Record<string, string>) => {
    mesh = await buildFsMesh({
      root: root(name),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (const [path, content] of Object.entries(files)) {
            await writeFile(join(folder, path), content);
          }
        }
      },
    });
    const start = await mesh.converged();
    expect(start.converged, whyNot(start)).toBe(true);
    return { a: mesh.node('A'), b: mesh.node('B') };
  };

  /**
   * Runs `change` on a node and waits until it is in that node's chain.
   * @param node - The node.
   * @param change - What it does to its folder.
   */
  const authors = async (node: FsMeshNode, change: () => Promise<void>) => {
    const before = node.agent.ownHead;
    await change();
    await until(() => node.agent.ownHead !== before, `${node.name} authored`);
  };

  /**
   * Waits until the hub has said a node's head back to it — it reached the
   * fleet, so it is stamped.
   * @param node - The node.
   */
  const reachedHub = (node: FsMeshNode) =>
    until(
      () => node.agent.antiEntropyStatus?.hubRef === node.agent.ownHead,
      `${node.name}'s head reached the hub`,
    );

  /** Heals B and waits for the two folders to agree. */
  const healAndConverge = async () => {
    mesh!.node('B').heal();
    const result = await mesh!.converged({ timeoutMs: 60_000, stableMs: 2_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    return result.snapshot['A'];
  };

  /**
   * The signals about one path, of every node.
   * @param path - The path.
   * @returns What was said about it.
   */
  const told = (path: string): FsSignal[] =>
    mesh!.signals
      .map(({ signal }) => signal)
      .filter((signal) => signal.paths.includes(path));

  /**
   * Asserts that every signal about `path` names the merge that raised it, as
   * the history of the node that said it lists that merge.
   * @param path - The path.
   */
  const namesItsMerge = async (path: string) => {
    for (const { node, signal } of mesh!.signals) {
      if (!signal.paths.includes(path)) continue;
      const page = await mesh!.node(node).agent.history({ limit: 20 });
      const entry = page.entries.find((e) => e.head === signal.head);
      expect(entry?.kind, `${node}'s signal names no merge`).toBe('merge');
    }
  };

  // ...........................................................................
  it('C1: a change that descends from the other side is applied, and is no conflict', async () => {
    const { a, b } = await twoNodes('c1', { 'doc.txt': 'v1' });

    await a.write('doc.txt', 'v2');
    await until(async () => (await b.read('doc.txt')) === 'v2', 'B has v2');

    expect(await b.files()).toEqual(['doc.txt']);
    expect(mesh!.signals).toEqual([]);
  });

  // ...........................................................................
  it('C2: concurrent changes to different paths are both kept, and are no conflict', async () => {
    const { a, b } = await twoNodes('c2', { 'base.txt': 'base' });

    b.cut();
    await authors(a, () => a.write('from-a.txt', 'A'));
    await authors(b, () => b.write('from-b.txt', 'B'));

    const files = await healAndConverge();
    expect(files).toEqual(['base.txt', 'from-a.txt', 'from-b.txt']);
    expect(await a.read('from-b.txt')).toBe('B');
    expect(await b.read('from-a.txt')).toBe('A');
    expect(mesh!.signals).toEqual([]);
  });

  // ...........................................................................
  it('C3: two versions of one file are both kept; the one that reached the fleet later keeps the name', async () => {
    const { a, b } = await twoNodes('c3', { 'shared.txt': 'base' });

    b.cut();
    await authors(a, () => a.write('shared.txt', 'FROM-A'));
    await reachedHub(a);
    await authors(b, () => b.write('shared.txt', 'FROM-B'));

    const files = await healAndConverge();
    expect(files).toHaveLength(2);
    const copy = files.find((f) => f !== 'shared.txt') as string;
    // Named for the version that lost: its stamp, not anybody's clock.
    expect(copy).toMatch(/^shared \(conflicted copy hub-\d+\)\.txt$/);
    for (const node of [a, b]) {
      expect(await node.read('shared.txt'), node.name).toBe('FROM-B');
      expect(await node.read(copy), node.name).toBe('FROM-A');
    }

    // Said by whoever merged, and every saying names the same copy.
    const signals = told('shared.txt');
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal).toMatchObject({
        kind: 'conflict/arbitrary',
        action: 'review',
        decidedBy: 'stamp',
        copyPath: copy,
      });
    }
    await namesItsMerge('shared.txt');
  });

  // ...........................................................................
  it('C3 with no stamp: nothing is decided, nothing is lost, and the wait is told', async () => {
    mesh = await buildFsMesh({
      root: root('c3-unstamped'),
      names: ['A', 'B'],
      stamping: false,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'shared.txt'), 'base');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);
    const [a, b] = [mesh.node('A'), mesh.node('B')];

    b.cut();
    await authors(a, () => a.write('shared.txt', 'FROM-A'));
    await authors(b, () => b.write('shared.txt', 'FROM-B'));
    b.heal();

    // Each beacon asks again; the second wait is the one that is told.
    await until(
      () =>
        told('shared.txt').some((signal) => signal.kind === 'repair/blocked'),
      'the wait was told',
    );
    expect(await a.read('shared.txt')).toBe('FROM-A');
    expect(await b.read('shared.txt')).toBe('FROM-B');
    expect(told('shared.txt').every((s) => s.kind === 'repair/blocked')).toBe(
      true,
    );

    // And the wait stays a wait. Each node announces its head to learn its
    // stamp, and on a hub that never sends one, two nodes answered each
    // other's announcements with announcements — unbounded, hot, with no
    // beacon in between. Backing off keeps it to a handful.
    const before = a.announced.length + b.announced.length;
    await sleep(2_000);
    expect(a.announced.length + b.announced.length - before).toBeLessThan(10);
  });

  // ...........................................................................
  it('C4: an edit beats a concurrent deletion, and the deletion is reported', async () => {
    const { a, b } = await twoNodes('c4', {
      'doc.txt': 'base',
      'other.txt': 'other',
    });

    b.cut();
    await authors(a, () => a.del('doc.txt'));
    await reachedHub(a);
    await authors(b, () => b.write('doc.txt', 'EDITED'));

    const files = await healAndConverge();
    expect(files).toEqual(['doc.txt', 'other.txt']);
    for (const node of [a, b]) {
      expect(await node.read('doc.txt'), node.name).toBe('EDITED');
    }

    const signals = told('doc.txt');
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.kind).toBe('conflict/arbitrary');
      expect(signal.copyPath).toBeUndefined();
      // A rule decided it — data beats absence — and no stamp was asked.
      expect(signal.decidedBy).toBe('chain');
    }
    await namesItsMerge('doc.txt');
  });

  // ...........................................................................
  it('C5: a folder and a file at one path are both kept — the folder keeps the path', async () => {
    const { a, b } = await twoNodes('c5', {
      notes: 'a file',
      'other.txt': 'other',
    });

    b.cut();
    await authors(a, async () => {
      await a.del('notes');
      await a.write('notes/inside.txt', 'IN THE FOLDER');
    });
    await until(async () => (await a.files()).includes('notes/inside.txt'), 'A has the folder');
    await reachedHub(a);
    await authors(b, () => b.write('notes', 'EDITED FILE'));

    const files = await healAndConverge();
    expect(files).toEqual([
      'notes (conflicted copy)',
      'notes/inside.txt',
      'other.txt',
    ]);
    for (const node of [a, b]) {
      expect(await node.read('notes/inside.txt'), node.name).toBe('IN THE FOLDER');
      expect(await node.read('notes (conflicted copy)'), node.name).toBe(
        'EDITED FILE',
      );
    }

    // A person has to look: the file is no longer where its owner left it.
    const signals = told('notes');
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal).toMatchObject({
        kind: 'collision/type',
        action: 'required',
        copyPath: 'notes (conflicted copy)',
      });
    }
  });

  // ...........................................................................
  it('C6: a head whose history cannot be read changes nothing, and says so', async () => {
    const { a, b } = await twoNodes('c6', { 'doc.txt': 'base' });
    const head = b.agent.ownHead;

    // An announcement naming a chain entry nobody holds.
    a.connector.send('NOBODY_HOLDS_THIS_ENTRY_000000');
    await until(
      () =>
        mesh!.signals.some(
          ({ node, signal }) => node === 'B' && signal.kind === 'repair/blocked',
        ),
      'B said it was blocked',
    );

    expect(b.agent.ownHead).toBe(head);
    expect(await b.files()).toEqual(['doc.txt']);
    expect(await b.read('doc.txt')).toBe('base');
    const blocked = mesh!.signals.find(
      ({ node, signal }) => node === 'B' && signal.kind === 'repair/blocked',
    )!.signal;
    expect(blocked).toMatchObject({ action: 'review', decidedBy: 'chain' });
  });

  // ...........................................................................
  // C3 between two histories that share nothing — two folders that each
  // started as the origin of their own. No entry names the file on either
  // side, because a root names nothing: the head that carried each version
  // introduced it. Driven by hand, because in a mesh whichever root arrives
  // first makes the other node a joiner.
  it('C3 between histories that share nothing: the later root keeps the name', async () => {
    const dir = root('strangers');
    const peerDir = `${dir}-peer`;
    for (const d of [dir, peerDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree'), socket);
    const bs = new BsMem();

    await writeFile(join(dir, 'shared.txt'), 'MINE');
    const agent = new FsAgent(dir, bs, { ...ORIGIN_FIXTURE, timeouts: { debounceMs: 1 } });
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    const stamp = (n: number) => ({ domain: 'office', epoch: 1, hub: 'hub', n });
    socket.emit(connector.events.stamp, { r: agent.ownHead, stamp: stamp(1) });

    await writeFile(join(peerDir, 'shared.txt'), 'THEIRS');
    const stranger = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(peerDir, bs, ORIGIN_FIXTURE).extract(),
    });
    socket.emit(connector.events.ref, {
      o: 'remote-peer',
      r: stranger.announcement,
      stamp: stamp(2),
    });
    await until(
      async () => (await readdir(dir)).some((n) => n.includes('conflicted copy')),
      'the two versions were merged',
    );

    expect(readFileSync(join(dir, 'shared.txt'), 'utf-8')).toBe('THEIRS');
    const copy = (await readdir(dir)).find((n) => n.includes('conflicted copy'));
    expect(copy).toBe('shared (conflicted copy hub-1).txt');
    expect(readFileSync(join(dir, copy as string), 'utf-8')).toBe('MINE');

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
    for (const d of [dir, peerDir]) await rm(d, { recursive: true, force: true });
  });
});
