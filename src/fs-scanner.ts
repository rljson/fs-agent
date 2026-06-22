// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { hip } from '@rljson/hash';
import { Json } from '@rljson/json';
import { Tree, TreeRef } from '@rljson/rljson';

import { FSWatcher, watch } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

// .............................................................................
// Types
// .............................................................................

/**
 * Metadata stored in Tree.meta for file system nodes
 */
export interface FsNodeMeta extends Json {
  /** Node name (file or directory name) */
  name: string;
  /** Type of node */
  type: 'file' | 'directory';
  /** Relative path from scan root (the cross-client-stable content identity) */
  relativePath: string;
  /** File size in bytes (for files) */
  size?: number;
  /** Blob ID for file content (files only) */
  blobId?: string;
  /**
   * Absolute path — informational only, NOT part of the content identity.
   * Excluded from stored meta so tree refs are folder-independent (shared
   * across clients). Retained in the type for back-compat.
   */
  path?: string;
  /**
   * Last modified timestamp — NOT part of the content identity (environment-
   * specific). Excluded from stored meta so refs are mtime-independent.
   */
  mtime?: number;
}

/**
 * Tree structure with hash mapping
 */
export interface FsTree {
  /** Root tree hash */
  rootHash: TreeRef;
  /** Map of hash to tree node */
  trees: Map<TreeRef, Tree>;
}

/**
 * Type of file system change
 */
export type FsChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'safety-rescan';

/**
 * File system change event
 */
export interface FsChange {
  /** Type of change */
  type: FsChangeType;
  /** Path that changed (relative to scan root) */
  path: string;
  /** Tree node (for added/modified) */
  tree?: Tree;
}

/**
 * Callback for file system changes
 */
export type FsChangeCallback = (change: FsChange) => void | Promise<void>;

/**
 * Options for scanning
 */
export interface FsScanOptions {
  /** Patterns to ignore (glob patterns) */
  ignore?: string[];
  /** Maximum depth to scan (undefined = unlimited) */
  maxDepth?: number;
  /** Follow symbolic links */
  followSymlinks?: boolean;
  /** Blob storage implementation (defaults to BsMem) */
  bs?: Bs;
}

// .............................................................................
// FsScanner Class
// .............................................................................

/**
 * Scans and watches file system changes, extracting RLJSON tree structure
 */
export class FsScanner {
  private _rootPath: string;
  private _tree: FsTree | null = null;
  private _watcher: FSWatcher | null = null;
  private _changeCallbacks: FsChangeCallback[] = [];
  private _options: FsScanOptions;
  private _bs: Bs;
  private _paused: boolean = false;
  private _missedChangesDuringPause: boolean = false;
  /** Periodic full-rescan timer that catches events the native watcher drops. */
  private _safetyTimer: ReturnType<typeof setInterval> | null = null;
  /** Set by stopWatch() so a pending watcher reinstall / rescan bails out. */
  private _stopRequested: boolean = false;

  constructor(rootPath: string, options: FsScanOptions = {}) {
    this._rootPath = rootPath;
    this._options = {
      ignore: options.ignore || ['node_modules', '.git', 'dist', 'coverage'],
      maxDepth: options.maxDepth,
      followSymlinks: options.followSymlinks ?? false,
      bs: options.bs,
    };
    this._bs = options.bs || new BsMem();
  }

  get tree(): FsTree | null {
    return this._tree;
  }

  get rootPath(): string {
    return this._rootPath;
  }

  get bs(): Bs {
    return this._bs;
  }

