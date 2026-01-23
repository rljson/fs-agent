// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Route } from '@rljson/rljson';

import { mkdir, readdir, rm, utimes, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { FsBlobAdapter } from './fs-blob-adapter.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import type { FsNodeMeta } from './fs-scanner.ts';

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
  /** Enable bidirectional sync (both fs→db and db→fs) */
  bidirectional?: boolean;
}

/** Restore options */
export interface RestoreOptions {
  /** Remove files/dirs on target that are not present in the tree */
  cleanTarget?: boolean;
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
  private _stopSyncFromDb?: () => void;
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

      // Start reverse sync if bidirectional is enabled
      /* v8 ignore next 3 -- @preserve */
      this._startAutoSyncFromDb(options.bidirectional || false).catch(
        (error) => {
          console.error('Failed to start auto-sync from DB:', error);
        },
      );
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
   * Starts automatic syncing from database
   * @param bidirectional - Whether bidirectional sync is enabled
   */
  private async _startAutoSyncFromDb(bidirectional: boolean): Promise<void> {
    /* v8 ignore next 3 -- @preserve */
    if (!this._db || !this._treeKey || !bidirectional) {
      return;
    }

    this._stopSyncFromDb = await this.syncFromDb(this._db, this._treeKey);
  }

  /**
   * Stops automatic syncing and cleans up resources
   */
  dispose(): void {
    if (this._stopSync) {
      this._stopSync();
      this._stopSync = undefined;
    }
    if (this._stopSyncFromDb) {
      this._stopSyncFromDb();
      this._stopSyncFromDb = undefined;
    }
  }

