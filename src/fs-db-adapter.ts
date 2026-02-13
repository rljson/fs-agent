// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Db } from '@rljson/db';
import { Tree } from '@rljson/rljson';

import type { FsTree } from './fs-scanner.js';

/**
 * Options for storing filesystem trees in database
 */
export interface StoreFsTreeOptions {
  /**
   * Whether to skip notifications after storing (defaults to false).
   * When false, observers (e.g. Connector) are notified automatically
   * via the standard db.insertTrees() pipeline.
   */
  skipNotification?: boolean;
}

/**
 * Adapter for storing filesystem trees in a database.
 *
 * Uses `db.insertTrees()` to go through the standard insert pipeline:
 * - TreeController writes each node
 * - InsertHistoryRow is created automatically
 * - `notify.notify()` fires so Connector observers broadcast the ref
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

    // Use db.insertTrees() — goes through the full insert pipeline:
    // 1. TreeController writes each node
    // 2. InsertHistoryRow created automatically
    // 3. notify.notify() fires → Connector observers broadcast ref
    const results = await this.db.insertTrees(this.treeKey, trees, {
      skipNotification: options.skipNotification,
    });

    return results[0][`${this.treeKey}Ref`] as string;
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
