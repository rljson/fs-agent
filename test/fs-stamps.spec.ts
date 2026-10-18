// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import type { RefStamp } from '@rljson/rljson';

import { beforeEach, describe, expect, it } from 'vitest';

import { FsStamps } from '../src/fs-stamps.ts';

const stamp = (n: number, epoch = 1, domain = 'office'): RefStamp => ({
  domain,
  epoch,
  hub: 'hub-a',
  n,
});

describe('FsStamps — where each version reached the fleet', () => {
  let db: Db;
  // A chain as `entry → previous`. An entry missing from it cannot be read.
  let chain: Map<string, string[]>;
  let reads: string[];
  const previousOf = async (entry: string) => {
    reads.push(entry);
    return chain.get(entry);
  };
  const fresh = async () => {
    const stamps = new FsStamps(db, 'fileTree', previousOf);
    await stamps.init();
    return stamps;
  };

  beforeEach(async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    db = new Db(io);
    reads = [];
    chain = new Map([
      ['root', []],
      ['e1', ['root']],
      ['e2', ['e1']],
      ['e3', ['e2']],
      ['m', ['e3', 'side']],
      ['side', ['root']],
      ['holed', ['ghost']],
    ]);
  });

  it('knows nothing before anything was heard', async () => {
    const stamps = await fresh();
    expect(stamps.get('e1')).toBeUndefined();
    expect(stamps.maxEpoch('office')).toBe(0);
    expect(stamps.open).toBe(0);
  });

  it('gives a head’s stamp to every entry below it no announcement carried', async () => {
    const stamps = await fresh();
    await stamps.heard('e1', stamp(1));
    await stamps.heard('e3', stamp(7));

    expect(stamps.get('root')).toEqual(stamp(1));
    expect(stamps.get('e1')).toEqual(stamp(1));
    expect(stamps.get('e2')).toEqual(stamp(7));
    expect(stamps.get('e3')).toEqual(stamp(7));
    expect(stamps.open).toBe(0);
  });

  it('follows every parent of a merge, and stops at what it already knows', async () => {
    const stamps = await fresh();
    await stamps.heard('e3', stamp(3));
    await stamps.heard('m', stamp(9));
    expect(stamps.get('side')).toEqual(stamp(9));
    expect(stamps.get('e3')).toEqual(stamp(3));
  });

  it('keeps the first stamp an entry got, and ignores a malformed one', async () => {
    const stamps = await fresh();
    await stamps.heard('e1', stamp(1));
    await stamps.heard('e1', stamp(5));
    await stamps.heard('e2', { domain: 'office' });
    expect(stamps.get('e1')).toEqual(stamp(1));
    expect(stamps.get('e2')).toBeUndefined();
  });

  it('leaves a walk open where the history cannot be read, and settles it later', async () => {
    const stamps = await fresh();
    await stamps.heard('holed', stamp(2));
    expect(stamps.get('ghost')).toEqual(stamp(2));
    expect(stamps.open).toBe(1);

    // The next announcement does not ask for the missing row again.
    reads = [];
    await stamps.heard('e1', stamp(3));
    expect(reads).not.toContain('ghost');

    // Once it can be read, a settle walks on below it.
    chain.set('ghost', ['deep']);
    chain.set('deep', []);
    await stamps.settle();
    expect(stamps.get('deep')).toEqual(stamp(2));
    expect(stamps.open).toBe(0);
  });

  it('settles nothing while the row is still missing', async () => {
    const stamps = await fresh();
    await stamps.heard('holed', stamp(2));
    await stamps.settle();
    expect(stamps.open).toBe(1);
  });

  it('stops at the walk budget, and the rest stays open for a settle', async () => {
    const stamps = await fresh();
    await stamps.heard('e3', stamp(4), 2);
    expect(stamps.get('e1')).toEqual(stamp(4));
    expect(stamps.get('root')).toBeUndefined();
    expect(stamps.open).toBe(1);

    await stamps.settle();
    expect(stamps.get('root')).toEqual(stamp(4));
    expect(stamps.open).toBe(0);
  });

  it('settles the earliest stamp first, so a shared ancestor gets the earlier one', async () => {
    // `l2` was announced before `r1`, and both walks stopped at once. `r1` is
    // one step from `root`, `l2` two: settled in any other order, `root`
    // would take the later stamp.
    chain = new Map();
    const stamps = await fresh();
    await stamps.heard('l2', stamp(2));
    await stamps.heard('r1', stamp(5));

    chain.set('root', []);
    chain.set('l1', ['root']);
    chain.set('l2', ['l1']);
    chain.set('r1', ['root']);
    await stamps.settle();
    expect(stamps.get('root')).toEqual(stamp(2));
    expect(stamps.get('l1')).toEqual(stamp(2));
  });

  it('breaks a tie of equal stamps on the entry', async () => {
    chain = new Map();
    const stamps = await fresh();
    await stamps.heard('b', stamp(2));
    await stamps.heard('a', stamp(2));
    chain.set('a', []);
    chain.set('b', []);
    reads = [];
    await stamps.settle();
    expect(reads).toEqual(['a', 'b']);
  });

  it('survives a restart, an open walk included', async () => {
    const before = await fresh();
    await before.heard('e2', stamp(6, 3));
    await before.heard('holed', stamp(7, 3));

    const after = await fresh();
    expect(after.get('e2')).toEqual(stamp(6, 3));
    expect(after.get('root')).toEqual(stamp(6, 3));
    expect(after.open).toBe(1);

    chain.set('ghost', []);
    await after.settle();
    const again = await fresh();
    expect(again.open).toBe(0);
    expect(again.get('ghost')).toEqual(stamp(7, 3));
  });

  it('reports the highest epoch heard, per domain', async () => {
    const stamps = await fresh();
    await stamps.heard('e1', stamp(1, 4));
    await stamps.heard('e3', stamp(1, 9, 'zoo'));
    expect(stamps.maxEpoch('office')).toBe(4);
    expect(stamps.maxEpoch('zoo')).toBe(9);
    expect(stamps.epochs).toEqual({ office: 4, zoo: 9 });

    // A lower epoch heard later does not lower it, and a restart keeps it.
    await stamps.heard('e2', stamp(2, 1));
    expect((await fresh()).epochs).toEqual({ office: 4, zoo: 9 });
  });
});
