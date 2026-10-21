// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A node carries what it does not see — `fs-carry.ts`.
//
// The one property everything else rests on: a tree with the carried nodes
// grafted in is the tree the scanner builds for a folder that holds them. Not
// the same content in another shape — the same ref, node for node. A graft
// that differed by one byte would give two nodes with the same files two
// refs, and a ref is how the fleet tells a state it already has from a new
// one.
// .............................................................................

import { mkdir, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { carriedNodes, fileNode, graftTree } from '../src/fs-carry.ts';
import { FsScanner, type FsNodeMeta, type FsTree } from '../src/fs-scanner.ts';

const testDir = join(process.cwd(), 'test-temp-fs-carry');

/**
 * Writes files below the test folder.
 * @param files - Relative path → content; a path ending in `/` is an empty
 *   directory.
 */
const put = async (files: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const full = join(testDir, ...path.split('/'));
    if (path.endsWith('/')) {
      await mkdir(full, { recursive: true });
    } else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  }
};

/**
 * Scans the test folder.
 * @param ignore - The ignore list.
 * @returns The tree, and the scanner's rule.
 */
const scan = async (
  ignore: string[],
): Promise<{ tree: FsTree; scanner: FsScanner }> => {
  const scanner = new FsScanner(testDir, { ignore });
  return { tree: await scanner.scan(), scanner };
};

/**
 * Every path a tree holds, sorted.
 * @param tree - The tree.
 * @returns Its paths.
 */
const pathsIn = (tree: FsTree): string[] =>
  [...tree.trees.values()]
    .map((node) => (node.meta as unknown as FsNodeMeta).relativePath)
    .sort();