  /**
   * Extracts filesystem into tree structure with file content in blobs
   * File content is stored in Bs, tree structure returned with blobIds embedded
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
   * @param options - Restore options
   */
  async restore(
    tree: FsTree,
    targetPath?: string,
    options?: RestoreOptions,
  ): Promise<void> {
    const target = targetPath || this._rootPath;
    const { expectedDirs, expectedFiles } = this._collectExpectedPaths(
      tree,
      target,
    );

    // Recursively restore from tree structure
    await this._restoreTree(tree.rootHash, tree.trees, target);

    if (options?.cleanTarget) {
      await this._pruneExtraneous(target, expectedDirs, expectedFiles);
    }
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

    const meta = treeNode.meta as FsNodeMeta | null | undefined;
    /* v8 ignore next 3 -- @preserve */
    if (!meta) {
      throw new Error(`Tree node is missing meta for hash: ${treeHash}`);
    }

    /* v8 ignore next -- @preserve */
    if (meta.type === 'file') {
      // For files, fetch content using blobId from Bs
      const filePath = join(targetPath, meta.relativePath);

      /* v8 ignore else -- @preserve */
      if (meta.blobId) {
        // Try to fetch the blob
        let fileBlob;
        try {
          fileBlob = await this._bs.getBlob(meta.blobId);
        } catch (error) {
          throw new Error(
            `Failed to retrieve blob for file "${meta.relativePath}" (blobId: ${meta.blobId}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!fileBlob || !fileBlob.content) {
          throw new Error(
            `Missing blob content for file "${meta.relativePath}" (blobId: ${meta.blobId}). ` +
              `The blob may have been deleted or not synced properly.`,
          );
        }

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

    // Validate tree has content
    /* v8 ignore next 5 -- @preserve */
    if (!tree || !tree.rootHash || !tree.trees) {
      throw new Error(
        'Cannot store empty or invalid tree in database. ' +
          'Ensure the filesystem has been scanned and contains valid data.',
      );
    }

    /* v8 ignore next 3 -- @preserve */
    if (tree.trees.size === 0) {
      throw new Error(
        'Cannot store tree with no nodes. The tree structure is empty.',
      );
    }

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
   * @param options - Restore options
   */
  async loadFromDb(
    db: Db,
    treeKey: string,
    rootRef: string,
    targetPath?: string,
    options?: RestoreOptions,
  ): Promise<void> {
    // Validate inputs
    if (!rootRef || rootRef.trim() === '') {
      throw new Error('rootRef cannot be empty');
    }

    // Read tree by specific root reference - try without /root suffix
    const route = `/${treeKey}@${rootRef}`;
    let result;
    try {
      result = await db.get(Route.fromFlat(route), {});
    } catch (error) {
      /* v8 ignore next 4 -- @preserve */
      throw new Error(
        `Failed to load tree from database at route "${route}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { rljson } = result;
    /* v8 ignore next 3 -- @preserve */
    if (!rljson) {
      throw new Error(
        `No rljson data returned from database for ${treeKey}@${rootRef}`,
      );
    }

    // Get tree data from rljson
    const treeData = rljson[treeKey];
    /* v8 ignore next -- @preserve */
    if (!treeData || !treeData._data) {
      throw new Error(
        `No tree data found for ${treeKey}@${rootRef}. ` +
          `The tree may have been deleted or the reference is invalid.`,
      );
    }

    // Validate tree data structure
    if (!Array.isArray(treeData._data) || treeData._data.length === 0) {
      throw new Error(
        `Invalid tree data structure for ${treeKey}@${rootRef}: ` +
          `expected non-empty array, got ${typeof treeData._data}`,
      );
    }

    // DO NOT re-hash - the database manages hashes internally
    // Build trees Map from data as-is
    const trees = new Map<string, any>();
    for (const treeNode of treeData._data) {
      /* v8 ignore next 3 -- @preserve */
      if (treeNode._hash) {
        trees.set(treeNode._hash, treeNode);
      }
    }

    // Validate root tree exists
    /* v8 ignore next 4 -- @preserve */
    if (!trees.has(rootRef)) {
      throw new Error(
        `Root tree node "${rootRef}" not found in tree data. ` +
          `Available hashes: ${Array.from(trees.keys()).slice(0, 5).join(', ')}${trees.size > 5 ? '...' : ''}`,
      );
    }

    // Use rootRef directly - it identifies the root tree from InsertHistory
    const fsTree: FsTree = {
      rootHash: rootRef,
      trees,
    };

    // Restore to filesystem
    await this.restore(fsTree, targetPath, options);
  }

  /**
   * Collects expected file and directory paths for cleanup
   * @param tree - Tree structure to evaluate
   * @param target - Filesystem root where the tree will be restored
   */
  private _collectExpectedPaths(
    tree: FsTree,
    target: string,
  ): {
    expectedDirs: Set<string>;
    expectedFiles: Set<string>;
  } {
    const expectedDirs = new Set<string>([target]);
    const expectedFiles = new Set<string>();

    for (const [, node] of tree.trees) {
      const meta = node?.meta as FsNodeMeta | null | undefined;
      /* v8 ignore next 3 -- @preserve */
      if (!meta) {
        continue;
      }
      if (meta.type === 'directory') {
        const dirPath =
          meta.relativePath === '.' ? target : join(target, meta.relativePath);
        expectedDirs.add(dirPath);
      } else if (meta.type === 'file') {
        const filePath = join(target, meta.relativePath);
        expectedFiles.add(filePath);
        expectedDirs.add(dirname(filePath));
      }
    }

    return { expectedDirs, expectedFiles };
  }

  /**
   * Remove files/dirs not present in the expected sets
   * @param currentDir - Directory currently being inspected
   * @param expectedDirs - Allowed directory paths
   * @param expectedFiles - Allowed file paths
   */
  private async _pruneExtraneous(
    currentDir: string,
    expectedDirs: Set<string>,
    expectedFiles: Set<string>,
  ): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!expectedDirs.has(fullPath)) {
          await rm(fullPath, { recursive: true, force: true });
          continue;
        }

        await this._pruneExtraneous(fullPath, expectedDirs, expectedFiles);
      } else {
        if (!expectedFiles.has(fullPath)) {
          await rm(fullPath, { force: true });
        }
      }
    }
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
      /* v8 ignore next 3 -- @preserve */
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

  /**
   * Watches database for tree changes and syncs to filesystem
   * Registers notification callbacks and automatically updates filesystem
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @returns Function to stop watching
   */
  async syncFromDb(db: Db, treeKey: string): Promise<() => void> {
    // Start watching filesystem (if not already watching)
    if (!this._scanner['_watcher']) {
      await this._scanner.watch();
    }

    // Register on the treeKey+ route to listen for insertions
    const notifyRoute = Route.fromFlat(`/${treeKey}+`);

    // Create callback to sync on DB changes
    const syncCallback = async (historyRow: any) => {
      // Validate history row structure
      if (!historyRow || typeof historyRow !== 'object') {
        console.error('[syncFromDb] Invalid history row received:', historyRow);
        return;
      }

      // Extract the tree reference from the history row
      const treeRef = historyRow[`${treeKey}Ref`];

      if (!treeRef || typeof treeRef !== 'string') {
        console.error(
          `[syncFromDb] Missing or invalid treeRef in history row. Expected string, got:`,
          typeof treeRef,
        );
        return;
      }

      // Pause filesystem watching to prevent loops
      this._scanner.pauseWatch();

      try {
        // Load tree from database and restore to filesystem
        await this.loadFromDb(db, treeKey, treeRef);
      } catch (error) {
        /* v8 ignore next 5 -- @preserve */
        console.error(
          `[syncFromDb] Failed to sync tree "${treeRef}" from database:`,
          error instanceof Error ? error.message : String(error),
        );
        // Don't re-throw - we don't want one sync failure to break the notification system
      } finally {
        // Always resume watching, even if there was an error
        this._scanner.resumeWatch();
      }
    };

    // Register notification callback
    db.notify.register(notifyRoute, syncCallback);

    // Return cleanup function
    return () => {
      db.notify.unregister(notifyRoute, syncCallback);
    };
  }

  /** Example instance for test purposes */
  static get example(): FsAgent {
    return new FsAgent(process.cwd());
  }
}
