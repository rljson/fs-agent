// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';

import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent';

describe('FsAgent', () => {
  const testDir = join(process.cwd(), 'test-temp-fs-agent');

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create instance with default BsMem', () => {
      const agent = new FsAgent(testDir);
      expect(agent).toBeDefined();
      expect(agent.rootPath).toBe(testDir);
      expect(agent.bs).toBeDefined();
    });

    it('should create instance with custom Bs', () => {
      const customBs = new BsMem();
      const agent = new FsAgent(testDir, customBs);
      expect(agent.bs).toBe(customBs);
    });

    it('should create instance with options', () => {
      const agent = new FsAgent(testDir, undefined, {
        ignore: ['node_modules'],
        maxDepth: 5,
      });
      expect(agent).toBeDefined();
    });
  });

  describe('extract', () => {
    it('should extract empty directory', async () => {
      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      expect(tree).toBeDefined();
      expect(tree.rootHash).toBeDefined();
      expect(typeof tree.rootHash).toBe('string');
      expect(tree.trees).toBeInstanceOf(Map);
    });

    it('should extract directory with files', async () => {
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'file2.txt'), 'content2');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      expect(tree).toBeDefined();
      expect(tree.rootHash).toBeDefined();
      expect(tree.trees).toBeInstanceOf(Map);
      expect(tree.trees.size).toBeGreaterThan(0);
    });

    it('should extract nested directories', async () => {
      await mkdir(join(testDir, 'subdir'), { recursive: true });
      await writeFile(join(testDir, 'root.txt'), 'root content');
      await writeFile(join(testDir, 'subdir', 'nested.txt'), 'nested content');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      expect(tree).toBeDefined();
      expect(tree.rootHash).toBeDefined();
    });

    it('should respect ignore patterns', async () => {
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(join(testDir, 'node_modules', 'package.json'), '{}');
      await writeFile(join(testDir, 'keep.txt'), 'keep');

      const agent = new FsAgent(testDir, undefined, {
        ignore: ['node_modules'],
      });
      const tree = await agent.extract();

      expect(tree).toBeDefined();
      expect(tree.rootHash).toBeDefined();
    });

    it('should store file content in blob storage', async () => {
      const content = 'test file content';
      await writeFile(join(testDir, 'test.txt'), content);

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Verify we can access the tree and file is referenced
      expect(tree).toBeDefined();
      expect(tree.rootHash).toBeDefined();

      // Find file node with blobId
      const allTrees = agent.scanner.getAllTrees();
      const fileNode = allTrees.find((t) => {
        const meta = t.meta as any;
        return meta?.type === 'file';
      });

      expect(fileNode).toBeDefined();
      const fileMeta = fileNode?.meta as any;
      expect(fileMeta.blobId).toBeDefined();

      // Verify content is in Bs
      const fileContent = await agent.getFileContent(fileMeta.blobId);
      expect(fileContent.toString()).toBe(content);

      // Verify hasBlob works
      const hasBlobResult = await agent.hasBlob(fileMeta.blobId);
      expect(hasBlobResult).toBe(true);

      // Verify hasBlob returns false for non-existent blob
      const hasNonExistent = await agent.hasBlob('nonexistent-blob-id');
      expect(hasNonExistent).toBe(false);
    });
  });

  describe('restore', () => {
    it('should restore files from tree structure', async () => {
      // Create original structure
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'file2.txt'), 'content2');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Clear directory
      await rm(testDir, { recursive: true, force: true });
      await mkdir(testDir, { recursive: true });

      // Restore
      await agent.restore(tree);

      // Verify files are restored
      const content1 = await readFile(join(testDir, 'file1.txt'), 'utf-8');
      const content2 = await readFile(join(testDir, 'file2.txt'), 'utf-8');
      expect(content1).toBe('content1');
      expect(content2).toBe('content2');
    });

    it('should restore to different target path', async () => {
      await writeFile(join(testDir, 'source.txt'), 'source content');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      const targetDir = join(testDir, 'target');
      await mkdir(targetDir, { recursive: true });

      await agent.restore(tree, targetDir);

      const content = await readFile(join(targetDir, 'source.txt'), 'utf-8');
      expect(content).toBe('source content');
    });

    it('should restore to same location without target path', async () => {
      await writeFile(join(testDir, 'test.txt'), 'test content');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Clear and restore to same location (no targetPath parameter)
      await rm(join(testDir, 'test.txt'), { force: true });

      await agent.restore(tree);

      const content = await readFile(join(testDir, 'test.txt'), 'utf-8');
      expect(content).toBe('test content');
    });

    it('should restore nested directory structure', async () => {
      await mkdir(join(testDir, 'dir1', 'dir2'), { recursive: true });
      await writeFile(join(testDir, 'dir1', 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'dir1', 'dir2', 'file2.txt'), 'content2');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Clear and restore
      await rm(testDir, { recursive: true, force: true });
      await mkdir(testDir, { recursive: true });

      await agent.restore(tree);

      const content1 = await readFile(
        join(testDir, 'dir1', 'file1.txt'),
        'utf-8',
      );
      const content2 = await readFile(
        join(testDir, 'dir1', 'dir2', 'file2.txt'),
        'utf-8',
      );
      expect(content1).toBe('content1');
      expect(content2).toBe('content2');
    });

    it('should preserve file metadata', async () => {
      await writeFile(join(testDir, 'test.txt'), 'test content');

      const agent = new FsAgent(testDir);

      // Get original mtime
      const originalStats = await stat(join(testDir, 'test.txt'));

      const tree = await agent.extract();

      // Restore to different location
      const targetDir = join(testDir, 'restored');
      await mkdir(targetDir, { recursive: true });
      await agent.restore(tree, targetDir);

      // Check metadata is preserved
      const restoredStats = await stat(join(targetDir, 'test.txt'));
      expect(restoredStats.mtime.getTime()).toBe(originalStats.mtime.getTime());
      expect(restoredStats.size).toBe(originalStats.size);
    });
  });

  describe('round-trip', () => {
    it('should preserve content through extract and restore', async () => {
      const files = {
        'file1.txt': 'content 1',
        'file2.js': 'console.log("test");',
        'data.json': '{"key": "value"}',
      };

      // Create files
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(testDir, name), content);
      }

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Clear directory
      await rm(testDir, { recursive: true, force: true });
      await mkdir(testDir, { recursive: true });

      // Restore
      await agent.restore(tree);

      // Verify all files match
      for (const [name, expectedContent] of Object.entries(files)) {
        const actualContent = await readFile(join(testDir, name), 'utf-8');
        expect(actualContent).toBe(expectedContent);
      }
    });

    it('should handle binary files', async () => {
      const binaryData = Buffer.from([0, 1, 2, 3, 4, 255, 254, 253]);
      await writeFile(join(testDir, 'binary.dat'), binaryData);

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      await rm(testDir, { recursive: true, force: true });
      await mkdir(testDir, { recursive: true });

      await agent.restore(tree);

      const restored = await readFile(join(testDir, 'binary.dat'));
      expect(Buffer.compare(restored, binaryData)).toBe(0);
    });
  });

  describe('getTree', () => {
    it('should return null before scanning', () => {
      const agent = new FsAgent(testDir);
      expect(agent.getTree()).toBeNull();
    });

    it('should return tree after extract', async () => {
      await writeFile(join(testDir, 'test.txt'), 'content');

      const agent = new FsAgent(testDir);
      await agent.extract();

      const tree = agent.getTree();
      expect(tree).not.toBeNull();
      expect(tree?.rootHash).toBeDefined();
    });
  });

  describe('accessors', () => {
    it('should provide access to scanner', () => {
      const agent = new FsAgent(testDir);
      expect(agent.scanner).toBeDefined();
      expect(agent.scanner.rootPath).toBe(testDir);
    });

    it('should provide access to adapter', () => {
      const agent = new FsAgent(testDir);
      expect(agent.adapter).toBeDefined();
    });
  });

  describe('example', () => {
    it('should create an example instance', () => {
      const agent = FsAgent.example;
      expect(agent).toBeDefined();
      expect(agent.rootPath).toBe(process.cwd());
    });
  });
});
