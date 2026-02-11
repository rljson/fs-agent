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
import { join, sep } from 'path';

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
  /** Absolute path */
  path: string;
  /** Relative path from scan root */
  relativePath: string;
  /** File size in bytes (for files) */
  size?: number;
  /** Last modified timestamp (milliseconds since epoch) */
  mtime: number;
  /** Blob ID for file content (files only) */
  blobId?: string;
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
export type FsChangeType = 'added' | 'modified' | 'deleted';

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
    const stats = await stat(absolutePath);
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
          path: childPath,
          relativePath: childRelPath,
          size: childStats.size,
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

    // Create directory tree node
    const dirName =
      relativePath === '.'
        ? /* v8 ignore next -- @preserve */
          this._rootPath.split(sep).pop() || ''
        : /* v8 ignore next -- @preserve */
          relativePath.split('/').pop() || '';

    const dirMeta: FsNodeMeta = {
      name: dirName,
      type: 'directory',
      path: absolutePath,
      relativePath,
      mtime: stats.mtime.getTime(),
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
    this._watcher = watch(
      this._rootPath,
      { recursive: true },
      /* v8 ignore next -- @preserve */
      async (eventType, filename) => {
        if (!filename) return;
        if (this._shouldIgnore(filename)) {
          return;
        }
        await this._handleFileChange(eventType, filename);
      },
    );
  }

  private async _handleFileChange(
    _eventType: string,
    filename: string,
  ): Promise<void> {
    // Skip processing if paused
    if (this._paused) {
      return;
    }

    const relativePath = filename.replace(/\\/g, '/');

    try {
      await stat(join(this._rootPath, filename));
      const existingTree = this._findTreeByPath(relativePath);

      /* v8 ignore next -- @preserve */
      if (!existingTree) {
        // File was added - rescan to rebuild tree
        await this.scan();
        await this._notifyChange({
          type: 'added',
          path: relativePath,
        });
      } else {
        // File was modified - rescan to update hashes
        await this.scan();
        await this._notifyChange({
          type: 'modified',
          path: relativePath,
        });
      }
    } catch {
      // Check if root directory still exists
      try {
        await stat(this._rootPath);
        // Root exists, so file was deleted
        await this.scan();
        await this._notifyChange({
          type: 'deleted',
          path: relativePath,
        });
      } catch {
        // Root directory no longer exists - stop watching
        this.stopWatch();
      }
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
  }

  /**
   * Resume file change notifications
   */
  resumeWatch(): void {
    this._paused = false;
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
