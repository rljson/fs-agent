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
// ALL GREEN as of 2026-10-04, and nothing here is inverted any more.
//
// The file was written with `it.fails` for the rules that were red —
// deterministically red, naming what would turn each one green. They all did:
// D1, D2 and D4 on 2026-10-01 without needing the chain (see each comment),
// D3 as a GUARD once the livelock closed, and D5's rule was **deleted
// outright** with its second decision site rather than fixed — see the block
// below where it used to be.
//
// The history is worth keeping. On 2026-09-30 all four were red, and two of
// them (§7.3's D2 and D3) the plan expected to be green: enumerated, the
// livelock 0.0.85 was believed to have closed was still reachable in 2 of 576
// pairs. Fixing that is what made the other two fixable.
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

/**
 * Every node this space can describe, for one origin — and ONLY the reachable
 * ones.
 *
 * The first version enumerated every combination, which generated views no
 * node can be in: `cur=S2, applied=S0, authored=false` says "I am at S2, I did
 * not write it, and the last thing I applied was S0" — so how did the folder
 * get to S2? That artifact was reported as a defect (D3's offenders) and it was
 * the test over-generating, not the rule misbehaving.
 *
 * A node is at `currentRef` for exactly one of two reasons:
 *
 * - it AUTHORED it, in which case the last thing it applied may be any earlier
 *   state or nothing at all;
 * - it APPLIED it, in which case `lastAppliedRef` IS that state. (It may be a
 *   different NAME for it — a restore does not always reproduce mtimes, so the
 *   re-scan can derive another ref for identical content. That case has its own
 *   example test under D5, with the alias spelled out, because an enumeration
 *   over three refs cannot express "the same state under another name".)
 * @param origin - The origin to stamp on every node.
 * @returns The reachable views.
 */
