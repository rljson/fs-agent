// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// LEVEL 1 for the delete path: which of a peer's deletions to apply here.
//
// `planRemovals` is pure, so the whole of §1.2 is reachable in milliseconds.
// It is the authorisation ancestry could not supply — a removal carried in the
// chain is a FACT rather than an inference — and that is exactly why it is
// bounded twice, by recency and by volume. Both bounds are enumerated here,
// because a rule that deletes without asking the ancestry check is the one
// place a mistake is maximally destructive.
// .............................................................................

import { describe, expect, it } from 'vitest';

import { compareTimeId, planRemovals } from '../src/fs-edit-chain.ts';

/** Defaults that put nothing near the mass-delete bound. */
const plan = (o: {
  removed: string[];
  timeId?: string;
  localTimeIds?: Record<string, string>;
  held?: string[];
  minFiles?: number;
  maxRatio?: number;
}) =>
  planRemovals({
    removed: o.removed,
    timeId: o.timeId ?? '2000:zzz',
    localTimeIds: new Map(Object.entries(o.localTimeIds ?? {})),
    held: new Set(o.held ?? o.removed),
    minFiles: o.minFiles ?? 100,
    maxRatio: o.maxRatio ?? 0.3,
  });

describe('compareTimeId', () => {
  it('orders by the millisecond part', () => {
    expect(compareTimeId('100:a', '200:a')).toBe(-1);
    expect(compareTimeId('200:a', '100:a')).toBe(1);
  });

  it('breaks a tie on the random tail, totally and identically everywhere', () => {
    // Arbitrary in wall-clock terms and the SAME on every node, which is the
    // property convergence needs. Nothing may read it as "later in time".
    expect(compareTimeId('100:a', '100:b')).toBe(-1);
    expect(compareTimeId('100:b', '100:a')).toBe(1);
  });

  it('calls equal ids equal', () => {
    expect(compareTimeId('100:a', '100:a')).toBe(0);
  });

  it('calls a missing or malformed id NOT COMPARABLE, never older', () => {
    // So a caller cannot accidentally treat "unknown" as "older" and delete on
    // the strength of it.
    expect(compareTimeId(undefined, '100:a')).toBe(0);
    expect(compareTimeId('100:a', undefined)).toBe(0);
    expect(compareTimeId('', '100:a')).toBe(0);
    expect(compareTimeId('nonsense', '100:a')).toBe(0);
    expect(compareTimeId('100:a', 'nonsense')).toBe(0);
  });

  it('tolerates an id with no tail at all, on either side', () => {
    // `split(':')` on a bare millisecond yields no tail, and an id from an
    // older build can look like that. A missing tail sorts below any tail
    // rather than throwing.
    expect(compareTimeId('100', '100:b')).toBe(-1);
    expect(compareTimeId('100:b', '100')).toBe(1);
  });
});

