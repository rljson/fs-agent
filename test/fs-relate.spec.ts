// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg } from '@rljson/rljson';

import { beforeEach, describe, expect, it } from 'vitest';

import { FsEditChain } from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('FsEditChain.relate', () => {
  let chain: FsEditChain;

  beforeEach(async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    chain = new FsEditChain(db, TREE);
    await chain.init();
  });

  /** Appends an entry on the given parents. */
  const at = async (treeRef: string, previous: string[]) =>
    (await chain.append({ treeRef, changed: [treeRef], previous })).head;

  it('calls one head the same', async () => {
    const one = await at('T1', []);
    expect(await chain.relate(one, one)).toEqual({ verdict: 'same' });
  });

  it('calls us behind when theirs descends from ours, and ahead the other way', async () => {
    const ours = await at('T1', []);
    const theirs = await at('T2', [ours]);
    expect(await chain.relate(ours, theirs)).toEqual({ verdict: 'behind' });
    expect(await chain.relate(theirs, ours)).toEqual({ verdict: 'ahead' });
  });

  it('sees a merge that joined our lineage as descent, not a fork', async () => {
    const root = await at('T0', []);
    const ours = await at('L1', [root]);
    const other = await at('R1', [root]);
    const merge = await at('M', [other, ours]);
    expect(await chain.relate(ours, merge)).toEqual({ verdict: 'behind' });
  });

  it('gives a fork the nearest common ancestor as its base, not the root', async () => {
    const root = await at('T0', []);
    const mid = await at('T1', [root]);
    const ours = await at('L', [mid]);
    const theirs = await at('R', [mid]);
    expect(await chain.relate(ours, theirs)).toEqual({ verdict: 'fork', base: mid });
  });

  it('picks the smallest of several best ancestors — the same base from either side', async () => {
    // A criss-cross: two nodes each merged the other's head.
    const root = await at('T0', []);
    const a = await at('A', [root]);
    const b = await at('B', [root]);
    const mergeAB = await at('MAB', [a, b]);
    const mergeBA = await at('MBA', [b, a]);
    const ours = await at('L', [mergeAB]);
    const theirs = await at('R', [mergeBA]);

    const fromHere = await chain.relate(ours, theirs);
    const fromThere = await chain.relate(theirs, ours);

    expect(fromHere).toEqual({ verdict: 'fork', base: [a, b].sort()[0] });
    expect(fromThere).toEqual(fromHere);
  });

  it('gives two histories that share nothing no base', async () => {
    const ours = await at('L', []);
    const theirs = await at('R', []);
    expect(await chain.relate(ours, theirs)).toEqual({ verdict: 'fork', base: undefined });
  });

  it('answers incomplete when no descent is found and an entry cannot be read', async () => {
    const ours = await at('L', []);
    const theirs = await at('R', ['anEntryNobodyHolds']);
    expect(await chain.relate(ours, theirs)).toEqual({ verdict: 'incomplete' });
  });

  it('proves descent even when another part of the history cannot be read', async () => {
    const ours = await at('L', []);
    const theirs = await at('R', [ours, 'anEntryNobodyHolds']);
    expect(await chain.relate(ours, theirs)).toEqual({ verdict: 'behind' });
  });

  it('walks an entry once where two paths of different length reach it', async () => {
    const root = await at('T0', []);
    const x = await at('X', [root]);
    const z = await at('Z', [root]);
    const y = await at('Y', [z]);
    const merge = await at('M', [x, y]);
    expect(await chain.relate(root, merge)).toEqual({ verdict: 'behind' });
  });

  it('finds the base of a fork inside a long shared history the budget cuts short', async () => {
    let shared = await at('S0', []);
    for (let i = 1; i < 5; i++) shared = await at(`S${i}`, [shared]);
    const ours = await at('L', [shared]);
    const theirs = await at('R', [shared]);
    expect(await chain.relate(ours, theirs, 3)).toEqual({
      verdict: 'fork',
      base: shared,
    });
  });

  it('answers fork when the walk runs out of budget with everything readable', async () => {
    const root = await at('T0', []);
    let ours = root;
    let theirs = root;
    for (let i = 0; i < 4; i++) {
      ours = await at(`L${i}`, [ours]);
      theirs = await at(`R${i}`, [theirs]);
    }
    expect(await chain.relate(ours, theirs, 3)).toEqual({
      verdict: 'fork',
      base: undefined,
    });
  });
});
