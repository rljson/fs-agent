// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';

// A scan walks a folder that is still being written to. `readdir` returns a
// name and the entry can be gone before the scan reaches it — a
// save-and-rename editor, a build tool, a peer applying a deletion. One such
// child used to abort the ENTIRE scan, and the watcher depends on the scan, so
// a folder under churn could stop syncing altogether.
//
// Two of the three race windows (`readFile`, and the `readdir` of a recursive
// descent) cannot be produced with a real filesystem deterministically, so
// this file mocks `fs/promises` behind a switch that is off by default. It
// lives apart from `fs-scanner.spec.ts` because `vi.mock` is hoisted per file
// and that suite must keep talking to the real disk.
const failures: Array<{
  op: 'stat' | 'readFile' | 'readdir';
  match: RegExp;
  code: string;
}> = [];

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const wrap =
    (op: 'stat' | 'readFile' | 'readdir', real: (...a: never[]) => unknown) =>
    (...args: never[]) => {
      const target = String(args[0]);
      const hit = failures.find((f) => f.op === op && f.match.test(target));
      if (hit) {
        const err = new Error(`${hit.code}: mocked`) as NodeJS.ErrnoException;
        err.code = hit.code;
        return Promise.reject(err);
      }
      return real(...args);
    };
  return {
    ...actual,
    stat: wrap('stat', actual.stat as never),
    readFile: wrap('readFile', actual.readFile as never),
    readdir: wrap('readdir', actual.readdir as never),
  };
});

const { FsScanner } = await import('../src/fs-scanner.ts');

/** Relative paths present in a scanned tree. */
const pathsIn = (tree: { trees: Map<string, { meta: unknown }> }): string[] =>
  Array.from(tree.trees.values())
    .map((t) => (t.meta as { relativePath?: string } | null)?.relativePath)
    .filter((p): p is string => Boolean(p));

describe('FsScanner — an entry that vanishes mid-scan', () => {
  const testDir = join(process.cwd(), 'test-temp-fs-scanner-vanish');
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    failures.length = 0;
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    failures.length = 0;
    warnSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  const warned = (needle: string): boolean =>
    warnSpy.mock.calls.some((c) => String(c[0]).includes(needle));

  it('skips a file that disappears between readdir and stat', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await writeFile(join(testDir, 'vanishes.txt'), 'gone');
    failures.push({ op: 'stat', match: /vanishes\.txt$/, code: 'ENOENT' });

    const tree = await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(pathsIn(tree)).toContain('stays.txt');
    expect(pathsIn(tree)).not.toContain('vanishes.txt');
    // One summary line per scan, not one per entry — under real churn a
    // message per file would bury everything else.
    expect(warned('1 entry vanished')).toBe(true);
  });

  it('skips a file deleted between stat and read', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await writeFile(join(testDir, 'racy.txt'), 'racy');
    failures.push({ op: 'readFile', match: /racy\.txt$/, code: 'ENOENT' });

    const tree = await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(pathsIn(tree)).toContain('stays.txt');
    expect(pathsIn(tree)).not.toContain('racy.txt');
  });

  it('skips a directory removed before it is descended into', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await mkdir(join(testDir, 'doomed'), { recursive: true });
    await writeFile(join(testDir, 'doomed', 'inner.txt'), 'inner');
    failures.push({ op: 'readdir', match: /doomed$/, code: 'ENOENT' });

    const tree = await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(pathsIn(tree)).toContain('stays.txt');
    expect(pathsIn(tree)).not.toContain('doomed');
  });

  it('skips an entry whose parent turned out not to be a directory (ENOTDIR)', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await mkdir(join(testDir, 'swapped'), { recursive: true });
    failures.push({ op: 'readdir', match: /swapped$/, code: 'ENOTDIR' });

    const tree = await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(pathsIn(tree)).toContain('stays.txt');
    expect(pathsIn(tree)).not.toContain('swapped');
  });

  it('counts several vanished entries in one summary', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await writeFile(join(testDir, 'gone-a.txt'), 'a');
    await writeFile(join(testDir, 'gone-b.txt'), 'b');
    failures.push({ op: 'stat', match: /gone-[ab]\.txt$/, code: 'ENOENT' });

    await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(warned('2 entries vanished')).toBe(true);
  });

  it('says nothing when nothing vanished', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');

    await new FsScanner(testDir, { bs: new BsMem() }).scan();

    expect(warned('vanished during the scan')).toBe(false);
  });

  // The counterpart that matters just as much. Tolerance is for "it is not
  // there any more", NOT for a permission problem or a failing disk. Those
  // must still stop the scan loudly — a tree that is quietly missing files is
  // a tree a peer will faithfully apply as a set of deletions.
  it('still fails the scan on a non-ENOENT error', async () => {
    await writeFile(join(testDir, 'locked.txt'), 'locked');
    failures.push({ op: 'stat', match: /locked\.txt$/, code: 'EACCES' });

    await expect(
      new FsScanner(testDir, { bs: new BsMem() }).scan(),
    ).rejects.toThrow(/EACCES/);
  });

  it('still fails the scan when a read fails for a non-ENOENT reason', async () => {
    await writeFile(join(testDir, 'unreadable.txt'), 'x');
    failures.push({ op: 'readFile', match: /unreadable\.txt$/, code: 'EIO' });

    await expect(
      new FsScanner(testDir, { bs: new BsMem() }).scan(),
    ).rejects.toThrow(/unreadable\.txt/);
  });

  // The real-filesystem case, no mock involved: a symlink whose target is gone
  // is indistinguishable from an entry deleted mid-scan, and `followSymlinks`
  // walks straight into it.
  it('skips a dangling symlink when following symlinks', async () => {
    await writeFile(join(testDir, 'stays.txt'), 'stays');
    await symlink(join(testDir, 'no-such-target.txt'), join(testDir, 'dangling.txt'));

    const tree = await new FsScanner(testDir, {
      bs: new BsMem(),
      followSymlinks: true,
    }).scan();

    expect(pathsIn(tree)).toContain('stays.txt');
    expect(pathsIn(tree)).not.toContain('dangling.txt');
  });
});
