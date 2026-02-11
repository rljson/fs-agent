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

    // Validate input
    if (!fsTree) {
      throw new Error('fsTree cannot be null or undefined');
    }

    if (!fsTree.rootHash || typeof fsTree.rootHash !== 'string') {
      throw new Error(
        `Invalid rootHash: expected non-empty string, got ${typeof fsTree.rootHash}`,
      );
    }

    if (!fsTree.trees || !(fsTree.trees instanceof Map)) {
      throw new Error(
        `Invalid trees: expected Map, got ${typeof fsTree.trees}`,
      );
    }

    if (fsTree.trees.size === 0) {
      throw new Error(
        'Cannot store empty tree: trees Map must contain at least one node',
      );
    }

    // Verify root node exists in the tree
    if (!fsTree.trees.has(fsTree.rootHash)) {
      throw new Error(
        `Root hash "${fsTree.rootHash}" not found in trees Map. ` +
          `The tree structure may be corrupted.`,
      );
    }

    // Convert all tree nodes from Map to Array
    // CRITICAL: Root tree MUST be the last element (per @rljson/server pattern)
    const rootTree = fsTree.trees.get(fsTree.rootHash)!;
    const trees: Array<Tree> = Array.from(fsTree.trees.values()).filter(
      (tree) => tree._hash !== fsTree.rootHash,
    );
    trees.push(rootTree); // Add root as last element

    // Create TreesTable
    const treeTable: TreesTable = {
      _type: 'trees',
      _data: trees,
    };

    // Import trees into database
    try {
      await this.db.core.import({
        [this.treeKey]: treeTable,
      });
    } catch (error) {
      /* v8 ignore start -- @preserve */
      throw new Error(
        `Failed to import tree data into database: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    /* v8 ignore stop -- @preserve */

    // Get root reference (last tree in array per @rljson/server pattern)
    const treeRootRef = trees[trees.length - 1]._hash as string;

    // Manually create insert history entry for root tree
    const historyRow: InsertHistoryRow<any> = {
      timeId: timeId(),
      route: `/${this.treeKey}/${treeRootRef}`,
      [`${this.treeKey}Ref`]: treeRootRef,
    } as InsertHistoryRow<any>;

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
      // Notify on the treeKey route (matches table name)
      const treeKeyRoute = Route.fromFlat(`/${this.treeKey}`);
      this.db.notify.notify(treeKeyRoute, historyRow);
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
