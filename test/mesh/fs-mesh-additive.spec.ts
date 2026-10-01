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
// §3.1 of the plan: *"This single property makes §1.1 and §1.2 impossible"* —
// and these are §1.1 and §1.2.
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
    // §1.1, and the recipe `fork-keeps-own-work`. Whole-folder replacement
    // answered this by picking a winner and picked wrong in both possible
    // directions within one day. Here there is no winner to pick.
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
    // §1.2, and T4. The deleting node advertises the path at an EMPTY blob id,
    // so the peer sees something to drop rather than an absence it has to
    // interpret.
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
    // them.
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
});
