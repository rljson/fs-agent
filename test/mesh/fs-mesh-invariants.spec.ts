// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// What must be true of the ROUTE a fleet takes, not only its destination.
//
// Every multi-node test in this repo so far asks `converged()`: does every node
// hold the same files once things settle. A fleet can answer that correctly and
// still have done something no user forgives on the way — a document showing
// last week's version for ten seconds, a deleted file reappearing and being
// deleted again, a folder emptying and refilling. All three converge. All three
// are the reports this project actually gets.
//
// `@rljson/mongo-agent`'s mesh has asserted this for a while: `expectNoRegression`
// walks a per-node history looking for a document whose version went BACKWARDS
// and for one resurrected after a delete. This harness had no history at all, so
// it could not ask.
//
// THE INVARIANTS, and why each is checkable:
//
//  1. SINGLE-WRITER MONOTONICITY. If only one node ever writes a path, every
//     other node's observed sequence of contents for it must be a SUBSEQUENCE
//     of what the writer wrote, in order. Skipping versions is fine — that is
//     just coalescing. Going backwards is not, and nothing else can produce it.
//     This is mongo's version field, spelled as content.
//  2. NO RESURRECTION. Once a deletion has converged, the path does not come
//     back unless somebody writes it again.
//  3. CONVERGENCE UNDER RANDOM CHURN. Not a scripted scenario: a seeded
//     sequence of writes, deletions, partitions and heals, then everything
//     healed, and every node must agree. This is the test that finds
//     combinations no script contains, and the seed makes a failure replayable.
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildFsMesh,
  whyNot,
  type FsMesh,
  type FsMeshNode,
} from './fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-inv-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The distinct contents a node was observed holding at `path`, in order.
 * @param node - The node to read.
 * @param path - The path to follow.
 * @returns One entry per change, `null` for absent.
 */
const seriesOf = (node: FsMeshNode, path: string): Array<string | null> => {
  const out: Array<string | null> = [];
  for (const sample of node.timeline.samples) {
    const value = sample.files[path] ?? null;
    if (out.length === 0 || out[out.length - 1] !== value) out.push(value);
  }
  return out;
};

/**
 * Whether `seen` is `written` in order, allowing gaps and leading absence.
 * @param seen - What a node went through.
 * @param written - What the single writer wrote, in order.
 * @returns Whether the sequence only ever moved forward.
 */
const isForwardOnly = (
  seen: ReadonlyArray<string | null>,
  written: readonly string[],
): boolean => {
  let at = -1;
  for (const value of seen) {
    // ABSENCE IS IGNORED, and treating it as a rollback is what made this
    // test flaky — roughly one run in five of my own making.
    //
    // The sampler reads the folder from disk on a timer, so it can land in the
    // instant between a file being replaced and its replacement being in
    // place. That is a momentary gap in PRESENCE, not a step backwards in
    // CONTENT, and this predicate is about content order only. Whether a file
    // may vanish is a different question with its own test — "a converged
    // deletion does not come back" — and conflating the two meant a sampling
    // artefact reported as a data defect.
    if (value === null) continue;
    const found = written.indexOf(value);
    // Checked BEFORE the comparison below, or content nobody wrote (index -1)
    // reports itself as "went backwards", which sends the reader after the
    // wrong fault.
    if (found === -1) return false;
    if (found < at) return false; // an older version after a newer one
    at = found;
  }
  return true;
};

