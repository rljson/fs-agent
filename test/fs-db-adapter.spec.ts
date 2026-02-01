// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Db } from '@rljson/db';
import { rmhsh } from '@rljson/hash';
import { IoMem } from '@rljson/io';
import {
  createTreesTableCfg,
  InsertHistoryRow,
  Route,
  TableCfg,
} from '@rljson/rljson';

import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent } from '../src/fs-agent';
import { FsDbAdapter } from '../src/fs-db-adapter';

describe('FsDbAdapter', () => {
  let testDir: string;
  let io: IoMem;
  let db: Db;
  let agent: FsAgent;
  let dbAdapter: FsDbAdapter;
  const treeKey = 'fsTree';

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `fs-db-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Initialize IoMem and Db
    io = new IoMem();
    await io.init();
    db = new Db(io);

    // Create table for file trees
    const treeTableCfg: TableCfg = createTreesTableCfg(treeKey);
    await db.core.createTableWithInsertHistory(treeTableCfg);

    // Initialize FsAgent and FsDbAdapter
    agent = new FsAgent(testDir);
    dbAdapter = new FsDbAdapter(db, treeKey);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('store filesystem trees', () => {
    it('should store a simple file tree in database', async () => {
      // Create test filesystem
      await writeFile(join(testDir, 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'file2.txt'), 'content2');

      // Extract filesystem tree
      const fsTree = await agent.extract();
      expect(fsTree.trees.size).toBeGreaterThan(0);

      // Store tree using adapter
      const treeRootRef = await dbAdapter.storeFsTree(fsTree);
      expect(treeRootRef).toBe(fsTree.rootHash);

      // Read back from database
      const route = `/${treeKey}@${treeRootRef}/root`;
      const { tree } = await db.get(Route.fromFlat(route), {});

      // Verify structure
      expect(tree).toBeDefined();
      expect(tree[treeKey]).toBeDefined();

      // Verify insert history was written
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable2 = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable2).toBeDefined();
      expect(historyTable2._type).toBe('insertHistory');
      expect(historyTable2._data.length).toBe(1);
      expect(historyTable2._data[0][`${treeKey}Ref`]).toBe(treeRootRef);
      expect(historyTable2._data[0].route).toBe(`/fsTree/${treeRootRef}`);
      expect(historyTable2._data[0].timeId).toBeDefined();
    });

    it('should store nested directory tree in database', async () => {
      // Create nested directory structure
      await mkdir(join(testDir, 'dir1', 'dir2'), { recursive: true });
      await writeFile(join(testDir, 'dir1', 'file1.txt'), 'content1');
      await writeFile(join(testDir, 'dir1', 'dir2', 'file2.txt'), 'content2');

      // Extract filesystem tree
      const fsTree = await agent.extract();

      // Store tree using adapter
      const treeRootRef = await dbAdapter.storeFsTree(fsTree);

      // Verify storage
      const route = `/${treeKey}@${treeRootRef}/root`;
      const { tree } = await db.get(Route.fromFlat(route), {});

      expect(tree).toBeDefined();
      const treeWithoutHash = rmhsh(tree);
      expect(treeWithoutHash[treeKey]).toBeDefined();
      expect((treeWithoutHash[treeKey] as any)._data).toBeDefined();

      // Verify insert history was written
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable2 = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable2).toBeDefined();
      expect(historyTable2._type).toBe('insertHistory');
      expect(historyTable2._data.length).toBe(1);
      expect(historyTable2._data[0][`${treeKey}Ref`]).toBe(treeRootRef);
      expect(historyTable2._data[0].route).toBe(`/fsTree/${treeRootRef}`);
      expect(historyTable2._data[0].timeId).toBeDefined();
    });

    it('should preserve file metadata in stored tree', async () => {
      // Create test file
      await writeFile(join(testDir, 'test.txt'), 'test content');

      // Extract filesystem tree
      const fsTree = await agent.extract();

      // Store tree using adapter
      const treeRootRef = await dbAdapter.storeFsTree(fsTree);

      // Read back and verify metadata exists
      const route = `/${treeKey}@${treeRootRef}/root`;
      const { tree } = await db.get(Route.fromFlat(route), {});

      const treeData = rmhsh(tree);
      expect(treeData[treeKey]).toBeDefined();
      expect((treeData[treeKey] as any)._data).toBeDefined();

      // Verify the tree structure is stored
      expect((treeData[treeKey] as any)._data.length).toBeGreaterThan(0);

      // Verify insert history was written
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable2 = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable2).toBeDefined();
      expect(historyTable2._type).toBe('insertHistory');
      expect(historyTable2._data.length).toBe(1);
      expect(historyTable2._data[0][`${treeKey}Ref`]).toBe(treeRootRef);
      expect(historyTable2._data[0].route).toBe(`/fsTree/${treeRootRef}`);
      expect(historyTable2._data[0].timeId).toBeDefined();
    });
  });

  describe('read filesystem trees', () => {
    it('should read stored tree and access file metadata', async () => {
      // Create and store tree
      await writeFile(join(testDir, 'example.txt'), 'example content');

      const fsTree = await agent.extract();

      // Store tree using adapter
      const treeRootRef = await dbAdapter.storeFsTree(fsTree);

      // Read tree from database
      const route = `/${treeKey}@${treeRootRef}/root`;
      const { rljson, tree } = await db.get(Route.fromFlat(route), {});

      // Verify we can access the data
      expect(rljson[treeKey]).toBeDefined();
      expect(rljson[treeKey]._data).toBeDefined();
      expect(tree[treeKey]).toBeDefined();

      // Verify insert history was written
      const insertHistory = await db.getInsertHistory(treeKey);
      expect(insertHistory).toBeDefined();
      const historyTable2 = insertHistory[`${treeKey}InsertHistory`];
      expect(historyTable2).toBeDefined();
      expect(historyTable2._type).toBe('insertHistory');
      expect(historyTable2._data.length).toBe(1);
      expect(historyTable2._data[0][`${treeKey}Ref`]).toBe(treeRootRef);
      expect(historyTable2._data[0].route).toBe(`/fsTree/${treeRootRef}`);
      expect(historyTable2._data[0].timeId).toBeDefined();
    });

    it('should trigger notifications when manually notifying after import', async () => {
      // Create test file
      await writeFile(join(testDir, 'notify-test.txt'), 'notify content');

      // Extract filesystem tree
      const fsTree = await agent.extract();

      // Register notification callback using vi.fn on treeKey route for inserts
      const callback = vi.fn();

      const treeRootRef = fsTree.rootHash;
      const notifyRoute = Route.fromFlat(`/fsTree`);
      db.notify.register(notifyRoute, callback as any);

      // Store tree without notification
      await dbAdapter.storeFsTree(fsTree, { notify: false });

      // Verify notification NOT received yet (notify option was false)
      expect(callback).not.toHaveBeenCalled();

      // Now store again with notification enabled
      const callback2 = vi.fn(async () => {});
      db.notify.register(notifyRoute, callback2 as any);

      await dbAdapter.storeFsTree(fsTree, { notify: true });

      // Wait for async notification to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify notification was received
      expect(callback2).toHaveBeenCalledTimes(1);

      // Verify the callback received the correct data
      const receivedHistoryRow = callback2.mock
        .calls[0][0] as InsertHistoryRow<any>;
      expect(receivedHistoryRow[`${treeKey}Ref`]).toBe(treeRootRef);
      expect(receivedHistoryRow.route).toBe(`/fsTree/${treeRootRef}`);
      expect(receivedHistoryRow.timeId).toBeDefined();

      // Clean up
      db.notify.unregister(notifyRoute, callback as any);
      db.notify.unregister(notifyRoute, callback2 as any);
    });
  });

  describe('adapter methods', () => {
    it('should expose tree key and database instance', () => {
      expect(dbAdapter.getTreeKey()).toBe(treeKey);
      expect(dbAdapter.getDb()).toBe(db);
    });
  });
});
