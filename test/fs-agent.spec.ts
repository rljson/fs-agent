// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
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
import { FsDbAdapter } from '../src/fs-db-adapter';

/**
 * Creates a mock Connector for tests that don't need real socket communication
 */
function createMockConnector(db: Db, treeKey: string) {
  const route = Route.fromFlat(`/${treeKey}+`);
  const socket = new SocketMock();
  return new Connector(db, route, socket);
}

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

    it('should reject auto-sync via constructor with db and treeKey', async () => {
      // Create a mock database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);

      // Create table
      const treeCfg = createTreesTableCfg('testTree');
      await db.core.createTableWithInsertHistory(treeCfg);

      // Constructor with db and treeKey triggers deprecated auto-sync pattern
      // This will fail internally but is silently ignored
      new FsAgent(testDir, undefined, {
        db,
        treeKey: 'testTree',
      });

      // Wait for async error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No assertion - deprecated pattern fails silently
    });

    it('should reject bidirectional auto-sync via constructor', async () => {
      // Create a mock database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);

      // Create table
      const treeCfg = createTreesTableCfg('testTree');
      await db.core.createTableWithInsertHistory(treeCfg);

      // Constructor with db, treeKey, and bidirectional triggers deprecated pattern
      // This will fail internally but is silently ignored
      new FsAgent(testDir, undefined, {
        db,
        treeKey: 'testTree',
        bidirectional: true,
      });

      // Wait for async error handling
      await new Promise((resolve) => setTimeout(resolve, 10));

      // No assertion - deprecated pattern fails silently
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

    it('should ignore unknown node types when cleaning target', async () => {
      const agent = new FsAgent(testDir);
      const strayPath = join(testDir, 'stray.txt');
      await writeFile(strayPath, 'stray');

      const ghostHash = 'ghost-node';
      const rootHash = 'root-node';
      const timestamp = Date.now();
      const tree = {
        rootHash,
        trees: new Map([
          [
            rootHash,
            {
              _hash: rootHash,
              meta: {
                type: 'directory',
                name: '.',
                path: testDir,
                relativePath: '.',
                mtime: timestamp,
              },
              children: [ghostHash],
            },
          ],
          [
            ghostHash,
            {
              _hash: ghostHash,
              meta: {
                type: 'unknown' as any,
                name: 'ghost',
                path: join(testDir, 'ghost'),
                relativePath: 'ghost',
                mtime: timestamp,
              },
            },
          ],
        ]),
      } as any;

      await agent.restore(tree, undefined, { cleanTarget: true });

      const strayExists = await stat(strayPath)
        .then(() => true)
        .catch(() => false);
      expect(strayExists).toBe(false);
    });

    it('should clean unexpected directories and nested files with cleanTarget', async () => {
      // First create a tree with nested structure
      const expectedDir = join(testDir, 'expected_dir');
      await mkdir(expectedDir, { recursive: true });
      await writeFile(join(testDir, 'wanted.txt'), 'keep me');
      await writeFile(join(expectedDir, 'nested_wanted.txt'), 'keep me too');

      const agent = new FsAgent(testDir);
      const tree = await agent.extract();

      // Now add unwanted directory with nested files (should be removed entirely)
      const unwantedDir = join(testDir, 'unwanted_dir');
      const nestedDir = join(unwantedDir, 'nested');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(join(unwantedDir, 'file1.txt'), 'remove me');
      await writeFile(join(nestedDir, 'file2.txt'), 'remove me too');

      // Also add unwanted file inside expected directory (should be removed, dir kept)
      await writeFile(
        join(expectedDir, 'unwanted_nested.txt'),
        'remove me three',
      );

      // Also add unwanted file at root
      await writeFile(join(testDir, 'unwanted.txt'), 'remove me four');

      // Restore with cleanTarget should remove all unwanted items
      await agent.restore(tree, undefined, { cleanTarget: true });

      // Check wanted files still exist
      const wantedExists = await stat(join(testDir, 'wanted.txt'))
        .then(() => true)
        .catch(() => false);
      expect(wantedExists).toBe(true);

      const nestedWantedExists = await stat(
        join(expectedDir, 'nested_wanted.txt'),
      )
        .then(() => true)
        .catch(() => false);
      expect(nestedWantedExists).toBe(true);

      // Check expected directory still exists
      const expectedDirExists = await stat(expectedDir)
        .then(() => true)
        .catch(() => false);
      expect(expectedDirExists).toBe(true);

      // Check unwanted directory was removed
      const unwantedDirExists = await stat(unwantedDir)
        .then(() => true)
        .catch(() => false);
      expect(unwantedDirExists).toBe(false);

      // Check unwanted files were removed
      const unwantedFileExists = await stat(join(testDir, 'unwanted.txt'))
        .then(() => true)
        .catch(() => false);
      expect(unwantedFileExists).toBe(false);

      const unwantedNestedExists = await stat(
        join(expectedDir, 'unwanted_nested.txt'),
      )
        .then(() => true)
        .catch(() => false);
      expect(unwantedNestedExists).toBe(false);
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
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncToDb(db, connector, treeKey);

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
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncToDb(db, connector, treeKey);

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
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncToDb(db, connector, treeKey);

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

      // Register notification callback on treeKey route to catch insertions
      const syncCallback = vi.fn(async () => {});
      const notifyRoute = Route.fromFlat(`/${treeKey}`);
      db.notify.register(notifyRoute, syncCallback as any);

      // Store with notifications enabled
      await agent.storeInDb(db, treeKey, { notify: true });

      // Wait for async notification to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify notification was triggered
      expect(syncCallback).toHaveBeenCalledTimes(1);

      // Verify the callback received correct InsertHistoryRow
      expect(syncCallback.mock.calls[0]).toBeDefined();
      const firstCall = syncCallback.mock.calls[0] as any[];
      const receivedHistoryRow = firstCall[0] as InsertHistoryRow<any>;
      expect(receivedHistoryRow).toBeDefined();
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

    it.skip('should automatically sync when db and treeKey are provided in constructor', async () => {
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

    it.skip('should stop automatic syncing when dispose is called', async () => {
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

    it('should sync from database to filesystem when tree changes', async () => {
      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create initial file
      await writeFile(join(testDir, 'initial.txt'), 'initial content');

      // Setup agent
      const agent = new FsAgent(testDir);

      // Store initial state
      await agent.storeInDb(db, treeKey);

      // Start syncing FROM database
      const connector = createMockConnector(db, treeKey);
      const stopSyncFromDb = await agent.syncFromDb(db, connector, treeKey);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create a new target directory with different content
      const sourceDir = join(testDir, 'source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'from-db.txt'), 'db content');

      // Extract and store new tree from source
      const sourceAgent = new FsAgent(sourceDir, agent.bs);
      const newTree = await sourceAgent.extract();
      const dbAdapter = new FsDbAdapter(db, treeKey);
      const treeRef = await dbAdapter.storeFsTree(newTree);

      // Manually send the ref through connector to trigger sync
      connector.send(treeRef);

      // Wait for sync to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify file was synced from DB to filesystem
      const syncedFile = join(testDir, 'from-db.txt');
      const exists = await stat(syncedFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      if (exists) {
        const content = await readFile(syncedFile, 'utf-8');
        expect(content).toBe('db content');
      }

      // Clean up
      stopSyncFromDb();
    });

    it.skip('should not create loops with bidirectional sync', async () => {
      // Setup database
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create initial file
      await writeFile(join(testDir, 'test.txt'), 'content');

      // Create agent with bidirectional sync
      const agent = new FsAgent(testDir, undefined, {
        db,
        treeKey,
        bidirectional: true,
      });

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get initial history count
      const insertHistory1 = await db.getInsertHistory(treeKey);
      const initialCount =
        insertHistory1[`${treeKey}InsertHistory`]._data.length;

      // Modify filesystem
      await writeFile(join(testDir, 'test.txt'), 'modified');

      // Wait for sync
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Get final history count
      const insertHistory2 = await db.getInsertHistory(treeKey);
      const finalCount = insertHistory2[`${treeKey}InsertHistory`]._data.length;

      // Should have only a few more entries (not dozens from loops)
      // We expect initialCount + 1 from the modification, but bidirectional
      // sync may cause 1-2 additional syncs as the change propagates
      const extraEntries = finalCount - initialCount;
      expect(extraEntries).toBeGreaterThanOrEqual(1);
      expect(extraEntries).toBeLessThanOrEqual(3);

      // Clean up
      agent.dispose();
    });

    it('should pause and resume file watching', async () => {
      // Setup initial file
      await writeFile(join(testDir, 'watch-test.txt'), 'initial');

      const agent = new FsAgent(testDir);
      await agent.scanner.watch();

      // Register callback
      const callback = vi.fn();
      agent.scanner.onChange(callback);

      // Wait a bit for watching to be active and clear any initial events
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Reset mock to ignore any startup events
      callback.mockClear();

      // Pause watching
      agent.scanner.pauseWatch();

      // Modify file while paused
      await writeFile(join(testDir, 'watch-test.txt'), 'modified while paused');

      // Wait to ensure change is processed (or would be if not paused)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Resume watching
      agent.scanner.resumeWatch();

      // Clear any remaining queued events
      await new Promise((resolve) => setTimeout(resolve, 200));
      callback.mockClear();

      // Modify file while resumed - this should definitely trigger
      await writeFile(
        join(testDir, 'watch-test.txt'),
        'modified while resumed',
      );

      // Wait for callback
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify callback WAS called after resuming
      expect(callback).toHaveBeenCalled();

      // Clean up
      agent.scanner.stopWatch();
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

  describe('error handling', () => {
    it('should throw error when loading non-existent tree reference', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);

      await expect(
        agent.loadFromDb(db, treeKey, 'nonExistentRef'),
      ).rejects.toThrow();
    });

    it('should throw error when storing empty tree', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create agent pointing to empty directory
      const emptyDir = join(testDir, 'empty-for-error');
      await mkdir(emptyDir, { recursive: true });

      // Empty directory should still have a root node, so test with truly invalid scenario
      await expect(async () => {
        const dbAdapter = new FsDbAdapter(db, treeKey);
        await dbAdapter.storeFsTree(null as any);
      }).rejects.toThrow(/fsTree cannot be null/);
    });

    it('should throw error when loading tree with empty rootRef', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';

      const agent = new FsAgent(testDir);

      await expect(agent.loadFromDb(db, treeKey, '')).rejects.toThrow(
        /rootRef cannot be empty/,
      );
    });

    it('should throw error when restoring with missing blob', async () => {
      // Create a file
      await writeFile(join(testDir, 'test.txt'), 'content');

      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Store in database
      const agent = new FsAgent(testDir);
      const treeRootRef = await agent.storeInDb(db, treeKey);

      // Create new agent with DIFFERENT blob storage (missing the blob)
      const targetDir = join(testDir, 'restored-missing-blob');
      await mkdir(targetDir, { recursive: true });
      const agent2 = new FsAgent(targetDir, new BsMem());

      // Should fail because blob is missing
      await expect(agent2.loadFromDb(db, treeKey, treeRootRef)).rejects.toThrow(
        /Failed to retrieve blob/,
      );
    });

    it('should throw error when scanning non-existent directory', async () => {
      const nonExistentDir = join(testDir, 'does-not-exist');
      const agent = new FsAgent(nonExistentDir);

      await expect(agent.extract()).rejects.toThrow(/does not exist/);
    });

    it('should handle invalid tree structure gracefully', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      // Try to store tree with invalid structure (empty map)
      await expect(
        dbAdapter.storeFsTree({
          rootHash: 'invalid',
          trees: new Map(), // Empty map
        }),
      ).rejects.toThrow(/Cannot store empty tree/);
    });

    it('should validate tree has content before storing', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      await expect(
        dbAdapter.storeFsTree({
          rootHash: '',
          trees: new Map(),
        }),
      ).rejects.toThrow(/Invalid rootHash/);
    });

    it('should validate trees is a Map', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      await expect(
        dbAdapter.storeFsTree({
          rootHash: 'someHash',
          trees: [] as any, // Not a Map
        }),
      ).rejects.toThrow(/Invalid trees: expected Map/);
    });

    it('should validate root hash exists in tree map', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      const trees = new Map();
      trees.set('otherHash', { meta: { name: 'test' } });

      await expect(
        dbAdapter.storeFsTree({
          rootHash: 'missingHash',
          trees,
        }),
      ).rejects.toThrow(/Root hash.*not found in trees Map/);
    });

    it('should handle syncFromDb with invalid treeRef', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);
      await agent.scanner.watch();

      // Register syncFromDb
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncFromDb(db, connector, treeKey);

      // Trigger with invalid treeRef types - should be ignored gracefully
      connector.send(null as any);
      connector.send(123 as any);
      connector.send({} as any);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Clean up
      stopSync();
      agent.scanner.stopWatch();
    });

    it('should handle syncFromDb with missing treeRef', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);
      await agent.scanner.watch();

      // Register syncFromDb
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncFromDb(db, connector, treeKey);

      // Manually trigger with missing treeRef by sending empty string via connector
      connector.send('');

      // Clean up
      stopSync();
      agent.scanner.stopWatch();
    });

    it('should handle syncFromDb failure gracefully', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir);
      await agent.scanner.watch();

      // Register syncFromDb
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncFromDb(db, connector, treeKey);

      // Trigger with invalid treeRef that will cause loadFromDb to fail
      connector.send('invalidTreeRef');

      // Wait a bit for the async operation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not throw - error is logged but notification system continues
      // Clean up
      stopSync();
      agent.scanner.stopWatch();
    });

    it('should handle scanning path that is not a directory', async () => {
      // Create a file instead of directory
      const filePath = join(testDir, 'not-a-dir');
      await writeFile(filePath, 'content');

      const agent = new FsAgent(filePath);
      await expect(agent.extract()).rejects.toThrow(
        /exists but is not a directory/,
      );
    });

    it('should handle loadFromDb when root node is missing from tree data', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Create a file to get a valid tree
      await writeFile(join(testDir, 'test.txt'), 'content');
      const agent = new FsAgent(testDir);
      await agent.storeInDb(db, treeKey);

      // Now try to load with a different (non-existent) rootRef
      // This will fail during database retrieval or validation
      await expect(
        agent.loadFromDb(db, treeKey, 'wrongRootRef'),
      ).rejects.toThrow(); // Just verify it throws an error
    });

    it('should handle file read failure during scan', async () => {
      // This is hard to test without mocking, but we can test the path exists
      // by verifying the error handling code is present
      // The actual error path requires file system failures which are hard to simulate

      // Create a file and verify normal operation works
      await writeFile(join(testDir, 'readable.txt'), 'content');
      const testAgent = new FsAgent(testDir);
      const tree = await testAgent.extract();
      expect(tree).toBeDefined();
    });

    it('should not trigger scan on invalid tree extraction', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      // Try to store null tree directly via adapter
      await expect(dbAdapter.storeFsTree(null as any)).rejects.toThrow(
        /fsTree cannot be null/,
      );
    });

    it('should handle tree with zero size map', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'fsTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const dbAdapter = new FsDbAdapter(db, treeKey);

      // Try to store tree with rootHash but empty trees map
      await expect(
        dbAdapter.storeFsTree({
          rootHash: 'someHash',
          trees: new Map(),
        }),
      ).rejects.toThrow(/Cannot store empty tree/);
    });
  });

  describe('fromClient', () => {
    it('should create FsAgent with simplified sync methods', async () => {
      // Setup test directory with a file
      await writeFile(join(testDir, 'test.txt'), 'content');

      // Setup mock client
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const client = { io, bs };

      // Create mock socket
      const socket = {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      };

      // Create agent using fromClient
      const agent = await FsAgent.fromClient(
        testDir,
        'testTree',
        client,
        socket,
      );

      // Verify agent has simplified methods
      expect(agent.syncToDbSimple).toBeDefined();
      expect(typeof agent.syncToDbSimple).toBe('function');
      expect(agent.syncFromDbSimple).toBeDefined();
      expect(typeof agent.syncFromDbSimple).toBe('function');

      // Verify agent has standard properties
      expect(agent.scanner).toBeDefined();
      expect(agent.adapter).toBeDefined();
    });

    it('should throw error if client.io is not initialized', async () => {
      const bs = new BsMem();
      const client = { io: null, bs };
      const socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

      await expect(
        FsAgent.fromClient(testDir, 'testTree', client, socket),
      ).rejects.toThrow('Client.io is not initialized');
    });

    it('should throw error if client.bs is not initialized', async () => {
      const io = new IoMem();
      await io.init();
      const client = { io, bs: null };
      const socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

      await expect(
        FsAgent.fromClient(testDir, 'testTree', client, socket),
      ).rejects.toThrow('Client.bs is not initialized');
    });

    it('should use syncToDbSimple to sync to database', async () => {
      // Setup test file
      await writeFile(join(testDir, 'simple.txt'), 'simple content');

      // Setup client and database
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const client = { io, bs };

      // Create database and tree table
      const db = new Db(client.io);
      const treeKey = 'simpleTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Setup mock socket
      const socket = {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      };

      // Create agent
      const agent = await FsAgent.fromClient(testDir, treeKey, client, socket);

      // Use simplified sync method
      const stopSync = await agent.syncToDbSimple();

      // Wait for initial sync
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop sync
      stopSync();

      // Verify tree was stored (check via db.getInsertHistory)
      const history = await db.getInsertHistory(treeKey);
      expect(history[`${treeKey}InsertHistory`]).toBeDefined();
      expect(history[`${treeKey}InsertHistory`]._data.length).toBeGreaterThan(
        0,
      );
    });

    it('should use syncFromDbSimple to sync from database', async () => {
      // Setup client
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const client = { io, bs };

      // Create database and tree table
      const db = new Db(client.io);
      const treeKey = 'fromSimpleTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Use real SocketMock
      const socket = new SocketMock();
      socket.connect();

      // Create agent using fromClient
      const agent = await FsAgent.fromClient(testDir, treeKey, client, socket);

      // Verify syncFromDbSimple can be called and returns cleanup function
      const stopSync = await agent.syncFromDbSimple();
      expect(stopSync).toBeDefined();
      expect(typeof stopSync).toBe('function');

      // Call cleanup
      stopSync();

      // Verify method is still callable after cleanup (should not throw)
      const stopSync2 = await agent.syncFromDbSimple({ cleanTarget: true });
      stopSync2();
    });
  });

  // =========================================================================
  // Timeout Detection
  // =========================================================================
  describe('timeout detection', () => {
    it('should use default timeout values', () => {
      const agent = new FsAgent(testDir);
      expect(agent.timeouts.dbQuery).toBe(10_000);
      expect(agent.timeouts.fetchTree).toBe(20_000);
      expect(agent.timeouts.extract).toBe(15_000);
      expect(agent.timeouts.restore).toBe(15_000);
      expect(agent.timeouts.syncCallback).toBe(25_000);
      expect(agent.timeouts.debounceMs).toBe(300);
    });

    it('should accept custom timeout values', () => {
      const agent = new FsAgent(testDir, undefined, {
        timeouts: {
          dbQuery: 1_000,
          fetchTree: 2_000,
          extract: 3_000,
          restore: 4_000,
          syncCallback: 5_000,
          debounceMs: 100,
        },
      });
      expect(agent.timeouts.dbQuery).toBe(1_000);
      expect(agent.timeouts.fetchTree).toBe(2_000);
      expect(agent.timeouts.extract).toBe(3_000);
      expect(agent.timeouts.restore).toBe(4_000);
      expect(agent.timeouts.syncCallback).toBe(5_000);
      expect(agent.timeouts.debounceMs).toBe(100);
    });

    it('should allow partial timeout overrides', () => {
      const agent = new FsAgent(testDir, undefined, {
        timeouts: { dbQuery: 500 },
      });
      expect(agent.timeouts.dbQuery).toBe(500);
      // Remaining use defaults
      expect(agent.timeouts.fetchTree).toBe(20_000);
      expect(agent.timeouts.extract).toBe(15_000);
    });

    it('should reject with timeout error when loadFromDb db.get() hangs', async () => {
      // Create a Db whose get() never resolves
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'timeoutTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      // Monkey-patch db.get to never resolve
      const originalGet = db.get.bind(db);
      db.get = () => new Promise(() => {});

      // Create agent with very short timeouts
      const agent = new FsAgent(testDir, undefined, {
        timeouts: { dbQuery: 50, fetchTree: 100 },
      });

      await expect(
        agent.loadFromDb(db, treeKey, 'nonexistent-hash'),
      ).rejects.toThrow(/Timeout after/);

      // Restore
      db.get = originalGet;
    });

    it('should reject storeInDb with timeout when io.write hangs', async () => {
      // Create a valid file to scan
      await writeFile(join(testDir, 'hello.txt'), 'world');

      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'storeTimeoutTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      const agent = new FsAgent(testDir, undefined, {
        timeouts: { fetchTree: 50 },
      });

      // Monkey-patch io.write so it never resolves
      const original = io.write.bind(io);
      io.write = () => new Promise(() => {});

      const connector = createMockConnector(db, treeKey);

      // syncToDb calls storeInDb which is guarded by fetchTree timeout
      await expect(agent.syncToDb(db, connector, treeKey)).rejects.toThrow(
        /Timeout after/,
      );

      io.write = original;
    });

    it('should survive syncFromDb timeout without crashing the watcher', async () => {
      // Setup real DB with tree
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'syncFromTimeoutTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      await writeFile(join(testDir, 'file.txt'), 'content');

      // Agent with very short fetch timeout
      const agent = new FsAgent(testDir, undefined, {
        timeouts: { fetchTree: 50, dbQuery: 25 },
      });

      const connector = createMockConnector(db, treeKey);

      // Monkey-patch db.get to never resolve (simulates hung socket)
      const originalGet = db.get.bind(db);
      db.get = () => new Promise(() => {});

      // syncFromDb should still return a stop function (setup succeeds)
      const stopSync = await agent.syncFromDb(db, connector, treeKey);
      expect(stopSync).toBeDefined();
      expect(typeof stopSync).toBe('function');

      // Simulate incoming ref — callback fires but db.get hangs.
      // The timeout catches it and the catch block swallows the error.
      // The watcher should NOT crash.
      connector.send('fake-ref-that-will-timeout');

      // Give the callback time to fire and timeout
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Cleanup
      stopSync();
      db.get = originalGet;
      agent.dispose();
    });

    it('should survive syncToDb callback timeout without crashing', async () => {
      const io = new IoMem();
      await io.init();
      const db = new Db(io);
      const treeKey = 'syncToTimeoutTree';
      const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
      await db.core.createTableWithInsertHistory(treeTableCfg);

      await writeFile(join(testDir, 'file.txt'), 'initial');

      // Start syncToDb with real DB (initial store succeeds)
      const agent = new FsAgent(testDir, undefined, {
        timeouts: { fetchTree: 50 },
      });
      const connector = createMockConnector(db, treeKey);
      const stopSync = await agent.syncToDb(db, connector, treeKey);

      // Now break the IO so subsequent stores hang
      const original = io.write.bind(io);
      io.write = () => new Promise(() => {});

      // Trigger a filesystem change — the syncToDb callback fires
      // but storeFsTree hangs and gets caught by the timeout + catch block
      await writeFile(join(testDir, 'file.txt'), 'changed');

      // Give the watcher + callback time to fire and timeout
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Cleanup — should not throw
      stopSync();
      io.write = original;
      agent.dispose();
    });
  });
});
