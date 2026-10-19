// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// THE HISTORY A PERSON READS, without a filesystem.
//
// The walk is tested against chains written by hand, because the orders that
// matter are the ones a running fleet produces rarely: a fork whose two sides
// reached the fleet in one announcement, a stamp that disagrees with the
// graph, a merge below a merge. Each has one test, and each test states the
// order it expects in full.
//
// The one rule that outranks every key: an entry is never listed above one
// made on top of it. A history that shows a file's deletion above its creation
// is wrong whatever the stamps said.
// .............................................................................

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg, type RefStamp } from '@rljson/rljson';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_WALK, FsEditChain, type FsChainEntry } from '../src/fs-edit-chain.ts';
import {
  FS_HISTORY_PAGE,
  readFsHistory,
  walkFsHistory,
  type FsHistoryOptions,
  type FsHistorySource,
} from '../src/fs-history.ts';
import { FsStamps, readFsStamps } from '../src/fs-stamps.ts';

/** A stamp from the one hub of these tests. */
const stamp = (n: number, epoch = 1): RefStamp => ({
  domain: 'office',
  epoch,
  hub: 'hub',
  n,
});

/** One hand-written entry: its head, what it was made from, its time, its stamp. */
interface Written {
  head: string;
  previous?: string[];
  /** Epoch ms of an edit; absent for a merge or a root, which carry none. */
  at?: number;
  stamp?: RefStamp;
}

/**
 * A chain written by hand.
 * @param written - The entries.
 * @returns A source the walk reads.
 */
const chainOf = (written: Written[]): FsHistorySource => {
  const entries = new Map<string, FsChainEntry>();
  const stamps = new Map<string, RefStamp>();
  for (const w of written) {
    entries.set(w.head, {
      head: w.head,
      // A minted time id for an edit; a derived `0:` one otherwise.
      timeId: w.at === undefined ? `0:${w.head}-derived` : `${w.at}:abcd`,
      treeRef: `tree-of-${w.head}`,
      previous: w.previous ?? [],
      changed: [],
      removed: [],
    });
    if (w.stamp) stamps.set(w.head, w.stamp);
  }
  return {
    entry: async (head) => entries.get(head),
    stamp: (head) => stamps.get(head),
  };
};

/**
 * The heads of one page.
 * @param source - The chain.
 * @param options - Where to start, how much.
 * @returns The heads, in the order listed.
 */
const headsOf = async (
  source: FsHistorySource,
  options: FsHistoryOptions,
): Promise<string[]> =>
  (await walkFsHistory(source, options)).entries.map((e) => e.head);

/**
 * A straight line of `n` edits on a root: `e0` is the root, `e<n>` the head.
 * @param n - How many edits.
 * @returns The chain.
 */
const line = (n: number): FsHistorySource =>
  chainOf(
    Array.from({ length: n + 1 }, (_, i) => ({
      head: `e${i}`,
      previous: i === 0 ? [] : [`e${i - 1}`],
      ...(i === 0 ? {} : { at: 1_000 + i }),
      stamp: stamp(i + 1),
    })),
  );

