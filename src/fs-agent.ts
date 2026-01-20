// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';

import { join } from 'path';

import { FsBlobAdapter } from './fs-blob-adapter.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

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

  constructor(rootPath: string, bs?: Bs, options: FsAgentOptions = {}) {
    this._rootPath = rootPath;
    this._bs = bs || new BsMem();
    this._scanner = new FsScanner(rootPath, { ...options, bs: this._bs });
    this._adapter = new FsBlobAdapter(this._bs);
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
        const { mkdir } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });

        // Write file
        const { writeFile, utimes } = await import('fs/promises');
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

      const { mkdir } = await import('fs/promises');
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

  /** Example instance for test purposes */
  static get example(): FsAgent {
    return new FsAgent(process.cwd());
  }
}
