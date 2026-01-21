// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Db } from '@rljson/db';
import {
  InsertHistoryRow,
  InsertHistoryTable,
  Route,
  timeId,
  Tree,
  TreesTable,
} from '@rljson/rljson';

import type { FsTree } from './fs-scanner.js';

/**
 * Options for storing filesystem trees in database
 */
export interface StoreFsTreeOptions {
  /**
   * Whether to trigger notifications after storing (defaults to false)
   */
  notify?: boolean;
}

/**
 * Adapter for storing filesystem trees in a database
 */
export class FsDbAdapter {
  constructor(
    private db: Db,
    private treeKey: string,
  ) {}

  /**
   * Store a filesystem tree in the database
   * @param fsTree - The filesystem tree to store
   * @param options - Storage options
   * @returns The root tree reference
   */
  async storeFsTree(
    fsTree: FsTree,
    options: StoreFsTreeOptions = {},
  ): Promise<string> {
    const { notify = false } = options;

    // Convert all tree nodes from Map to Array
    const trees: Array<Tree> = Array.from(fsTree.trees.values());

    // Create TreesTable
    const treeTable: TreesTable = {
      _type: 'trees',
      _data: trees,
    };

    // Import trees into database
    await this.db.core.import({
      [this.treeKey]: treeTable,
    });

    // Get root reference
    const treeRootRef = fsTree.rootHash;

    // Manually create insert history entry for root tree
    const historyRow: InsertHistoryRow<any> = {
      timeId: timeId(),
      route: `/${this.treeKey}/${treeRootRef}`,
      [`${this.treeKey}Ref`]: treeRootRef,
    };

    const historyTable: InsertHistoryTable<any> = {
      _type: 'insertHistory',
      _data: [historyRow],
    };

    // Import insert history
    await this.db.core.import({
      [`${this.treeKey}InsertHistory`]: historyTable,
    });

    // Optionally trigger notification
    if (notify) {
      const notifyRoute = Route.fromFlat(`/${this.treeKey}/${treeRootRef}`);
      this.db.notify.notify(notifyRoute, historyRow);
    }

    return treeRootRef;
  }

  /**
   * Get the tree table key
   */
  getTreeKey(): string {
    return this.treeKey;
  }

  /**
   * Get the database instance
   */
  getDb(): Db {
    return this.db;
  }
}