describe('walkFsHistory', () => {
  // ...........................................................................
  describe('the order', () => {
    it('lists a straight line newest first, down to its root', async () => {
      const page = await walkFsHistory(line(3), { from: 'e3' });

      expect(page.entries.map((e) => e.head)).toEqual(['e3', 'e2', 'e1', 'e0']);
      expect(page.entries.map((e) => e.kind)).toEqual([
        'edit',
        'edit',
        'edit',
        'root',
      ]);
      // An edit says when; a root carries no time, and is not given one.
      expect(page.entries[0].at).toBe(1_003);
      expect(page.entries[3]).not.toHaveProperty('at');
      expect(page.entries[0].stamp).toEqual(stamp(4));
      expect(page.entries[0].treeRef).toBe('tree-of-e3');
      expect(page).toEqual({ entries: page.entries, missing: [] });
    });

    it('lists both sides of a fork below their merge, and the base once', async () => {
      const chain = chainOf([
        { head: 'base', stamp: stamp(1) },
        { head: 'a1', previous: ['base'], at: 10, stamp: stamp(2) },
        { head: 'b1', previous: ['base'], at: 20, stamp: stamp(3) },
        { head: 'a2', previous: ['a1'], at: 30, stamp: stamp(4) },
        { head: 'merge', previous: ['a2', 'b1'], stamp: stamp(5) },
      ]);

      const page = await walkFsHistory(chain, { from: 'merge' });
      expect(page.entries.map((e) => e.head)).toEqual([
        'merge',
        'a2',
        'b1',
        'a1',
        'base',
      ]);
      expect(page.entries[0]).toMatchObject({
        kind: 'merge',
        previous: ['a2', 'b1'],
      });
      expect(page.entries[0]).not.toHaveProperty('at');
    });

    it('never lists an entry above one made on top of it, whatever the stamps say', async () => {
      // `parent` carries a LATER stamp than its own child — the shape a stamp
      // learned out of order leaves. The merge reaches both at once, and the
      // stamps alone would list the parent first.
      const chain = chainOf([
        { head: 'root', stamp: stamp(1) },
        { head: 'parent', previous: ['root'], at: 10, stamp: stamp(5) },
        { head: 'child', previous: ['parent'], at: 20, stamp: stamp(2) },
        { head: 'merge', previous: ['child', 'parent'], stamp: stamp(6) },
      ]);

      expect(await headsOf(chain, { from: 'merge' })).toEqual([
        'merge',
        'child',
        'parent',
        'root',
      ]);
    });

    it('puts what has not reached the fleet yet first', async () => {
      // Unstamped: this node's own newest work, which the hub has not said
      // back yet. Newer than anything the fleet has ordered.
      const chain = chainOf([
        { head: 'root', stamp: stamp(1) },
        { head: 'stamped', previous: ['root'], at: 50, stamp: stamp(2) },
        { head: 'mine', previous: ['root'], at: 10 },
        { head: 'merge', previous: ['mine', 'stamped'] },
      ]);

      const page = await walkFsHistory(chain, { from: 'merge' });
      expect(page.entries.map((e) => e.head)).toEqual([
        'merge',
        'mine',
        'stamped',
        'root',
      ]);
      expect(page.entries[1]).not.toHaveProperty('stamp');
    });

    it('orders what nobody has stamped yet by its authoring times', async () => {
      // Both sides of this node's own offline fork, neither said back by the
      // hub: no stamp to compare, so the times decide.
      const chain = chainOf([
        { head: 'root', stamp: stamp(1) },
        { head: 'older', previous: ['root'], at: 1_000 },
        { head: 'newer', previous: ['root'], at: 2_000 },
        { head: 'merge', previous: ['older', 'newer'] },
      ]);

      expect(await headsOf(chain, { from: 'merge' })).toEqual([
        'merge',
        'newer',
        'older',
        'root',
      ]);
    });

    it('orders one announcement’s stretch by its authoring times', async () => {
      // Both sides reached the fleet in ONE announcement — a node that merged
      // while the hub was away — so the stamps are equal, and the times decide.
      const chain = chainOf([
        { head: 'root', stamp: stamp(1) },
        { head: 'early', previous: ['root'], at: 1_000, stamp: stamp(7) },
        { head: 'late', previous: ['root'], at: 2_000, stamp: stamp(7) },
        { head: 'merge', previous: ['early', 'late'], stamp: stamp(7) },
      ]);

      expect(await headsOf(chain, { from: 'merge' })).toEqual([
        'merge',
        'late',
        'early',
        'root',
      ]);
    });

    it('orders a merge, which has no time, by the entry it was reached from', async () => {
      // `inner` is a merge below a merge below an edit at 4 000, so it is
      // ordered at 4 000 — above `side` at 2 000, although `inner` carries no
      // time of its own and `side` does.
      const chain = chainOf([
        { head: 'root', stamp: stamp(1) },
        { head: 'a', previous: ['root'], at: 1_500, stamp: stamp(5) },
        { head: 'b', previous: ['root'], at: 2_500, stamp: stamp(5) },
        { head: 'side', previous: ['root'], at: 2_000, stamp: stamp(5) },
        { head: 'inner', previous: ['a', 'b'], stamp: stamp(5) },
        { head: 'outer', previous: ['inner', 'side'], stamp: stamp(5) },
        { head: 'top', previous: ['outer'], at: 4_000, stamp: stamp(5) },
      ]);

      expect(await headsOf(chain, { from: 'top' })).toEqual([
        'top',
        'outer',
        'inner',
        'b',
        'side',
        'a',
        'root',
      ]);
    });

    it('breaks a full tie by head, so two walks list one chain alike', async () => {
      const chain = chainOf([
        { head: 'm1', stamp: stamp(3) },
        { head: 'm2', stamp: stamp(3) },
      ]);
      const cursor = JSON.stringify([
        ['m1', null],
        ['m2', null],
      ]);
      expect(await headsOf(chain, { cursor })).toEqual(['m2', 'm1']);
    });
  });

  // ...........................................................................
  describe('a page at a time', () => {
    it('continues each page exactly where the last one stopped', async () => {
      const chain = line(6);

      const first = await walkFsHistory(chain, { from: 'e6', limit: 3 });
      const second = await walkFsHistory(chain, {
        cursor: first.cursor,
        limit: 3,
      });
      const third = await walkFsHistory(chain, {
        cursor: second.cursor,
        limit: 3,
      });

      expect(first.entries.map((e) => e.head)).toEqual(['e6', 'e5', 'e4']);
      expect(second.entries.map((e) => e.head)).toEqual(['e3', 'e2', 'e1']);
      expect(third.entries.map((e) => e.head)).toEqual(['e0']);
      expect(third.cursor).toBeUndefined();
    });

    it('carries both sides of a fork across a page', async () => {
      const chain = chainOf([
        { head: 'base', stamp: stamp(1) },
        { head: 'a1', previous: ['base'], at: 10, stamp: stamp(2) },
        { head: 'b1', previous: ['base'], at: 20, stamp: stamp(3) },
        { head: 'a2', previous: ['a1'], at: 30, stamp: stamp(4) },
        { head: 'merge', previous: ['a2', 'b1'], stamp: stamp(5) },
      ]);
      const whole = await headsOf(chain, { from: 'merge' });

      const paged: string[] = [];
      let page = await walkFsHistory(chain, { from: 'merge', limit: 1 });
      paged.push(...page.entries.map((e) => e.head));
      while (page.cursor !== undefined) {
        page = await walkFsHistory(chain, { cursor: page.cursor, limit: 1 });
        paged.push(...page.entries.map((e) => e.head));
      }
      expect(paged).toEqual(whole);
    });

    it('starts at the entry it is given', async () => {
      expect(await headsOf(line(3), { from: 'e1' })).toEqual(['e1', 'e0']);
    });

    it('takes the cursor over the start', async () => {
      const first = await walkFsHistory(line(3), { from: 'e3', limit: 2 });
      expect(
        await headsOf(line(3), { from: 'e3', cursor: first.cursor }),
      ).toEqual(['e1', 'e0']);
    });

    it('lists nothing without a start', async () => {
      expect(await walkFsHistory(line(3), {})).toEqual({
        entries: [],
        missing: [],
      });
    });

    it('holds a page to its size, and bounds the size', async () => {
      const chain = line(DEFAULT_MAX_WALK + 10);
      const from = `e${DEFAULT_MAX_WALK + 10}`;

      expect(await headsOf(chain, { from })).toHaveLength(FS_HISTORY_PAGE);
      expect(await headsOf(chain, { from, limit: 0 })).toHaveLength(1);
      expect(await headsOf(chain, { from, limit: Number.NaN })).toHaveLength(1);
      expect(await headsOf(chain, { from, limit: 2.7 })).toHaveLength(2);
      const most = await walkFsHistory(chain, { from, limit: 1e9 });
      expect(most.entries).toHaveLength(DEFAULT_MAX_WALK);
      expect(most.cursor).toBeDefined();
    });
  });

  // ...........................................................................
  describe('what it cannot read', () => {
    it('lists what it can, and names what it could not read', async () => {
      // History this node does not hold: the entry is named as a parent and
      // the row is not here. A host must say so rather than show the list as
      // complete.
      const chain = chainOf([
        { head: 'e2', previous: ['e1'], at: 20, stamp: stamp(2) },
      ]);
      expect(await walkFsHistory(chain, { from: 'e2' })).toMatchObject({
        entries: [{ head: 'e2' }],
        missing: ['e1'],
      });
      expect(
        (await walkFsHistory(chain, { from: 'e2' })).cursor,
      ).toBeUndefined();
    });

    it.each([
      ['not JSON', 'not json'],
      ['not a list', '{"a":1}'],
      ['an item that is not a pair', '[["x"]]'],
      ['a head that is not a string', '[[1,null]]'],
      ['a time that is not a number', '[["x","y"]]'],
    ])('refuses a cursor that is %s', async (_what, cursor) => {
      await expect(walkFsHistory(line(1), { cursor })).rejects.toThrow(
        /not a cursor/,
      );
    });
  });
});