describe('invariants over the route, not the destination', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  // ...........................................................................
  // SKIPPED, ROOT-CAUSED, AND PINNED IN 3 ms ELSEWHERE.
  //
  // Two mechanisms that used to decide this by something other than the chain
  // have been replaced, and BOTH are pinned deterministically elsewhere:
  //
  //  - the conflict resolver ordered a BRANCH, so a tip won paths it never
  //    touched. It now asks the chain per path — `FsEditChain.lastEditOf`,
  //    three cases in `fs-conflict-resolver.spec.ts`, both directions.
  //  - the bucket round settled a same-path conflict by comparing CONTENT
  //    HASHES, which converges on whichever id sorts higher and has nothing to
  //    do with who edited last. Each side's claim now travels with its entry
  //    and the side that edited the file keeps it — four cases in
  //    `fs-manifest.spec.ts`, including both mirror directions.
  //
  // **AND THIS TEST STILL CANNOT SAY WHETHER THAT HELPED.** It is skipped for
  // that reason and not for the defect: across this work it measured 6 of 8
  // failing, then 4 of 8, then 8 of 8 — the last two on code whose only
  // difference did nothing at all (a guard that logged zero hits in every
  // run). So the samples are noise at this sample size, and three separate
  // judgements were drawn from them before that was clear.
  //
  // Anything measured here needs either a deterministic reproduction or far
  // more runs than a gate can afford. What it is good for is REPRODUCING:
  // remove the `.skip` and it fails on the route, not on the destination.
  it('a document never goes backwards while one person edits it', async () => {
    // One writer, eight saves, and the other nodes being cut and healed
    // underneath. Every receiver may MISS versions — coalescing is correct —
    // but may never show an older one after a newer one. That is the whole
    // difference between "eventually consistent" and "it flickered".
    mesh = await buildFsMesh({
      root: root('monotonic'),
      names: ['WRITER', 'B', 'C'],
      recordHistory: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'doc.txt'), 'v0');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    const written = ['v0'];
    for (let v = 1; v <= 8; v++) {
      // Disturb the fleet while the writing goes on, so the receivers have to
      // catch up out of order rather than in lockstep.
      if (v % 3 === 0) mesh.node('B').cut();
      if (v % 4 === 0) mesh.node('C').cut();
      const content = `v${v}`;
      await mesh.node('WRITER').write('doc.txt', content);
      written.push(content);
      await sleep(350);
      mesh.node('B').heal();
      mesh.node('C').heal();
    }

    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 5_000 });
    expect(result.converged, whyNot(result)).toBe(true);

    for (const name of ['WRITER', 'B', 'C']) {
      const seen = seriesOf(mesh.node(name), 'doc.txt');
      expect(
        isForwardOnly(seen, written),
        `${name} went backwards: ${JSON.stringify(seen)} against a writer ` +
          `that wrote ${JSON.stringify(written)}`,
      ).toBe(true);
    }
    // WHETHER EVERYBODY ENDS ON THE LAST SAVE IS A SEPARATE TEST, AND IT IS
    // CURRENTLY RED. See `ANNOUNCEMENT LOSS FREEZES THE FLEET` below — the
    // receivers stop six versions behind and report health, which is a defect
    // of its own rather than a rollback. Asserting it here would hide a
    // passing invariant behind a failing one.
  }, 180_000);

  // ...........................................................................
  // OPEN, ROOT-CAUSED, AND PINNED SOMEWHERE CHEAPER.
  //
  // The test above guards this invariant under full-suite load and passes
  // there. Run ALONE it fails most of the time, with high variance — a control
  // at the commit before the chain audit fails 6 of 8, and the same code state
  // measured 3 of 8 and 7 of 8 on different eight-run samples. **It is not a
  // usable instrument for judging a fix**, which is worth more than the
  // reproduction: two attempted fixes were measured against it and one was
  // credited with halving the failure rate on a sample that could not support
  // the claim.
  //
  //   WRITER: v0 v1 v2 v3 v4 v5 v6 v7 v8 → v5
  //
  // THE DETERMINISTIC REPRODUCTION IS `compareTips` — see `orders a BRANCH,
  // not a path` in `fs-conflict-resolver.spec.ts`, which pins the wrong answer
  // in 3 ms. `compareTips` orders a BRANCH, and the caller applies that one
  // verdict to every path the branches disagree about, so a tip wins paths it
  // never touched: a receiver that authored an entry for its conflict copy at
  // 9000 also wins `doc.txt`, resolved to the v5 bytes it happens to hold,
  // over the writer's own v8 edit authored at 8000.
  //
  // **Not a timestamp problem.** mtime is out of the content identity and a
  // received file gets no date applied, so the only times in the system come
  // from edits, and 9000 is the honest moment that edit was authored. The
  // error is applying one branch's verdict to a path that branch never edited.
  //
  // What IS fixed, because the design rule says so rather than because this
  // test said so: a node no longer claims a path it merely received — at the
  // apply, at the merge, and when it applies a peer's stated removal
  // (`_recordReceived`). Two further attempts to infer authorship from BYTES —
  // a `path+hash` ledger, and recording fetches in the bucket round — each
  // measured worse and were reverted, both for the same reason: a node's own
  // bytes come back from a peer and get classified as received, so the node
  // stops asserting its own work. Authorship cannot be recovered from bytes.
  // It has to be read from the chain, which is what the per-path question
  // above is.
  //
  // CLOSED. The defect was not in `compareTips` after all — it was upstream of
  // it, in what the chain was told. `storeMerge` recorded an entry claiming
  // every path whose bytes differed from what that node had last ANNOUNCED, so
  // a receiver merging against a late v5 announcement wrote itself down as the
  // author of `doc.txt` 28 seconds after the writer's v8 edit. `compareTips`
  // then ordered that claim correctly. A merge now claims only the paths whose
  // merged bytes differ from BOTH inputs — the ones it genuinely synthesised —
  // and the test above runs unskipped.

  // ...........................................................................
  it('a converged deletion does not come back', async () => {
    // Resurrection is the half of mongo's invariant that matters most here,
    // because a file coming back looks to a user like the system undoing their
    // work. T2 and T4 cover two scripted shapes; this watches the whole run
    // and would catch a third.
    mesh = await buildFsMesh({
      root: root('resurrect'),
      names: ['A', 'B', 'C'],
      recordHistory: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'doomed.txt'), 'doomed');
          await writeFile(join(folder, 'keeper.txt'), 'keeper');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await mesh.node('C').del('doomed.txt');
    const left = ['keeper.txt'];
    for (const name of ['A', 'B', 'C']) {
      expect(await mesh.node(name).settlesOn(left, 30_000)).toEqual(left);
    }

    // Now churn around the deletion: unrelated work, partitions, heals. None
    // of it may bring the file back.
    for (let i = 0; i < 4; i++) {
      mesh.node(i % 2 === 0 ? 'A' : 'B').cut();
      await mesh.node('A').write(`other-${i}.txt`, `o${i}`);
      await sleep(300);
      mesh.node('A').heal();
      mesh.node('B').heal();
      await sleep(300);
    }
    await mesh.converged({ timeoutMs: 90_000, stableMs: 5_000 });

    for (const name of ['A', 'B', 'C']) {
      const seen = seriesOf(mesh.node(name), 'doomed.txt');
      const cameBack = seen.indexOf(null) !== -1 &&
        seen.slice(seen.indexOf(null)).some((v) => v !== null);
      expect(
        cameBack,
        `${name} saw the deleted file return: ${JSON.stringify(seen)}`,
      ).toBe(false);
    }
  }, 180_000);

  // ...........................................................................
  // The fuzz run. Seeded, so a failure is replayable from the message alone.
  //
  // Scripted scenarios test the combinations somebody thought of. This one
  // tests the combinations nobody did, which is where the last four defects in
  // this package came from.
  // ...........................................................................
  for (const seed of [1, 2, 3]) {
    it(`converges under random churn and partitions (seed ${seed})`, async () => {
      // A tiny deterministic generator, so the run is reproducible without a
      // dependency and the seed in the test name is the whole repro.
      let state = seed * 2654435761;
      const next = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];

      const names = ['A', 'B', 'C', 'D'];
      mesh = await buildFsMesh({
        root: root(`fuzz-${seed}`),
        names,
        recordHistory: true,
        seed: async (folders) => {
          for (const folder of Object.values(folders)) {
            await writeFile(join(folder, 'base.txt'), 'base');
          }
        },
      });
      expect((await mesh.converged()).converged).toBe(true);

      const paths = ['one.txt', 'two.txt', 'sub/three.txt', 'sub/four.txt'];
      const log: string[] = [];
      let writes = 0;

      for (let step = 0; step < 24; step++) {
        const who = pick(names);
        const node = mesh.node(who);
        const action = next();

        if (action < 0.55) {
          const path = pick(paths);
          const content = `s${step}`;
          await node.write(path, content);
          log.push(`${who} write ${path}=${content}`);
          writes++;
        } else if (action < 0.75) {
          const path = pick(paths);
          const existing = await node.read(path);
          if (existing !== undefined) {
            await node.del(path);
            log.push(`${who} del ${path}`);
          }
        } else if (action < 0.9) {
          // One-way cuts as well as total ones: a firewall is not symmetric.
          const how = pick(['cut', 'mute', 'deafen'] as const);
          node[how]();
          log.push(`${who} ${how}`);
        } else {
          node.heal();
          log.push(`${who} heal`);
        }
        await sleep(120);
      }

      // Everything back, then let it settle. A fleet is allowed any amount of
      // disagreement while partitioned; what it is not allowed is to stay that
      // way.
      for (const name of names) mesh.node(name).heal();
      log.push('all heal');

      const result = await mesh.converged({
        timeoutMs: 120_000,
        stableMs: 6_000,
      });
      // WHO disagreed, and what each of them thinks the fleet is at.
      //
      // Without this a failure reads `applied 7 peer deletions` twice with
      // nothing saying which node said it, and the only way forward is to
      // guess. Each node's anti-entropy status is the comparable fact: the ref
      // it last heard, the ref it holds, and whether it believes those differ.
      // A 2-2 split where both pairs report `diverged=false` is a different
      // defect from one where two nodes know they are behind.
      const perNode = await Promise.all(
        names.map(async (name) => {
          const node = mesh.node(name);
          const ae = node.agent.antiEntropyStatus;
          const tree = node.agent.getTree();
          // DISK versus the agent's own TREE. They must be the same number:
          // the scanner's tree is what the node announces, compares incoming
          // states against, and reports as its own ref. A tree that is short
          // of the folder means the node is syncing a state it is not in —
          // it skips restores as "equivalent content", pushes nothing because
          // its scan shows no change, and the anti-entropy reports in-sync
          // because the stale ref matches the hub. Nothing repairs that,
          // because every signal involved is derived from the same stale tree.
          const onDisk = (await node.files()).length;
          const inTree = tree
            ? [...tree.trees.values()].filter(
                (t) => (t as { isFile?: boolean }).isFile !== false,
              ).length
            : 0;
          return (
            `  ${name}: ${onDisk} files on disk` +
            `  tree=${tree ? `${inTree} entries` : 'none'}` +
            `  diverged=${ae?.diverged ?? 'n/a'}` +
            `  hub=${ae?.hubRef?.slice(0, 8) ?? 'none'}` +
            `  local=${ae?.localRef?.slice(0, 8) ?? 'none'}` +
            `  differing=[${ae?.differingPaths?.join(', ') ?? ''}]`
          );
        }),
      );

      const story =
        `seed ${seed}, ${writes} writes\n  ${log.join('\n  ')}\n` +
        `state after healing:\n${perNode.join('\n')}`;
      expect(
        result.converged,
        `did not converge after healing.\n${story}\n` +
          JSON.stringify(result.snapshot, null, 1),
      ).toBe(true);

      // Every node holds the same thing, byte for byte — a file list matching
      // is not agreement.
      const first = mesh.node(names[0]);
      for (const path of result.snapshot[names[0]]) {
        const expected = await first.read(path);
        for (const name of names.slice(1)) {
          expect(
            await mesh.node(name).read(path),
            `${name} disagrees about "${path}".\n${story}`,
          ).toBe(expected);
        }
      }

      // And nothing holds content nobody ever wrote.
      const everWritten = new Set(['base', ...log
        .filter((l) => l.includes(' write '))
        .map((l) => l.split('=')[1])]);
      for (const name of names) {
        for (const path of result.snapshot[name]) {
          const content = await mesh.node(name).read(path);
          expect(
            everWritten.has(content as string),
            `${name}:"${path}" holds ${JSON.stringify(content)}, which ` +
              `nobody wrote.\n${story}`,
          ).toBe(true);
        }
      }
    }, 300_000);
  }
  // ...........................................................................
  // ANNOUNCEMENT LOSS USED TO FREEZE THE FLEET. Closed, and this test is the
  // regression guard — keep it asserting CONTENT, because that is the only
  // reason it ever caught anything.
  //
  // One writer saves a document eight times while two receivers are cut and
  // healed underneath. As first measured, in under ten seconds:
  //
  //   WRITER holds: v8     AE: diverged=false hub=I8gAs19q local=I8gAs19q
  //   B holds:      v2     AE: diverged=false hub=7I0QklQj local=7I0QklQj
  //   C holds:      v2     AE: diverged=false hub=7I0QklQj local=7I0QklQj
  //
  // The receivers were SIX VERSIONS BEHIND and every health signal said fine.
  //
  // THE MECHANISM, and it was not a race. The anti-entropy decided by
  // comparing this node's state against THE LAST HUB REF IT HEARD. B never
  // heard about v3 onwards, so its idea of the hub was still v2, its own state
  // was v2, and the two agreed — `diverged=false`, zero repairs. The repair
  // mechanism's own input was the thing that failed, so the harder the
  // transport failed the healthier the fleet reported itself.
  //
  // THE FIX, and it was a design decision rather than a patch: anti-entropy
  // that only ever LISTENS cannot notice silence, so it now ASKS. See
  // `ANTI_ENTROPY_ASK_MS` — every two seconds a node reads its OWN database
  // for the newest entry the fleet has replicated there, instead of waiting to
  // be told about it. That costs nothing on the wire, and it closes the window
  // that matters: the rows are present and only the announcement that would
  // have triggered the repair was dropped. It cannot help while NOTHING
  // arrives — no local source can — and that is the honest limit of it.
  //
  // WHY NO TEST HAD CAUGHT IT. `converged()` compares FILE LISTS, and
  // `doc.txt` is present everywhere whatever version it holds. Nothing in this
  // repo compared content across nodes after a run. The assertions below do,
  // and that is the point of them.
  //
  // NOT AN ARTEFACT OF THE HARNESS, which was the first thing to ask. `cut()`
  // models a transport that reports success and delivers nothing, and the
  // relay is already recorded as dropping broadcasts under load. A clean
  // DISCONNECT is a different and gentler fault: it triggers a reconnect,
  // which resets the dedup and re-announces. Silent loss is the one that had
  // no recovery path.
  //
  // HOW IT IS MEASURED, and solo runs are not the answer. This test once
  // passed 8 of 8 on its own and then failed inside a FULL run, because
  // `converged()` compared file NAMES and returned the moment `doc.txt`
  // existed everywhere — so the version assertion was sampled a moment after a
  // convergence that had never looked at content. `converged()` now compares
  // content (see `fs-mesh.ts`), which closes that sampling window; the
  // evidence that counts for this one is therefore the full gate, not this
  // file alone. Solo after the three read-bound fixes (io 0.0.81, io 0.0.82,
  // bs 0.0.28): 8 of 8, about 11 s each, where it had been failing 2 runs in 3
  // while the reads could still block.
  // ...........................................................................
  it('every node ends on the last save', async () => {
    mesh = await buildFsMesh({
      root: root('freeze'),
      names: ['WRITER', 'B', 'C'],
      recordHistory: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'doc.txt'), 'v0');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    for (let v = 1; v <= 8; v++) {
      if (v % 3 === 0) mesh.node('B').cut();
      if (v % 4 === 0) mesh.node('C').cut();
      await mesh.node('WRITER').write('doc.txt', `v${v}`);
      await sleep(350);
      mesh.node('B').heal();
      mesh.node('C').heal();
    }
    await mesh.converged({ timeoutMs: 90_000, stableMs: 5_000 });

    for (const name of ['WRITER', 'B', 'C']) {
      expect(
        await mesh.node(name).read('doc.txt'),
        `${name} is behind the last save`,
      ).toBe('v8');
    }
  }, 180_000);
});
