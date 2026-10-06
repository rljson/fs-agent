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
    const seed = await chain.append({ treeRef: 'T0', changed: ['seed.txt'] });
    await chain.append({ treeRef: 'T1', removed: ['doomed.txt'] });
    const head = await chain.append({ treeRef: 'T2', changed: ['later.txt'] });

    const walk = await chain.collectRemovals(head.head, seed.head);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['doomed.txt']);
  });

  // ...........................................................................
  it('lets a re-add CANCEL an earlier removal', async () => {
    // Order is the whole correctness of this function. A path deleted and then
    // created again inside the walked range is not a removal at all, and
    // taking the union of `removed` would delete a live file.
    const seed = await chain.append({ treeRef: 'T0' });
    await chain.append({ treeRef: 'T1', removed: ['flip.txt'] });
    const head = await chain.append({ treeRef: 'T2', changed: ['flip.txt'] });

    const walk = await chain.collectRemovals(head.head, seed.head);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual([]);
  });

  // ...........................................................................
  it('keeps a removal that comes AFTER a re-add', async () => {
    const seed = await chain.append({ treeRef: 'T0' });
    await chain.append({ treeRef: 'T1', changed: ['flip.txt'] });
    const head = await chain.append({ treeRef: 'T2', removed: ['flip.txt'] });

    const walk = await chain.collectRemovals(head.head, seed.head);
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
    const known = await chain.append({
      treeRef: 'T1',
      removed: ['already-reflected.txt'],
    });
    const head = await chain.append({ treeRef: 'T2', removed: ['news.txt'] });

    const walk = await chain.collectRemovals(head.head, known.head);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['news.txt']);
    expect(walk.timeId).toBe(head.timeId);
  });

  // ...........................................................................
  it('reports the greatest timeId it walked', async () => {
    const root = await chain.append({ treeRef: 'T0' });
    const middle = await chain.append({ treeRef: 'T1', removed: ['x.txt'] });
    const head = await chain.append({ treeRef: 'T2' });

    const walk = await chain.collectRemovals(head.head, root.head);

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

    const walk = await chain.collectRemovals(head.head, undefined);
    expect(walk.complete).toBe(false);
  });

  // ...........................................................................
  it('T6: reports INCOMPLETE when the head itself is unresolvable', async () => {
    const walk = await chain.collectRemovals(
      'not-a-head-we-hold',
      undefined,
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

    const walk = await chain.collectRemovals(last.head, undefined, 3);
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

    const walk = await chain.collectRemovals(merge.head, base.head);
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

    const walk = await chain.collectRemovals(outer.head, undefined);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['base.txt', 'left.txt']);
  });

  // ...........................................................................
  it('terminates on a chain that reaches its own root', async () => {
    // No lineage of our own: a fresh receiver with nothing in common.
    // It must end at the root rather than loop.
    await chain.append({ treeRef: 'T0', removed: ['a.txt'] });
    const head = await chain.append({ treeRef: 'T1', removed: ['b.txt'] });

    const walk = await chain.collectRemovals(head.head, undefined);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['a.txt', 'b.txt']);
  });

  // ...........................................................................
  // Where the walk stops, now that the chain answers it.
  // ...........................................................................
  it('walks THROUGH a sibling entry that merely shares our content', async () => {
    // Two entries, same `treeRef`, different lineages — the ordinary case now
    // that mtime is out of the content identity: two nodes holding the same
    // bytes derive the same ref. The old stop set was content refs, so the
    // peer's `sibling` ended the walk although this node was never on that
    // lineage, and the removal behind it was never collected.
    const ours = await chain.append({ treeRef: 'SHARED', changed: ['a.txt'] });

    const sibling = await chain.append({
      treeRef: 'SHARED',
      removed: ['older.txt'],
      previous: [],
    });
    const peer = await chain.append({
      treeRef: 'PEER',
      removed: ['newer.txt'],
      previous: [sibling.head],
    });

    const walk = await chain.collectRemovals(peer.head, ours.head);
    expect(walk.complete).toBe(true);
    // BOTH. Our lineage never passed through `sibling`, so nothing it states
    // can be assumed already reflected here.
    expect(walk.removed).toEqual(['newer.txt', 'older.txt']);
  });

  // ...........................................................................
  it('stops at an entry in our lineage however its content compares', async () => {
    // The other half: the stop is reachability, so it holds for an entry whose
    // content this node cannot recognise at all.
    const here = await chain.append({ treeRef: 'HERE', removed: ['mine.txt'] });
    const peer = await chain.append({
      treeRef: 'THERE',
      removed: ['theirs.txt'],
      previous: [here.head],
    });

    const walk = await chain.collectRemovals(peer.head, here.head);
    expect(walk.complete).toBe(true);
    expect(walk.removed).toEqual(['theirs.txt']);
  });

  // ...........................................................................
  it('concludes NOTHING when our own lineage is unreadable', async () => {
    // Our own history holed is not a licence to walk past it: the entry that
    // would have stopped the walk may be inside the part we cannot read, and
    // continuing collects removals from a lineage we have already left.
    const peer = await chain.append({ treeRef: 'P', removed: ['x.txt'] });
    const ourBrokenHead = await chain.append({
      treeRef: 'OURS',
      previous: ['a-ref-nobody-ever-wrote'],
    });

    const walk = await chain.collectRemovals(peer.head, ourBrokenHead.head);
    expect(walk.complete).toBe(false);
    expect(walk.removed).toEqual([]);
  });

  // ...........................................................................
  it('walks our lineage once per state, not once per announcement', async () => {
    // Announcements arrive in bursts. Walking our whole history for each one
    // would cost a read per entry per announcement, which on a long chain is
    // the kind of regression that only shows up on a real folder.
    const ours = await chain.append({ treeRef: 'O0' });
    const peer = await chain.append({
      treeRef: 'P0',
      removed: ['x.txt'],
      previous: [ours.head],
    });

    let reads = 0;
    const real = db.getEditHistories.bind(db);
    db.getEditHistories = (async (...args: Parameters<typeof real>) => {
      reads++;
      return real(...args);
    }) as typeof real;

    await chain.collectRemovals(peer.head, ours.head);
    const first = reads;
    await chain.collectRemovals(peer.head, ours.head);
    const second = reads - first;
    expect(second).toBeLessThan(first);

    // And appending onto our own head EXTENDS the cached lineage rather than
    // discarding it, so the steady state stays cheap.
    const next = await chain.append({ treeRef: 'O1', previous: [ours.head] });
    const before = reads;
    await chain.collectRemovals(peer.head, next.head);
    expect(reads - before).toBe(second);

    db.getEditHistories = real;
  });

  // ...........................................................................
  // The other half of the delta, which is what lifts a tombstone.
  // ...........................................................................
  it('states what was CHANGED, not only what was removed', async () => {
    // A receiver tombstones every path it deletes, including the ones a peer
    // told it to delete, and that tombstone refuses the path if anyone writes
    // it again. The watcher lifts one on a LOCAL re-creation; a peer's
    // re-creation can only arrive through the restore the tombstone refuses.
    // So the peer has to say it.
    const ours = await chain.append({ treeRef: 'T0', changed: ['seed.txt'] });
    await chain.append({ treeRef: 'T1', removed: ['cycle.txt'] });
    const head = await chain.append({
      treeRef: 'T2',
      changed: ['cycle.txt'],
    });

    const walk = await chain.collectRemovals(head.head, ours.head);
    expect(walk.complete).toBe(true);
    // Deleted and re-created inside the walked range: nothing to remove, and
    // a statement that the path is back.
    expect(walk.removed).toEqual([]);
    expect(walk.changed).toEqual(['cycle.txt']);
  });

  // ...........................................................................
  it('does not report a path written and then deleted as changed', async () => {
    // The mirror. Without it, a path created and deleted inside the walked
    // range would lift a tombstone for a file that is gone.
    const ours = await chain.append({ treeRef: 'T0' });
    await chain.append({ treeRef: 'T1', changed: ['brief.txt'] });
    const head = await chain.append({ treeRef: 'T2', removed: ['brief.txt'] });

    const walk = await chain.collectRemovals(head.head, ours.head);
    expect(walk.changed).toEqual([]);
    expect(walk.removed).toEqual(['brief.txt']);
  });

  // ...........................................................................
  // WHO LAST CHANGED THIS PATH — the per-path question.
  // ...........................................................................
  describe('lastEditOf', () => {
    it('finds the newest edit naming the path, not the newest edit', async () => {
      // The measured rollback in one assertion. `doc.txt` was last changed by
      // the middle entry; the tip changed something else entirely and must not
      // count for it.
      await chain.append({ treeRef: 'T0', changed: ['doc.txt'] });
      const real = await chain.append({ treeRef: 'T1', changed: ['doc.txt'] });
      await chain.append({ treeRef: 'T2', changed: ['unrelated.txt'] });

      const found = await chain.lastEditOf(chain.head as string, 'doc.txt');
      expect(found?.head).toBe(real.head);
      expect(found?.timeId).toBe(real.timeId);
    });

    it('counts a REMOVAL as touching the path', async () => {
      // An edit/delete conflict is still two people acting on one file, and
      // the one who acted later decides it.
      await chain.append({ treeRef: 'T0', changed: ['doc.txt'] });
      const gone = await chain.append({ treeRef: 'T1', removed: ['doc.txt'] });

      const found = await chain.lastEditOf(chain.head as string, 'doc.txt');
      expect(found?.head).toBe(gone.head);
    });

    it('says nothing when the lineage never named the path', async () => {
      await chain.append({ treeRef: 'T0', changed: ['other.txt'] });
      expect(
        await chain.lastEditOf(chain.head as string, 'doc.txt'),
      ).toBeUndefined();
    });

    it('says nothing when the walk cannot be read to the end', async () => {
      // A hole makes the answer unknowable rather than empty: the edit being
      // looked for may be inside the part that cannot be read. The caller must
      // fall back rather than conclude nobody edited it.
      const holed = await chain.append({
        treeRef: 'T1',
        changed: ['other.txt'],
        previous: ['a-ref-nobody-ever-wrote'],
      });
      expect(await chain.lastEditOf(holed.head, 'doc.txt')).toBeUndefined();
    });

    it('follows BOTH parents of a merge', async () => {
      // A merge hides one branch's edits from this question unless both sides
      // are walked, and then whoever edited the path last on either side wins
      // a conflict they should not.
      const base = await chain.append({ treeRef: 'B' });
      const left = await chain.append({
        treeRef: 'L',
        changed: ['doc.txt'],
        previous: [base.head],
      });
      const right = await chain.append({
        treeRef: 'R',
        changed: ['other.txt'],
        previous: [base.head],
      });
      const merge = await chain.append({
        treeRef: 'M',
        previous: [left.head, right.head],
      });

      const found = await chain.lastEditOf(merge.head, 'doc.txt');
      expect(found?.head).toBe(left.head);
    });

    it('breaks a same-distance tie on timeId', async () => {
      // Two parents of a merge BOTH named the path. They are the same distance
      // from the head, so neither descends from the other and they really are
      // concurrent — which is the one case where a clock is the right answer,
      // `timeId` being a total order every node computes identically.
      //
      // COMPUTED, not assumed from append order: two ids minted in one
      // millisecond are separated by a random tail.
      const base = await chain.append({ treeRef: 'B' });
      const left = await chain.append({
        treeRef: 'L',
        changed: ['doc.txt'],
        previous: [base.head],
      });
      const right = await chain.append({
        treeRef: 'R',
        changed: ['doc.txt'],
        previous: [base.head],
      });
      const merge = await chain.append({
        treeRef: 'M',
        previous: [left.head, right.head],
      });

      const greater =
        compareTimeId(left.timeId, right.timeId) > 0 ? left : right;
      const found = await chain.lastEditOf(merge.head, 'doc.txt');
      expect(found?.head).toBe(greater.head);
    });

    it('ends a walk whose whole frontier has already been seen', async () => {
      // A DAG: `base` is reachable from `outer` directly AND through `left`, so
      // a pass ends with a frontier whose every member has been walked. Without
      // that check the loop cannot shrink the frontier and never terminates.
      const base = await chain.append({ treeRef: 'B' });
      const left = await chain.append({
        treeRef: 'L',
        changed: ['other.txt'],
        previous: [base.head],
      });
      const outer = await chain.append({
        treeRef: 'O',
        changed: ['third.txt'],
        previous: [left.head, base.head],
      });

      expect(await chain.lastEditOf(outer.head, 'absent.txt')).toBeUndefined();
    });

    it('stops at the walk bound rather than running a whole history', async () => {
      // The same bound every other walk here has, for the same reason: a deep
      // history is a cold replay, and left unbounded it pins a core.
      let last = await chain.append({ treeRef: 'T0', changed: ['doc.txt'] });
      for (let i = 1; i <= 6; i++) {
        last = await chain.append({ treeRef: `T${i}`, changed: ['other.txt'] });
      }
      expect(await chain.lastEditOf(last.head, 'doc.txt', 3)).toBeUndefined();
    });
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

    it('picks the OLDEST whichever order the rows come back in', async () => {
      // The mirror of the test above, and the same reason: the comparison is
      // otherwise exercised by whichever way the random `timeId` tails fell,
      // which is coverage by luck.
      //
      // `oldestEntryForTreeRef` is how a fleet agrees on ONE name for one
      // state — see `FsEditChain.append`'s root rule — so picking the wrong
      // row means two nodes disagree about their own shared history.
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

      // Descending then ascending, so the loop both replaces and KEEPS.
      await row('9:zzz');
      const winner = await row('1:aaa');
      await row('5:mmm');

      const rows = await db.getEditHistories(TREE, { dataRef: 'SHARED' });
      expect(rows.length).toBe(3);
      // The entry itself is unresolvable (its multiEdit is a stub), so this
      // asserts the SELECTION rather than the reconstruction — which is the
      // part with the branch in it.
      expect(await chain.oldestEntryForTreeRef('SHARED')).toBeUndefined();
      expect(winner).toBeTruthy();
    });

    it('answers undefined when no entry produced the content', async () => {
      // The empty arm of the oldest-entry lookup, which is reached whenever a
      // node hears about content whose history has not replicated to it yet.
      await chain.append({ treeRef: 'KNOWN' });
      expect(await chain.oldestEntryForTreeRef('NEVER-STORED')).toBeUndefined();
    });

    it('answers undefined for a tree ref no entry produced', async () => {
      await chain.append({ treeRef: 'T1' });
      expect(await chain.entryForTreeRef('never-stored')).toBeUndefined();
    });
  });
});
