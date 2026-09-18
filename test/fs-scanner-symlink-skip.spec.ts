// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';

// Creating a real symlink to exercise the followSymlinks=false skip branch
// requires Developer Mode or an elevated process on Windows — a privilege a
// CI runner or a plain dev machine may not have (test/fs-scanner.spec.ts's
// real-symlink test silently no-ops there). This fakes a symlink Dirent
// instead, so FsScanner._scanDirectory's skip is covered on every platform.
// Lives apart from fs-scanner.spec.ts because vi.mock is hoisted per file and
// that suite must keep talking to the real disk.
const testDir = join(process.cwd(), 'test-temp-fs-scanner-symlink-skip');

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const fakeSymlink = {
    name: 'fake-symlink.txt',
    isSymbolicLink: () => true,
    isDirectory: () => false,
    isFile: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
  return {
    ...actual,
    readdir: (async (...args: never[]) => {
      const entries = await (
        actual.readdir as (...a: never[]) => Promise<unknown>
      )(...args);
      if (String(args[0]) === testDir && Array.isArray(entries)) {
        return [...entries, fakeSymlink];
      }
      return entries;
    }) as typeof actual.readdir,
  };
});

const { FsScanner } = await import('../src/fs-scanner.ts');

/** Relative paths present in a scanned tree. */
const pathsIn = (tree: { trees: Map<string, { meta: unknown }> }): string[] =>
  Array.from(tree.trees.values())
    .map((t) => (t.meta as { relativePath?: string } | null)?.relativePath)
    .filter((p): p is string => Boolean(p));

describe('FsScanner — a symlink entry without followSymlinks', () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('skips a symlink entry when followSymlinks is false', async () => {
    const tree = await new FsScanner(testDir, {
      bs: new BsMem(),
      followSymlinks: false,
    }).scan();

    expect(pathsIn(tree)).not.toContain('fake-symlink.txt');
  });
});
