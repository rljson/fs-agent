// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { ClientId, Route, SyncConfig } from '@rljson/rljson';

import { mkdir, readdir, rm, utimes, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { FsBlobAdapter } from './fs-blob-adapter.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import type { Connector, Db } from '@rljson/db';
import type { FsNodeMeta } from './fs-scanner.ts';

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
  /** Restore options applied when syncing from DB */
  restoreOptions?: RestoreOptions;
  /** Timeout configuration for async operations */
  timeouts?: TimeoutConfig;
  /**
   * Centralized sync protocol configuration.
   * When provided, this SyncConfig is forwarded to every Connector
   * created by {@link FsAgent.fromClient}, and governs whether
   * `sendWithAck()` (when `requireAck` is true) or `send()` is used
   * in {@link FsAgent.syncToDb}.
   *
   * The same SyncConfig should also be passed to the Server and Client
   * constructors so that every layer uses the same protocol settings.
   */
  syncConfig?: SyncConfig;
  /**
   * Stable client identity. When provided, it is forwarded to every
   * Connector created by {@link FsAgent.fromClient}. When omitted but
   * `syncConfig.includeClientIdentity` is true, each Connector
   * auto-generates its own identity.
   */
  clientIdentity?: ClientId;
}

/** Restore options */
export interface RestoreOptions {
  /** Remove files/dirs on target that are not present in the tree */
  cleanTarget?: boolean;
}

/**
 * Timeout configuration for async operations (milliseconds).
 * Every async operation in FsAgent is guarded by a timeout to prevent
 * silent hangs in socket communication, filesystem I/O, or database queries.
 */
export interface TimeoutConfig {
  /** Timeout for a single db.get() query. Default: 10 000 ms */
  dbQuery?: number;
  /** Timeout for fetching an entire tree from the DB. Default: 20 000 ms */
  fetchTree?: number;
  /** Timeout for a filesystem extract / scan. Default: 15 000 ms */
  extract?: number;
  /** Timeout for a filesystem restore. Default: 15 000 ms */
  restore?: number;
  /** Timeout for the overall syncFromDb callback. Default: 25 000 ms */
  syncCallback?: number;
  /**
   * Debounce delay for sync callbacks (milliseconds). Default: 300 ms.
   * Rapid filesystem events (e.g. macOS Finder "Keep Both" copy+rename)
   * are coalesced into a single sync operation after this quiet period.
   * Also applies to incoming database refs in syncFromDb.
   */
  debounceMs?: number;
}

