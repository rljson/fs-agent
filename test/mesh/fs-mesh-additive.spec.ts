// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WP7 end to end: a divergence answered ADDITIVELY.
//
// The same mesh as `fs-mesh.spec.ts`, with `bucketSync` on. The difference is
// what a divergence DOES: `pull` replaces this folder with the hub's and
// `merge` applies the hub's tree under the ordinary rules — both whole-folder,
// so both can discard work. A bucket round cannot, because the only things it
// can do are fetch what is missing and drop what a peer proved it deleted.
//
// §3.1 of the plan: *"This single property makes §1.1 and §1.2 impossible"*.
//
// WHAT A1–A3 DO AND DO NOT PROVE, because the distinction was got wrong once
// and reported as a result. **They pass with `bucketSync` OFF as well** —
// measured, 8 of 8 either way. Two nodes, a three-second partition and two
// files converge under the old model too, so these assert that the additive
// path WORKS and prove nothing about what it fixed.
//
// A4 is the controlled one. It is T4's scenario — the only test in this repo
// that reproduces a field data loss off-lab — run with the switch on, and T4
// is the same scenario with it off:
//
//   T4, `bucketSync` off   4–5 of 8   (`fs-mesh.spec.ts`, committed skipped)
//   A4, `bucketSync` on    8 of 8
//
// Same scenario, same assertions, one switch. That is the evidence; A1–A3 are
// coverage of the additive path.
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, type FsMesh } from './fs-mesh.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('additive reconciliation', () => {
  let mesh: FsMesh | undefined;

  const root = (name: string) => join(process.cwd(), `test-temp-add-${name}`);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  it('A1: a fork keeps BOTH sides’ work', async () => {
    // §1.1 in shape, and it passes with the switch OFF too — see the header.
    // Kept as coverage of the additive path rather than as proof of a fix.
    mesh = await buildFsMesh({
      root: root('fork'),
      names: ['A', 'B'],
      bucketSync: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('A').cut();
    await mesh.node('A').write('from-a.txt', 'a');
    await mesh.node('B').write('from-b.txt', 'b');
    await sleep(3_000);
    mesh.node('A').heal();

    const result = await mesh.converged({ timeoutMs: 60_000 });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    const expected = ['from-a.txt', 'from-b.txt', 'seed.txt'];
    expect(result.snapshot['A']).toEqual(expected);
    expect(result.snapshot['B']).toEqual(expected);
  }, 120_000);

  // ...........................................................................
  it('A2: a delete made while partitioned stays deleted', async () => {
    // §1.2 in shape, and it passes with the switch OFF too — see the header
    // and A4. The deleting node advertises the path at an EMPTY blob id, so
    // the peer sees something to drop rather than an absence to interpret.
    mesh = await buildFsMesh({
      root: root('delete'),
      names: ['A', 'B'],
      bucketSync: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'keeper.txt'), 'keeper');
          await writeFile(join(folder, 'doomed.txt'), 'doomed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('A').cut();
    await mesh.node('A').del('doomed.txt');
    await mesh.node('B').write('meanwhile.txt', 'meanwhile');
    await sleep(3_000);
    mesh.node('A').heal();

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    const expected = ['keeper.txt', 'meanwhile.txt'];
    expect(result.snapshot['A']).toEqual(expected);
    expect(result.snapshot['B']).toEqual(expected);
  }, 120_000);

  // ...........................................................................
  it('A3: three nodes, adds and a delete at once', async () => {
    // The shape the lab reported: *"exactly one of three peers applied the
    // deletion and the other two kept the file"*. A mesh reaches a ref by more
    // paths than a pair does, and an additive round has to hold for all of
    // them. Also passes with the switch off — see the header.
    mesh = await buildFsMesh({
      root: root('three'),
      names: ['A', 'B', 'C'],
      bucketSync: true,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
          await writeFile(join(folder, 'doomed.txt'), 'doomed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('A').cut();
    await mesh.node('A').del('doomed.txt');
    await mesh.node('A').write('from-a.txt', 'a');
    await mesh.node('B').write('from-b.txt', 'b');
    await sleep(3_000);
    mesh.node('A').heal();

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    const expected = ['from-a.txt', 'from-b.txt', 'seed.txt'];
    for (const node of ['A', 'B', 'C']) {
      expect(result.snapshot[node], `node ${node}`).toEqual(expected);
    }
  }, 120_000);

  // ...........................................................................
  // A4 — T4, with the switch on. THE CONTROLLED RESULT.
  //
  // Byte-for-byte the scenario of `fs-mesh.spec.ts`'s T4, which is the only
  // test in this repo that reproduces a field data loss off-lab: a node deletes
  // a file while partitioned, the fleet moves on meanwhile, and on rejoin the
  // file comes back on every node INCLUDING the one that deleted it.
  //
  //   T4, `bucketSync` off   4–5 of 8, measured repeatedly, committed skipped
  //   A4, `bucketSync` on    8 of 8
  //
  // Same three nodes, same eight-second partition, same four files, same
  // sixty-second budget and ten-second stability window, same assertions. The
  // only difference is the switch, which is what makes this evidence rather
  // than a demonstration.
  //
  // Eight runs, because anything less is noise: every sub-eight sample taken
  // while building this plan was wrong, including two that were reported as
  // results.
  // ...........................................................................
  it('A4: T4’s scenario — a partitioned delete, with adds alongside', async () => {
    mesh = await buildFsMesh({
      root: root('t4-equivalent'),
      names: ['A', 'B', 'C'],
      bucketSync: true,
    });

    await mesh.node('A').write('doomed.txt', 'doomed');
    await mesh.node('A').write('keeper.txt', 'keeper');
    expect((await mesh.converged()).converged).toBe(true);

    mesh.node('A').cut();
    await mesh.node('A').del('doomed.txt');
    // The fleet moves on too, so A cannot simply fast-forward everyone onto
    // its deletion when it returns.
    await mesh.node('B').write('meanwhile.txt', 'meanwhile');
    await mesh.node('B').write('more/one.txt', '1');
    await mesh.node('B').write('more/two.txt', '2');
    await sleep(8_000);
    expect(await mesh.node('A').files()).toEqual(['keeper.txt']);

    mesh.node('A').heal();
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
});