const nodesFor = (origin: string): Node[] => {
  const out: Node[] = [];
  for (const currentRef of REFS) {
    for (const lastAppliedRef of [undefined, ...REFS]) {
      out.push({ origin, currentRef, lastAppliedRef, authored: true });
    }
    out.push({
      origin,
      currentRef,
      lastAppliedRef: currentRef,
      authored: false,
    });
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
      // ATTEMPT 2, because a livelock is a REPEAT. One push each is not a
      // livelock — it is two nodes correctly asserting a state the other had
      // not seen. What the field measured was the same disagreement answered
      // the same way over and over: twenty flips in ninety seconds. So the
      // property is about the retry, and the retry is where it is asserted.
      const aSees = antiEntropyDecision(
        { ref: b.currentRef, origin: b.origin, predecessors: history[b.currentRef] },
        viewOf(a),
        2,
      );
      const bSees = antiEntropyDecision(
        { ref: a.currentRef, origin: a.origin, predecessors: history[a.currentRef] },
        viewOf(b),
        2,
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
  // D2 — no pair of nodes may both decide `push`. **GREEN as of 2026-10-01.**
  //
  // §7.3 said this was already green "because 0.0.85 restored the yielding
  // side". Enumerated, it was not: of 576 disagreeing pairs, exactly TWO ended
  // with nobody yielding, and they were mirror images of each other —
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
  // So the livelock 0.0.85 was believed to have closed was never closed — only
  // made harder to reach, at a cost of 90 seconds of a customer's folder
  // rewriting itself each time it was.
  //
  // THE FIX IS A TIE-BREAK ON THE ORIGIN. Both sides can compare it and both
  // compare it the same way: the smaller origin pushes, the larger yields to a
  // merge. No coordination, no extra message, no pair able to both assert.
  // Where the hub declares no origin there is nothing to break the tie with
  // and the old behaviour stands, so a deployment without client identity
  // keeps exactly what it had.
  //
  // It needed no chain, and it is what made D1 and D4 fixable: the narrowing
  // those two need is only unsafe because of this livelock.
  // ...........................................................................
  for (const { name, of: history } of HISTORIES) {
    it(`D2 GUARD: never both push — ${name}`, () => {
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
    it(`D3 GUARD: never both silent — ${name}`, () => {
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
  it('D4: a deletion and a fork are distinguishable', () => {
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
  it('D1: a fork is not a lag — our own work is not discarded', () => {
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

  // ...........................................................................
  // D5 — the SECOND decision site — IS GONE, rule and enumeration together.
  //
  // It asked *"may this sender PRUNE my files?"*, enumerated over every
  // (node, sender) pair this space can describe, and its own RED case was the
  // mirror of D3: `statesIAmIn` cannot tell "a state I am in" from "a state I
  // have left". Two GUARD cases existed only to keep the rule from refusing
  // every deletion — a transport that carries no ancestry, and a push that
  // declares none — and a third because a node needed two names for one state
  // while mtime was in the content identity.
  //
  // Nothing prunes on absence any more, so there is no authority to grant.
  // The guarantee the GUARD cases protected — *a sender that has not seen my
  // state may add, never delete* — is now structural rather than enforced:
  // deletions arrive STATED in the chain, from the node that performed them.
  // Its tests live where that happens, in `fs-collect-removals.spec.ts` and
  // `fs-plan-removals.spec.ts`.
  // ...........................................................................

  // ...........................................................................
  // The same properties, WITH the chain's answer. This is what the protocol
  // change bought, and the difference between these and the inverted tests
  // above is the whole argument for it.
  // ...........................................................................
  describe('given reachability, the decision is not a guess', () => {
    const decide = (
      reachability: 'behind' | 'ahead' | 'fork' | 'incomplete',
      node: Node,
      hubRef: Ref,
    ) =>
      antiEntropyDecision(
        { ref: hubRef, origin: 'hub', predecessors: [], reachability },
        viewOf(node),
      );

    const us: Node = {
      origin: 'us',
      currentRef: 'S1',
      lastAppliedRef: 'S0',
      authored: true,
    };

    it('D1: a fork is a fork, and our work survives', () => {
      // The morning failure. Without the chain this view returns `pull` and
      // discards a copied folder; the inverted D1 above pins that.
      expect(decide('fork', us, 'S2')).toBe('merge');
    });

    it('D4: a deletion and a fork now differ', () => {
      // §2.2's two situations, which are the SAME VALUE at the old signature.
      // The refs and predecessors are identical here too — only the chain's
      // answer differs, which is exactly the point.
      expect(decide('behind', us, 'S0')).toBe('pull');
      expect(decide('fork', us, 'S0')).toBe('merge');
    });

    it('is willing to push a state it did NOT author', () => {
      // The condition that made WP2b's delete invisible. A node that ADOPTED a
      // peer's tree and then deleted a file authors nothing, so the old rule
      // could never re-announce the deletion — and the delete never
      // propagated. Reachability proves "they do not have this yet" without
      // asking who wrote it.
      const adopter: Node = {
        origin: 'us',
        currentRef: 'S2',
        lastAppliedRef: 'S1',
        authored: false,
      };
      expect(decide('ahead', adopter, 'S1')).toBe('push');
    });

    it('refuses to decide on a truncated walk', () => {
      // Every action available is destructive in one direction or the other,
      // and an incomplete walk that answers "not an ancestor" is
      // indistinguishable from a definite no. So: nothing.
      expect(decide('incomplete', us, 'S2')).toBe('blocked');
    });

    it('never lets both sides push', () => {
      // D2 as a property, with the chain answering. Reachability is
      // antisymmetric by construction — if theirs descends from ours it cannot
      // also be that ours descends from theirs — so the livelock is not merely
      // unlikely, it is unreachable.
      for (const { of: history } of HISTORIES) {
        for (const a of nodesFor('A')) {
          for (const b of nodesFor('B')) {
            if (a.currentRef === b.currentRef) continue;
            void history;
            // A sees B as ahead ⇒ B must see A as behind, and vice versa.
            const aSees = decide('behind', a, b.currentRef);
            const bSees = decide('ahead', b, a.currentRef);
            expect(aSees === 'push' && bSees === 'push').toBe(false);
          }
        }
      }
    });

    it('still falls back to the heuristics when the chain cannot answer', () => {
      // Absence must never read as `fork`. An older peer, or a node whose
      // chain failed to initialise, gets exactly the behaviour that shipped
      // before — including its known limits.
      expect(
        antiEntropyDecision(
          { ref: 'S2', origin: 'hub', predecessors: ['S1'] },
          viewOf(us),
        ),
      ).toBe('pull');
    });
  });
});
