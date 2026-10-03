// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// THE SCENARIO MATRIX, at the tier that proves it.
//
// `doc/scenario-matrix.md` enumerates every way a folder and a history can
// disagree. Most rows had a test; these are the ones that had none, or none
// above the decision tier — a pure function proves the RULE and not that the
// rule is reached, and the gap between those two is where this package's
// defects have always lived.
//
// Everything here runs on the real thing: a real `Server`, real sockets from
// `createSocketPair`, real watchers, real files on disk, per-node blob stores
// so a blob has to travel, and `resolveConflicts` on as production sets it.
//
// The rows covered, by their matrix ids:
//
//   L7  rename a directory                      (was: below the mesh tier)
//   L8  move a file between directories         (was: no test anywhere)
//   I7  a removal for a path since re-created   (was: decision tier only)
//   I10 a far sparser peer                      (was: single node only)
//   J9  a chain that disagrees with its folder  (was: no test at any tier)
// .............................................................................

import { rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, whyNot, type FsMesh } from './fs-mesh.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the scenario matrix, at the mesh tier', () => {
  let mesh: FsMesh | undefined;
  const base = join(process.cwd(), 'test-temp-mesh-matrix');
  const root = (name: string) => join(base, name);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });

  // ...........................................................................
  // L7 — renaming a DIRECTORY.
  //
  // To this system a rename is "delete everything and re-add", so a folder
  // rename is the single operation most likely to be mistaken for a mass
  // deletion — `KNOWN-WEAKNESSES.md` D5, measured at 140 of 140 files and
  // nothing applied. It was covered by two agents over a database; this is the
  // same operation with a hub, watchers and a peer that has to converge on it.
  // ...........................................................................
  it('L7: renaming a directory moves it on every node', async () => {
    mesh = await buildFsMesh({ root: root('l7'), names: ['A', 'B'] });

    for (let i = 0; i < 6; i++) {
      await mesh.node('A').write(`old/f${i}.txt`, `c${i}`);
    }
    expect((await mesh.converged({ timeoutMs: 30_000 })).converged).toBe(true);

    // A rename, as a user performs it: every path under the old name
    // disappears at once and reappears under the new one.
    for (let i = 0; i < 6; i++) {
      await mesh.node('A').write(`new/f${i}.txt`, `c${i}`);
    }
    await rm(join(mesh.node('A').folder, 'old'), { recursive: true });

    const result = await mesh.converged({ timeoutMs: 60_000, stableMs: 3_000 });
    expect(result.converged, whyNot(result)).toBe(true);

    const onB = await mesh.node('B').files();
    expect(
      onB.filter((f) => f.startsWith('new/')).length,
      'the renamed directory did not arrive',
    ).toBe(6);
    expect(
      onB.filter((f) => f.startsWith('old/')),
      'the old name survived the rename',
    ).toEqual([]);
    // The content travelled once, under the new name — a rename must not be a
    // re-upload of every byte.
    expect(await mesh.node('B').read('new/f3.txt')).toBe('c3');
  }, 150_000);

  // ...........................................................................
  // L8 — moving ONE file between directories.
  //
  // No test anywhere, and it is the narrow version of L7: a single removal
  // plus a single claim, with the blob unchanged. The failure it guards
  // against is the file arriving at the new path AND staying at the old one,
  // which converges and is still wrong.
  // ...........................................................................
  it('L8: a file moved between directories is not duplicated', async () => {
    mesh = await buildFsMesh({ root: root('l8'), names: ['A', 'B'] });

    await mesh.node('A').write('from/doc.txt', 'the same bytes');
    await mesh.node('A').write('to/keep.txt', 'keep');
    expect((await mesh.converged({ timeoutMs: 30_000 })).converged).toBe(true);

    await mesh.node('A').write('to/doc.txt', 'the same bytes');
    await mesh.node('A').del('from/doc.txt');

    const result = await mesh.converged({ timeoutMs: 60_000, stableMs: 3_000 });
    expect(result.converged, whyNot(result)).toBe(true);

    for (const name of ['A', 'B']) {
      const files = await mesh.node(name).files();
      expect(files, `${name} lost the moved file`).toContain('to/doc.txt');
      expect(files, `${name} kept the file at its old path too`).not.toContain(
        'from/doc.txt',
      );
    }
  }, 150_000);

  // ...........................................................................
  // I7 — a removal for a path this node has SINCE re-created.
  //
  // The removal is real and the re-creation is newer, so the file must stay.
  // `planRemovals` decides it from a `timeId` comparison and is tested
  // directly; what was never tested is whether a fleet reaches that decision
  // when the two events happen on different machines seconds apart.
  //
  // Getting it wrong deletes a file somebody has just written, which is the
  // worst outcome in this package.
  // ...........................................................................
  it('I7: a peer deletion does not remove a file re-created since', async () => {
    mesh = await buildFsMesh({ root: root('i7'), names: ['A', 'B'] });

    await mesh.node('A').write('flip.txt', 'first');
    await mesh.node('A').write('anchor.txt', 'anchor');
    expect((await mesh.converged({ timeoutMs: 30_000 })).converged).toBe(true);

    // B goes away and deletes the file. Its removal is stated but reaches
    // nobody yet.
    mesh.node('B').cut();
    await mesh.node('B').del('flip.txt');
    await sleep(600);

    // Meanwhile A re-creates the same path with new content — strictly newer
    // than B's deletion.
    await mesh.node('A').write('flip.txt', 'written again, after the delete');
    expect(await mesh.node('A').settlesOn(['anchor.txt', 'flip.txt'])).toEqual([
      'anchor.txt',
      'flip.txt',
    ]);

    mesh.node('B').heal();
    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 4_000 });
    expect(result.converged, whyNot(result)).toBe(true);

    // The newer creation wins over the older deletion, on BOTH nodes.
    expect(
      await mesh.node('A').read('flip.txt'),
      'the author of the newer file lost it to an older deletion',
    ).toBe('written again, after the delete');
    expect(
      await mesh.node('B').read('flip.txt'),
      'the deleting node never learned the file came back',
    ).toBe('written again, after the delete');
  }, 180_000);

  // ...........................................................................
  // I10 — a peer that holds far less than this node does.
  //
  // Tested against a single agent with a hand-built tree; never with a real
  // peer that genuinely has almost nothing. The failure mode is not deletion —
  // an absence prunes nothing any more — it is SILENCE: the sparse node cannot
  // push, the full node has nothing new to say, and the fleet sits in a state
  // that is stable and wrong. Measured in the field at 1 of 3 642 files.
  // ...........................................................................
  it('I10: a nearly-empty peer is filled rather than left alone', async () => {
    mesh = await buildFsMesh({
      root: root('i10'),
      names: ['FULL', 'SPARSE'],
      seed: async (folders) => {
        // FULL has a folder; SPARSE has one file of the same name, as a
        // half-finished copy would.
        for (let i = 0; i < 40; i++) {
          await rm(join(folders['FULL'], `f${i}.txt`), { force: true });
        }
      },
    });

    for (let i = 0; i < 40; i++) {
      await mesh.node('FULL').write(`f${i}.txt`, `content ${i}`);
    }

    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 3_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(
      (await mesh.node('SPARSE').files()).length,
      'the sparse node was left behind',
    ).toBe(40);
    expect(await mesh.node('SPARSE').read('f17.txt')).toBe('content 17');
  }, 180_000);

  // ...........................................................................
  // J9 — a chain that disagrees with its OWN folder.
  //
  // No test at any tier, and it is what every crash produces: the agent is
  // not running, the folder changes, and on restart its own history describes
  // a state the folder is no longer in.
  //
  // The rule: the chain wins on everything it STATES, and what it does not
  // state is a new local event. So a file added while down must propagate —
  // nobody ever said anything about it — and that is the half that would be
  // lost by a naive "the chain wins" reading.
  // ...........................................................................
  it('J9: work done while the agent was down is not lost', async () => {
    mesh = await buildFsMesh({ root: root('j9'), names: ['A', 'B'] });

    await mesh.node('A').write('shared.txt', 'shared');
    expect((await mesh.converged({ timeoutMs: 30_000 })).converged).toBe(true);

    // A stops. Its chain stays behind, describing a folder with one file.
    mesh.node('A').down();
    await sleep(300);

    // The user keeps working in the folder with the client closed.
    await mesh.node('A').write('made-while-down.txt', 'typed into a dead node');

    // And the folder comes back.
    await mesh.node('A').up();

    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 4_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(
      await mesh.node('B').read('made-while-down.txt'),
      'a file written while the agent was down never reached the network',
    ).toBe('typed into a dead node');
    expect(
      await mesh.node('A').read('shared.txt'),
      'the restart lost what the chain already knew',
    ).toBe('shared');
  }, 180_000);

  // ...........................................................................
  // J9, the destructive half: a DELETION performed while the agent was down.
  //
  // Harder than the addition, and the one the chain is for. The folder lost a
  // file the history still names, and the only honest reading is that somebody
  // deleted it — so it must propagate, not be restored from the chain.
  // ...........................................................................
  it('J9: a deletion made while the agent was down propagates', async () => {
    mesh = await buildFsMesh({ root: root('j9b'), names: ['A', 'B'] });

    await mesh.node('A').write('doomed.txt', 'doomed');
    await mesh.node('A').write('keeper.txt', 'keeper');
    expect((await mesh.converged({ timeoutMs: 30_000 })).converged).toBe(true);

    mesh.node('A').down();
    await sleep(300);
    await rm(join(mesh.node('A').folder, 'doomed.txt'));
    await mesh.node('A').up();

    const result = await mesh.converged({ timeoutMs: 90_000, stableMs: 4_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(
      (await mesh.node('B').files()).includes('doomed.txt'),
      'the deletion made while down did not reach the peer',
    ).toBe(false);
    expect(await mesh.node('B').read('keeper.txt')).toBe('keeper');
  }, 180_000);
});
