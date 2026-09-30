// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// LEVEL 1 — the decision function, exhaustively (PLAN-fs-edit-chain.md §7.3).
//
// `antiEntropyDecision` is pure, so the whole of §1 is reachable here in
// MILLISECONDS, with no folders and no sockets. That matters more than it
// sounds: 0.0.84 passed every example test in the suite, fixed the case it was
// written for, and then flipped a production folder between two states roughly
// twenty times in ninety seconds. Ninety seconds of a customer's folder
// rewriting itself was an expensive way to learn something a loop over a
// three-element set says before the commit.
//
// The example-based tests live in `fs-anti-entropy.spec.ts`. This file holds
// the ENUMERATIONS — the ones that cannot be written as a list of cases,
// because the property is "for every pair of views", and that is precisely the
// shape of defect an example test cannot see.
//
// `it.fails` — red today, deterministically, and names what turns it green.
//
// MEASURED 2026-09-30 against 0.0.85: **all four are red, and two of them the
// plan expected to be green.** D2 in particular is described in §7.3 as a
// guard that passes today; enumerated, it does not. Each test's comment
// carries the offending pair.
// .............................................................................

import { describe, expect, it } from 'vitest';

import {
  antiEntropyDecision,
  type AntiEntropyDecision,
  type AntiEntropyView,
} from '../src/fs-anti-entropy.ts';

// .............................................................................
// The state space.
//
// Three refs and two shapes of history between them. Small enough to enumerate
// exhaustively in milliseconds, large enough to contain every situation in §1:
// a linear advance, a fork from a shared ancestor, and a return to a state
// already held.
// .............................................................................
const REFS = ['S0', 'S1', 'S2'] as const;
type Ref = (typeof REFS)[number];

/** `ref → what it was made from`. */
type History = Record<Ref, Ref[]>;

const HISTORIES: Array<{ name: string; of: History }> = [
  // A fork: S1 and S2 are siblings, both made from S0.
  { name: 'fork from a shared ancestor', of: { S0: [], S1: ['S0'], S2: ['S0'] } },
  // A line: S0 → S1 → S2.
  { name: 'a linear advance', of: { S0: [], S1: ['S0'], S2: ['S1'] } },
];

/** One node, reduced to what the decision actually reads. */
interface Node {
  origin: string;
  currentRef: Ref;
  lastAppliedRef: Ref | undefined;
  /** Whether this node authored `currentRef` — all `lastPushedRef` decides. */
  authored: boolean;
}

const viewOf = (node: Node): AntiEntropyView => ({
  origin: node.origin,
  currentRef: node.currentRef,
  lastAppliedRef: node.lastAppliedRef,
  lastPushedRef: node.authored ? node.currentRef : 'something-else',
});

/** Every node this space can describe, for one origin. */
const nodesFor = (origin: string): Node[] => {
  const out: Node[] = [];
  for (const currentRef of REFS) {
    for (const lastAppliedRef of [undefined, ...REFS]) {
      for (const authored of [true, false]) {
        out.push({ origin, currentRef, lastAppliedRef, authored });
      }
    }
  }
  return out;
};

/**
 * Every pair of nodes that can actually disagree.
 *
 * Same `currentRef` is not a disagreement, and a node cannot have applied a ref
 * that its own history says does not exist.
 * @param history - The ancestry the pair shares.
 * @returns Pairs of nodes, with each side's decision about the other.
 */
const disagreeingPairs = (history: History) => {
  const as = nodesFor('A');
  const bs = nodesFor('B');
  const out: Array<{
    a: Node;
    b: Node;
    aSees: AntiEntropyDecision;
    bSees: AntiEntropyDecision;
  }> = [];

  for (const a of as) {
    for (const b of bs) {
      if (a.currentRef === b.currentRef) continue;
      // Each node hears the other announce the state it is in, with the
      // ancestry that state actually has.
      const aSees = antiEntropyDecision(
        { ref: b.currentRef, origin: b.origin, predecessors: history[b.currentRef] },
        viewOf(a),
      );
      const bSees = antiEntropyDecision(
        { ref: a.currentRef, origin: a.origin, predecessors: history[a.currentRef] },
        viewOf(b),
      );
      out.push({ a, b, aSees, bSees });
    }
  }
  return out;
};

const describePair = (p: {
  a: Node;
  b: Node;
  aSees: AntiEntropyDecision;
  bSees: AntiEntropyDecision;
}): string =>
  `A(cur=${p.a.currentRef} applied=${p.a.lastAppliedRef ?? '-'} ` +
  `authored=${p.a.authored}) → ${p.aSees}   |   ` +
  `B(cur=${p.b.currentRef} applied=${p.b.lastAppliedRef ?? '-'} ` +
  `authored=${p.b.authored}) → ${p.bSees}`;