  async scan(): Promise<FsTree> {
    // Validate root path exists
    try {
      const stats = await stat(this._rootPath);
      if (!stats.isDirectory()) {
        throw new Error(
          `Root path "${this._rootPath}" exists but is not a directory`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Root path "${this._rootPath}" does not exist. Cannot scan non-existent directory.`,
        );
      }
      /* v8 ignore start -- @preserve */
      throw new Error(
        `Cannot access root path "${this._rootPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    /* v8 ignore stop -- @preserve */

    const trees = new Map<TreeRef, Tree>();
    let rootTree;
    try {
      rootTree = await this._scanDirectory(this._rootPath, '.', 0, trees);
    } catch (error) {
      /* v8 ignore start -- @preserve */
      throw new Error(
        `Failed to scan directory "${this._rootPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    /* v8 ignore stop -- @preserve */

    // Hash root tree in place (content-addressed by JSON)
    hip(rootTree);
    const rootHashStr = rootTree._hash as string;

    /* v8 ignore if -- @preserve */
    if (!rootHashStr) {
      throw new Error(
        'Failed to generate hash for root tree. Tree structure may be invalid.',
      );
    }

    // Add the root tree to the map
    trees.set(rootHashStr, rootTree);

    this._tree = {
      rootHash: rootHashStr,
      trees,
    };

    return this._tree;
  }

  private async _scanDirectory(
    absolutePath: string,
    relativePath: string,
    depth: number,
    trees: Map<TreeRef, Tree>,
  ): Promise<Tree> {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const childTrees: Tree[] = [];
    const childRefs: TreeRef[] = [];

    for (const entry of entries) {
      if (this._shouldIgnore(entry.name)) {
        continue;
      }

      const childPath = join(absolutePath, entry.name);
      const childRelPath =
        relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`;

      if (entry.isSymbolicLink() && !this._options.followSymlinks) {
        continue;
      }

      // Check max depth before processing children
      if (
        this._options.maxDepth !== undefined &&
        depth >= this._options.maxDepth
      ) {
        continue;
      }

      const childStats = await stat(childPath);
      /* v8 ignore else -- @preserve */
      if (entry.isDirectory()) {
        // Recursively scan directory
        const childTree = await this._scanDirectory(
          childPath,
          childRelPath,
          depth + 1,
          trees,
        );
        childTrees.push(childTree);

        // Hash directory tree node in place (JSON hash, NOT stored in Bs)
        hip(childTree);
        const childHashStr = childTree._hash as string;

        // Add child tree to map
        trees.set(childHashStr, childTree);
        childRefs.push(childHashStr);
      } else if (entry.isFile()) {
        /* v8 ignore else -- @preserve */
        // Store ONLY file content in blob storage (NOT tree node)
        let fileContent: Buffer;
        try {
          fileContent = await readFile(childPath);
        } catch (error) {
          throw new Error(
            `Failed to read file "${childRelPath}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        let blobProps;
        try {
          blobProps = await this._bs.setBlob(fileContent);
        } catch (error) {
          throw new Error(
            `Failed to store blob for file "${childRelPath}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!blobProps || !blobProps.blobId) {
          throw new Error(
            `Blob storage returned invalid blobId for file "${childRelPath}"`,
          );
        }

        const fileMeta: FsNodeMeta = {
          name: entry.name,
          type: 'file',
          relativePath: childRelPath,
          size: childStats.size,
          // mtime is kept for files (restore preserves it, so it round-trips to
          // the same ref on every client) but NOT for directories (a folder's
          // mtime is per-machine and does not round-trip). The absolute `path`
          // is excluded everywhere — it is folder-specific.
          mtime: childStats.mtime.getTime(),
          blobId: blobProps.blobId, // Link to content in Bs
        };

        const fileTree: Tree = {
          id: entry.name,
          isParent: false,
          meta: fileMeta,
          children: null,
        };

        childTrees.push(fileTree);

        // Hash file tree node in place (JSON hash, NOT stored in Bs)
        hip(fileTree);
        const fileTreeHashStr = fileTree._hash as string;

        // Add file tree to map
        trees.set(fileTreeHashStr, fileTree);
        childRefs.push(fileTreeHashStr);
      }
    }

    // Create directory tree node. The root's name is normalised to '.' (the
    // mount-point folder name is environment-specific and would otherwise make
    // the root hash folder-dependent, breaking shared cross-client refs).
    const dirName =
      relativePath === '.'
        ? '.'
        : /* v8 ignore next -- @preserve */
          relativePath.split('/').pop() || '';

    const dirMeta: FsNodeMeta = {
      name: dirName,
      type: 'directory',
      relativePath,
    };

    const dirTree: Tree = {
      id: dirName,
      isParent: childRefs.length > 0,
      meta: dirMeta,
      children: childRefs.length > 0 ? childRefs : null,
    };

    return dirTree;
  }

  private _shouldIgnore(name: string): boolean {
    /* v8 ignore next -- @preserve */
    if (!this._options.ignore) {
      return false;
    }
    for (const pattern of this._options.ignore) {
      if (name === pattern || name.startsWith(pattern)) {
        return true;
      }
    }
    return false;
  }

  async watch(): Promise<void> {
    if (this._watcher) {
      throw new Error('Already watching. Call stopWatch() first.');
    }
    /* v8 ignore next -- @preserve */
    if (!this._tree) {
      await this.scan();
    }
    /* v8 ignore start -- @preserve native watcher wiring is not unit-testable */
    const onEvent = async (eventType: string, filename: string | null) => {
      if (!filename) return;
      if (this._shouldIgnore(filename)) {
        return;
      }
      await this._handleFileChange(eventType, filename);
    };
    // Native fs.watch on Windows surfaces EPERM/ENOBUFS via 'error' when its
    // internal change buffer overflows under a burst (renaming a whole folder,
    // antivirus rescan). The handle is dead at that point — close and reinstall
    // a fresh watcher; events lost in the gap are recovered by the safety scan.
    const onError = (err: unknown): void => {
      console.warn(
        `[fs-scanner] watcher error: ${FsScanner._errMessage(err)} — reinstalling`,
      );
      try {
        this._watcher?.close();
      } catch {
        // already closed
      }
      this._watcher = null;
      setTimeout(() => {
        if (this._stopRequested) return;
        try {
          this._watcher = watch(this._rootPath, { recursive: true }, onEvent);
          this._watcher.on('error', onError);
        } catch (e) {
          console.warn(
            `[fs-scanner] watcher reinstall failed: ${FsScanner._errMessage(e)}`,
          );
        }
      }, 500);
    };
    this._stopRequested = false;
    this._watcher = watch(this._rootPath, { recursive: true }, onEvent);
    this._watcher.on('error', onError);
    /* v8 ignore stop -- @preserve */

    // Periodic safety net: native fs.watch drops events under burst load
    // (especially Windows ReadDirectoryChangesW). A periodic full rescan +
    // notify catches drift the watcher missed — one O(N) scan every 30 s.
    /* v8 ignore next -- @preserve stopWatch clears the timer with the watcher, so it is always null here */
    if (!this._safetyTimer) {
      this._safetyTimer = setInterval(() => {
        /* v8 ignore next -- @preserve timer firing is exercised via _runSafetyRescan */
        void this._runSafetyRescan();
      }, 30_000);
      this._safetyTimer.unref?.();
    }
  }

  /**
   * One safety-rescan pass: rescans the tree and, if its content differs from
   * the previous scan (the native watcher dropped an event), emits a sync
   * notification so syncToDb reconciles the drift. Paused/stopped scanners and
   * scan failures are no-ops.
   */
  private async _runSafetyRescan(): Promise<void> {
    if (this._paused || this._stopRequested) return;
    /* v8 ignore next -- @preserve _tree is set before the timer ever fires */
    const prevKey = this._tree ? this._safetyContentKey(this._tree) : null;
    try {
      await this.scan();
    } catch (err) {
      console.warn(
        `[fs-scanner] safety rescan failed: ${FsScanner._errMessage(err)}`,
      );
      return;
    }
    /* v8 ignore next -- @preserve defensive: pause/stop racing the scan */
    if (this._paused || this._stopRequested) return;
    /* v8 ignore next -- @preserve scan() always sets _tree on success */
    const nextKey = this._tree ? this._safetyContentKey(this._tree) : null;
    if (prevKey !== nextKey) {
      console.warn(
        `[fs-scanner] safety rescan detected drift on ${this._rootPath} — notifying`,
      );
      await this._notifyChange({ type: 'safety-rescan', path: '.' });
    }
  }

  /**
   * Path+blobId content fingerprint used by the safety rescan to detect drift
   * the native watcher missed (mtime-independent, same idea as the agent's
   * content key but local to the scanner).
   * @param tree - The tree to fingerprint
   * @returns A stable content key
   */
  private _safetyContentKey(tree: FsTree): string {
    const parts: string[] = [];
    for (const [, node] of tree.trees) {
      const meta = node.meta as FsNodeMeta | null;
      /* v8 ignore next -- @preserve scanned nodes always carry meta */
      if (!meta) continue;
      if (meta.type === 'file') {
        /* v8 ignore next -- @preserve scanned files always carry a blobId */
        parts.push(`${meta.relativePath}:${meta.blobId ?? ''}`);
      } else if (meta.type === 'directory' && meta.relativePath !== '.') {
        parts.push(`d:${meta.relativePath}`);
      }
    }
    parts.sort();
    return parts.join('\n');
  }

  /**
   * Extracts a readable message from a thrown value.
   * @param err - The caught value
   * @returns A message string
   */
  private static _errMessage(err: unknown): string {
    /* v8 ignore next -- @preserve non-Error throws are defensive */
    return err instanceof Error ? err.message : String(err);
  }

  private async _handleFileChange(
    _eventType: string,
    filename: string,
  ): Promise<void> {
    // Skip processing if paused — but record that we missed a change
    if (this._paused) {
      this._missedChangesDuringPause = true;
      return;
    }

    const relativePath = filename.replace(/\\/g, '/');
    const fullPath = join(this._rootPath, filename);

    // Windows briefly reports ENOENT/EBUSY for a file that was just written or
    // renamed (antivirus, indexer, save-and-rename editors). A single stat()
    // failure is not proof of deletion — retry a few times with a short backoff
    // before concluding the file is gone.
    let exists = false;
    for (let i = 0; i < 4; i++) {
      try {
        await stat(fullPath);
        exists = true;
        break;
      } catch {
        /* v8 ignore next -- @preserve last iteration falls through */
        if (i < 3) await new Promise((r) => setTimeout(r, 80 + i * 80));
      }
    }

    try {
      if (exists) {
        // File added or modified — rescan to update the tree, then notify.
        const existingTree = this._findTreeByPath(relativePath);
        await this.scan();
        await this._notifyChange({
          type: existingTree ? 'modified' : 'added',
          path: relativePath,
        });
        return;
      }

      // Gone after retries. Only stop watching if the root itself disappeared;
      // otherwise emit a delete for this path.
      let rootExists = false;
      try {
        await stat(this._rootPath);
        rootExists = true;
      } catch {
        this.stopWatch();
      }
      if (rootExists) {
        await this.scan();
        await this._notifyChange({ type: 'deleted', path: relativePath });
      }
    } catch {
      // Transient scan/notify failure (locked file, etc.) — skip this event;
      // the watcher stays alive and the next change triggers a fresh scan.
    }
  }

  private _findTreeByPath(relativePath: string): Tree | undefined {
    if (!this._tree) return undefined;

    for (const tree of this._tree.trees.values()) {
      const meta = tree.meta as FsNodeMeta | null;
      if (meta && meta.relativePath === relativePath) {
        return tree;
      }
    }
    return undefined;
  }

  private async _notifyChange(change: FsChange): Promise<void> {
    // Don't notify if watching is paused (prevents loops during external updates)
    /* v8 ignore if -- @preserve */
    if (this._paused) {
      return;
    }

    for (const callback of this._changeCallbacks) {
      await callback(change);
    }
  }

  onChange(callback: FsChangeCallback): void {
    this._changeCallbacks.push(callback);
  }

  offChange(callback: FsChangeCallback): void {
    this._changeCallbacks = this._changeCallbacks.filter(
      (cb) => cb !== callback,
    );
  }

  stopWatch(): void {
    this._stopRequested = true;
    if (this._safetyTimer) {
      clearInterval(this._safetyTimer);
      this._safetyTimer = null;
    }
    /* v8 ignore next -- @preserve */
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  /**
   * Temporarily pause file change notifications
   * Used to prevent loops when updating filesystem from external source
   */
  pauseWatch(): void {
    this._paused = true;
    this._missedChangesDuringPause = false;
  }

  /**
   * Resume file change notifications.
   * If any filesystem events were missed during the pause, triggers
   * an asynchronous rescan so that syncToDb can detect and push the changes.
   */
  resumeWatch(): void {
    const missedChanges = this._missedChangesDuringPause;
    this._paused = false;
    this._missedChangesDuringPause = false;
    if (missedChanges) {
      void this._rescanAfterPause();
    }
  }

  /**
   * Re-scan the filesystem and fire onChange callbacks to catch modifications
   * that were missed while watching was paused.
   */
  private async _rescanAfterPause(): Promise<void> {
    try {
      await this.scan();
      /* v8 ignore if -- @preserve */
      if (this._paused) {
        return;
      }
      await this._notifyChange({ type: 'modified', path: '.' });
    } catch {
      /* v8 ignore start -- @preserve */
      // Ignore — the next filesystem event will trigger a fresh scan.
    }
    /* v8 ignore stop -- @preserve */
  }

  getTreeByHash(treeHash: TreeRef): Tree | undefined {
    return this._tree?.trees.get(treeHash);
  }

  getTreeByPath(relativePath: string): Tree | undefined {
    return this._findTreeByPath(relativePath);
  }

  getAllTrees(): Tree[] {
    if (!this._tree) {
      return [];
    }
    return Array.from(this._tree.trees.values());
  }

  getChildren(treeHash: TreeRef): Tree[] {
    const tree = this.getTreeByHash(treeHash);
    if (!tree || !tree.children) {
      return [];
    }

    return tree.children
      .map((childHash: TreeRef) => this.getTreeByHash(childHash))
      .filter((t: Tree | undefined): t is Tree => t !== undefined);
  }

  getRootTree(): Tree | undefined {
    /* v8 ignore next -- @preserve */
    if (!this._tree) return undefined;
    return this._tree.trees.get(this._tree.rootHash);
  }

  static example(): FsScanner {
    return new FsScanner(process.cwd(), {
      ignore: ['node_modules', '.git', 'dist', 'coverage'],
    });
  }
}
