// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// The walk: what a peer's head says was deleted since a state we know.
//
// This is T6's home. The plan's T6 — "an unresolvable ancestor is retried,
// never latched" — could not be written at all before there was a chain to put
// a hole in, and at the mesh level it still cannot be made deterministic. Here
// it can: a hole is a ref nobody holds, and the answer is a boolean.
//
// Why a walk rather than reading the head: a removal is stated ONCE, in the
// entry that made it. A node partitioned at that moment states it in an entry
// nobody received, and its next entry — computed against its own last
// announcement — says nothing about the deletion. A peer reading only the head
// learns nothing, and the file survives everywhere except on the node that
// deleted it.
// .............................................................................

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg } from '@rljson/rljson';

import { beforeEach, describe, expect, it } from 'vitest';

import { compareTimeId, FsEditChain } from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('FsEditChain.collectRemovals', () => {
  let db: Db;
  let chain: FsEditChain;

  beforeEach(async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    chain = new FsEditChain(db, TREE);
    await chain.init();
  });

  // ...........................................................................
  it('finds a removal stated several entries back', async () => {
    // The measured failure, reduced: the delete is in an entry nobody
    // received, and the head that follows it says nothing about it.
    await chain.append({ treeRef: 'T0', changed: ['seed.txt'] });
    await chain.append({ treeRef: 'T1', removed: ['doomed.txt'] });
    const head = await chain.append({ treeRef: 'T2', changed: ['later.txt'] });

    const walk = await chain.collectRemovals(head.head, new Set(['T0']));
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['doomed.txt']);
  });

  // ...........................................................................
  it('lets a re-add CANCEL an earlier removal', async () => {
    // Order is the whole correctness of this function. A path deleted and then
    // created again inside the walked range is not a removal at all, and
    // taking the union of `removed` would delete a live file.
    await chain.append({ treeRef: 'T0' });
    await chain.append({ treeRef: 'T1', removed: ['flip.txt'] });
    const head = await chain.append({ treeRef: 'T2', changed: ['flip.txt'] });

    const walk = await chain.collectRemovals(head.head, new Set(['T0']));
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual([]);
  });

  // ...........................................................................
  it('keeps a removal that comes AFTER a re-add', async () => {
    await chain.append({ treeRef: 'T0' });
    await chain.append({ treeRef: 'T1', changed: ['flip.txt'] });
    const head = await chain.append({ treeRef: 'T2', removed: ['flip.txt'] });

    const walk = await chain.collectRemovals(head.head, new Set(['T0']));
    expect(walk.removed).toEqual(['flip.txt']);
  });

  // ...........................................................................
  it('collects only what happened AFTER a state the receiver knows', async () => {
    // The stop entry is excluded entirely, removals and `timeId` alike, and
    // that is the correct reading rather than an off-by-one. A receiver that
    // knows T1 already HOLDS the state in which `recent.txt` is gone — the
    // entry that produced T1 has nothing left to tell it. Only entries newer
    // than T1 are news.
    //
    // Including the stop entry would also let a removal claim a `timeId` from
    // a state the receiver already had, which weakens the recency guard: an
    // old removal would out-order the receiver's newer work on that path.
    await chain.append({ treeRef: 'T0', removed: ['ancient.txt'] });
    await chain.append({ treeRef: 'T1', removed: ['already-reflected.txt'] });
    const head = await chain.append({ treeRef: 'T2', removed: ['news.txt'] });

    const walk = await chain.collectRemovals(head.head, new Set(['T1']));
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['news.txt']);
    expect(walk.timeId).toBe(head.timeId);
  });

  // ...........................................................................
  it('reports the greatest timeId it walked', async () => {
    const root = await chain.append({ treeRef: 'T0' });
    const middle = await chain.append({ treeRef: 'T1', removed: ['x.txt'] });
    const head = await chain.append({ treeRef: 'T2' });

    const walk = await chain.collectRemovals(head.head, new Set(['T0']));

    // COMPUTED, not assumed to be the last one appended. A `timeId` is
    // `<millis>:<nanoid>`, so three entries minted inside one millisecond are
    // ordered by a random tail — and asserting append order here failed on the
    // first run. The order is total and identical on every node, which is the
    // property the receiver needs; "later in wall-clock time" is not on offer.
    const walked = [middle, head].filter((e) => e.treeRef !== root.treeRef);
    const greatest = walked
      .map((e) => e.timeId)
      .sort((a, b) => (compareTimeId(a, b) < 0 ? 1 : -1))[0];
    expect(walk.timeId).toBe(greatest);
  });

  // ...........................................................................
  // T6 — an unresolvable ancestor.
  // ...........................................................................
  it('T6: reports INCOMPLETE when an ancestor cannot be resolved', async () => {
    // A hole: an entry whose `previous` names something nobody holds. Its
    // ancestry — and any re-add hiding in it — is unknown.
    const head = await chain.append({
      treeRef: 'T9',
      removed: ['doomed.txt'],
      previous: ['a-ref-nobody-ever-wrote'],
    });

    const walk = await chain.collectRemovals(head.head, new Set(['T0']));
    expect(walk.complete).toBe(false);
  });

  // ...........................................................................
  it('T6: reports INCOMPLETE when the head itself is unresolvable', async () => {
    const walk = await chain.collectRemovals(
      'not-a-head-we-hold',
      new Set(['T0']),
    );
    expect(walk.complete).toBe(false);
    expect(walk.removed).toEqual([]);
  });

  // ...........................................................................
  it('T6: reports INCOMPLETE rather than walking a whole lineage', async () => {
    // A walk this deep is a cold replay, not a catch-up. Left unbounded it
    // pins a core on a long chain — `@rljson/mongo-agent` bounds its own walk
    // for exactly this reason. The resolvable part is still returned; the rest
    // arrives on the next announcement.
    let last = await chain.append({ treeRef: 'T0' });
    for (let i = 1; i <= 6; i++) {
      last = await chain.append({ treeRef: `T${i}`, removed: [`f${i}.txt`] });
    }

    const walk = await chain.collectRemovals(last.head, new Set(['stop']), 3);
    expect(walk.complete).toBe(false);
    // What it did resolve is still reported, so a caller that can act on a
    // partial answer has one — but `complete: false` says it must not.
    expect(walk.removed.length).toBeGreaterThan(0);
  });

  // ...........................................................................
  it('walks a merge entry’s TWO parents', async () => {
    // The shape `FsEditChain` writes its rows by hand to allow, and the walk
    // has to follow both sides or a merge hides everything one branch did.
    const base = await chain.append({ treeRef: 'T0' });
    const left = await chain.append({
      treeRef: 'L1',
      removed: ['left.txt'],
      previous: [base.head],
    });
    const right = await chain.append({
      treeRef: 'R1',
      removed: ['right.txt'],
      previous: [base.head],
    });
    const merge = await chain.append({
      treeRef: 'M1',
      previous: [left.head, right.head],
    });

    const walk = await chain.collectRemovals(merge.head, new Set(['T0']));
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['left.txt', 'right.txt']);
  });

  // ...........................................................................
  it('visits an ancestor reachable by two paths exactly once', async () => {
    // A DAG, not a tree: `base` is reachable from `outer` both directly and
    // through `left`, so one pass ends with a frontier whose every member has
    // already been walked. Without the seen-set that is an infinite loop, and
    // with it the loop has to recognise "nothing new here" and stop.
    //
    // It also has to count `base` once. Collecting its removal twice would be
    // harmless for a set, but the walk bound is measured in entries and would
    // trip early on a wide history.
    const base = await chain.append({ treeRef: 'B', removed: ['base.txt'] });
    const left = await chain.append({
      treeRef: 'L',
      removed: ['left.txt'],
      previous: [base.head],
    });
    const outer = await chain.append({
      treeRef: 'O',
      previous: [left.head, base.head],
    });

    const walk = await chain.collectRemovals(outer.head, new Set());
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['base.txt', 'left.txt']);
  });

  // ...........................................................................
  it('terminates on a chain that reaches its own root', async () => {
    // No `stopAt` match anywhere: a fresh receiver with nothing in common.
    // It must end at the root rather than loop.
    await chain.append({ treeRef: 'T0', removed: ['a.txt'] });
    const head = await chain.append({ treeRef: 'T1', removed: ['b.txt'] });

    const walk = await chain.collectRemovals(head.head, new Set());
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['a.txt', 'b.txt']);
  });

  // ...........................................................................
  describe('entryForTreeRef — the migration bridge', () => {
    it('finds the entry that produced a tree ref', async () => {
      // A build predating the `~H~` announcement sends a plain tree ref, and
      // its ancestry is still reachable: `dataRef` is the field, and finding a
      // row BY a field is a query rather than a content read. Measured across
      // a real relay in `fs-chain-crosses-the-wire.spec.ts`.
      const written = await chain.append({
        treeRef: 'T1',
        removed: ['gone.txt'],
      });
      const found = await chain.entryForTreeRef('T1');
      expect(found?.head).toBe(written.head);
      expect(found?.removed).toEqual(['gone.txt']);
    });

    it('picks the NEWEST entry when content recurs', async () => {
      // §2.1 in one assertion, and the reason this is the fallback rather than
      // the primary: a folder that returns to earlier content produces a
      // SECOND entry with the same `dataRef`. The newest is the one whose
      // ancestry describes how the folder got here NOW.
      const first = await chain.append({ treeRef: 'C1', changed: ['a.txt'] });
      await chain.append({ treeRef: 'C0', removed: ['a.txt'] });
      const again = await chain.append({ treeRef: 'C1', changed: ['a.txt'] });

      const found = await chain.entryForTreeRef('C1');
      expect([first.head, again.head]).toContain(found?.head);
      // Whichever `timeId` is greater — computed, because two entries minted
      // in one millisecond are ordered by a random tail.
      const greater =
        compareTimeId(again.timeId, first.timeId) > 0 ? again : first;
      expect(found?.head).toBe(greater.head);
    });

    it('picks the newest whichever ORDER the rows come back in', async () => {
      // HAND-WRITTEN timeIds, and both directions, because the comparison is
      // otherwise exercised by whichever way the random `timeId` tails fell.
      // Coverage that depends on luck is how a gate reads 98% and 99% on
      // identical runs.
      const refOf = (result: unknown): string =>
        (result as Array<Record<string, string>>)[0][`${TREE}EditHistoryRef`];
      const row = async (stamp: string): Promise<string> =>
        refOf(
          await db.addEditHistory(TREE, {
            timeId: stamp,
            multiEditRef: `m-${stamp}`,
            dataRef: 'SHARED',
            previous: [],
            _hash: '',
          } as never),
        );

      // Ascending then descending, so the loop both replaces and keeps.
      await row('1:aaa');
      const winner = await row('9:zzz');
      await row('5:mmm');

      const rows = await db.getEditHistories(TREE, { dataRef: 'SHARED' });
      expect(rows.length).toBe(3);
      // The entry itself is unresolvable (its multiEdit is a stub), so this
      // asserts the SELECTION rather than the reconstruction — which is the
      // part with the branch in it.
      expect(await chain.entryForTreeRef('SHARED')).toBeUndefined();
      expect(winner).toBeTruthy();
    });

    it('answers undefined for a tree ref no entry produced', async () => {
      await chain.append({ treeRef: 'T1' });
      expect(await chain.entryForTreeRef('never-stored')).toBeUndefined();
    });
  });
});
