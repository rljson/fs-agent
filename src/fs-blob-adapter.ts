// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Json } from '@rljson/json';

import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

// .............................................................................
// Types
// .............................................................................

/**
 * File metadata returned when storing a file as a blob
 */
export interface FileBlobMeta extends Json {
  /** Name of the file */
  name: string;
  /** Blob ID where content is stored */
  blobId: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (milliseconds since epoch) */
  mtime: number;
  /** Original file path */
  path: string;
}

/**
 * Options for file-to-blob conversion
 */
export interface FileToBlobOptions {
  /** Custom blob storage (defaults to BsMem) */
  bs?: Bs;
  /** Include full path in metadata (default: true) */
  includePath?: boolean;
}

/**
 * Options for blob-to-file conversion
 */
export interface BlobToFileOptions {
  /** Custom blob storage (defaults to BsMem) */
  bs?: Bs;
  /** Create parent directories if they don't exist (default: true) */
  createDirs?: boolean;
  /** Preserve modification time (default: true) */
  preserveMtime?: boolean;
}

// .............................................................................
// FsBlobAdapter Class
// .............................................................................

/**
 * Handles conversion between files and blobs in blob storage
 */
export class FsBlobAdapter {
  private _bs: Bs;

  constructor(bs?: Bs) {
    this._bs = bs || new BsMem();
  }

  /**
   * Gets the blob storage instance
   */
  get bs(): Bs {
    return this._bs;
  }

  /**
   * Converts a file to a blob and returns metadata
   * @param filePath - Absolute path to the file
   * @param options - Conversion options
   * @returns File metadata including blob ID
   */
  async fileToBlob(
    filePath: string,
    options: FileToBlobOptions = {},
  ): Promise<FileBlobMeta> {
    const bs = options.bs || this._bs;
    const includePath = options.includePath !== false;

    // Read file stats and content
    const stats = await stat(filePath);
    const content = await readFile(filePath);

    // Store content in blob storage
    const blobProps = await bs.setBlob(content);

    // Extract file name from path
    /* v8 ignore next -- @preserve */
    const name = filePath.split('/').pop() || filePath.split('\\').pop() || '';

    // Build metadata
    const metadata: FileBlobMeta = {
      name,
      blobId: blobProps.blobId,
      size: stats.size,
      mtime: stats.mtime.getTime(),
      path: includePath ? filePath : '',
    };

    return metadata;
  }

  /**
   * Converts multiple files to blobs
   * @param filePaths - Array of absolute file paths
   * @param options - Conversion options
   * @returns Array of file metadata
   */
  async filesToBlobs(
    filePaths: string[],
    options: FileToBlobOptions = {},
  ): Promise<FileBlobMeta[]> {
    const results: FileBlobMeta[] = [];

    for (const filePath of filePaths) {
      const metadata = await this.fileToBlob(filePath, options);
      results.push(metadata);
    }

    return results;
  }

  /**
   * Writes a file from a blob using metadata
   * @param metadata - File metadata including blob ID
   * @param targetPath - Target path where file should be written
   * @param options - Conversion options
   */
  async blobToFile(
    metadata: FileBlobMeta,
    targetPath: string,
    options: BlobToFileOptions = {},
  ): Promise<void> {
    const bs = options.bs || this._bs;
    const createDirs = options.createDirs !== false;
    const preserveMtime = options.preserveMtime !== false;

    // Get blob content
    const blob = await bs.getBlob(metadata.blobId);

    // Create parent directories if needed
    if (createDirs) {
      const dir = dirname(targetPath);
      await mkdir(dir, { recursive: true });
    }

    // Write file
    await writeFile(targetPath, blob.content);

    // Preserve modification time if requested
    if (preserveMtime && metadata.mtime) {
      const { utimes } = await import('fs/promises');
      const mtime = new Date(metadata.mtime);
      await utimes(targetPath, mtime, mtime);
    }
  }

  /**
   * Writes multiple files from blobs
   * @param metadataList - Array of file metadata
   * @param targetDir - Target directory where files should be written
   * @param options - Conversion options
   */
  async blobsToFiles(
    metadataList: FileBlobMeta[],
    targetDir: string,
    options: BlobToFileOptions = {},
  ): Promise<void> {
    for (const metadata of metadataList) {
      const targetPath = `${targetDir}/${metadata.name}`;
      await this.blobToFile(metadata, targetPath, options);
    }
  }

  /**
   * Retrieves file content from blob storage
   * @param blobId - Blob ID
   * @returns File content as Buffer
   */
  async getFileContent(blobId: string): Promise<Buffer> {
    const blob = await this._bs.getBlob(blobId);
    return blob.content;
  }

  /**
   * Checks if a blob exists in storage
   * @param blobId - Blob ID to check
   * @returns True if blob exists
   */
  async hasBlob(blobId: string): Promise<boolean> {
    return await this._bs.blobExists(blobId);
  }

  /**
   * Creates an example instance for testing
   */
  static example(): FsBlobAdapter {
    return new FsBlobAdapter();
  }
}
