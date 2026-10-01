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
// The scenario that carries the evidence is T4 in `fs-mesh.spec.ts`, which is
// now GREEN on the default path and whose comment records the whole
// progression. A4 used to live here as the switched-on copy of it; with the
// switch on by default the two were the same test, so it is gone and T4 is the
// one to read.
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, type FsMesh } from './fs-mesh.ts';


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
    // Waited FOR, not slept through: a fixed delay encodes how fast the
    // machine is, and under load it stops being long enough.
    expect(await mesh.node('A').settlesOn(['from-a.txt', 'seed.txt'])).toEqual([
      'from-a.txt',
      'seed.txt',
    ]);
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
    expect(await mesh.node('A').settlesOn(['keeper.txt'])).toEqual([
      'keeper.txt',
    ]);
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
    // A3 is the one that caught this: 8 of 8 alone, failing in the full suite,
    // because three seconds was not long enough under contention for A to
    // finish noticing its own deletion before it was healed. The test was
    // measuring its own setup.
    expect(await mesh.node('A').settlesOn(['from-a.txt', 'seed.txt'])).toEqual([
      'from-a.txt',
      'seed.txt',
    ]);
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

});
