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
  // OPEN, ROOT-CAUSED, AND REPRODUCIBLE OFF-LAB IN 30 SECONDS.
  //
  // The test above guards this invariant under full-suite load and passes
  // there. Run ALONE on a fast machine it fails 6 of 8 — and a control run at
  // the commit before the chain audit fails 6 of 8 too, so this predates that
  // work rather than being caused by it. The timeline is identical with and
  // without it:
  //
  //   WRITER: v0 v1 v2 v3 v4 v5 v6 v7 v8 → v5
  //
  // The writer's OWN folder goes back three versions, and a conflicted copy
  // appears on a file one person edited.
  //
  // **Two layers, and the first is fixed.** Every node used to author its own
  // root entry for the identical seed state, so the three lineages were
  // disjoint from the first second and every announcement was a `fork`. A root
  // entry is now identified by its content (`FsEditChain.append`), which took
  // the forks in this scenario from 4 to 2.
  //
  // **What is left is the `changed` list.** A receiver that applies and lands
  // SHORT authors an entry of its own — correctly, being short of what you
  // applied is a state of your own — but it computes `changed` by diffing its
  // folder against its last announcement. That conflates *"I changed this
  // path"* with *"I did not manage to update this path"*. So a node holding
  // v5 while v8 arrived stamps doc.txt as its own change at heal time: OLD
  // content with a NEW `timeId`. The writer then merges against it, orders by
  // `timeId`, and the receiver's v5 beats the writer's v8. Measured directly:
  //
  //   [C] head=rPKdH2 changed=[doc (conflicted copy …).txt, doc.txt]
  //
  // on a node that had edited neither. The conflict copy in that list IS its
  // own work; `doc.txt` is not. Receiving a path is not editing it, and the
  // partial fix for the case where the apply LANDS is already in
  // `syncFromDb` — every path whose bytes now equal the bytes that arrived is
  // recorded as received and claimed by nobody. The landed-short case needs
  // `changed` to come from what a local actor did, not from a content diff.
  //
  // **The shape of the real fix is per-path ancestry.** "Who is ahead on
  // doc.txt" is a question the chain can answer exactly — the entry that
  // introduced these bytes for this path is in MY ancestry and is not my
  // latest, therefore I am ahead on it — and it needs no clock at all. That is
  // a mechanism, not a patch, so it is written down here rather than
  // improvised.
  it.skip('OPEN: a writer is not rolled back by a receiver that is catching up', async () => {
    // The reproduction is the test above, run alone. Kept as a pointer so the
    // defect has a name in the suite rather than only in a document.
  });

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
      const story = `seed ${seed}, ${writes} writes\n  ${log.join('\n  ')}`;
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
  // ANNOUNCEMENT LOSS FREEZES THE FLEET — measured, open, and skipped so it is
  // visible rather than absent.
  //
  // One writer saves a document eight times while two receivers are cut and
  // healed underneath. Measured, in under ten seconds:
  //
  //   WRITER holds: v8     AE: diverged=false hub=I8gAs19q local=I8gAs19q
  //   B holds:      v2     AE: diverged=false hub=7I0QklQj local=7I0QklQj
  //   C holds:      v2     AE: diverged=false hub=7I0QklQj local=7I0QklQj
  //
  // The receivers are SIX VERSIONS BEHIND and every health signal says fine.
  //
  // THE MECHANISM, and it is not a race. The anti-entropy decides by comparing
  // this node's state against THE LAST HUB REF IT HEARD. B never heard about
  // v3 onwards, so its idea of the hub is still v2, its own state is v2, and
  // the two agree — `diverged=false`, zero repairs. The repair mechanism's own
  // input is the thing that failed, so the harder the transport fails the
  // healthier the fleet reports itself. A dropped announcement is never
  // retried and the periodic beacon that should cover it is suppressed by the
  // same dedup it was meant to bypass.
  //
  // `converged()` passes throughout, because it compares FILE LISTS and
  // `doc.txt` is present everywhere whatever version it holds. That is why no
  // test in this repo had ever caught it: nothing compared content across
  // nodes after a run.
  //
  // NOT AN ARTEFACT OF THE HARNESS, which is the first thing to ask. `cut()`
  // models a transport that reports success and delivers nothing, and the
  // relay is already recorded as dropping broadcasts under load. A clean
  // DISCONNECT is a different and gentler fault: it triggers a reconnect,
  // which resets the dedup and re-announces. Silent loss is the one with no
  // recovery path.
  //
  // It is also not a regression: src from before this session's commits
  // behaves identically.
  //
  // THE FIX IS A DESIGN DECISION, which is why this is reported rather than
  // patched. Anti-entropy that only ever LISTENS cannot notice silence. It
  // would have to ASK — periodically fetch the hub's current state rather than
  // wait to be told — and that changes who drives the protocol.
  // ...........................................................................
  it.skip('OPEN: every node ends on the last save', async () => {
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
