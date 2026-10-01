// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// T1–T7: the scenarios the filesystem sync has to survive.
//
// Every one of these is an OPEN OR CLOSED DEFECT, not an invented case. They
// are written together, before any of the fixes, so the baseline is explicit.
//
// MEASURED BASELINE, 2026-09-30, against `fs-agent` 0.0.85:
//
//   T1  green here, LOST DATA IN THE FIELD  — see its comment
//   T2  green here, LOST DATA IN THE FIELD  — see its comment
//   T3  green
//   T4  RED — reproduces the field failure in seven seconds. WP2b's target.
//   T5  green
//   T6  cannot be written yet — nothing announces a chain head. WP3.
//   T7  green at 400 files; the scale wall is WP5's, not this file's.
//
// T4 and T6 are committed INVERTED (`it.fails`), not skipped: failing is the
// expected result and does not break the build, while PASSING breaks it with
// "this works now — remove the inversion and let it gate". A skipped test is
// silent in both directions and relies on somebody remembering to return.
//
// The plan this came from predicted T1, T2 and T4 would all be red. Only T4
// is. **A green T1 or T2 here is not evidence the defect is gone** — both were
// measured on four machines the same day, and their comments say what this
// mesh does not yet model. They are kept and asserted because a test that
// passes is still a regression guard, and because narrowing the rule they
// depend on is what caused T4's sibling failure.
//
// Read `PLAN-fs-edit-chain.md` §7 in the workspace root for why this exists
// and `doc/known-limits.md` for the two failures it was written from.
//
// Every scenario asserts on FOLDER CONTENTS AND STABILITY, never on refs. See
// the header of `fs-mesh.ts`.
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, type FsMesh } from './fs-mesh.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('fs mesh', () => {
  let mesh: FsMesh | undefined;

  const root = (name: string) => join(process.cwd(), `test-temp-mesh-${name}`);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  // T3 — both sides change from a shared ancestor.
  //
  // Expected GREEN today: this is what `resolveConflicts` and the inline
  // three-way merge are for. It is here as the control — a mesh that cannot
  // pass T3 is not measuring anything in T1 or T2.
  // ...........................................................................
  it('T3: keeps both changes when two nodes edit from a shared ancestor', async () => {
    mesh = await buildFsMesh({
      root: root('t3'),
      names: ['A', 'B'],
      seed: async (folders) => {
        // A shared starting point, so the two edits really do fork from one
        // ancestor rather than meeting for the first time.
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });

    const first = await mesh.converged();
    expect(first.converged, 'the mesh never agreed on the seed').toBe(true);

    // Both sides add a file of their own, at the same moment, from the state
    // they now share.
    await Promise.all([
      mesh.node('A').write('from-a.txt', 'a'),
      mesh.node('B').write('from-b.txt', 'b'),
    ]);

    const result = await mesh.converged();
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    expect(result.snapshot['A']).toEqual([
      'from-a.txt',
      'from-b.txt',
      'seed.txt',
    ]);
    expect(result.snapshot['B']).toEqual(result.snapshot['A']);
  }, 60_000);

  // ...........................................................................
  // T5 — a node stops talking mid-flight and comes back.
  //
  // Expected GREEN today: the anti-entropy exists for exactly this, and
  // `heals-after-forced-divergence` covers the one-message version of it. Here
  // the loss lasts, which is the part that was never tested.
  // ...........................................................................
  it('T5: converges after a node is cut off and healed', async () => {
    mesh = await buildFsMesh({ root: root('t5'), names: ['A', 'B'] });

    await mesh.node('A').write('before.txt', 'before');
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('B').cut();
    await mesh.node('A').write('during.txt', 'during');
    // Long enough that A has pushed and B has demonstrably not heard it.
    await sleep(1_500);
    expect(await mesh.node('B').files()).toEqual(['before.txt']);

    mesh.node('B').heal();
    const result = await mesh.converged();
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    expect(result.snapshot['B']).toEqual(['before.txt', 'during.txt']);
  }, 60_000);

  // ...........................................................................
  // T1 — a node adds while the hub cannot hear it, AND THE FLEET MOVES ON.
  //
  // The morning failure of 2026-09-30, reduced. **It passes here. It lost data
  // on four machines.** Both halves of that matter.
  //
  // The scenario: the hub announces a state whose ancestry reaches S — the
  // state A applied before it started working — and `antiEntropyDecision`
  // counts S as "a state we are in", concludes it is behind, and chooses
  // `pull` AGAINST A'S OWN NEW WORK. Measured on NB-2744 as 15 files being
  // repeatedly replaced by the fleet's 13, `lastRepair: { action: "pull",
  // attempt: 5 }`.
  //
  // WHAT THIS MESH DOES NOT MODEL, and why it passes anyway: here the
  // reconciliation reaches the inline three-way merge, which finds the common
  // ancestor S and keeps both sides. On the fleet the ANTI-ENTROPY acted
  // first — a `pull` repair bypasses the merge entirely — and it acted because
  // the divergence outlived a ten-second grace period on a 120 GB folder whose
  // scans take seconds. Four files settle in one round, so the grace period
  // never expires and the repair never fires.
  //
  // Making it red therefore needs either the real grace window or a way to
  // force a repair, and the honest state is that this test pins the MERGE
  // path, not the repair path. The repair path's wrong answer is pinned
  // directly in `test/fs-anti-entropy.spec.ts`, which asserts `pull` — the
  // wrong answer — deliberately.
  //
  // The concurrent write on the other side is still load-bearing: without it
  // the hub has nothing of its own, adopts A's push, and the test proves
  // nothing at all.
  //
  // It cannot be fixed by reading the decision more cleverly: "the hub forked
  // from an ancestor we share" and "the hub deleted what we added" arrive
  // identical in `ref` + one generation of `predecessors`. Narrowing the rule
  // was tried in 0.0.84 and livelocked the fleet the same afternoon (T2).
  // Telling them apart needs the CHAIN: WP3 (walk and pull) and WP4 (decide
  // from reachability).
  //
  // See `doc/known-limits.md` → "A node's own new work can be discarded when
  // the hub has forked", and the pinned decision case in
  // `test/fs-anti-entropy.spec.ts`.
  // ...........................................................................
  it('T1: keeps a node’s own addition when the fleet forked meanwhile', async () => {
    mesh = await buildFsMesh({ root: root('t1'), names: ['A', 'B', 'C'] });

    await mesh.node('A').write('shared.txt', 'shared');
    expect((await mesh.converged()).converged).toBe(true);

    // A goes quiet and copies a folder in.
    mesh.node('A').cut();
    await mesh.node('A').write('copied/one.txt', '1');
    await mesh.node('A').write('copied/two.txt', '2');

    // THE PRECONDITION: the rest of the fleet moves on from the shared state
    // while A is away, so the hub has a fork of its own to defend.
    await mesh.node('B').write('meanwhile.txt', 'meanwhile');
    await sleep(2_000);

    mesh.node('A').heal();
    const result = await mesh.converged({ timeoutMs: 30_000 });

    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    // Nobody's work is destroyed: the union, on every node.
    const expected = [
      'copied/one.txt',
      'copied/two.txt',
      'meanwhile.txt',
      'shared.txt',
    ];
    expect(result.snapshot['A']).toEqual(expected);
    expect(result.snapshot['B']).toEqual(expected);
    expect(result.snapshot['C']).toEqual(expected);
  }, 90_000);

  // ...........................................................................
  // T2 — a delete and a concurrent add, from the same ancestor.
  //
  // The afternoon failure of 2026-09-30, reduced. **It passes here.** On the
  // fleet the same shape flipped a folder between two states roughly twenty
  // times in ninety seconds, both nodes reporting a healthy `push`, before
  // settling on the state the user had deleted.
  //
  // A deletes `doomed.txt` while B, cut off, adds a file of its own. The two
  // states fork from the same ancestor, so neither descends from the other and
  // reconciliation has to MERGE them rather than fast-forward.
  //
  // WHY IT PASSES, and it is worth knowing: a three-way merge against a
  // COMMON ANCESTOR does not need a tombstone. Given S, A's tree and B's
  // tree, "absent from A and present in S" IS a deletion, provably, and
  // `fs-conflict-resolver.ts` gets it right. The plan's §2.3 — "a deletion has
  // no representation at all" — is true of the anti-entropy's `pull`/`push`
  // decision, which sees no ancestor, and NOT of the merge, which sees one.
  //
  // So the tombstone's job is narrower than the plan states, and more precise:
  // it is what makes a delete survive where the ancestor CANNOT be resolved.
  // That is T4, which is red, and it is why T4 rather than this test is WP1's
  // proof obligation.
  //
  // `churn` is asserted as well as agreement, because the livelock AGREED
  // repeatedly — on alternating states. Nothing that samples once can see it.
  //
  // The concurrent add is load-bearing: without it this is a plain
  // fast-forward and no merge runs at all.
  // ...........................................................................
  it('T2: a delete survives a merge with a peer that still holds the file', async () => {
    mesh = await buildFsMesh({ root: root('t2'), names: ['A', 'B'] });

    await mesh.node('A').write('doomed.txt', 'doomed');
    await mesh.node('A').write('keeper.txt', 'keeper');
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('B').cut();
    await mesh.node('A').del('doomed.txt');
    // THE PRECONDITION: B forks rather than merely lagging, so the two states
    // have to be merged instead of one fast-forwarding onto the other.
    await mesh.node('B').write('from-b.txt', 'b');
    await sleep(2_000);

    mesh.node('B').heal();
    const result = await mesh.converged({ timeoutMs: 30_000 });

    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    // B's addition survives; A's deletion also survives. Both, not one.
    const expected = ['from-b.txt', 'keeper.txt'];
    expect(result.snapshot['A']).toEqual(expected);
    expect(result.snapshot['B']).toEqual(expected);
    // The livelock's signature: a folder that keeps being rewritten. A healthy
    // repair moves each folder a handful of times, not dozens.
    expect(result.churn).toBeLessThan(12);
  }, 90_000);

  // ...........................................................................
  // T4 — the DELETING node is the one that was away.
  //
  // **GREEN, 8 of 8 on the default path.** The one scenario of the seven that
  // reproduced a field data loss off-lab, and the measurement that mattered
  // most through this whole plan.
  //
  // Its history, because the numbers are the argument:
  //
  //   0.0.85, as shipped                      4-5 of 8
  //   + persistent tombstone log              ~40%
  //   + removals carried in the chain         ~25%
  //   + reachability                          1-2 of 8
  //   + joined lineages                       5 of 8
  //   + the decision fix (narrow + tie-break) 2 of 8   ← additions, not deletes
  //   + additive reconciliation               **8 of 8**
  //
  // Every step before the last was a coin flip, and two of them made it worse.
  // Additive reconciliation is what closed it: there is no outcome in which
  // one side's folder replaces the other's, so neither the deletion nor the
  // work done alongside it can be discarded.
  //
  // It took one more thing to be true at the same time — the prune rule and
  // the inline merge had to stop deleting on authority they do not have. Those
  // are `senderSawMyState`'s narrowing and the merge's targeted deletions, and
  // without them this scenario traded a lost delete for a lost add.
  it('T4: a delete made while cut off is not resurrected on rejoin', async () => {
    mesh = await buildFsMesh({ root: root('t4'), names: ['A', 'B', 'C'] });

    await mesh.node('A').write('doomed.txt', 'doomed');
    await mesh.node('A').write('keeper.txt', 'keeper');
    expect((await mesh.converged()).converged).toBe(true);

    // THE PARTITION MUST OUTLIVE THE MERGE'S REACH.
    //
    // §13.1b, measured on two real machines: a short partition on a small
    // folder is a test of the MERGE, which already works — Herman's fork
    // converged because his ancestor was resolvable. The field's did not,
    // because the divergence outlived the grace period and a `pull` repair
    // bypassed the merge entirely. **The trigger is scale and timing, not
    // topology.**
    //
    // A two-second partition with one file per side was exactly that short
    // test: it passed roughly one run in five, whenever reconciliation
    // happened to reach the merge. Holding the partition past the
    // anti-entropy's grace period, with several changes on each side, puts the
    // repair path in charge instead — which is the path the defect lives on.
    mesh.node('A').cut();
    await mesh.node('A').del('doomed.txt');
    // THE PRECONDITION: the fleet moves on too, so A cannot simply
    // fast-forward everyone onto its deletion when it returns.
    await mesh.node('B').write('meanwhile.txt', 'meanwhile');
    await mesh.node('B').write('more/one.txt', '1');
    await mesh.node('B').write('more/two.txt', '2');
    // Well past `MESH_ANTI_ENTROPY.graceMs` (500 ms) and several backoffs, so
    // the repair has demonstrably run rather than possibly run.
    await sleep(8_000);
    expect(await mesh.node('A').files()).toEqual(['keeper.txt']);

    mesh.node('A').heal();

    // SIXTY seconds, not thirty, and the difference is the whole of §7.7.
    //
    // At 30 s this scenario passed roughly half the time — and a longer budget
    // made it fail MORE, which is backwards for a timeout. The fleet passes
    // THROUGH the correct state and drifts back off it: B and C re-assert
    // `doomed.txt` on a later round. A short budget was sampling an unstable
    // intermediate and reporting it as convergence.
    //
    // The agreement must HOLD FOR TEN SECONDS, not merely occur —
    // `fork-does-not-flap`'s window (§7.6.3), and the distinction §7.7 draws:
    // stability over a window is a DIFFERENT assertion from agreement at an
    // instant, and only the second was ever being made. It narrowed the pass
    // rate without closing it; see the note above the test.
    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 10_000,
    });

    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    const expected = [
      'keeper.txt',
      'meanwhile.txt',
      'more/one.txt',
      'more/two.txt',
    ];
    expect(result.snapshot['A']).toEqual(expected);
    expect(result.snapshot['B']).toEqual(expected);
    expect(result.snapshot['C']).toEqual(expected);
  }, 120_000);

  // ...........................................................................
  // T6 — an ancestor row cannot be resolved.
  //
  // **RED, inverted.** There is nothing to walk yet: `src/fs-edit-chain.ts`
  // exists but nothing announces a head, so no node can receive a chain with a
  // hole in it. `lastAppliedRef` remains a single slot that latches
  // unconditionally — mongo records having had exactly this bug, "lost updates
  // root-caused to a single `_lastApplied` slot vs. per-node lineages".
  //
  // The body throws on purpose, so the inversion holds it red until WP3 gives
  // `collectPuts`'s contract (`complete`, `sealed`) something to assert
  // against. The day someone implements it, this test turns the suite red and
  // says so.
  // ...........................................................................
  it.fails('T6: an unresolvable ancestor is retried, never latched', async () => {
    throw new Error('WP3: nothing announces a chain head yet');
  });

  // ...........................................................................
  // T7 — a large folder cold-starts against a populated peer.
  //
  // **Green, in 2.5 seconds at 400 files.** The plan expected this red, on the
  // grounds that fs has no `ready()` gate — until a folder's baseline is
  // complete its state is partial, and advertising a partial state makes a
  // peer see differences that are not real.
  //
  // The gate is genuinely missing and mongo genuinely needs one. What this
  // measurement says is that its absence is a SCALE effect, not a logic one:
  // 400 files settle inside a single scan, so no peer ever sees the partial
  // state. Held at 400 rather than the plan's 1 200 so it runs in the ordinary
  // suite; the PROJEKTE-scale measurement, the memory budget and the gate all
  // belong to WP5, which is where a number here would be meaningful.
  //
  // Kept as a regression guard: it is the only scenario that would notice a
  // cold start deadlocking.
  // ...........................................................................
  it('T7: a populated folder cold-starts against a populated peer', async () => {
    mesh = await buildFsMesh({
      root: root('t7'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (let i = 0; i < 400; i++) {
          await writeFile(join(folders['A'], `f${i}.txt`), String(i));
        }
      },
    });

    const before = process.memoryUsage().heapUsed;
    const result = await mesh.converged({ timeoutMs: 60_000 });
    expect(result.converged, JSON.stringify(result.snapshot).slice(0, 400)).toBe(
      true,
    );
    expect(result.snapshot['B'].length).toBe(400);

    // WP5's stated budget, and it is stated rather than tuned: 400 files must
    // converge inside 64 MB of heap growth across TWO agents, their stores and
    // their chains. Generous on purpose — the point is to notice a change of
    // ORDER, not to police megabytes, and a budget that fails on ordinary
    // variation gets raised until it means nothing.
    //
    // What this is guarding, measured rather than assumed: the chain grows one
    // entry per PUSH and not per change (400 deletions coalesce into ~7
    // entries), so the structure that could have blown up here does not. The
    // one that grows without bound is the tombstone log, and it is capped at
    // `TOMBSTONE_LOG_MAX`.
    const grewMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);
    expect(grewMb, `heap grew ${grewMb.toFixed(1)} MB`).toBeLessThan(64);
  }, 120_000);
});