// .............................................................................
describe('readFsHistory', () => {
  const TREE = 'fileTree';

  /**
   * A store holding a short chain: a root and two edits.
   * @returns The database, its io and the chain's heads, oldest first.
   */
  const aStore = async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const chain = new FsEditChain(db, TREE);
    await chain.init();
    const root = await chain.append({ treeRef: 'T0', previous: [] });
    const one = await chain.append({
      treeRef: 'T1',
      changed: ['a.txt'],
      previous: [root.head],
    });
    const two = await chain.append({
      treeRef: 'T2',
      removed: ['a.txt'],
      previous: [one.head],
    });
    return { io, db, chain, heads: [root.head, one.head, two.head] };
  };

  it('reads a store it does not own, and writes nothing to it', async () => {
    const { io, db, chain, heads } = await aStore();
    const stamps = new FsStamps(db, TREE, async (entry) =>
      (await chain.entry(entry))?.previous,
    );
    await stamps.init();
    await stamps.heard(heads[2], stamp(9));
    const before = JSON.stringify(await io.dump());

    const page = await readFsHistory(db, TREE, { from: heads[2] });

    expect(page.entries.map((e) => e.head)).toEqual([...heads].reverse());
    expect(page.entries.map((e) => e.kind)).toEqual(['edit', 'edit', 'root']);
    expect(page.entries[0]).toMatchObject({ treeRef: 'T2', removed: ['a.txt'] });
    // The announcement that carried the head carried everything below it.
    expect(page.entries.map((e) => e.stamp)).toEqual([
      stamp(9),
      stamp(9),
      stamp(9),
    ]);
    expect(JSON.stringify(await io.dump())).toBe(before);
  });

  it('lists no stamps where the store has none', async () => {
    // A store whose agent never synced: the chain is there, the stamp table
    // is not — and is not created by reading.
    const { db, heads } = await aStore();
    expect(await readFsStamps(db, TREE)).toEqual(new Map());
    expect(await db.core.hasTable(`${TREE}EditStamps`)).toBe(false);

    const page = await readFsHistory(db, TREE, { from: heads[2] });
    expect(page.entries).toHaveLength(3);
    expect(page.entries.every((e) => e.stamp === undefined)).toBe(true);
  });
});
