// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A path changing WHAT IT IS, not just what it contains.
//
// Both mature comparable projects carry a dedicated suite for this and this one
// had nothing. Syncthing's `filetype_test.go` exercises exactly three
// transitions — file → directory, empty directory → file, directory WITH
// CONTENTS → file — and Unison's test suite lists "file replacement:
// file-to-file and file-to-directory" and "directory replacement:
// directory-to-file" as separate cases. They are separate because the code
// paths are: one has to delete a file to make room for a directory, the other
// has to remove a whole subtree to make room for a file.
//
// It is not an exotic shape. A user replaces `Reports` (a stray file) with the
// folder it should have been; an export writes a single `.PRJ` where a `.PRJZ`
// directory used to be unpacked. And the register's own D5 note applies: to
// this system such a change is "delete everything and re-add", which is the
// same sentence that explains why renaming a folder hit the mass-delete guard.
//
// SYMLINKS are here too, because `followSymlinks` defaults to false and
// nothing asserted what that actually means. "Not followed" has at least three
// plausible readings — skipped, stored as a link, stored as its target — and a
// dangling link has a fourth.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { existsSync, statSync } from 'fs';
import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';

describe('a path changes what it is', () => {
  let base = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    base = join(process.cwd(), `test-temp-filetype-${++nth}`);
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(base, 'a'), { recursive: true });
    await mkdir(join(base, 'b'), { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });

  /** A pair of agents over `a` and `b`, sharing one blob store. */
  const pair = () => {
    const bs = new BsMem();
    const a = new FsAgent(join(base, 'a'), bs);
    const b = new FsAgent(join(base, 'b'), bs);
    agents.push(a, b);
    return { a, b, bs };
  };

  /** Applies A's current state onto B. */
  const sync = async (a: FsAgent, b: FsAgent): Promise<unknown> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tree = await a.extract();
    const outcome = await b
      .restore(tree, join(base, 'b'), { cleanTarget: true })
      .then(() => undefined)
      .catch((e: unknown) => e);
    // B scans, as a live agent does after applying.
    await b.extract();
    warn.mockRestore();
    err.mockRestore();
    return outcome;
  };

  const bPath = (p: string) => join(base, 'b', p);
  const aPath = (p: string) => join(base, 'a', p);

  // ...........................................................................
  it('file → directory', async () => {
    const { a, b } = pair();
    await writeFile(aPath('thing'), 'was a file');
    expect(await sync(a, b)).toBeUndefined();
    expect(statSync(bPath('thing')).isFile()).toBe(true);

    await rm(aPath('thing'));
    await mkdir(aPath('thing'), { recursive: true });
    await writeFile(aPath('thing/inside.txt'), 'now a folder');
    expect(await sync(a, b)).toBeUndefined();

    expect(
      statSync(bPath('thing')).isDirectory(),
      'the peer kept a FILE where the tree says there is a directory',
    ).toBe(true);
    expect(existsSync(bPath('thing/inside.txt'))).toBe(true);
  }, 60_000);

  // ...........................................................................
  it('empty directory → file', async () => {
    const { a, b } = pair();
    await mkdir(aPath('thing'), { recursive: true });
    expect(await sync(a, b)).toBeUndefined();
    expect(statSync(bPath('thing')).isDirectory()).toBe(true);

    await rm(aPath('thing'), { recursive: true });
    await writeFile(aPath('thing'), 'now a file');
    expect(await sync(a, b)).toBeUndefined();

    expect(
      statSync(bPath('thing')).isFile(),
      'the peer kept a DIRECTORY where the tree says there is a file',
    ).toBe(true);
  }, 60_000);

  // ...........................................................................
  it('directory WITH CONTENTS → file', async () => {
    // Syncthing keeps this apart from the empty case, and so should we: the
    // receiver has to remove a subtree, not an empty entry, and that is the
    // path that runs into a delete guard.
    const { a, b } = pair();
    await mkdir(aPath('thing/nested'), { recursive: true });
    await writeFile(aPath('thing/one.txt'), '1');
    await writeFile(aPath('thing/nested/two.txt'), '2');
    expect(await sync(a, b)).toBeUndefined();
    expect(existsSync(bPath('thing/nested/two.txt'))).toBe(true);

    await rm(aPath('thing'), { recursive: true });
    await writeFile(aPath('thing'), 'collapsed into a file');
    expect(await sync(a, b)).toBeUndefined();

    expect(
      statSync(bPath('thing')).isFile(),
      'the peer kept the subtree where the tree says there is a file',
    ).toBe(true);
    expect(existsSync(bPath('thing/nested'))).toBe(false);
  }, 60_000);

  // ...........................................................................
  it('says the same thing about a symlink on both machines', async () => {
    // `followSymlinks` is false by default and nothing asserted what that
    // means. Whatever the answer is, the two sides must agree — a link that
    // one node stores and the other ignores is a permanent divergence that no
    // repair can close, because each is right about its own folder.
    const { a, b } = pair();
    await writeFile(aPath('real.txt'), 'real');
    await symlink(aPath('real.txt'), aPath('link.txt'));

    expect(await sync(a, b)).toBeUndefined();

    const inA = [...(await a.extract()).trees.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => !!p && p !== '.')
      .sort();
    const inB = [...(await b.extract()).trees.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => !!p && p !== '.')
      .sort();

    expect(
      inB,
      `the two folders disagree about a symlink: A=${JSON.stringify(inA)} ` +
        `B=${JSON.stringify(inB)}`,
    ).toEqual(inA);
  }, 60_000);

  // ...........................................................................
  it('a dangling symlink does not stop the rest of the folder', async () => {
    // Unison keeps "broken links" as its own case. A link to nothing fails
    // every stat, and the question is whether it costs the files beside it —
    // the same question as a locked file and an impossible name, and the same
    // answer is required.
    const { a, b } = pair();
    await writeFile(aPath('keeper.txt'), 'keeper');
    await symlink(aPath('does-not-exist.txt'), aPath('dangling.txt'));

    await sync(a, b);

    expect(
      existsSync(bPath('keeper.txt')),
      'a dangling symlink cost the file next to it',
    ).toBe(true);
  }, 60_000);

  // ...........................................................................
  it('a symlink pointing OUT of the folder cannot export its target', async () => {
    // A link is a path the sender controls. If it is followed, a link to `/etc`
    // puts somebody else's files into a shared folder — the mirror image of
    // the inbound traversal guard, and the reason `followSymlinks` defaults
    // off.
    const { a, b } = pair();
    const secret = join(base, 'outside-secret.txt');
    await writeFile(secret, 'NOT FOR SYNC');
    await writeFile(aPath('keeper.txt'), 'keeper');
    await symlink(secret, aPath('escape.txt'));

    await sync(a, b);

    if (existsSync(bPath('escape.txt'))) {
      const { readFile } = await import('fs/promises');
      expect(
        await readFile(bPath('escape.txt'), 'utf-8'),
        'a symlink exported a file from OUTSIDE the sync folder',
      ).not.toBe('NOT FOR SYNC');
    }
    expect(existsSync(bPath('keeper.txt'))).toBe(true);
  }, 60_000);
});
