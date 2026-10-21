// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Every node has its own ignore list, and a person can change it.
//
// A tree does not say which list made it, so what one node ignores is, to
// everybody else, a path its edits leave out — and a path an edit leaves out
// is a deletion. Measured before the fix, with one pattern added on one node
// of three: that node authored nothing ever again (a removal waits for the
// scan to agree, and a scan that ignores the file never does), and on a node
// whose head did not name the file yet, every edit deleted it everywhere.
//
// What has to hold, and what these scenarios check:
//
//  - a pattern added on one node deletes nothing on any node, and the node
//    keeps syncing everything else;
//  - nothing a node ignores is written into its folder, and nothing it
//    ignores is deleted from anybody else's;
//  - a pattern removed again takes the network's version first — the files
//    the node never received arrive, and a version of its own is kept beside
//    the network's rather than written over it;
//  - and while the network's version cannot be fetched, nothing the node
//    could not fetch is announced as deleted.
// .............................................................................

import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, type FsMesh } from './fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-ignore-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `check` holds.
 * @param what - What is waited for, for the failure message.
 * @param check - The condition.
 * @param timeoutMs - How long to allow.
 */
const until = async (
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(100);
  }
};

describe('per-node ignore lists', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  it('a pattern added on one node deletes nothing, and the node keeps syncing', async () => {
    mesh = await buildFsMesh({ root: root('added'), names: ['A', 'B', 'C'] });
    const [A, B, C] = ['A', 'B', 'C'].map((n) => (mesh as FsMesh).node(n));
    await A.write('notes.txt', 'n1');
    await A.write('docs/a.txt', 'a');
    await A.write('docs/old.bak', 'v1');
    const all = ['docs/a.txt', 'docs/old.bak', 'notes.txt'];
    for (const node of [A, B, C]) expect(await node.settlesOn(all)).toEqual(all);

    // B's list gains a pattern between two runs, as an edit in a settings
    // page and a restart leave it.
    B.down();
    await B.up({ ignore: ['*.bak'] });

    // B's work still goes out — it used to stop here for good.
    await B.write('notes.txt', 'n2');
    await until('B\'s edit on A and C', async () =>
      (await A.read('notes.txt')) === 'n2' && (await C.read('notes.txt')) === 'n2');

    // The others go on syncing what B ignores, among themselves. B's next
    // edit does not take their version back, and B's copy is not written
    // over.
    await A.write('docs/old.bak', 'v2');
    await until('A\'s version on C', async () => (await C.read('docs/old.bak')) === 'v2');
    await B.write('notes.txt', 'n3');
    await until('B\'s second edit', async () =>
      (await A.read('notes.txt')) === 'n3' && (await C.read('notes.txt')) === 'n3');
    await sleep(1_000);
    expect(await A.read('docs/old.bak')).toBe('v2');
    expect(await C.read('docs/old.bak')).toBe('v2');
    expect(await B.read('docs/old.bak')).toBe('v1');

    // And B removing its own copy is nobody else's business.
    await B.del('docs/old.bak');
    await B.write('notes.txt', 'n4');
    await until('B\'s third edit', async () =>
      (await A.read('notes.txt')) === 'n4' && (await C.read('notes.txt')) === 'n4');
    await sleep(1_000);
    expect(await A.read('docs/old.bak')).toBe('v2');
    expect(await C.read('docs/old.bak')).toBe('v2');
  }, 90_000);

  // ...........................................................................
  it('with different lists from the start, nothing ignored arrives or goes', async () => {
    mesh = await buildFsMesh({
      root: root('differ'),
      names: ['A', 'B'],
      ignore: { A: ['build/'] },
    });
    const [A, B] = ['A', 'B'].map((n) => (mesh as FsMesh).node(n));

    await B.write('build/out.js', 'theirs');
    await B.write('src/a.ts', 'a');
    expect(await A.settlesOn(['src/a.ts'])).toEqual(['src/a.ts']);

    // A's own build output stays its own, and A's edits leave B's alone.
    await A.write('build/local.js', 'mine');
    await A.write('src/b.ts', 'b');
    expect(await B.settlesOn(['build/out.js', 'src/a.ts', 'src/b.ts'])).toEqual([
      'build/out.js',
      'src/a.ts',
      'src/b.ts',
    ]);
    await sleep(1_500);
    expect(await A.files()).toEqual(['build/local.js', 'src/a.ts', 'src/b.ts']);
    expect(await B.files()).toEqual(['build/out.js', 'src/a.ts', 'src/b.ts']);

    // B changes what A ignores: A carries the new version, writes nothing.
    await B.write('build/out.js', 'theirs, again');
    await B.write('src/a.ts', 'a2');
    await until('B\'s edit on A', async () => (await A.read('src/a.ts')) === 'a2');
    expect(await A.files()).toEqual(['build/local.js', 'src/a.ts', 'src/b.ts']);
    expect(await A.read('build/local.js')).toBe('mine');
  }, 90_000);

  // ...........................................................................
  it('a pattern removed again takes the network\'s version first', async () => {
    mesh = await buildFsMesh({
      root: root('uncover'),
      names: ['A', 'B'],
      ignore: { B: ['*.bak'] },
    });
    const [A, B] = ['A', 'B'].map((n) => (mesh as FsMesh).node(n));

    await A.write('a.txt', 'a');
    await A.write('x.bak', 'network');
    await A.write('y.bak', 'only on A');
    // B's own, never synced.
    await B.write('x.bak', 'mine');
    expect(await B.settlesOn(['a.txt', 'x.bak'])).toEqual(['a.txt', 'x.bak']);
    expect(await B.read('x.bak')).toBe('mine');

    B.down();
    await B.up({ ignore: [] });

    // What B never received arrives; B's own version is kept beside the
    // network's, and goes out as a copy.
    await until('the network\'s versions on B', async () =>
      (await B.read('y.bak')) === 'only on A' && (await B.read('x.bak')) === 'network');
    const copy = (await B.files()).find((f) => f.startsWith('x (conflicted copy'));
    expect(copy, `B holds ${(await B.files()).join(', ')}`).toBeDefined();
    expect(await B.read(copy as string)).toBe('mine');
    await until('the copy on A', async () => (await A.files()).includes(copy as string));

    // A lost nothing.
    expect(await A.read('x.bak')).toBe('network');
    expect(await A.read('y.bak')).toBe('only on A');

    // Said, as a join says it.
    const said = mesh.signals.find(
      (s) => s.node === 'B' && s.signal.kind === 'join/conflicted',
    );
    expect(said?.signal.paths).toEqual(['x.bak']);
    expect(said?.signal.detail).toContain('left out of the sync');

    // And from then on B syncs them like everything else.
    await B.write('y.bak', 'edited on B');
    await until('B\'s edit on A', async () => (await A.read('y.bak')) === 'edited on B');
  }, 90_000);

  // ...........................................................................
  it('a pattern removed while offline deletes nothing it could not fetch', async () => {
    mesh = await buildFsMesh({
      root: root('offline'),
      names: ['A', 'B'],
      ignore: { B: ['*.bak'] },
    });
    const [A, B] = ['A', 'B'].map((n) => (mesh as FsMesh).node(n));

    await A.write('a.txt', 'a');
    await A.write('y.bak', 'y');
    expect(await B.settlesOn(['a.txt'])).toEqual(['a.txt']);

    // Restarted without the pattern, and nothing to fetch `y.bak` from.
    B.down();
    B.cut();
    await B.up({ ignore: [] });
    await B.write('a.txt', 'edited offline');
    await sleep(1_500);
    expect(await B.files()).toEqual(['a.txt']);

    B.heal();
    await until('B\'s edit on A', async () => (await A.read('a.txt')) === 'edited offline');
    await until('y.bak on B', async () => (await B.read('y.bak')) === 'y');
    expect(await A.read('y.bak')).toBe('y');
  }, 90_000);

  // ...........................................................................
  it('a merge carries what the merging node ignores', async () => {
    mesh = await buildFsMesh({
      root: root('merge'),
      names: ['A', 'B'],
      ignore: { A: ['*.bak'] },
    });
    const [A, B] = ['A', 'B'].map((n) => (mesh as FsMesh).node(n));

    await B.write('a.txt', 'a');
    await B.write('x.bak', 'v1');
    expect(await A.settlesOn(['a.txt'])).toEqual(['a.txt']);

    // Both work while apart: a fork, and a merge when they meet.
    A.cut();
    await A.write('a.txt', 'from A');
    await B.write('x.bak', 'v2');
    await sleep(1_000);
    A.heal();

    await until('A\'s edit on B', async () => (await B.read('a.txt')) === 'from A');
    await sleep(1_500);
    expect(await B.read('x.bak')).toBe('v2');
    expect(await A.files()).toEqual(['a.txt']);
    // One state, one name: the merge A made is the merge B made.
    await until('one head', async () => A.agent.ownHead === B.agent.ownHead);
  }, 90_000);
});