describe('level 1 — antiEntropyDecision, enumerated', () => {
  // ...........................................................................
  // D2 — no pair of nodes may both decide `push`.
  //
  // **The plan expected this GREEN. It is RED.** §7.3 says "D2 is green today,
  // because 0.0.85 restored the yielding side". Enumerated, it is not: of 576
  // disagreeing pairs, exactly TWO end with nobody yielding, and they are
  // mirror images of each other —
  //
  //   A(cur=S1 applied=S2 authored=true) → push
  //   B(cur=S2 applied=S1 authored=true) → push
  //
  // Each node has APPLIED THE OTHER'S CURRENT STATE and then authored its own.
  // The third rule — `authored && hub.ref === lastAppliedRef → push` — then
  // fires on both sides at once. That rule exists for a good reason (a peer
  // that deletes what we added returns the folder to exactly the state our
  // push was made from), and it has no way to notice that the peer is applying
  // it too.
  //
  // Reachable? Yes, and by the mechanism this whole plan is about. A node whose
  // current state is NOT descended from what it last applied looks impossible
  // until you remember §2.1: content-hash identity means a folder returning to
  // earlier content re-derives that content's exact ref. A delete-then-undelete
  // on each side produces this pair.
  //
  // So the livelock 0.0.85 was believed to have closed is not closed. It is
  // harder to reach, and it costs 90 seconds of a customer's folder rewriting
  // itself when it is reached. Inverted rather than skipped: the day a fix
  // lands, this breaks the build and says so.
  //
  // → WP3 + WP4 (reachability, so "both of us think the other is behind" is
  // answerable rather than guessable).
  // ...........................................................................
  for (const { name, of: history } of HISTORIES) {
    it.fails(`D2: never both push — ${name}`, () => {
      const offenders = disagreeingPairs(history).filter(
        (p) => p.aSees === 'push' && p.bSees === 'push',
      );
      expect(
        offenders.map(describePair),
        'a disagreement with nobody yielding is a livelock',
      ).toEqual([]);
    });
  }

  // ...........................................................................
  // D3 — no pair may leave BOTH states unannounced.
  //
  // The mirror of D2, and the cheaper failure to overlook: a pair where
  // neither side asserts its own state converges on nothing while reporting no
  // disagreement. Compare the hub-election deadlock — two nodes deferring to
  // each other is a stable, silent, total failure, and stable silent failures
  // are the expensive kind.
  //
  // `push` and `merge` both end with this node announcing what it holds.
  // `pull` and `unknown` do not.
  //
  // **RED, and the offenders are worse than a swap.** On the linear history
  // S0 → S1 → S2:
  //
  //   A(cur=S1 applied=-)  sees B's S2, predecessors [S1]  → pull   ← correct
  //   B(cur=S2 applied=S0) sees A's S1, predecessors [S0]  → pull   ← wrong
  //
  // B is AHEAD. It decides to adopt S1, **its own ancestor**, because S1's
  // predecessor is a state B once applied. `statesIAmIn` does not distinguish
  // "a state I am in" from "a state I have left", so a node can be walked
  // backwards down its own history by a peer that is simply behind.
  //
  // → WP3 + WP4.
  // ...........................................................................
  const silent = (d: AntiEntropyDecision) => d === 'pull' || d === 'unknown';

  for (const { name, of: history } of HISTORIES) {
    it.fails(`D3: never both silent — ${name}`, () => {
      const offenders = disagreeingPairs(history).filter(
        (p) => silent(p.aSees) && silent(p.bSees),
      );
      expect(
        offenders.slice(0, 5).map(describePair),
        'both sides yielding is a swap, not a convergence',
      ).toEqual([]);
    });
  }

  // ...........................................................................
  // D4 — a deletion and a fork must be DISTINGUISHABLE.
  //
  // The clearest statement in the whole plan of why this is a protocol change
  // and not a rule change. The two situations of §2.2 —
  //
  //   a peer DELETED what we added   hub = a state we once held, made from ours
  //   a peer FORKED from an ancestor hub = a state we once held, made from it
  //
  // — are built here and asserted to produce DIFFERENT decisions. The test
  // does not fail because the body is wrong. It fails because **the two inputs
  // are the same value**, so no amount of cleverness inside the function can
  // pass it. That is the point, and it is the argument for the chain in one
  // assertion.
  //
  // → WP2 + WP3 (an ancestry deep enough to tell them apart).
  // ...........................................................................
  it.fails('D4: a deletion and a fork are distinguishable', () => {
    // We are at S1, which we authored, having applied S0 before that.
    const us = viewOf({
      origin: 'us',
      currentRef: 'S1',
      lastAppliedRef: 'S0',
      authored: true,
    });

    // A peer DELETED what we added: it took our S1 and removed the file,
    // arriving back at S0's exact content — a state we have held.
    const deletion = { ref: 'S0', origin: 'peer', predecessors: ['S1'] };

    // A peer FORKED from the ancestor we share: it built its own S0-content
    // state from S0 without ever seeing our S1.
    const fork = { ref: 'S0', origin: 'peer', predecessors: ['S0'] };

    // Different situations, different correct answers — adopt the delete, or
    // keep both. If the function cannot tell them apart, it cannot be right
    // about both.
    expect(antiEntropyDecision(deletion, us)).not.toBe(
      antiEntropyDecision(fork, us),
    );
  });

  // ...........................................................................
  // D1 — a fork must not be read as a lag.
  //
  // §1.1 exactly, at the signature. We authored `currentRef`; the hub holds a
  // state whose predecessors include `lastAppliedRef` but NOT `currentRef`.
  // That is a sibling of our work, not a successor to it, and adopting it
  // discards what we made. Measured on NB-2744 as 15 files repeatedly replaced
  // by the fleet's 13, `lastRepair: { action: "pull", attempt: 5 }`.
  //
  // `fs-anti-entropy.spec.ts` pins the WRONG answer for this exact view on
  // purpose, with both halves of the trap in its comment. **When D1 goes green
  // that test is deleted, not amended.**
  //
  // → WP3 (the walk) + WP4 (decide from reachability).
  // ...........................................................................
  it.fails('D1: a fork is not a lag — our own work is not discarded', () => {
    expect(
      antiEntropyDecision(
        { ref: 'S2', origin: 'hub', predecessors: ['S0'] },
        viewOf({
          origin: 'us',
          currentRef: 'S1',
          lastAppliedRef: 'S0',
          authored: true,
        }),
      ),
    ).toBe('merge');
  });
});
