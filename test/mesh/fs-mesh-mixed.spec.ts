// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WP6 — a MIXED-VERSION fleet converges.
//
// The proof obligation is *"a mixed-version mesh — half the nodes on the old
// build — converges"*, and it exists because a rollout guarantees the mixed
// case whether or not anyone planned for it. This branch makes two changes a
// peer can notice:
//
//   1. announcements carry `~H~<chain head>` instead of a tree ref, which a
//      build predating it cannot parse — it tries to fetch a tree by that hash
//      and fails, so the new node's pushes are invisible to it;
//   2. the scan emits a CANONICAL child order, which changes every tree ref.
//
// (2) is unavoidable and, crucially, not destructive: `_treesHaveEquivalentContent`
// sees the two trees as the same folder, so no data moves. It shows up as a red
// divergence flag during the rollout window — §2.1b's symptom — and clears once
// every node sorts.
//
// (1) is avoidable, and `announceTreeRef` is the switch that avoids it: a new
// node speaks the old format and still resolves its own ancestry, because an
// entry can be found from the tree ref it produced. So the rollout order is
// "deploy with the switch ON, then turn it off", not "stop the fleet".
// .............................................................................

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, type FsMesh } from './fs-mesh.ts';

describe('a mixed-version fleet', () => {
  let mesh: FsMesh | undefined;

  const root = (name: string) => join(process.cwd(), `test-temp-mixed-${name}`);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  it('converges with half the fleet on the old wire format', async () => {
    // A and B speak `~H~`; C and D speak the old tree-ref format. Every
    // direction is exercised: new→new, new→old, old→new, old→old.
    mesh = await buildFsMesh({
      root: root('half'),
      names: ['A', 'B', 'C', 'D'],
      oldWireFormat: ['C', 'D'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });

    expect((await mesh.converged()).converged).toBe(true);

    // One write from each kind of node, so no direction is left untested.
    await mesh.node('A').write('from-new.txt', 'new');
    await mesh.node('C').write('from-old.txt', 'old');

    const result = await mesh.converged({ timeoutMs: 30_000 });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    const expected = ['from-new.txt', 'from-old.txt', 'seed.txt'];
    for (const node of ['A', 'B', 'C', 'D']) {
      expect(result.snapshot[node], `node ${node}`).toEqual(expected);
    }
  }, 90_000);

  // ...........................................................................
  it('a node on the old format still carries its ancestry', async () => {
    // The switch is not "turn the chain off". A node announcing a tree ref
    // still WRITES its chain, and a peer can still find the entry that
    // produced that ref — by query on `dataRef` rather than by hash. Measured
    // across a real relay in `fs-chain-crosses-the-wire.spec.ts`; asserted
    // here through the agent that depends on it.
    mesh = await buildFsMesh({
      root: root('ancestry'),
      names: ['A', 'B'],
      oldWireFormat: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await mesh.node('A').write('a.txt', 'a');
    const result = await mesh.converged({ timeoutMs: 30_000 });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    expect(result.snapshot['B']).toEqual(['a.txt', 'seed.txt']);
  }, 90_000);

  // ...........................................................................
  it('a deletion crosses from a new node to an old one', async () => {
    // The direction that matters most, because a deletion is the destructive
    // half and the one this whole plan is about. The new node announces
    // `~H~`; the old node has to end up without the file.
    mesh = await buildFsMesh({
      root: root('delete'),
      names: ['A', 'B'],
      oldWireFormat: ['B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
          await writeFile(join(folder, 'doomed.txt'), 'doomed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await mesh.node('A').del('doomed.txt');
    const result = await mesh.converged({ timeoutMs: 30_000 });
    expect(result.converged, JSON.stringify(result.snapshot)).toBe(true);
    expect(result.snapshot['A']).toEqual(['seed.txt']);
    expect(result.snapshot['B']).toEqual(['seed.txt']);
  }, 90_000);
});