/** Sensible defaults – every operation is bounded */
const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  dbQuery: 10_000,
  fetchTree: 20_000,
  extract: 15_000,
  restore: 15_000,
  syncCallback: 25_000,
  debounceMs: 300,
};

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
  private _lastSentRef?: string;
  /** Content fingerprint of the last tree we broadcasted (paths+blobIds) */
  private _lastSentContentKey?: string;
  private _timeouts: Required<TimeoutConfig>;

  constructor(rootPath: string, bs?: Bs, options: FsAgentOptions = {}) {
    this._rootPath = rootPath;
    this._bs = bs || new BsMem();
    this._db = options.db;
    this._treeKey = options.treeKey;
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this._scanner = new FsScanner(rootPath, { ...options, bs: this._bs });
    this._adapter = new FsBlobAdapter(this._bs);

    // Automatically start syncing if db and treeKey are provided
    /* v8 ignore next -- @preserve */
    if (this._db && this._treeKey) {
      this._startAutoSync().catch(() => {
        // Intentionally ignored - deprecated constructor pattern
      });

      // Start reverse sync if bidirectional is enabled
      this._startAutoSyncFromDb(options.bidirectional || false).catch(() => {
        // Intentionally ignored - deprecated constructor pattern
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
   * Gets the current timeout configuration
   */
  get timeouts(): Required<TimeoutConfig> {
    return this._timeouts;
  }

  /**
   * Wraps a promise with a timeout.
   * Rejects with a descriptive error if the promise does not settle
   * within the given number of milliseconds.
   * @param promise - The promise to guard
   * @param ms - Maximum allowed time in milliseconds
   * @param label - Human-readable label included in the error message
   */
  private static _withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms: ${label}`));
      }, ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Sends a ref through the connector.
   * Uses `sendWithAck()` when the connector has `requireAck` enabled,
   * otherwise falls back to fire-and-forget `send()`.
   * @param connector - The Connector to send through
   * @param ref - The ref to broadcast
   */
  private async _sendRef(connector: Connector, ref: string): Promise<void> {
    if (connector.syncConfig?.requireAck) {
      await connector.sendWithAck(ref);
    } else {
      connector.send(ref);
    }
  }

  /**
   * Starts automatic syncing to database
   * Note: Auto-sync requires Connector which is not available in constructor.
   * Consider using syncToDb() directly instead of constructor options.
   */
  private async _startAutoSync(): Promise<void> {
    /* v8 ignore next -- @preserve */
    if (!this._db || !this._treeKey) {
      return;
    }

    // Cannot create Connector without socket - auto-sync not supported
    /* v8 ignore next -- @preserve */
    throw new Error(
      'Auto-sync from constructor is not supported. ' +
        'Use syncToDb() method directly with a Connector instance.',
    );
  }

  /**
   * Starts automatic syncing from database
   * @param bidirectional - Whether bidirectional sync is enabled
   * Note: Auto-sync requires Connector which is not available in constructor.
   * Consider using syncFromDb() directly instead of constructor options.
   */
  private async _startAutoSyncFromDb(bidirectional: boolean): Promise<void> {
    /* v8 ignore if -- @preserve */
    if (!this._db || !this._treeKey || !bidirectional) {
      return;
    }

    // Cannot create Connector without socket - auto-sync not supported
    /* v8 ignore next -- @preserve */
    throw new Error(
      'Auto-sync from constructor is not supported. ' +
        'Use syncFromDb() method directly with a Connector instance.',
    );
  }

  /**
   * Stops automatic syncing and cleans up resources
   */
  dispose(): void {
    /* v8 ignore if -- @preserve */
    if (this._stopSync) {
      this._stopSync();
      this._stopSync = undefined;
    }
    /* v8 ignore if -- @preserve */
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
    /* v8 ignore if -- @preserve */
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
    /* v8 ignore if -- @preserve */
    if (!tree || !tree.rootHash || !tree.trees) {
      throw new Error(
        'Cannot store empty or invalid tree in database. ' +
          'Ensure the filesystem has been scanned and contains valid data.',
      );
    }

    /* v8 ignore if -- @preserve */
    if (tree.trees.size === 0) {
      throw new Error(
        'Cannot store tree with no nodes. The tree structure is empty.',
      );
    }

    const dbAdapter = new FsDbAdapter(db, treeKey);
    return await dbAdapter.storeFsTree(tree, options);
  }

  /**
   * Recursively fetches all tree nodes starting from a root hash
   * Trees are stored as separate rows with parent-child relationships
   * This method follows the tree structure and fetches all related nodes
   * @param db - Database instance
   * @param route - Route to tree table
   * @param treeKey - Tree table key
   * @param rootHash - Hash of the root node to start fetching from
   * @returns Array of all tree nodes in the tree
   */
  private async _fetchTreeRecursively(
    db: Db,
    route: Route,
    treeKey: string,
    rootHash: string,
  ): Promise<any[]> {
    const fetchedNodes = new Map<string, any>();
    const nodesToFetch = new Set<string>([rootHash]);
    const processed = new Set<string>();

    // Iteratively fetch all nodes (avoid deep recursion)
    while (nodesToFetch.size > 0) {
      const currentHash = Array.from(nodesToFetch)[0];
      nodesToFetch.delete(currentHash);

      // Skip if already processed
      /* v8 ignore if -- @preserve */
      if (processed.has(currentHash)) {
        continue;
      }
      processed.add(currentHash);

      // Fetch the node by hash
      // Use db.get() to query across sockets via IoMulti/IoPeer
      // The early return fix in @rljson/db prevents infinite recursion
      let result;
      try {
        result = await FsAgent._withTimeout(
          db.get(route, { _hash: currentHash }),
          this._timeouts.dbQuery,
          `db.get(${treeKey}, _hash=${currentHash.slice(0, 8)}…)`,
        );
      } catch (error) {
        // Re-throw timeout errors — they indicate a systemic problem
        /* v8 ignore if -- @preserve */
        if (error instanceof Error && error.message.startsWith('Timeout')) {
          throw error;
        }
        /* v8 ignore start -- @preserve */
        // Node not found - might be a blob reference or deleted
        continue;
      }
      /* v8 ignore stop -- @preserve */

      // Extract node data from rljson
      const treeData = result?.rljson?.[treeKey];
      /* v8 ignore next -- @preserve */
      if (!treeData || !treeData._data) {
        continue;
      }

      // Handle both array and object-with-numeric-keys
      /* v8 ignore next -- @preserve */
      const dataArray = Array.isArray(treeData._data)
        ? treeData._data
        : Object.values(treeData._data);

      // Process all nodes returned (should be just one for _hash query)
      for (const node of dataArray) {
        /* v8 ignore next -- @preserve */
        if (!node._hash) continue;

        fetchedNodes.set(node._hash, node);

        // If node has children, add them to fetch queue
        if (node.children && Array.isArray(node.children)) {
          for (const childHash of node.children) {
            /* v8 ignore next -- @preserve */
            if (typeof childHash === 'string' && !processed.has(childHash)) {
              nodesToFetch.add(childHash);
            }
          }
        }
      }
    }

    return Array.from(fetchedNodes.values());
  }

  /**
   * Fetches tree from database without restoring to filesystem.
   * Separated from loadFromDb to allow content comparison before restore.
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param rootRef - Root tree reference (hash)
   * @returns FsTree structure ready for restore
   */
  private async _fetchTreeFromDb(
    db: Db,
    treeKey: string,
    rootRef: string,
  ): Promise<FsTree> {
    // Validate inputs
    if (!rootRef || rootRef.trim() === '') {
      throw new Error('rootRef cannot be empty');
    }

    // Recursively fetch all tree nodes starting from root
    // Trees are stored as multiple rows - querying by hash only returns one node
    // We need to fetch the root node and recursively fetch all children
    const route = Route.fromFlat(treeKey);
    const allNodes = await FsAgent._withTimeout(
      this._fetchTreeRecursively(db, route, treeKey, rootRef),
      this._timeouts.fetchTree,
      `fetchTree(${treeKey}@${rootRef.slice(0, 8)}…)`,
    );

    if (allNodes.length === 0) {
      throw new Error(
        `No tree nodes found for ${treeKey}@${rootRef}. ` +
          `The tree may have been deleted or the reference is invalid.`,
      );
    }

    // Build trees Map from all fetched nodes
    const trees = new Map<string, any>();
    for (const treeNode of allNodes) {
      /* v8 ignore if -- @preserve */
      if (treeNode._hash) {
        trees.set(treeNode._hash, treeNode);
      }
    }

    // Validate root tree exists
    /* v8 ignore if -- @preserve */
    if (!trees.has(rootRef)) {
      throw new Error(
        `Root tree node "${rootRef}" not found in tree data. ` +
          `Available hashes: ${Array.from(trees.keys()).slice(0, 5).join(', ')}${trees.size > 5 ? '...' : ''}`,
      );
    }

    return { rootHash: rootRef, trees };
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
    const fsTree = await this._fetchTreeFromDb(db, treeKey, rootRef);
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
      /* v8 ignore if -- @preserve */
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
   * Uses Connector for socket-based broadcast
   * @param db - Database instance
   * @param connector - Connector instance for socket-based sync
   * @param treeKey - Tree table key
   * @param options - Storage options (e.g., skipNotification)
   * @returns Function to stop watching
   */
  async syncToDb(
    db: Db,
    connector: Connector,
    treeKey: string,
    options?: StoreFsTreeOptions,
  ): Promise<() => void> {
    // Store initial state
    const initialRef = await FsAgent._withTimeout(
      this.storeInDb(db, treeKey, options),
      this._timeouts.fetchTree,
      `syncToDb → initial storeInDb(${treeKey})`,
    );

    // Send initial ref through connector (self-filtering will prevent loops)
    /* v8 ignore next -- @preserve */
    if (initialRef) {
      this._lastSentRef = initialRef;
      const currentTree = this._scanner.tree;
      /* v8 ignore if -- @preserve */
      if (currentTree) {
        this._lastSentContentKey = this._contentKeyFromTree(currentTree);
      }
      await this._sendRef(connector, initialRef);
    }

    // Debounced callback: coalesce rapid filesystem events (e.g. macOS
    // Finder "Keep Both" copy + rename) into a single store+broadcast.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const debouncedSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        const tree = this._scanner.tree;
        /* v8 ignore if -- @preserve */
        if (tree) {
          try {
            // Content-level dedup: if the tree has the exact same files +
            // blobIds as the last tree we broadcasted, skip entirely.
            // This catches bounce-backs that have different mtimes (and
            // therefore different tree hashes / refs) but identical content.
            const contentKey = this._contentKeyFromTree(tree);
            if (contentKey === this._lastSentContentKey) {
              return;
            }

            const dbAdapter = new FsDbAdapter(db, treeKey);
            const ref = await FsAgent._withTimeout(
              dbAdapter.storeFsTree(tree, options),
              this._timeouts.fetchTree,
              `syncToDb → storeFsTree(${treeKey})`,
            );

            // Skip broadcast if the ref matches what we already sent.
            // This happens after syncFromDb restores files: the watcher
            // fires, we store the same tree, and get the same ref back.
            if (ref === this._lastSentRef) {
              return;
            }

            // Track the ref and content we're sending
            this._lastSentRef = ref;
            this._lastSentContentKey = contentKey;

            // Broadcast the new ref through connector
            if (ref) {
              await this._sendRef(connector, ref);
            }
          } catch {
            /* v8 ignore start -- @preserve */
            // Don't re-throw — one sync failure must not crash the watcher
          }
          /* v8 ignore stop -- @preserve */
        }
      }, this._timeouts.debounceMs);
    };

    // Register callback and start watching
    this._scanner.onChange(debouncedSync);
    await this._scanner.watch();

    // Return cleanup function
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      this._scanner.offChange(debouncedSync);
      this._scanner.stopWatch();
    };
  }

  /**
   * Builds a map of relativePath → blobId for all files in a tree.
   * Used to compare trees by content rather than by hash (which includes mtime).
   * @param tree - Tree structure to extract file content map from
   */
  private _getFileContentMap(tree: FsTree): Map<string, string> {
    const map = new Map<string, string>();
    for (const [, node] of tree.trees) {
      const meta = node?.meta;
      if (meta?.type === 'file') {
        /* v8 ignore next -- @preserve */
        map.set(meta.relativePath as string, (meta.blobId as string) ?? '');
      } else if (meta?.type === 'directory' && meta.relativePath !== '.') {
        // Include directories so that adding/removing empty dirs changes the
        // content key and is not silently deduplicated.
        map.set(meta.relativePath as string, '<dir>');
      }
    }
    return map;
  }

  /**
   * Derives a deterministic string key from a content map so that two trees
   * with identical file paths + blobIds produce the same key regardless of
   * mtime differences.
   * @param map - Content map (relativePath → blobId)
   */
  private _contentKeyFromMap(map: Map<string, string>): string {
    const sorted = Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return sorted.map(([p, b]) => `${p}:${b}`).join('\n');
  }

  /**
   * Derives a deterministic content key from an FsTree.
   * @param tree - Tree structure to derive content key from
   */
  private _contentKeyFromTree(tree: FsTree): string {
    return this._contentKeyFromMap(this._getFileContentMap(tree));
  }

  /**
   * Compares two trees by file content (relativePath + blobId).
   * Ignores mtime differences — trees are equivalent if they have the same
   * files with the same content. This prevents bounce-back restores from
   * destroying locally-created files during bidirectional sync.
   * @param a - First tree to compare
   * @param b - Second tree to compare
   */
  private _treesHaveEquivalentContent(a: FsTree, b: FsTree): boolean {
    const aFiles = this._getFileContentMap(a);
    const bFiles = this._getFileContentMap(b);

    if (aFiles.size !== bFiles.size) return false;

    for (const [path, blobId] of aFiles) {
      if (bFiles.get(path) !== blobId) return false;
    }

    return true;
  }

  /**
   * Watches database for tree changes and syncs to filesystem
   * Uses Connector for socket-based notifications
   * @param db - Database instance
   * @param connector - Connector instance for socket-based sync
   * @param treeKey - Tree table key
   * @param restoreOptions - Restore options (e.g., cleanTarget)
   * @returns Function to stop watching
   */
  async syncFromDb(
    db: Db,
    connector: Connector,
    treeKey: string,
    restoreOptions?: RestoreOptions,
  ): Promise<() => void> {
    // Start watching filesystem (if not already watching)
    if (!this._scanner['_watcher']) {
      await this._scanner.watch();
    }

    // Debounced incoming ref handler: when multiple refs arrive in rapid
    // succession (e.g. the other side is doing a multi-step Finder operation),
    // only the LAST ref is processed after a quiet period.
    let pendingRef: string | null = null;
    let fromDbTimer: ReturnType<typeof setTimeout> | null = null;

    const processRef = async (treeRef: string) => {
      // Pause filesystem watching to prevent loops
      this._scanner.pauseWatch();

      try {
        // Fetch incoming tree from DB (without restoring yet)
        const incomingTree = await FsAgent._withTimeout(
          this._fetchTreeFromDb(db, treeKey, treeRef),
          this._timeouts.fetchTree,
          `syncFromDb → fetchTree(${treeKey}@${treeRef.slice(0, 8)}…)`,
        );

        // Extract current filesystem state for content comparison
        const currentTree = await FsAgent._withTimeout(
          this.extract(),
          this._timeouts.extract,
          `syncFromDb → extract(${this._rootPath})`,
        );

        // Compare file content (paths + blobIds, ignoring mtime).
        // If identical, this is a bounce-back — skip restore to avoid
        // cleanTarget deleting locally-created files.
        if (this._treesHaveEquivalentContent(currentTree, incomingTree)) {
          return;
        }

        // Content differs — restore from incoming tree
        await FsAgent._withTimeout(
          this.restore(incomingTree, undefined, restoreOptions),
          this._timeouts.restore,
          `syncFromDb → restore(${treeKey})`,
        );

        // After restore: re-scan the filesystem so the scanner's internal
        // tree matches the just-restored state, then store and record the
        // ref.  When the watcher fires (because restore touched files on
        // disk), debouncedSync will produce the same content key → skip.
        //
        // IMPORTANT: skipNotification must be true here.  This store is
        // just bookkeeping — recording the current state after restore.
        // If we let notify fire, Connector broadcasts a ref, the other
        // side processes it, stores again (also broadcasting), and we get
        // an extra bounce-back cycle that can race with real file
        // mutations happening right after the settling period.
        const postRestoreTree = await this._scanner.scan();
        const dbAdapter = new FsDbAdapter(db, treeKey);
        const postRestoreRef = await dbAdapter.storeFsTree(postRestoreTree, {
          skipNotification: true,
        });
        this._lastSentRef = postRestoreRef;
        this._lastSentContentKey = this._contentKeyFromTree(postRestoreTree);
      } catch {
        /* v8 ignore start -- @preserve */
        // Don't re-throw - we don't want one sync failure to break the notification system
      } finally {
        /* v8 ignore stop -- @preserve */
        // Always resume watching, even if there was an error
        this._scanner.resumeWatch();
      }
    };

    // Create callback to sync on DB changes.
    // listen() already handles origin-filtering and ref-level dedup,
    // so we only need content-level bounce-back detection (in processRef)
    // and debouncing for rapid incoming refs.
    const syncCallback = async (treeRef: string) => {
      // Validate the tree reference
      if (!treeRef || typeof treeRef !== 'string') {
        return;
      }

      // Store latest ref and (re)start debounce timer
      pendingRef = treeRef;
      /* v8 ignore next -- @preserve */
      if (fromDbTimer) clearTimeout(fromDbTimer);
      fromDbTimer = setTimeout(async () => {
        fromDbTimer = null;
        const ref = pendingRef;
        pendingRef = null;
        /* v8 ignore if -- @preserve */
        if (ref) {
          await processRef(ref);
        }
      }, this._timeouts.debounceMs);
    };

    // Register callback with Connector using the safe, deduplicated API
    connector.listen(syncCallback);

    // Return cleanup function
    return () => {
      if (fromDbTimer) clearTimeout(fromDbTimer);
      connector.tearDown();
    };
  }

  /**
   * Creates a fully configured FsAgent from a Client instance.
   * This factory method provides a simplified API where sync methods don't require
   * db, connector, and treeKey parameters - they are stored internally.
   * @param filePath - Directory path to sync
   * @param treeKey - Tree table key (route will be `/${treeKey}`)
   * @param client - Client instance with io and bs properties
   * @param socket - Socket instance for connector communication
   * @param options - Optional FsAgent options (db and treeKey are set automatically).
   *   `syncConfig` and `clientIdentity` from these options are forwarded to
   *   the Connector so that a single config origin governs all layers.
   * @returns Configured FsAgent instance with simplified sync API
   * @example
   * ```typescript
   * const syncConfig: SyncConfig = { requireAck: true, maxDedupSetSize: 5000 };
   * const agent = await FsAgent.fromClient(
   *   './my-folder', 'sharedTree', client, socket, { syncConfig },
   * );
   * // Simplified sync methods - no db/connector/treeKey needed
   * await agent.syncToDbSimple();
   * await agent.syncFromDbSimple({ cleanTarget: true });
   * // Original methods still work
   * await agent.syncToDb(db, connector, treeKey);
   * ```
   */
  static async fromClient(
    filePath: string,
    treeKey: string,
    client: any, // Client type from \@rljson/server
    socket: any, // Socket type from \@rljson/io
    options?: Omit<FsAgentOptions, 'db' | 'treeKey'>,
  ): Promise<
    FsAgent & {
      syncToDbSimple: (options?: StoreFsTreeOptions) => Promise<() => void>;
      syncFromDbSimple: (options?: RestoreOptions) => Promise<() => void>;
    }
  > {
    // Validate client has required properties
    if (!client.io) {
      throw new Error('Client.io is not initialized');
    }

    if (!client.bs) {
      throw new Error('Client.bs is not initialized');
    }

    // Import Db and Connector dynamically to avoid circular deps
    const { Db, Connector } = await import('@rljson/db');

    // Create Db from client.io
    const db = new Db(client.io);

    // Create Route from treeKey
    const route = Route.fromFlat(`/${treeKey}`);

    // Create Connector with centralized SyncConfig and ClientIdentity
    const connector = new Connector(
      db,
      route,
      socket,
      options?.syncConfig,
      options?.clientIdentity,
    );

    // Create FsAgent with client's blob storage
    const agent = new FsAgent(filePath, client.bs, options);

    // Add simplified sync methods
    const enhancedAgent = agent as any;

    enhancedAgent.syncToDbSimple = async (syncOptions?: StoreFsTreeOptions) => {
      return agent.syncToDb(db, connector, treeKey, syncOptions);
    };

    enhancedAgent.syncFromDbSimple = async (restoreOpts?: RestoreOptions) => {
      return agent.syncFromDb(db, connector, treeKey, restoreOpts);
    };

    return enhancedAgent;
  }

  /** Example instance for test purposes */
  static get example(): FsAgent {
    return new FsAgent(process.cwd());
  }
}
