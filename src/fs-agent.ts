// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Route } from '@rljson/rljson';

import { mkdir, utimes, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { FsBlobAdapter } from './fs-blob-adapter.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import type { Db } from '@rljson/db';

// .............................................................................
// Types
// .............................................................................

/**
 * Options for FsAgent operations
 */
export interface FsAgentOptions {
  /** Ignore patterns for scanning */
  ignore?: string[];
  /** Maximum depth for directory traversal */
  maxDepth?: number;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
  /** Database instance for automatic syncing */
  db?: Db;
  /** Tree key for database storage */
  treeKey?: string;
  /** Storage options for database operations */
  storageOptions?: StoreFsTreeOptions;
}

// .............................................................................
// FsAgent Class
// .............................................................................

/**
 * Orchestrates filesystem operations with tree structures and blob storage
 */
export class FsAgent {
  private _scanner: FsScanner;
  private _adapter: FsBlobAdapter;
  private _rootPath: string;
  private _bs: Bs;
  private _db?: Db;
  private _treeKey?: string;
  private _stopSync?: () => void;
  private _storageOptions?: StoreFsTreeOptions;

  constructor(rootPath: string, bs?: Bs, options: FsAgentOptions = {}) {
    this._rootPath = rootPath;
    this._bs = bs || new BsMem();
    this._db = options.db;
    this._treeKey = options.treeKey;
    this._storageOptions = options.storageOptions;
    this._scanner = new FsScanner(rootPath, { ...options, bs: this._bs });
    this._adapter = new FsBlobAdapter(this._bs);

    // Automatically start syncing if db and treeKey are provided
    if (this._db && this._treeKey) {
      /* v8 ignore next 3 -- @preserve */
      this._startAutoSync().catch((error) => {
        console.error('Failed to start auto-sync:', error);
      });
    }
  }

  /**
   * Gets the root path
   */
  get rootPath(): string {
    return this._rootPath;
  }

  /**
   * Gets the blob storage instance
   */
  get bs(): Bs {
    return this._bs;
  }

  /**
   * Gets the scanner instance
   */
  get scanner(): FsScanner {
    return this._scanner;
  }

  /**
   * Gets the adapter instance
   */
  get adapter(): FsBlobAdapter {
    return this._adapter;
  }

  /**
   * Starts automatic syncing to database
   */
  private async _startAutoSync(): Promise<void> {
    /* v8 ignore next 3 -- @preserve */
    if (!this._db || !this._treeKey) {
      return;
    }

    this._stopSync = await this.syncToDb(
      this._db,
      this._treeKey,
      this._storageOptions,
    );
  }

  /**
   * Stops automatic syncing and cleans up resources
   */
  dispose(): void {
    if (this._stopSync) {
      this._stopSync();
      this._stopSync = undefined;
    }
  }

  /**
   * Extracts filesystem into tree structure with file content in blobs
   * Files content stored in Bs, tree structure returned with blobIds embedded
   * @returns Tree structure with blobIds in file metadata
   */
  async extract(): Promise<FsTree> {
    // Scan filesystem - stores file content in Bs, returns tree structure
    const tree = await this._scanner.scan();

    // Return the tree structure (blobIds are already in file metadata)
    return tree;
  }

  /**
   * Restores filesystem from tree structure and blob storage
   * @param tree - Tree structure with blobIds in file metadata
   * @param targetPath - Optional target path (defaults to rootPath)
   */
  async restore(tree: FsTree, targetPath?: string): Promise<void> {
    const target = targetPath || this._rootPath;

    // Recursively restore from tree structure
    await this._restoreTree(tree.rootHash, tree.trees, target);
  }

  /**
   * Recursively restores a tree node and its children
   * @param treeHash - Hash of the tree node to restore
   * @param trees - Map of all tree nodes
   * @param targetPath - Target directory path
   */
  private async _restoreTree(
    treeHash: string,
    trees: Map<string, any>,
    targetPath: string,
  ): Promise<void> {
    const treeNode = trees.get(treeHash);
    /* v8 ignore next -- @preserve */
    if (!treeNode) {
      throw new Error(`Tree node not found: ${treeHash}`);
    }

    const meta = treeNode.meta;

    /* v8 ignore next -- @preserve */
    if (meta.type === 'file') {
      // For files, fetch content using blobId from Bs
      const filePath = join(targetPath, meta.relativePath);

      /* v8 ignore else -- @preserve */
      if (meta.blobId) {
        const fileBlob = await this._bs.getBlob(meta.blobId);

        // Create parent directories
        await mkdir(dirname(filePath), { recursive: true });

        // Write file
        await writeFile(filePath, fileBlob.content);

        // Preserve mtime
        /* v8 ignore else -- @preserve */
        if (meta.mtime) {
          const mtime = new Date(meta.mtime);
          await utimes(filePath, mtime, mtime);
        }
      }
    } else if (meta.type === 'directory') {
      // For directories, create directory and recursively restore children
      const dirPath =
        meta.relativePath === '.'
          ? targetPath
          : join(targetPath, meta.relativePath);

      await mkdir(dirPath, { recursive: true });

      // Recursively restore children
      /* v8 ignore else -- @preserve */
      if (treeNode.children && Array.isArray(treeNode.children)) {
        for (const childHash of treeNode.children) {
          await this._restoreTree(childHash, trees, targetPath);
        }
      }
    }
  }

  /**
   * Gets the current tree structure
   */
  getTree(): FsTree | null {
    return this._scanner.tree;
  }

  /**
   * Checks if a blob exists in storage
   * @param blobId - Blob ID to check
   */
  async hasBlob(blobId: string): Promise<boolean> {
    return await this._adapter.hasBlob(blobId);
  }

  /**
   * Gets file content from blob storage
   * @param blobId - Blob ID
   */
  async getFileContent(blobId: string): Promise<Buffer> {
    return await this._adapter.getFileContent(blobId);
  }

  /**
   * Extracts and stores filesystem tree in database
   * Reads from filesystem, stores trees in DB and blobs in Bs
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param options - Storage options
   * @returns The root tree reference
   */
  async storeInDb(
    db: Db,
    treeKey: string,
    options?: StoreFsTreeOptions,
  ): Promise<string> {
    const tree = await this.extract();
    const dbAdapter = new FsDbAdapter(db, treeKey);
    return await dbAdapter.storeFsTree(tree, options);
  }

  /**
   * Loads tree from database and restores to filesystem
   * Writes to filesystem from DB trees and Bs blobs
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param rootRef - Root tree reference (hash)
   * @param targetPath - Optional target path (defaults to rootPath)
   */
  async loadFromDb(
    db: Db,
    treeKey: string,
    rootRef: string,
    targetPath?: string,
  ): Promise<void> {
    // Read tree by specific root reference - try without /root suffix
    const route = `/${treeKey}@${rootRef}`;
    const { rljson } = await db.get(Route.fromFlat(route), {});

    // Get tree data from rljson
    const treeData = rljson[treeKey];
    /* v8 ignore next -- @preserve */
    if (!treeData || !treeData._data) {
      throw new Error(`No tree data found for ${treeKey}@${rootRef}`);
    }

    // DO NOT re-hash - the database manages hashes internally
    // Build trees Map from data as-is
    const trees = new Map<string, any>();
    for (const treeNode of treeData._data) {
      if (treeNode._hash) {
        trees.set(treeNode._hash, treeNode);
      }
    }

    // Use rootRef directly - it identifies the root tree from InsertHistory
    const fsTree: FsTree = {
      rootHash: rootRef,
      trees,
    };

    // Restore to filesystem
    await this.restore(fsTree, targetPath);
  }

  /**
   * Watches filesystem for changes and syncs to database
   * Registers change callbacks and automatically stores updates in DB
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param options - Storage options
   * @returns Function to stop watching
   */
  async syncToDb(
    db: Db,
    treeKey: string,
    options?: StoreFsTreeOptions,
  ): Promise<() => void> {
    // Store initial state
    await this.storeInDb(db, treeKey, options);

    // Create callback to sync on changes
    const syncCallback = async () => {
      // Use the scanner's already-updated tree instead of extracting again
      const tree = this._scanner.tree;
      if (tree) {
        const dbAdapter = new FsDbAdapter(db, treeKey);
        await dbAdapter.storeFsTree(tree, options);
      }
    };

    // Register callback and start watching
    this._scanner.onChange(syncCallback);
    await this._scanner.watch();

    // Return cleanup function
    return () => {
      this._scanner.offChange(syncCallback);
      this._scanner.stopWatch();
    };
  }

  /** Example instance for test purposes */
  static get example(): FsAgent {
    return new FsAgent(process.cwd());
  }
}
