// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// JOINING A NETWORK, decided before anything is written.
//
// A joining node used to author a lineage root from whatever it happened to
// hold and push it as the network's newest claim. That is one defect wearing
// two faces: every node got its own lineage root, so `classify` answered `fork`
// to every announcement ever made; and a node restored from a backup pushed
// deleted files back to the whole fleet.
//
// `planJoin` answers every question against the CHAIN. The folder is consulted
// for what it holds and never for what that means — which is the whole design
// rule in one function, and the reason it can be tested without a filesystem,
// a socket or a clock.
// .............................................................................

import { describe, expect, it } from 'vitest';

import { planJoin } from '../src/fs-edit-chain.ts';

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('planJoin', () => {
  // ...........................................................................
  it('writes what the head has and this folder lacks', () => {
    const plan = planJoin({
      haveHead: true,
      head: m({ 'a.txt': 'A', 'b.txt': 'B' }),
      folder: m({ 'a.txt': 'A' }),
      removedEver: new Set(),
    });
    expect(plan).toEqual({
      write: ['b.txt'],
      announce: [],
      recover: [],
      conflict: [],
    });
  });

  // ...........................................................................
  it('announces a local file the history has never mentioned', () => {
    // New work, made while this node was away from the network. Dropping it is
    // how a node loses its own files on joining.
    const plan = planJoin({
      haveHead: true,
      head: m({ 'a.txt': 'A' }),
      folder: m({ 'a.txt': 'A', 'mine.txt': 'M' }),
      removedEver: new Set(),
    });
    expect(plan.announce).toEqual(['mine.txt']);
    expect(plan.recover).toEqual([]);
  });

  // ...........................................................................
  it('recovers a local file the history DELETED, and says nothing about it', () => {
    // The restored-backup case, and the reason the two buckets exist. These
    // bytes are not news: the fleet removed this path deliberately. Announcing
    // them would push a month of deletions back to every node.
    const plan = planJoin({
      haveHead: true,
      head: m({ 'a.txt': 'A' }),
      folder: m({ 'a.txt': 'A', 'deleted-last-month.txt': 'OLD' }),
      removedEver: new Set(['deleted-last-month.txt']),
    });
    expect(plan.recover).toEqual(['deleted-last-month.txt']);
    expect(plan.announce).toEqual([]);
  });

  // ...........................................................................
  it('treats a re-added path as new work, not as a deletion', () => {
    // `removedEver` is the NET removals: a path deleted and created again in
    // the history is not removed at all, so a local copy of it is an ordinary
    // live file. The netting happens in `collectRemovals`; this asserts that
    // `planJoin` honours it rather than re-deciding.
    const plan = planJoin({
      haveHead: true,
      head: m({}),
      folder: m({ 'flip.txt': 'F' }),
      removedEver: new Set(),
    });
    expect(plan.announce).toEqual(['flip.txt']);
    expect(plan.recover).toEqual([]);
  });

  // ...........................................................................
  it('calls a path that is live on both sides with different bytes a conflict', () => {
    // Edited while this node was away — neither "missing here" nor "additional
    // here", which is why the stated algorithm did not name it. The head's
    // bytes win because the chain states them; the local bytes are kept aside.
    const plan = planJoin({
      haveHead: true,
      head: m({ 'doc.txt': 'THEIRS' }),
      folder: m({ 'doc.txt': 'MINE' }),
      removedEver: new Set(),
    });
    expect(plan).toEqual({
      write: [],
      announce: [],
      recover: [],
      conflict: ['doc.txt'],
    });
  });

  // ...........................................................................
  it('does nothing where the two already agree', () => {
    const plan = planJoin({
      haveHead: true,
      head: m({ 'a.txt': 'A', 'b.txt': 'B' }),
      folder: m({ 'a.txt': 'A', 'b.txt': 'B' }),
      removedEver: new Set(['gone.txt']),
    });
    expect(plan).toEqual({
      write: [],
      announce: [],
      recover: [],
      conflict: [],
    });
  });

  // ...........................................................................
  it('treats an EMPTY head as a fact, not as an absent one', () => {
    // A fleet that has agreed the folder is empty states exactly that, and its
    // emptiness is to be applied. So a local file is still judged: unknown to
    // the history it is new work, removed by it a stale copy. Conflating this
    // with "no head" is what would make an emptied network un-joinable.
    const plan = planJoin({
      haveHead: true,
      head: m({}),
      folder: m({ 'new.txt': 'N', 'old.txt': 'O' }),
      removedEver: new Set(['old.txt']),
    });
    expect(plan.announce).toEqual(['new.txt']);
    expect(plan.recover).toEqual(['old.txt']);
  });

  // ...........................................................................
  it('leaves an origin alone — no head means no history anywhere', () => {
    // The first client in a new network. There is nothing to reconcile against
    // and its folder is the first state, which the ordinary root push states.
    // Deciding anything here is how a brand-new network becomes unstartable.
    const plan = planJoin({
      haveHead: false,
      head: m({}),
      folder: m({ 'a.txt': 'A', 'b.txt': 'B' }),
      removedEver: new Set(['a.txt']),
    });
    expect(plan).toEqual({
      write: [],
      announce: [],
      recover: [],
      conflict: [],
    });
  });

  // ...........................................................................
  it('puts every path in at most one bucket', () => {
    // The buckets drive writes, renames and announcements, so a path in two of
    // them is a file written and renamed, or announced and withheld.
    const plan = planJoin({
      haveHead: true,
      head: m({ missing: 'X', same: 'S', differs: 'THEIRS' }),
      folder: m({ same: 'S', differs: 'MINE', fresh: 'F', stale: 'OLD' }),
      removedEver: new Set(['stale']),
    });
    const all = [
      ...plan.write,
      ...plan.announce,
      ...plan.recover,
      ...plan.conflict,
    ];
    expect(all.length).toBe(new Set(all).size);
    expect(plan.write).toEqual(['missing']);
    expect(plan.conflict).toEqual(['differs']);
    expect(plan.announce).toEqual(['fresh']);
    expect(plan.recover).toEqual(['stale']);
  });
});