describe('fs-carry', () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ...........................................................................
  describe('graftTree', () => {
    it('gives the folder the ref a scan that saw everything gives it', async () => {
      await put({
        'a.txt': 'a',
        'docs/b.txt': 'b',
        'docs/old.bak': 'old',
        'build/out.js': 'out',
        'build/sub/x.js': 'x',
        'only-ignored/c.bak': 'c',
        'empty/': '',
      });
      const all = await scan([]);
      const some = await scan(['*.bak', 'build/']);
      expect(some.tree.rootHash).not.toBe(all.tree.rootHash);

      const carried = carriedNodes(all.tree, (path, isDirectory) =>
        some.scanner.ignores(path, isDirectory),
      );
      expect([...carried.keys()].sort()).toEqual([
        'build',
        'build/out.js',
        'build/sub',
        'build/sub/x.js',
        'docs/old.bak',
        'only-ignored/c.bak',
      ]);

      const grafted = graftTree(some.tree, carried);
      expect(grafted.tree.rootHash).toBe(all.tree.rootHash);
      expect([...grafted.tree.trees.keys()].sort()).toEqual(
        [...all.tree.trees.keys()].sort(),
      );
      expect([...grafted.carried.keys()].sort()).toEqual(
        [...carried.keys()].sort(),
      );
    });

    it('returns the scan itself when nothing is carried', async () => {
      await put({ 'a.txt': 'a' });
      const { tree } = await scan([]);
      const grafted = graftTree(tree, new Map());
      expect(grafted.tree).toBe(tree);
      expect(grafted.carried.size).toBe(0);
    });

    it("keeps the folder's own entry where it holds a carried path itself", async () => {
      await put({ 'a.txt': 'a', 'b.txt': 'version one' });
      const before = await scan([]);
      const carried = carriedNodes(before.tree, (path) => path === 'b.txt');

      await put({ 'b.txt': 'version two' });
      const now = await scan([]);
      const grafted = graftTree(now.tree, carried);
      expect(grafted.tree).toBe(now.tree);
    });

    it('carries nothing below a path the folder holds as a file', async () => {
      await put({ 'a.txt': 'a', 'build/out.js': 'out' });
      const before = await scan([]);
      const carried = carriedNodes(before.tree, (path) =>
        path.startsWith('build'),
      );
      expect([...carried.keys()].sort()).toEqual(['build', 'build/out.js']);

      // `build` is a file now. A tree cannot hold both.
      await rm(join(testDir, 'build'), { recursive: true });
      await put({ build: 'a file' });
      const now = await scan([]);
      const grafted = graftTree(now.tree, carried);
      expect(grafted.tree).toBe(now.tree);
      expect(pathsIn(grafted.tree)).toContain('build');
    });

    it('puts back a directory the folder lost around a carried file', async () => {
      await put({ 'a.txt': 'a', 'docs/b.txt': 'b', 'docs/old.bak': 'old' });
      const before = await scan([]);
      const carried = carriedNodes(before.tree, (path) =>
        path.endsWith('.bak'),
      );

      // This node deleted `docs` — everything in it it could see.
      await rm(join(testDir, 'docs'), { recursive: true });
      const now = await scan(['*.bak']);
      expect(pathsIn(now.tree)).toEqual(['.', 'a.txt']);

      const grafted = graftTree(now.tree, carried);
      expect(pathsIn(grafted.tree)).toEqual(['.', 'a.txt', 'docs', 'docs/old.bak']);

      // The same tree the scanner builds for a folder holding exactly that.
      await put({ 'docs/old.bak': 'old' });
      const expected = await scan([]);
      expect(grafted.tree.rootHash).toBe(expected.tree.rootHash);
    });

    it('holds a carried empty directory as the scanner does', async () => {
      await put({ 'a.txt': 'a', 'cache/': '' });
      const all = await scan([]);
      const some = await scan(['cache']);
      const grafted = graftTree(
        some.tree,
        carriedNodes(all.tree, (path, isDirectory) =>
          some.scanner.ignores(path, isDirectory),
        ),
      );
      expect(grafted.tree.rootHash).toBe(all.tree.rootHash);
    });
  });

  // ...........................................................................
  describe('carriedNodes', () => {
    it('takes an ignored directory whole, and a rescue below it too', async () => {
      // The scan never descends into `build`, so `build/keep.txt` is not seen
      // either — whatever the `!` line says. What is carried is what is not
      // seen.
      await put({ 'a.txt': 'a', 'build/keep.txt': 'k', 'build/out.js': 'o' });
      const all = await scan([]);
      const some = await scan(['build/', '!build/keep.txt']);
      const carried = carriedNodes(all.tree, (path, isDirectory) =>
        some.scanner.ignores(path, isDirectory),
      );
      expect([...carried.keys()].sort()).toEqual([
        'build',
        'build/keep.txt',
        'build/out.js',
      ]);
      expect(
        graftTree(some.tree, carried).tree.rootHash,
      ).toBe(all.tree.rootHash);
    });

    it('takes nothing from a tree whose nodes it cannot read', () => {
      const carried = carriedNodes(
        {
          rootHash: 'root',
          trees: new Map([
            [
              'root',
              {
                isParent: true,
                meta: { name: '.', type: 'directory', relativePath: '.' },
                children: ['gone'],
              },
            ],
          ]),
        },
        () => true,
      );
      expect(carried.size).toBe(0);
    });

    it('skips a child it cannot read below an ignored directory', async () => {
      await put({ 'build/out.js': 'o' });
      const { tree } = await scan([]);
      const build = [...tree.trees.values()].find(
        (node) => (node.meta as unknown as FsNodeMeta).relativePath === 'build',
      );
      const partial: FsTree = {
        rootHash: tree.rootHash,
        trees: new Map(
          [...tree.trees].filter(
            ([, node]) =>
              (node.meta as unknown as FsNodeMeta).relativePath !==
              'build/out.js',
          ),
        ),
      };
      const carried = carriedNodes(partial, (path) => path === 'build');
      expect([...carried.values()]).toEqual([build]);
    });
  });

  // ...........................................................................
  describe('fileNode', () => {
    it('is the node the scanner builds for that file', async () => {
      await put({ 'docs/report (conflicted copy).txt': 'some bytes' });
      const { tree } = await scan([]);
      const scanned = [...tree.trees.values()].find(
        (node) => (node.meta as unknown as FsNodeMeta).type === 'file',
      );
      const meta = scanned?.meta as unknown as FsNodeMeta;
      expect(
        fileNode(meta.relativePath, meta.blobId as string, meta.size as number)
          ._hash,
      ).toBe(scanned?._hash);
    });
  });
});
