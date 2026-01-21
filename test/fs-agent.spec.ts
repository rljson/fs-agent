// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import {
  createTreesTableCfg,
  InsertHistoryRow,
  Route,
  TableCfg,
} from '@rljson/rljson';

import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('storeInDb', () => {
    it('should extract and store tree in database', async () => {
      // Setup test files
      await writeFile(join(testDir, 'test.txt'), 'test content');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Verify tree was stored
      expect(treeRootRef).toBeDefined();
      const route = `/${treeKey}@${treeRootRef}/root`;
      const { tree } = await db.get(Route.fromFlat(route), {});
      expect(tree).toBeDefined();
      expect(tree[treeKey]).toBeDefined();

      // Verify insert history was written
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable).toBeDefined();
      expect(historyTable._data.length).toBe(1);
      expect(historyTable._data[0][`${treeKey}Ref`]).toBe(treeRootRef);
    });
  });

  describe('loadFromDb', () => {
    it('should load tree from database and restore to filesystem', async () => {
      // Setup test files
      await writeFile(join(testDir, 'original.txt'), 'original content');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create a new empty target directory
      const targetDir = join(testDir, 'restored');
      await mkdir(targetDir, { recursive: true });

      // Load from database to new location
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify file was restored
      const restoredFile = join(targetDir, 'original.txt');
      const content = await readFile(restoredFile, 'utf-8');
      expect(content).toBe('original content');
    });

    it('should create complete file structure from root ref using DB trees and Bs blobs', async () => {
      // Setup complex structure with multiple files and directories
      await mkdir(join(testDir, 'docs'), { recursive: true });
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(join(testDir, 'README.md'), '# Project');
      await writeFile(join(testDir, 'docs', 'guide.md'), '## Guide');
      await writeFile(join(testDir, 'src', 'main.ts'), 'console.log("hello")');
      await writeFile(
        join(testDir, 'src', 'helper.ts'),
        'export const help = () => {}',
      );

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database - this stores TREE STRUCTURE in DB and BLOB CONTENT in Bs
      const agent = new FsAgent(testDir);
      const rootRef = await agent.storeInDb(db, treeKey);

      // Create completely empty target directory
      const targetDir = join(testDir, 'complete-restore');
      await mkdir(targetDir, { recursive: true });

      // Create NEW agent with SAME blob storage but different root path
      // This proves that loadFromDb reconstructs everything from:
      // 1. Tree structure from DB (using rootRef)
      // 2. File content from Bs (using blobIds in tree metadata)
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, rootRef);

      // VERIFY: Complete directory structure was created
      const docsStats = await stat(join(targetDir, 'docs'));
      expect(docsStats.isDirectory()).toBe(true);

      const srcStats = await stat(join(targetDir, 'src'));
      expect(srcStats.isDirectory()).toBe(true);

      // VERIFY: All files were created with correct content from blobs
      const readmeContent = await readFile(
        join(targetDir, 'README.md'),
        'utf-8',
      );
      expect(readmeContent).toBe('# Project');

      const guideContent = await readFile(
        join(targetDir, 'docs', 'guide.md'),
        'utf-8',
      );
      expect(guideContent).toBe('## Guide');

      const mainContent = await readFile(
        join(targetDir, 'src', 'main.ts'),
        'utf-8',
      );
      expect(mainContent).toBe('console.log("hello")');

      const helperContent = await readFile(
        join(targetDir, 'src', 'helper.ts'),
        'utf-8',
      );
      expect(helperContent).toBe('export const help = () => {}');

      // VERIFY: This proves that passing just a rootRef to loadFromDb:
      // - Retrieves the complete tree structure from the database
      // - Uses blobIds from tree metadata to fetch file contents from Bs
      // - Recreates the entire filesystem structure
    });

    it('should handle empty tree restoration', async () => {
      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store empty tree
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create target directory
      const targetDir = join(testDir, 'restored-empty');
      await mkdir(targetDir, { recursive: true });

      // Load from database
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify directory exists
      const stats = await stat(targetDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should restore nested directory structure', async () => {
      // Setup nested structure
      await mkdir(join(testDir, 'a', 'b', 'c'), { recursive: true });
      await writeFile(join(testDir, 'a', 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'a', 'b', 'file2.txt'), 'content2');
      await writeFile(join(testDir, 'a', 'b', 'c', 'file3.txt'), 'content3');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create target directory
      const targetDir = join(testDir, 'restored-nested');
      await mkdir(targetDir, { recursive: true });

      // Load from database
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify all files restored
      expect(await readFile(join(targetDir, 'a', 'file1.txt'), 'utf-8')).toBe(
        'content1',
      );
      expect(
        await readFile(join(targetDir, 'a', 'b', 'file2.txt'), 'utf-8'),
      ).toBe('content2');
      expect(
        await readFile(join(targetDir, 'a', 'b', 'c', 'file3.txt'), 'utf-8'),
      ).toBe('content3');
    });

    it('should restore binary files correctly', async () => {
      // Create binary file
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      await writeFile(join(testDir, 'binary.bin'), binaryData);

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create target directory
      const targetDir = join(testDir, 'restored-binary');
      await mkdir(targetDir, { recursive: true });

      // Load from database
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify binary content
      const restoredData = await readFile(join(targetDir, 'binary.bin'));
      expect(restoredData).toEqual(binaryData);
    });

    it('should handle multiple versions in database', async () => {
      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);

      // Store version 1
      await writeFile(join(testDir, 'file.txt'), 'version 1');
      const ref1 = await agent.storeInDb(db, treeKey);

      // Store version 2
      await writeFile(join(testDir, 'file.txt'), 'version 2');
      const ref2 = await agent.storeInDb(db, treeKey);

      // Restore version 1
      const targetDir1 = join(testDir, 'restored-v1');
      await mkdir(targetDir1, { recursive: true });
      const agent1 = new FsAgent(targetDir1, agent.bs);
      await agent1.loadFromDb(db, treeKey, ref1);

      // Restore version 2
      const targetDir2 = join(testDir, 'restored-v2');
      await mkdir(targetDir2, { recursive: true });
      const agent2 = new FsAgent(targetDir2, agent.bs);
      await agent2.loadFromDb(db, treeKey, ref2);

      // Verify both versions restored correctly
      expect(await readFile(join(targetDir1, 'file.txt'), 'utf-8')).toBe(
        'version 1',
      );
      expect(await readFile(join(targetDir2, 'file.txt'), 'utf-8')).toBe(
        'version 2',
      );
    });

    it('should throw error for non-existent tree reference', async () => {
      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);

      // Try to load non-existent reference
      await expect(
        agent.loadFromDb(db, treeKey, 'nonExistentRef123'),
      ).rejects.toThrow();
    });

    it('should preserve file timestamps during restore', async () => {
      // Create file with specific timestamp
      const testFile = join(testDir, 'timestamped.txt');
      await writeFile(testFile, 'content');
      const originalMtime = new Date('2025-01-15T12:00:00Z');
      const { utimes } = await import('fs/promises');
      await utimes(testFile, originalMtime, originalMtime);

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create target directory
      const targetDir = join(testDir, 'restored-time');
      await mkdir(targetDir, { recursive: true });

      // Load from database
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify timestamp preserved (within 1 second tolerance)
      const restoredStats = await stat(join(targetDir, 'timestamped.txt'));
      const timeDiff = Math.abs(
        restoredStats.mtime.getTime() - originalMtime.getTime(),
      );
      expect(timeDiff).toBeLessThan(1000);
    });
  });

  describe('syncToDb', () => {
    it('should watch filesystem and sync changes to database', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'watched.txt'), 'initial content');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Start syncing
      const agent = new FsAgent(testDir);
      const stopSync = await agent.syncToDb(db, treeKey);

      // Wait a bit for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Modify file
      await writeFile(join(testDir, 'watched.txt'), 'modified content');

      // Wait for change detection and sync
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Stop syncing
      stopSync();

      // Verify insert history shows multiple entries
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable).toBeDefined();
      // Should have at least 2 entries (initial + one change)
      expect(historyTable._data.length).toBeGreaterThanOrEqual(2);
    });

    it('should stop watching when cleanup function is called', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'watched2.txt'), 'initial');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Start syncing
      const agent = new FsAgent(testDir);
      const stopSync = await agent.syncToDb(db, treeKey);

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop watching
      stopSync();

      // Get initial history count
      const insertHistory1 = await db.getInsertHistory(treeKey);
      const initialCount =
        insertHistory1[`${treeKey}InsertHistory`]._data.length;

      // Modify file after stopping
      await writeFile(join(testDir, 'watched2.txt'), 'after stop');

      // Wait to ensure no sync happens
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify no new entries added
      const insertHistory2 = await db.getInsertHistory(treeKey);
      const finalCount = insertHistory2[`${treeKey}InsertHistory`]._data.length;
      expect(finalCount).toBe(initialCount);
    });

    it('should handle rapid consecutive changes', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'rapid.txt'), 'initial');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Start syncing
      const agent = new FsAgent(testDir);
      const stopSync = await agent.syncToDb(db, treeKey);

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Make multiple rapid changes
      await writeFile(join(testDir, 'rapid.txt'), 'change1');
      await writeFile(join(testDir, 'rapid.txt'), 'change2');
      await writeFile(join(testDir, 'rapid.txt'), 'change3');

      // Wait for syncs to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Stop syncing
      stopSync();

      // Verify changes were tracked
      const insertHistory = await db.getInsertHistory(treeKey);
      const historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable._data.length).toBeGreaterThanOrEqual(2);
    });

    it('should sync file modifications to database with notification', async () => {
      // Setup initial state with a file
      await writeFile(join(testDir, 'test.txt'), 'original');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store initial state WITHOUT notification
      const agent = new FsAgent(testDir);
      await agent.storeInDb(db, treeKey);

      // Get initial version count
      let insertHistory = await db.getInsertHistory(treeKey);
      let historyTable = insertHistory[`${treeKey}InsertHistory`];
      const initialCount = historyTable._data.length;

      // Modify the file
      await writeFile(join(testDir, 'test.txt'), 'modified content');

      // Extract to get the tree structure
      const tree = await agent.extract();
      const modifiedRef = tree.rootHash;

      // Register notification callback
      const syncCallback = vi.fn();
      const notifyRoute = Route.fromFlat(`/${treeKey}/${modifiedRef}`);
      db.notify.register(notifyRoute, syncCallback as any);

      // Store with notifications enabled
      await agent.storeInDb(db, treeKey, { notify: true });

      // Verify notification was triggered
      expect(syncCallback).toHaveBeenCalledTimes(1);

      // Verify the callback received correct InsertHistoryRow
      const receivedHistoryRow = syncCallback.mock
        .calls[0][0] as InsertHistoryRow<any>;
      expect(receivedHistoryRow[`${treeKey}Ref`]).toBe(modifiedRef);
      expect(receivedHistoryRow.route).toBe(`/${treeKey}/${modifiedRef}`);
      expect(receivedHistoryRow.timeId).toBeDefined();

      // Verify new version created (initial + modified = 2 total)
      insertHistory = await db.getInsertHistory(treeKey);
      historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable._data.length).toBe(initialCount + 1);

      // Verify the tree in the DB contains the modified file with correct blob
      const testFileTree = tree.trees.get(tree.rootHash);
      expect(testFileTree).toBeDefined();

      // The root is a directory, children array contains hashes
      // Find the test.txt file by looking up each child hash
      let testFileHash: string | undefined;
      for (const childHash of testFileTree?.children || []) {
        const childNode = tree.trees.get(childHash);
        if (childNode?.meta?.name === 'test.txt') {
          testFileHash = childHash;
          break;
        }
      }
      expect(testFileHash).toBeDefined();

      const testFileNode = tree.trees.get(testFileHash!);
      expect(testFileNode).toBeDefined();

      // The node structure uses meta.type, not direct type property
      expect(testFileNode?.meta?.type).toBe('file');
      expect(testFileNode?.meta?.blobId).toBeDefined();

      // Verify the blob content is correct
      const blobContent = await agent.bs.getBlob(
        testFileNode!.meta!.blobId as string,
      );
      expect(blobContent?.content.toString('utf-8')).toBe('modified content');

      // Clean up
      db.notify.unregister(notifyRoute, syncCallback as any);
    });

    it('should automatically sync when db and treeKey are provided in constructor', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'auto-sync.txt'), 'initial content');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create agent with db and treeKey - should automatically start syncing
      const agent = new FsAgent(testDir, undefined, { db, treeKey });

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify initial state was stored
      let insertHistory = await db.getInsertHistory(treeKey);
      let historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable._data.length).toBeGreaterThanOrEqual(1);
      const initialCount = historyTable._data.length;

      // Modify file
      await writeFile(join(testDir, 'auto-sync.txt'), 'modified content');

      // Wait for automatic sync
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify new version was automatically created
      insertHistory = await db.getInsertHistory(treeKey);
      historyTable = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable._data.length).toBeGreaterThan(initialCount);

      // Clean up
      agent.dispose();
    });

    it('should stop automatic syncing when dispose is called', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'dispose-test.txt'), 'initial');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create agent with automatic syncing
      const agent = new FsAgent(testDir, undefined, { db, treeKey });

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get initial history count
      const insertHistory1 = await db.getInsertHistory(treeKey);
      const initialCount =
        insertHistory1[`${treeKey}InsertHistory`]._data.length;

      // Stop automatic syncing
      agent.dispose();

      // Modify file after dispose
      await writeFile(join(testDir, 'dispose-test.txt'), 'after dispose');

      // Wait to ensure no sync happens
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify no new entries added
      const insertHistory2 = await db.getInsertHistory(treeKey);
      const finalCount = insertHistory2[`${treeKey}InsertHistory`]._data.length;
      expect(finalCount).toBe(initialCount);
    });

    it('should handle dispose being called when no sync is active', () => {
      // Create agent without db/treeKey
      const agent = new FsAgent(testDir);

      // Should not throw when dispose is called with no active sync
      expect(() => agent.dispose()).not.toThrow();
    });
  });

  describe('storeInDb', () => {
    it('should handle large files', async () => {
      // Create large file (1MB)
      const largeContent = Buffer.alloc(1024 * 1024, 'x');
      await writeFile(join(testDir, 'large.bin'), largeContent);

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      expect(treeRootRef).toBeDefined();

      // Verify can restore
      const targetDir = join(testDir, 'restored-large');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      const restoredContent = await readFile(join(targetDir, 'large.bin'));
      expect(restoredContent.length).toBe(largeContent.length);
    });

    it('should handle special characters in filenames', async () => {
      // Create files with special characters
      await writeFile(join(testDir, 'file with spaces.txt'), 'content1');
      await writeFile(join(testDir, 'file-with-dashes.txt'), 'content2');
      await writeFile(join(testDir, 'file_with_underscores.txt'), 'content3');
      await writeFile(join(testDir, 'file.multiple.dots.txt'), 'content4');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Restore and verify
      const targetDir = join(testDir, 'restored-special');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify all files restored
      expect(
        await readFile(join(targetDir, 'file with spaces.txt'), 'utf-8'),
      ).toBe('content1');
      expect(
        await readFile(join(targetDir, 'file-with-dashes.txt'), 'utf-8'),
      ).toBe('content2');
      expect(
        await readFile(join(targetDir, 'file_with_underscores.txt'), 'utf-8'),
      ).toBe('content3');
      expect(
        await readFile(join(targetDir, 'file.multiple.dots.txt'), 'utf-8'),
      ).toBe('content4');
    });

    it('should store and restore empty files', async () => {
      // Create empty file
      await writeFile(join(testDir, 'empty.txt'), '');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Restore and verify
      const targetDir = join(testDir, 'restored-empty-file');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify empty file exists
      const content = await readFile(join(targetDir, 'empty.txt'), 'utf-8');
      expect(content).toBe('');
    });

    it('should handle deeply nested directory structures', async () => {
      // Create deeply nested structure (10 levels)
      let currentPath = testDir;
      for (let i = 0; i < 10; i++) {
        currentPath = join(currentPath, `level${i}`);
        await mkdir(currentPath, { recursive: true });
      }
      await writeFile(join(currentPath, 'deep.txt'), 'deeply nested');

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Restore and verify
      const targetDir = join(testDir, 'restored-deep');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      // Verify deeply nested file
      let verifyPath = targetDir;
      for (let i = 0; i < 10; i++) {
        verifyPath = join(verifyPath, `level${i}`);
      }
      const content = await readFile(join(verifyPath, 'deep.txt'), 'utf-8');
      expect(content).toBe('deeply nested');
    });

    it('should handle files with same content (deduplication)', async () => {
      // Create multiple files with same content
      const sharedContent = 'shared content across files';
      await writeFile(join(testDir, 'file1.txt'), sharedContent);
      await writeFile(join(testDir, 'file2.txt'), sharedContent);
      await writeFile(join(testDir, 'file3.txt'), sharedContent);

      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Restore and verify all files
      const targetDir = join(testDir, 'restored-dedup');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, agent.bs);
      await agent2.loadFromDb(db, treeKey, treeRootRef);

      expect(await readFile(join(targetDir, 'file1.txt'), 'utf-8')).toBe(
        sharedContent,
      );
      expect(await readFile(join(targetDir, 'file2.txt'), 'utf-8')).toBe(
        sharedContent,
      );
      expect(await readFile(join(targetDir, 'file3.txt'), 'utf-8')).toBe(
        sharedContent,
      );
    });
  });
});