describe('planRemovals', () => {
  // ...........................................................................
  it('applies a removal of a path this node still holds', () => {
    // The whole point: the peer says it deleted `doomed.txt`, and this node
    // acts on the statement rather than trying to infer it from an absence.
    const result = plan({ removed: ['doomed.txt'] });
    expect(result).toEqual({
      apply: ['doomed.txt'],
      staler: [],
      blocked: false,
    });
  });

  // ...........................................................................
  it('says nothing about a path this node does not hold', () => {
    // Not a refusal — the ordinary case. Both sides already agree it is gone,
    // and counting it would inflate the mass-delete ratio with no-ops.
    const result = plan({ removed: ['already-gone.txt'], held: [] });
    expect(result.apply).toEqual([]);
    expect(result.staler).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  // ...........................................................................
  it('refuses a removal older than this node’s own work on that path', () => {
    // The recency bound. A removal is a statement about a state; a node that
    // has since re-created the path has moved past it, and applying the
    // removal would undo newer work on the authority of an older edit.
    const result = plan({
      removed: ['recreated.txt'],
      timeId: '100:a',
      localTimeIds: { 'recreated.txt': '200:a' },
    });
    expect(result.apply).toEqual([]);
    expect(result.staler).toEqual(['recreated.txt']);
  });

  // ...........................................................................
  it('applies a removal newer than this node’s own work', () => {
    const result = plan({
      removed: ['stale-local.txt'],
      timeId: '300:a',
      localTimeIds: { 'stale-local.txt': '200:a' },
    });
    expect(result.apply).toEqual(['stale-local.txt']);
    expect(result.staler).toEqual([]);
  });

  // ...........................................................................
  it('applies a removal when the two ids are NOT comparable', () => {
    // "Unknown" must not read as "older" — see `compareTimeId`. A peer on a
    // build that mints no usable id still has to be able to delete, or every
    // deletion from it is silently refused. That failure mode has been shipped
    // before: judging silence as untrustworthy refused every deletion across
    // twenty tests.
    const result = plan({
      removed: ['x.txt'],
      timeId: 'nonsense',
      localTimeIds: { 'x.txt': '200:a' },
    });
    expect(result.apply).toEqual(['x.txt']);
  });

  // ...........................................................................
  it('applies a removal for a path with no local claim at all', () => {
    const result = plan({
      removed: ['never-touched.txt'],
      timeId: '100:a',
      localTimeIds: { 'other.txt': '999:a' },
      held: ['never-touched.txt', 'other.txt'],
    });
    expect(result.apply).toEqual(['never-touched.txt']);
  });

  // ...........................................................................
  describe('the mass-delete bound', () => {
    const many = (n: number, prefix = 'f') =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}.txt`);

    it('blocks a removal of most of the folder, wholesale', () => {
      // It deletes without asking the ancestry rule, so it must not also
      // bypass the bound on how much one message may destroy. Blocked
      // WHOLESALE rather than trimmed: a partial mass delete is a folder in a
      // state neither side asked for.
      const held = many(300);
      const result = plan({ removed: many(200), held, maxRatio: 0.3 });
      expect(result.blocked).toBe(true);
      expect(result.apply).toEqual([]);
    });

    it('lets a small removal through however large the folder', () => {
      const held = many(300);
      const result = plan({ removed: many(5), held });
      expect(result.blocked).toBe(false);
      expect(result.apply.length).toBe(5);
    });

    it('bounds nothing below the floor — emptying a small folder is an edit', () => {
      // Below `minFiles`, "most of the folder" is not a meaningful statement:
      // a guard that blocked it would fire constantly on small trees and be
      // turned off.
      const held = many(4);
      const result = plan({ removed: many(4), held, minFiles: 100 });
      expect(result.blocked).toBe(false);
      expect(result.apply.length).toBe(4);
    });

    it('refuses to empty a folder of more than a handful of files', () => {
      // The user's rule — protect whenever ALL files would vanish — against
      // the reason the ratio floor exists. 40 removals against 40 held files
      // is a ratio of 1.0 and was still under `minFiles`, so it passed
      // unchallenged: measured as every node in a small fleet emptied by one
      // peer's loss (`a small folder survives a wiped peer too`).
      const held = many(40);
      const result = plan({ removed: many(40), held, minFiles: 100 });
      expect(result.blocked).toBe(true);
      expect(result.apply).toEqual([]);
    });

    it('still lets a handful of files go — and a rename is one', () => {
      // The control for the rule above, and the reason it needs its own floor
      // rather than applying at any size. A folder of four files loses all
      // four as ordinary work; a rename removes every path a small folder
      // holds and adds them back under new names, so a blanket "all gone"
      // rule turns every small-folder rename into a duplicate.
      const held = many(4);
      const result = plan({ removed: many(4), held, minFiles: 100 });
      expect(result.blocked).toBe(false);
      expect(result.apply.length).toBe(4);
    });

    it('judges the ratio on what would ACTUALLY be deleted', () => {
      // Paths this node does not hold, and paths refused as stale, are not
      // deletions — counting them would trip the breaker on a message that
      // removes almost nothing.
      const held = many(300);
      const result = plan({
        removed: [...many(200, 'absent'), ...many(5)],
        held,
        minFiles: 100,
      });
      expect(result.blocked).toBe(false);
      expect(result.apply.length).toBe(5);
    });

    it('reports what was refused as stale even when it blocks', () => {
      const held = many(300);
      const result = plan({
        removed: [...many(200), 'mine.txt'],
        held: [...held, 'mine.txt'],
        timeId: '100:a',
        localTimeIds: { 'mine.txt': '900:a' },
        maxRatio: 0.3,
      });
      expect(result.blocked).toBe(true);
      expect(result.staler).toEqual(['mine.txt']);
    });

    it('does not divide by zero on an empty folder', () => {
      const result = plan({ removed: ['x.txt'], held: [] });
      expect(result.blocked).toBe(false);
    });
  });
});

describe('unannounced local work', () => {
  // A stated removal is re-collected by every later walk, so it keeps arriving
  // after it was first applied. If this node re-creates the path meanwhile,
  // that creation has NO `localTimeIds` entry yet — claims are recorded by the
  // push, which has not happened — so the recency rule cannot see it.
  //
  // Measured as `I7b`: the re-created file was deleted under its own author,
  // three seconds after the write.
  const base = {
    removed: ['flip.txt'],
    held: new Set(['anchor.txt', 'flip.txt']),
    minFiles: 100,
    maxRatio: 0.3,
  };

  it('keeps a path this node holds and has never announced', () => {
    const plan = planRemovals({
      ...base,
      timeId: '9000:zzz',
      localTimeIds: new Map(),
      unannounced: new Set(['flip.txt']),
    });
    expect(plan.apply).toEqual([]);
    expect(plan.staler).toEqual(['flip.txt']);
  });

  it('outranks even a removal with a LATER timeId', () => {
    // Deliberate, and the reason is not recency: no removal can be about a
    // file no peer has ever seen. A later `timeId` on the removal does not
    // make it a statement about this node's unannounced work.
    const plan = planRemovals({
      ...base,
      timeId: '99999999:zzz',
      localTimeIds: new Map(),
      unannounced: new Set(['flip.txt']),
    });
    expect(plan.staler).toEqual(['flip.txt']);
  });

  it('applies the removal for a path that IS announced', () => {
    // The ordinary case must not change: a peer deletes a file this node holds
    // and has told the network about, and it goes.
    const plan = planRemovals({
      ...base,
      timeId: '9000:zzz',
      localTimeIds: new Map(),
      unannounced: new Set(),
    });
    expect(plan.apply).toEqual(['flip.txt']);
  });

  it('changes nothing when the set is omitted', () => {
    // Every existing caller and every test above passes no set at all.
    const plan = planRemovals({
      ...base,
      timeId: '9000:zzz',
      localTimeIds: new Map(),
    });
    expect(plan.apply).toEqual(['flip.txt']);
  });
});
