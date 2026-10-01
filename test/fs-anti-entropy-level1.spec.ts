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
// MEASURED 2026-10-01: **D1, D2 and D4 are GREEN**, and none of them needed
// the chain — see each comment. D3 and D5 are still red.
//
// The history is worth keeping. On 2026-09-30 all four were red, and two of
// them (§7.3's D2 and D3) the plan expected to be green: enumerated, the
// livelock 0.0.85 was believed to have closed was still reachable in 2 of 576
// pairs. Fixing that is what made the other two fixable.
// .............................................................................

import { describe, expect, it } from 'vitest';

import {
  antiEntropyDecision,
  senderSawMyState,
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
  // D5 — the SECOND decision site (§7.3.1).
  //
  // `antiEntropyDecision` chooses a repair; `senderSawMyState` authorises
  // DELETIONS. They are not duplicates — which is why narrowing the first in
  // 0.0.84 correctly left this one alone — but they ask the same underlying
  // question from the same insufficient inputs, so §2.2's ambiguity exists at
  // both. A chain consulted for repairs but not for pruning leaves the deletion
  // path guessing exactly as it does today.
  //
  // Enumerated over the same space: for every (node, sender) pair, may that
  // sender delete this node's files?
  // ...........................................................................
  describe('D5 — may this sender prune my files?', () => {
    /** Every (node, sender) pair in the space, with the verdict. */
    const prunePairs = (history: History) => {
      const out: Array<{ me: Node; sender: Node; mayPrune: boolean }> = [];
      for (const me of nodesFor('A')) {
        for (const sender of nodesFor('B')) {
          if (me.currentRef === sender.currentRef) continue;
          out.push({
            me,
            sender,
            mayPrune: senderSawMyState({
              currentRef: me.currentRef,
              lastAppliedRef: me.lastAppliedRef,
              senderPredecessors: history[sender.currentRef],
              ancestryIsCarried: true,
            }),
          });
        }
      }
      return out;
    };

    // .........................................................................
    // GUARD. A sender whose state descends from nothing I hold must never be
    // allowed to delete my files.
    //
    // This is the rule that closed the measured failure where "a file reached
    // all three connected nodes and was gone from all three two seconds later,
    // as the fourth reconnected and its stale tree was applied as
    // authoritative". It passes today and must never stop.
    // .........................................................................
    for (const { name, of: history } of HISTORIES) {
      it(`GUARD: a sender sharing no state with me may not prune — ${name}`, () => {
        const offenders = prunePairs(history).filter(
          (p) =>
            p.mayPrune &&
            // A sender at a lineage ROOT declares no ancestry at all, and
            // undeclared ancestry is handled one rule up in `syncFromDb`
            // rather than here. Judging it here would refuse every deletion
            // from a client whose first push predates its own `_currentRef` —
            // which is a real client on an ordinary startup.
            history[p.sender.currentRef].length > 0 &&
            !history[p.sender.currentRef].includes(p.me.currentRef) &&
            !(
              p.me.lastAppliedRef !== undefined &&
              history[p.sender.currentRef].includes(p.me.lastAppliedRef)
            ),
        );
        expect(
          offenders
            .slice(0, 5)
            .map(
              (p) =>
                `me(cur=${p.me.currentRef} applied=${p.me.lastAppliedRef ?? '-'}) ` +
                `← sender(cur=${p.sender.currentRef} prev=[${history[p.sender.currentRef].join(',')}])`,
            ),
          'a sender that has not seen my state may add, never delete',
        ).toEqual([]);
      });
    }

    // .........................................................................
    // RED. A sender that has LEFT the state it shares with me may still prune.
    //
    // The mirror of D3 at this site. `statesIAmIn` cannot tell "a state I am
    // in" from "a state I have left", and neither can this rule tell "the
    // sender built on my state" from "the sender built on a state I have since
    // moved past". On the linear history S0 → S1 → S2, a node at S2 that once
    // applied S0 accepts a prune from a sender still at S1 — whose tree
    // predates everything the node has done since.
    //
    // That is the deletion path's half of §2.2, and it is why WP4 has to make
    // BOTH sites chain-aware. → WP3 + WP4.
    // .........................................................................
    it.fails('D5: a sender I have moved past may not prune me', () => {
      // I am at S2, built from S1. I applied S0 long ago and have moved on.
      // The sender is still at S1, which descends from S0.
      expect(
        senderSawMyState({
          currentRef: 'S2',
          lastAppliedRef: 'S0',
          senderPredecessors: ['S0'],
          ancestryIsCarried: true,
        }),
      ).toBe(false);
    });

    // .........................................................................
    // GUARD — the two escape hatches, both load-bearing and both measured.
    // .........................................................................
    it('GUARD: a transport that carries no ancestry may still delete', () => {
      // Every deployment without `causalOrdering` declares nothing, so judging
      // silence as "has not seen my state" refuses every deletion. That is not
      // hypothetical: it is what the first run of this rule did to twenty
      // tests.
      expect(
        senderSawMyState({
          currentRef: 'S2',
          lastAppliedRef: undefined,
          senderPredecessors: [],
          ancestryIsCarried: false,
        }),
      ).toBe(true);
    });

    it('GUARD: a push declaring no ancestry is left to the rule above', () => {
      // A genuinely fresh client's first push carries no predecessors, and
      // undeclared ancestry has always been handled one rule up rather than
      // here.
      expect(
        senderSawMyState({
          currentRef: 'S2',
          lastAppliedRef: undefined,
          senderPredecessors: [],
          ancestryIsCarried: true,
        }),
      ).toBe(true);
    });

    it('GUARD: lastAppliedRef counts, not only currentRef', () => {
      // After an apply a node records `currentRef` from its OWN re-scan, which
      // need not equal the ref the tree arrived under — mtimes do not always
      // survive a restore, and on Windows they regularly do not. Measured:
      // with `currentRef` alone, three lab runs in four converged on 1 201
      // files and propagated an added file, and NONE could delete one.
      expect(
        senderSawMyState({
          currentRef: 'rescanned-locally',
          lastAppliedRef: 'S1',
          senderPredecessors: ['S1'],
          ancestryIsCarried: true,
        }),
      ).toBe(true);
    });
  });

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
