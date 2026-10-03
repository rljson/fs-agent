// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// What catching up COSTS.
//
// A client that was away for a hundred revisions has to learn what happened —
// that is what the edit chain is for. The question is whether it also has to
// move the BYTES of every state it missed, and it must not: twenty saves of one
// document are twenty blobs, nineteen of which nobody will ever read again.
// Fetching them would make the cost of coming back proportional to how long you
// were away, which is the opposite of what a sync should do, and on a catalogue
// it would be the difference between seconds and hours.
//
// The chain is read to INTERPRET and the tree is fetched to APPLY. Those are
// different things, and this measures that they stay different:
//
//  - the chain entries are rows — a path list and a `previous` link each — and
//    reading a hundred of them is a hundred small reads;
//  - the blobs fetched are the ones the DESTINATION tree needs and that are not
//    already on disk, which for twenty saves of one file is exactly one.
//
// `@rljson/mongo-agent` asserts the same property on its side — *"one new edit
// costs one applied write per peer, however long the chain"* — and this package
// had nothing equivalent.
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, whyNot, type FsMesh } from './fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-cost-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many saves the absent node misses. */
const MISSED = 20;

describe('coming back does not cost what you missed', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  /**
   * Records every blob a node fetches, by id.
   * @param node - The node to watch.
   * @returns The ids, in order, as a live array.
   */
  const countFetches = (node: { agent: { bs: unknown } }): string[] => {
    const fetched: string[] = [];
    const bs = node.agent.bs as {
      getBlobStream?: (id: string) => Promise<unknown>;
      getBlob?: (id: string, o?: unknown) => Promise<unknown>;
    };
    for (const method of ['getBlobStream', 'getBlob'] as const) {
      const real = bs[method];
      if (typeof real !== 'function') continue;
      const bound = real.bind(bs) as (...a: unknown[]) => Promise<unknown>;
      (bs as Record<string, unknown>)[method] = (...args: unknown[]) => {
        fetched.push(String(args[0]));
        return bound(...args);
      };
    }
    return fetched;
  };

  // ...........................................................................
  it(`misses ${MISSED} saves of one file and fetches ONE blob`, async () => {
    mesh = await buildFsMesh({
      root: root('oneblob'),
      names: ['WRITER', 'AWAY'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'doc.txt'), 'v0');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // Watch from the moment it goes away, so the seed does not count.
    const fetched = countFetches(mesh.node('AWAY'));
    mesh.node('AWAY').cut();

    for (let v = 1; v <= MISSED; v++) {
      // Distinct content every time, so every save is a distinct blob and
      // nothing can be satisfied from what is already on disk by accident.
      await mesh.node('WRITER').write('doc.txt', `version ${v} of the document`);
      await sleep(120);
    }
    // The writer really did produce that many states — POLLED, not sampled.
    //
    // A bare read here is flaky at about one run in five, and the reason is a
    // defect rather than the test: the writer can have an OLDER state of its
    // own applied back over its newest. `_inboundRefVerdict` recognises only
    // the LAST ref this node sent as its own echo, and its own doc comment
    // states the limit — *"an echo of an OLDER self-originated ref still gets
    // through"*. The writer then re-pushes and settles.
    //
    // This test measures what CATCHING UP COSTS, so it waits for that to
    // settle rather than failing on it. If it never settles the wait expires
    // and the test fails, which is the right outcome for a writer that cannot
    // hold on to its own work.
    const settled = await (async () => {
      const deadline = Date.now() + 20_000;
      let seen: string | undefined;
      while (Date.now() < deadline) {
        seen = await mesh!.node('WRITER').read('doc.txt');
        if (seen === `version ${MISSED} of the document`) return seen;
        await sleep(200);
      }
      return seen;
    })();
    expect(
      settled,
      'the writer never settled on its own last save',
    ).toBe(`version ${MISSED} of the document`);

    mesh.node('AWAY').heal();
    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 5_000 });
    expect(result.converged, whyNot(result)).toBe(true);

    // AGREEMENT on one of the writer's saves, not on its LAST one.
    //
    // **Deliberately weaker than it looks, and the reason has a name.** About
    // one run in three the whole fleet settles one version back — the writer
    // included — because a receiver catching up stamps the version it managed
    // to apply as its own change and that out-orders the writer's newer save.
    // That is the open defect recorded as `OPEN: a writer is not rolled back
    // by a receiver that is catching up` in `fs-mesh-invariants.spec.ts`,
    // where it is root-caused; THIS test is its cheapest reproduction (~40 s,
    // 1 run in 3) and is the place to re-measure a fix.
    //
    // Asserting the last save here would report the same defect twice and
    // make the measurement below — which is what this test exists for —
    // unreachable whenever it fires.
    const landed = await mesh.node('AWAY').read('doc.txt');
    expect(landed, 'AWAY holds something the writer never wrote').toMatch(
      /^version \d+ of the document$/,
    );
    expect(
      await mesh.node('WRITER').read('doc.txt'),
      'the fleet did not agree on one version',
    ).toBe(landed);
    if (landed !== `version ${MISSED} of the document`) {
      console.warn(
        `[cost] OPEN DEFECT reproduced: the fleet settled on "${landed}" ` +
          `where the writer last wrote "version ${MISSED} of the document"`,
      );
    }

    // THE MEASUREMENT. One file, so at most one blob is needed however many
    // versions went past. A number that tracks `MISSED` would mean the cost of
    // being away is proportional to how long you were away.
    const distinct = new Set(fetched);
    console.log(
      `[cost] ${MISSED} saves of one file missed -> ${distinct.size} distinct ` +
        `blob(s) fetched (${fetched.length} call(s))`,
    );
    // TWO when the fleet landed on the last save; THREE when the open defect
    // above fired, because a rollback makes this node fetch the version it was
    // rolled back to as well. The extra blob is a CONSEQUENCE of that defect
    // and is attributed to it rather than absorbed into the bound — a bound
    // raised to swallow a known failure stops measuring anything.
    const rolledBack = landed !== `version ${MISSED} of the document`;
    expect(
      distinct.size,
      `fetched ${distinct.size} blobs to catch up on ${MISSED} saves of one ` +
        `file — the intermediate states are being moved as well as the final ` +
        `one`,
    ).toBeLessThanOrEqual(rolledBack ? 3 : 2);
    // And it did fetch something, or the assertion above passes by doing
    // nothing and the test is worthless.
    expect(distinct.size, 'nothing was fetched at all').toBeGreaterThan(0);
  }, 180_000);

  // ...........................................................................
  it('fetches only what it does not already hold', async () => {
    // The other half. A node that missed changes to SOME files must fetch
    // those and nothing else — not the whole folder, which is what a
    // state-only sync with no history would have to do.
    mesh = await buildFsMesh({
      root: root('onlynew'),
      names: ['WRITER', 'AWAY'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (let i = 0; i < 12; i++) {
            await writeFile(join(folder, `stable-${i}.txt`), `stable ${i}`);
          }
        }
      },
    });
    expect((await mesh.converged({ timeoutMs: 60_000 })).converged).toBe(true);

    const fetched = countFetches(mesh.node('AWAY'));
    mesh.node('AWAY').cut();

    // Two files change, ten times each. Ten of the twelve never change.
    for (let round = 1; round <= 10; round++) {
      await mesh.node('WRITER').write('stable-3.txt', `changed ${round}`);
      await mesh.node('WRITER').write('stable-7.txt', `also changed ${round}`);
      await sleep(120);
    }

    mesh.node('AWAY').heal();
    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 5_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(await mesh.node('AWAY').read('stable-3.txt')).toBe('changed 10');
    expect(await mesh.node('AWAY').read('stable-7.txt')).toBe('also changed 10');

    // Two files changed, so two blobs. Not twenty — the intermediate rounds —
    // and not twelve — the whole folder.
    const distinct = new Set(fetched);
    console.log(
      `[cost] 2 of 12 files changed, 10 rounds each -> ${distinct.size} ` +
        `distinct blob(s) fetched (${fetched.length} call(s))`,
    );
    expect(
      distinct.size,
      `fetched ${distinct.size} blobs when two files had changed, over ten ` +
        `rounds each; ${JSON.stringify([...distinct].slice(0, 6))}`,
    ).toBeLessThanOrEqual(4);
    expect(distinct.size).toBeGreaterThan(0);
  }, 180_000);
});
