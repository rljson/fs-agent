// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg } from '@rljson/rljson';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createFsChainTables,
  FS_EDIT_ACTION,
  FsEditChain,
} from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('FsEditChain', () => {
  let db: Db;

  const freshDb = async (): Promise<Db> => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const next = new Db(io);
    // The host creates the trees table; the chain creates its own. That split
    // is the point of `createFsChainTables` — see its doc comment.
    await next.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    return next;
  };

  beforeEach(async () => {
    db = await freshDb();
  });

  // ...........................................................................
  describe('createFsChainTables', () => {
    it('creates the three tables the chain needs', async () => {
      await createFsChainTables(db, TREE);
      for (const suffix of ['Edits', 'MultiEdits', 'EditHistory']) {
        expect(await db.core.hasTable(`${TREE}${suffix}`)).toBe(true);
      }
    });

    it('is idempotent, so an init may run on every start', async () => {
      await createFsChainTables(db, TREE);
      await createFsChainTables(db, TREE);
      expect(await db.core.hasTable(`${TREE}EditHistory`)).toBe(true);
    });
  });

  // ...........................................................................
  describe('init', () => {
    it('starts with no head on an empty chain', async () => {
      const chain = new FsEditChain(db, TREE);
      expect(chain.ready).toBe(false);
      await chain.init();
      expect(chain.ready).toBe(true);
      expect(chain.head).toBeUndefined();
    });

    it('continues the lineage a previous process left behind', async () => {
      const first = new FsEditChain(db, TREE);
      await first.init();
      await first.append({ treeRef: 'T1' });
      const second = await first.append({ treeRef: 'T2' });

      // A fresh instance over the same store: a restart.
      const restarted = new FsEditChain(db, TREE);
      await restarted.init();
      expect(restarted.head).toBe(second.head);

      // And it appends onto that tip rather than starting a new root.
      const third = await restarted.append({ treeRef: 'T3' });
      expect(third.previous).toEqual([second.head]);
    });

    it('treats a row with no ancestry as a lineage root', async () => {
      // `MultiEditManager` writes `previous: null` rather than `[]`, so a
      // chain this agent did not author can carry either. Both mean "root",
      // and a caller walking `previous` must not have to know which wrote it.
      //
      // Written by hand all the way down, because `entry()` resolves the
      // multiEdit and edit rows before it ever looks at `previous` — a row
      // with a dangling `multiEditRef` answers `undefined` and would prove
      // nothing about the ancestry spelling.
      await createFsChainTables(db, TREE);
      const refOf = (result: unknown, suffix: string): string =>
        (result as Array<Record<string, string>>)[0][`${TREE}${suffix}Ref`];

      const editRef = refOf(
        await db.addEdit(TREE, {
          name: FS_EDIT_ACTION,
          action: {
            name: FS_EDIT_ACTION,
            type: FS_EDIT_ACTION,
            data: { treeRef: 'T1', changed: [], removed: [] },
            _hash: '',
          },
          _hash: '',
        } as never),
        'Edits',
      );
      const multiEditRef = refOf(
        await db.addMultiEdit(TREE, {
          previous: null,
          edit: editRef,
          _hash: '',
        } as never),
        'MultiEdits',
      );
      const head = refOf(
        await db.addEditHistory(TREE, {
          timeId: '1:aaa',
          multiEditRef,
          dataRef: 'T1',
          previous: null,
          _hash: '',
        } as never),
        'EditHistory',
      );

      const chain = new FsEditChain(db, TREE);
      await chain.init();
      expect(chain.head).toBe(head);

      // Read back as an EMPTY ancestry, never as `null` — a caller walking
      // `previous` must not have to know which spelling wrote the row.
      const root = await chain.entry(head);
      expect(root?.previous).toEqual([]);

      const next = await chain.append({ treeRef: 'T2' });
      expect(next.previous).toEqual([head]);
    });

    // A `timeId` is `<millis>:<nanoid>`, so two entries minted in the SAME
    // millisecond are ordered by a RANDOM tail. "The one I appended last" is
    // therefore not reliably the newest, and asserting it made this suite fail
    // roughly one run in ten. Both tests below compute the expected tip from
    // the timeIds instead of assuming append order.
    //
    // The arbitrariness is not a defect: the order is total and IDENTICAL on
    // every node, which is the property convergence needs. It is only "newest"
    // in the wall-clock sense that is unreliable, and nothing depends on that.
    const newest = (entries: Array<{ head: string; timeId: string }>): string =>
      [...entries].sort((a, b) => (a.timeId < b.timeId ? 1 : -1))[0].head;

    it('takes the greatest timeId among tips, in either direction', async () => {
      // HAND-WRITTEN timeIds, deliberately out of order: `2:b` arrives after
      // the winner, so the comparison is exercised in both directions by
      // construction rather than by whichever way the random tails fell.
      await createFsChainTables(db, TREE);
      const refOf = (result: unknown): string =>
        (result as Array<Record<string, string>>)[0][`${TREE}EditHistoryRef`];
      const tip = async (stamp: string): Promise<string> =>
        refOf(
          await db.addEditHistory(TREE, {
            timeId: stamp,
            multiEditRef: `m-${stamp}`,
            dataRef: `T-${stamp}`,
            previous: [],
            _hash: '',
          } as never),
        );

      await tip('1:a');
      const winner = await tip('3:c');
      await tip('2:b');

      const chain = new FsEditChain(db, TREE);
      await chain.init();
      expect(chain.head).toBe(winner);
    });

    it('picks the newest tip when the chain has forked', async () => {
      // Two entries built from the SAME parent — two tips, which is what the
      // table looks like once several lineages live in it.
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const root = await chain.append({ treeRef: 'T1' });
      const tips = [
        await chain.append({ treeRef: 'T2', previous: [root.head] }),
        await chain.append({ treeRef: 'T3', previous: [root.head] }),
      ];

      const restarted = new FsEditChain(db, TREE);
      await restarted.init();
      expect(restarted.head).toBe(newest(tips));
      // And never the root, which both tips descend from.
      expect(restarted.head).not.toBe(root.head);
    });
  });

  // ...........................................................................
  describe('append', () => {
    // .........................................................................
    // THE ROOT OF A HISTORY IS A FUNCTION OF THE CONTENT.
    //
    // Two nodes that start from the same folder must end up with the SAME root
    // entry, not two rows describing the same thing. Every field of a root row
    // is already derived from the tree ref — so fixing the stamp makes the
    // whole row, and therefore its hash, identical on both.
    //
    // Without it the fleet has one lineage per node from the first second, and
    // `classify` answers `fork` to every announcement there has ever been.
    // Measured in `fs-mesh-invariants.spec.ts`: a writer's own folder went
    // from v8 back to v5, 6 runs in 8.
    // .........................................................................
    it('gives two nodes the SAME root entry for the same content', async () => {
      // Two chains, two independent `append` calls, one row.
      const first = new FsEditChain(db, TREE);
      await first.init();
      const second = new FsEditChain(db, TREE);
      await second.init();

      const a = await first.append({ treeRef: 'SEED' });
      const b = await second.append({ treeRef: 'SEED' });

      expect(b.head).toBe(a.head);
      expect(b.timeId).toBe(a.timeId);
      // `0:` orders before every minted id, which is what the beginning of a
      // history should do.
      expect(a.timeId.startsWith('0:')).toBe(true);
    });

    it('gives different content different roots', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const a = await chain.append({ treeRef: 'ONE', previous: [] });
      const b = await chain.append({ treeRef: 'TWO', previous: [] });
      expect(b.head).not.toBe(a.head);
      // Still a total order between two roots, so nothing reads as "equal".
      expect(a.timeId).not.toBe(b.timeId);
    });

    it('mints a stamp as soon as anything is STATED', async () => {
      // A root is only a name for where a folder is. An entry that states a
      // change is an edit, it happened at a moment, and two nodes stating the
      // same change are two different events.
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const stated = await chain.append({
        treeRef: 'SEED',
        changed: ['a.txt'],
        previous: [],
      });
      expect(stated.timeId).toMatch(/^[1-9]\d*:/);
    });

    it('records the tree ref, the changes and the removals', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();

      const entry = await chain.append({
        treeRef: 'T1',
        changed: ['b.txt', 'a.txt'],
        removed: ['z.txt', 'y.txt'],
      });

      expect(entry.treeRef).toBe('T1');
      // Sorted, so the same change on two nodes produces the same row.
      expect(entry.changed).toEqual(['a.txt', 'b.txt']);
      expect(entry.removed).toEqual(['y.txt', 'z.txt']);
      expect(entry.previous).toEqual([]);
      expect(entry.timeId).toMatch(/^\d+:/);
      expect(chain.head).toBe(entry.head);
    });

    it('defaults changes and removals to empty', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const entry = await chain.append({ treeRef: 'T1' });
      expect(entry.changed).toEqual([]);
      expect(entry.removed).toEqual([]);
    });

    it('chains each entry onto the one before it', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const one = await chain.append({ treeRef: 'T1' });
      const two = await chain.append({ treeRef: 'T2' });
      const three = await chain.append({ treeRef: 'T3' });

      expect(one.previous).toEqual([]);
      expect(two.previous).toEqual([one.head]);
      expect(three.previous).toEqual([two.head]);
    });

    it('accepts TWO parents, which a merge revision needs', async () => {
      // The reason the rows are written by hand: `MultiEditManager` refuses
      // more than one `previous`, and an fs merge revision has two by design.
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const ours = await chain.append({ treeRef: 'T1' });
      const theirs = await chain.append({
        treeRef: 'T2',
        previous: [],
      });

      const merge = await chain.append({
        treeRef: 'T3',
        previous: [ours.head, theirs.head],
      });
      expect(merge.previous).toEqual([ours.head, theirs.head]);

      const read = await chain.entry(merge.head);
      expect(read?.previous).toEqual([ours.head, theirs.head]);
    });

    it('gives a state it re-derives a NEW identity', async () => {
      // The whole point. A folder that returns to an earlier state re-derives
      // that state's tree ref — so the tree ref cannot say whether we moved
      // back or never left. The chain entry can.
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const there = await chain.append({
        treeRef: 'T1',
        changed: ['a.txt'],
      });
      const back = await chain.append({ treeRef: 'T0', removed: ['a.txt'] });
      const againThere = await chain.append({
        treeRef: 'T1',
        changed: ['a.txt'],
      });

      expect(againThere.treeRef).toBe(there.treeRef);
      expect(againThere.head).not.toBe(there.head);
      expect(againThere.previous).toEqual([back.head]);
    });
  });

  // ...........................................................................
  describe('entry', () => {
    it('reads back everything it wrote', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const written = await chain.append({
        treeRef: 'T1',
        changed: ['a.txt'],
        removed: ['b.txt'],
      });

      expect(await chain.entry(written.head)).toEqual(written);
    });

    it('answers undefined for a ref this node cannot resolve', async () => {
      // A peer's entry we have not pulled. The ordinary case, not an error.
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      await chain.append({ treeRef: 'T1' });
      expect(await chain.entry('nothing-we-hold')).toBeUndefined();
    });

    it('answers undefined when the multiEdit row is missing', async () => {
      const chain = new FsEditChain(db, TREE);
      await chain.init();
      const written = await chain.append({ treeRef: 'T1' });
      // A hole mid-row: the history resolved, what it points at did not.
      const stripped = new FsEditChain(await freshDb(), TREE);
      await stripped.init();
      await stripped['_db'].addEditHistory(TREE, {
        timeId: '1:x',
        multiEditRef: 'gone',
        dataRef: 'T1',
        previous: [],
        _hash: '',
      } as never);
      const rows = await stripped['_db'].getEditHistories(TREE, {
        multiEditRef: 'gone',
      });
      expect(await stripped.entry(rows[0]._hash as string)).toBeUndefined();
      expect(written.head).toBeTruthy();
    });

    it('answers undefined when the edit row is missing', async () => {
      const other = await freshDb();
      const chain = new FsEditChain(other, TREE);
      await chain.init();
      await other.addMultiEdit(TREE, {
        previous: null,
        edit: 'gone',
        _hash: '',
      } as never);
      const multiEdits = await other.getMultiEdits(TREE, { edit: 'gone' });
      await other.addEditHistory(TREE, {
        timeId: '1:x',
        multiEditRef: (multiEdits[0] as { _hash: string })._hash,
        dataRef: 'T1',
        previous: [],
        _hash: '',
      } as never);
      const histories = await other.getEditHistories(TREE, { dataRef: 'T1' });
      expect(
        await chain.entry((histories[0] as { _hash: string })._hash),
      ).toBeUndefined();
    });

    it('survives an edit whose action carries no data', async () => {
      const other = await freshDb();
      const chain = new FsEditChain(other, TREE);
      await chain.init();
      await other.addEdit(TREE, {
        name: FS_EDIT_ACTION,
        action: { name: FS_EDIT_ACTION, type: FS_EDIT_ACTION, _hash: '' },
        _hash: '',
      } as never);
      const edits = await other.getEdits(TREE, { name: FS_EDIT_ACTION });
      await other.addMultiEdit(TREE, {
        previous: null,
        edit: (edits[0] as { _hash: string })._hash,
        _hash: '',
      } as never);
      const multiEdits = await other.getMultiEdits(TREE, {
        edit: (edits[0] as { _hash: string })._hash,
      });
      await other.addEditHistory(TREE, {
        timeId: '1:x',
        multiEditRef: (multiEdits[0] as { _hash: string })._hash,
        dataRef: 'T9',
        previous: [],
        _hash: '',
      } as never);
      const histories = await other.getEditHistories(TREE, { dataRef: 'T9' });
      const entry = await chain.entry(
        (histories[0] as { _hash: string })._hash,
      );
      expect(entry?.changed).toEqual([]);
      expect(entry?.removed).toEqual([]);
    });
  });
});
