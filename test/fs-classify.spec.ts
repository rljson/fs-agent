// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Reachability: where two histories stand relative to each other.
//
// The fact §2.2 says is missing. Without it the decision has a content hash
// and one generation of ancestry, and "a peer deleted what we added" and "a
// peer forked from an ancestor we share" arrive at that signature as the SAME
// VALUE — which is why narrowing the rule was tried twice, and cost a
// discarded folder the first time and a livelock the second.
//
// The truncation cases carry the most weight here. An incomplete walk that
// answers "not an ancestor" is indistinguishable from a definite no, and
// acting on it is how a node decides it is ahead of a peer it is behind.
// .............................................................................

import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg } from '@rljson/rljson';

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_WALK, FsEditChain } from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('FsEditChain.classify', () => {
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

  // ...........................................................................
  it('calls us BEHIND when theirs descends from ours', async () => {
    const ours = await chain.append({ treeRef: 'T1' });
    const theirs = await chain.append({ treeRef: 'T2' });
    expect(await chain.classify(ours.head, theirs.head)).toBe('behind');
  });

  // ...........................................................................
  it('calls us AHEAD when ours descends from theirs', async () => {
    const theirs = await chain.append({ treeRef: 'T1' });
    const ours = await chain.append({ treeRef: 'T2' });
    expect(await chain.classify(ours.head, theirs.head)).toBe('ahead');
  });

  // ...........................................................................
  it('calls the same head AHEAD, never a fork', async () => {
    const one = await chain.append({ treeRef: 'T1' });
    expect(await chain.classify(one.head, one.head)).toBe('ahead');
  });

  // ...........................................................................
  it('calls it a FORK when neither descends from the other', async () => {
    // Two siblings of one ancestor. This is §1.1: the case the old signature
    // read as a lag and answered with `pull`, discarding the node's own work.
    const base = await chain.append({ treeRef: 'T0' });
    const ours = await chain.append({ treeRef: 'L1', previous: [base.head] });
    const theirs = await chain.append({ treeRef: 'R1', previous: [base.head] });
    expect(await chain.classify(ours.head, theirs.head)).toBe('fork');
  });

  // ...........................................................................
  it('sees through a MERGE entry: a joined lineage is not a fork', async () => {
    // The keystone, and it cost a measurement to find. Every node appends to
    // its OWN lineage and chains are never merged, so an entry that names only
    // this node's previous head can never be reachable from a peer's — and
    // `classify` answers `fork` for every disagreement there has ever been.
    // Adding reachability WITHOUT this made the delete scenario worse, because
    // cases that used to pull or push correctly all became merges.
    //
    // Naming the adopted peer head as a second parent is what joins them.
    const base = await chain.append({ treeRef: 'T0' });
    const theirs = await chain.append({ treeRef: 'R1', previous: [base.head] });
    const ourFork = await chain.append({
      treeRef: 'L1',
      previous: [base.head],
    });
    const ourMerge = await chain.append({
      treeRef: 'M1',
      previous: [ourFork.head, theirs.head],
    });

    // We adopted their work, so we are ahead of them — not forked from them.
    expect(await chain.classify(ourMerge.head, theirs.head)).toBe('ahead');
    // And from their side, they are behind us.
    expect(await chain.classify(theirs.head, ourMerge.head)).toBe('behind');
  });

  // ...........................................................................
  it('refuses to answer when THIS node has no head', async () => {
    const theirs = await chain.append({ treeRef: 'T1' });
    expect(await chain.classify(undefined, theirs.head)).toBe('incomplete');
  });

  // ...........................................................................
  it('refuses to answer when THEIR head cannot be resolved', async () => {
    // A partitioned peer's entry is exactly this, and the answer must not be
    // `fork`: a node that concludes "we both have work" on a walk it could not
    // finish will merge when it should have pulled.
    const ours = await chain.append({ treeRef: 'T1' });
    expect(await chain.classify(ours.head, 'a-head-nobody-holds')).toBe(
      'incomplete',
    );
  });

  // ...........................................................................
  it('refuses to answer when OUR ancestry has a hole', async () => {
    // The other direction: their walk resolves, ours does not. Our missing
    // ancestor may be the very entry that proves we already have their work.
    const theirs = await chain.append({ treeRef: 'T1' });
    const ours = await chain.append({
      treeRef: 'T2',
      previous: ['a-parent-nobody-holds'],
    });
    expect(await chain.classify(ours.head, theirs.head)).toBe('incomplete');
  });

  // ...........................................................................
  it('calls a walk that ran out of BUDGET a fork, not an unknown', async () => {
    // **A latent permanent failure, and the earlier version of this test
    // pinned it.** Running out of budget is not the same truncation as failing
    // to read a row: everything asked for WAS readable, and no relation was
    // found within `DEFAULT_MAX_WALK` entries.
    //
    // Answering `incomplete` here meant any node more than that many pushes
    // into its own history said so forever — which the decision turns into
    // `blocked`, which never repairs. A long-lived node would simply stop
    // healing, silently, and nothing in the suite would have noticed.
    //
    // `fork` instead: both sides keep their work, reconciliation is additive.
    // Less precise than the truth and never destructive.
    const theirs = await chain.append({ treeRef: 'T0' });
    let last = theirs;
    for (let i = 1; i <= DEFAULT_MAX_WALK + 200; i++) {
      last = await chain.append({ treeRef: `T${i}` });
    }
    expect(await chain.classify(last.head, theirs.head)).toBe('fork');
  }, 120_000);

  it('still answers within the budget for an ordinary history', async () => {
    // The control for the case above: the same shape, short enough to resolve,
    // must give the precise answer rather than the safe one.
    const theirs = await chain.append({ treeRef: 'T0' });
    let last = theirs;
    for (let i = 1; i <= 20; i++) {
      last = await chain.append({ treeRef: `T${i}` });
    }
    expect(await chain.classify(last.head, theirs.head)).toBe('ahead');
  }, 60_000);
});
