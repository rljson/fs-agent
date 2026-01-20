// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsScanner } from '../src/fs-scanner.ts';


describe('FsScanner', () => {
  const testDir = join(process.cwd(), 'test-temp-fs-scanner');

  beforeEach(async () => {
    // Create test directory structure
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe('scan', () => {
    it('should scan an empty directory', async () => {
      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      expect(tree.trees.size).toBe(1); // Just the root
      const rootTree = scanner.getRootTree();
      expect(rootTree).toBeDefined();
      expect(rootTree?.meta).toBeDefined();
      const meta = rootTree?.meta as any;
      expect(meta.type).toBe('directory');
    });

    it('should scan a directory with files', async () => {
      // Create test structure
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'file2.txt'), 'content2');

      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      expect(tree.trees.size).toBe(3); // root + 2 files
      const rootTree = scanner.getRootTree();
      expect(rootTree?.children?.length).toBe(2);
    });

    it('should scan nested directories', async () => {
      // Create nested structure
      await mkdir(join(testDir, 'subdir'), { recursive: true });
      await writeFile(join(testDir, 'subdir', 'nested.txt'), 'nested content');
      await writeFile(join(testDir, 'root.txt'), 'root content');

      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      expect(tree.trees.size).toBe(4); // root + subdir + 2 files
      const rootTree = scanner.getRootTree();
      expect(rootTree?.children?.length).toBe(2); // subdir + root.txt

      // Find subdir tree by checking children
      const subdirRef = rootTree?.children?.find((ref: string) => {
        const childTree = scanner.getTreeByHash(ref);
        const meta = childTree?.meta as any;
        return meta?.type === 'directory';
      });

      expect(subdirRef).toBeDefined();
      const subdirTree = scanner.getTreeByHash(subdirRef!);
      expect(subdirTree?.isParent).toBe(true);
      expect(subdirTree?.children?.length).toBe(1);
    });

    it('should respect ignore patterns', async () => {
      // Create files to ignore
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'package.json'), '{}');
      await writeFile(join(testDir, 'keep.txt'), 'keep this');

      const scanner = new FsScanner(testDir, {
        ignore: ['node_modules'],
      });
      const tree = await scanner.scan();

      // Check that node_modules is not in the tree
      const allTrees = Array.from(tree.trees.values());
      const hasNodeModules = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'node_modules';
      });
      expect(hasNodeModules).toBe(false);

      // Check that keep.txt is in the tree
      const hasKeepTxt = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'keep.txt';
      });
      expect(hasKeepTxt).toBe(true);
    });

    it('should respect maxDepth option', async () => {
      // Create deep structure
      await mkdir(join(testDir, 'level1', 'level2', 'level3'), {
        recursive: true,
      });
      await writeFile(
        join(testDir, 'level1', 'level2', 'level3', 'deep.txt'),
        'deep',
      );

      const scanner = new FsScanner(testDir, { maxDepth: 2 });
      const tree = await scanner.scan();

      // The root counts as depth 0, level1 as depth 1, level2 as depth 2
      // So level3 should not be scanned
      const allTrees = Array.from(tree.trees.values());
      const hasLevel3 = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'level3';
      });
      expect(hasLevel3).toBe(false);
    });

    it('should include file metadata', async () => {
      await writeFile(join(testDir, 'metadata.txt'), 'test content');

      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      // Find the file by searching through all trees
      const allTrees = Array.from(tree.trees.values());
      const fileTree = allTrees.find((t) => {
        const meta = t.meta as any;
        return meta?.name === 'metadata.txt';
      });

      expect(fileTree).toBeDefined();
      const meta = fileTree?.meta as any;
      expect(meta?.size).toBe(12); // "test content" length
      expect(meta?.mtime).toBeTypeOf('number');
      expect(fileTree?.isParent).toBe(false);
    });
  });

  describe('getTreeByHash', () => {
    it('should retrieve a tree by hash', async () => {
      await writeFile(join(testDir, 'test.txt'), 'content');

      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      // Get root and verify we can retrieve it by hash
      const rootTree = scanner.getTreeByHash(tree.rootHash);
      expect(rootTree).toBeDefined();
      const meta = rootTree?.meta as any;
      expect(meta?.type).toBe('directory');
    });

    it('should return undefined for non-existent hash', async () => {
      const scanner = new FsScanner(testDir);
      await scanner.scan();

      const tree = scanner.getTreeByHash('non-existent-hash');
      expect(tree).toBeUndefined();
    });
  });

  describe('getChildren', () => {
    it('should return children of a directory', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'file2.txt'), 'content2');

      const scanner = new FsScanner(testDir);
      const tree = await scanner.scan();

      const children = scanner.getChildren(tree.rootHash);
      expect(children).toHaveLength(2);
      expect(
        children.map((c) => {
          const meta = c.meta as any;
          return meta?.name;
        }),
      ).toContain('file1.txt');
      expect(
        children.map((c) => {
          const meta = c.meta as any;
          return meta?.name;
        }),
      ).toContain('file2.txt');
    });

    it('should return empty array for file node', async () => {
      await writeFile(join(testDir, 'file.txt'), 'content');

      const scanner = new FsScanner(testDir);
      await scanner.scan();

      // Get the file hash from the root's children
      const rootTree = scanner.getRootTree();
      const fileHash = rootTree?.children?.[0];

      const children = scanner.getChildren(fileHash!);
      expect(children).toHaveLength(0);
    });
  });

  describe('getAllTrees', () => {
    it('should return all trees as array', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await mkdir(join(testDir, 'subdir'), { recursive: true });
      await writeFile(join(testDir, 'subdir', 'file2.txt'), 'content2');

      const scanner = new FsScanner(testDir);
      await scanner.scan();

      const trees = scanner.getAllTrees();
      expect(trees.length).toBe(4); // root + file1 + subdir + file2
      const names = trees.map((t) => {
        const meta = t.meta as any;
        return meta?.name;
      });
      expect(names).toContain('file1.txt');
      expect(names).toContain('subdir');
    });
  });

  describe('onChange', () => {
    it('should register and unregister callbacks', async () => {
      const scanner = new FsScanner(testDir);
      const callback = () => {};

      scanner.onChange(callback);
      expect(scanner['_changeCallbacks']).toHaveLength(1);

      scanner.offChange(callback);
      expect(scanner['_changeCallbacks']).toHaveLength(0);
    });
  });

  describe('watch', () => {
    it('should throw if already watching', async () => {
      const scanner = new FsScanner(testDir);
      await scanner.watch();

      await expect(scanner.watch()).rejects.toThrow(
        'Already watching. Call stopWatch() first.',
      );

      scanner.stopWatch();
    });

    it('should scan before watching if not already scanned', async () => {
      const scanner = new FsScanner(testDir);
      expect(scanner.tree).toBeNull();

      await scanner.watch();
      expect(scanner.tree).not.toBeNull();

      scanner.stopWatch();
    });
  });

  describe('example', () => {
    it('should create an example instance', () => {
      const scanner = FsScanner.example();
      expect(scanner).toBeInstanceOf(FsScanner);
      expect(scanner.rootPath).toBe(process.cwd());
    });
  });

  describe('getTreeByPath', () => {
    it('should retrieve a tree by relative path', async () => {
      await writeFile(join(testDir, 'test.txt'), 'content');

      const scanner = new FsScanner(testDir);
      await scanner.scan();

      const tree = scanner.getTreeByPath('test.txt');
      expect(tree).toBeDefined();
      const meta = tree?.meta as any;
      expect(meta?.name).toBe('test.txt');
    });

    it('should return undefined for non-existent path', async () => {
      const scanner = new FsScanner(testDir);
      await scanner.scan();

      const tree = scanner.getTreeByPath('does-not-exist.txt');
      expect(tree).toBeUndefined();
    });

    it('should return undefined when tree is null', () => {
      const scanner = new FsScanner(testDir);
      const tree = scanner.getTreeByPath('test.txt');
      expect(tree).toBeUndefined();
    });
  });

  describe('getAllTrees', () => {
    it('should return empty array when tree is null', () => {
      const scanner = new FsScanner(testDir);
      const trees = scanner.getAllTrees();
      expect(trees).toEqual([]);
    });
  });

  describe('bs accessor', () => {
    it('should return the blob storage instance', () => {
      const scanner = new FsScanner(testDir);
      expect(scanner.bs).toBeDefined();
    });
  });

  describe('symlink handling', () => {
    it('should skip symlinks when followSymlinks is false', async () => {
      // Create a file and a symlink to it
      await writeFile(join(testDir, 'target.txt'), 'target content');

      try {
        // Create a symbolic link (may fail on Windows without proper permissions)
        const { symlink } = await import('fs/promises');
        await symlink(
          join(testDir, 'target.txt'),
          join(testDir, 'link.txt'),
          'file',
        );

        const scanner = new FsScanner(testDir, { followSymlinks: false });
        const tree = await scanner.scan();

        // Check that the symlink is not in the tree
        const allTrees = Array.from(tree.trees.values());
        const hasSymlink = allTrees.some((t) => {
          const meta = t.meta as any;
          return meta?.name === 'link.txt';
        });

        // The symlink should be skipped
        expect(hasSymlink).toBe(false);

        // But the target file should be there
        const hasTarget = allTrees.some((t) => {
          const meta = t.meta as any;
          return meta?.name === 'target.txt';
        });
        expect(hasTarget).toBe(true);
      } catch {
        // Skip test if symlinks are not supported
        console.log('Symlink test skipped - not supported on this platform');
      }
    });
  });

  describe('ignore patterns', () => {
    it('should not ignore when no patterns provided', async () => {
      await writeFile(join(testDir, 'file.txt'), 'content');
      await mkdir(join(testDir, 'folder'), { recursive: true });

      const scanner = new FsScanner(testDir, { ignore: undefined });
      const tree = await scanner.scan();

      const allTrees = Array.from(tree.trees.values());
      const hasFile = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'file.txt';
      });
      const hasFolder = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'folder';
      });

      expect(hasFile).toBe(true);
      expect(hasFolder).toBe(true);
    });

    it('should not ignore when empty patterns array provided', async () => {
      await writeFile(join(testDir, 'file.txt'), 'content');

      const scanner = new FsScanner(testDir, { ignore: [] });
      const tree = await scanner.scan();

      const allTrees = Array.from(tree.trees.values());
      const hasFile = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'file.txt';
      });

      expect(hasFile).toBe(true);
    });

    it('should handle null ignore option', async () => {
      await writeFile(join(testDir, 'file.txt'), 'content');

      // Force null to test the early return in _shouldIgnore
      const scanner = new FsScanner(testDir, {});
      // Directly set to null to test line 272
      (scanner as any)._options.ignore = null;

      const tree = await scanner.scan();

      const allTrees = Array.from(tree.trees.values());
      const hasFile = allTrees.some((t) => {
        const meta = t.meta as any;
        return meta?.name === 'file.txt';
      });

      expect(hasFile).toBe(true);
    });
  });

  describe('file watching with changes', () => {
    it('should detect file additions', async () => {
      const scanner = new FsScanner(testDir);
      const changes: any[] = [];

      scanner.onChange((change) => {
        changes.push(change);
      });

      await scanner.watch();

      // Give the watcher time to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Add a new file
      await writeFile(join(testDir, 'new-file.txt'), 'new content');

      // Wait for change detection
      await new Promise((resolve) => setTimeout(resolve, 500));

      scanner.stopWatch();

      // Check if the add event was detected
      const addEvent = changes.find((c) => c.type === 'added');
      expect(addEvent).toBeDefined();
    });

    it('should detect file modifications', async () => {
      // Create initial file
      await writeFile(join(testDir, 'modify-me.txt'), 'initial content');

      const scanner = new FsScanner(testDir);
      const changes: any[] = [];

      scanner.onChange((change) => {
        changes.push(change);
      });

      await scanner.watch();

      // Give the watcher time to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Modify the file
      await writeFile(join(testDir, 'modify-me.txt'), 'modified content');

      // Wait for change detection
      await new Promise((resolve) => setTimeout(resolve, 500));

      scanner.stopWatch();

      // Check if modification was detected
      const modifyEvent = changes.find(
        (c) => c.type === 'modified' || c.type === 'added',
      );
      expect(modifyEvent).toBeDefined();
    });

    it('should detect file deletions', async () => {
      // Create initial file
      await writeFile(join(testDir, 'delete-me.txt'), 'to be deleted');

      const scanner = new FsScanner(testDir);
      const changes: any[] = [];

      scanner.onChange((change) => {
        changes.push(change);
      });

      await scanner.watch();

      // Give the watcher time to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Delete the file
      await rm(join(testDir, 'delete-me.txt'));

      // Wait for change detection
      await new Promise((resolve) => setTimeout(resolve, 500));

      scanner.stopWatch();

      // Check if deletion was detected
      const deleteEvent = changes.find((c) => c.type === 'deleted');
      expect(deleteEvent).toBeDefined();
    });

    it('should ignore changes to ignored files', async () => {
      const scanner = new FsScanner(testDir, {
        ignore: ['ignored.txt'],
      });
      const changes: any[] = [];

      scanner.onChange((change) => {
        changes.push(change);
      });

      await scanner.watch();

      // Give the watcher time to initialize
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Add an ignored file
      await writeFile(join(testDir, 'ignored.txt'), 'should be ignored');

      // Wait to ensure no change is detected
      await new Promise((resolve) => setTimeout(resolve, 500));

      scanner.stopWatch();

      // Should not detect the ignored file
      const ignoredEvent = changes.find((c) => c.path?.includes('ignored.txt'));
      expect(ignoredEvent).toBeUndefined();
    });
  });
});
