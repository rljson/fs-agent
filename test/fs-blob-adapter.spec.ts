// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';

import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsBlobAdapter } from '../src/fs-blob-adapter.ts';


describe('FsBlobAdapter', () => {
  const testDir = join(process.cwd(), 'test-temp-fs-blob-adapter');

  beforeEach(async () => {
    // Create test directory structure
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create instance with default BsMem', () => {
      const handler = new FsBlobAdapter();
      expect(handler).toBeInstanceOf(FsBlobAdapter);
      expect(handler.bs).toBeDefined();
    });

    it('should create instance with custom Bs', () => {
      const customBs = new BsMem();
      const handler = new FsBlobAdapter(customBs);
      expect(handler.bs).toBe(customBs);
    });
  });

  describe('fileToBlob', () => {
    it('should convert a file to blob and return metadata', async () => {
      const filePath = join(testDir, 'test.txt');
      const content = 'test content';
      await writeFile(filePath, content);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      expect(metadata.name).toBe('test.txt');
      expect(metadata.blobId).toBeDefined();
      expect(metadata.size).toBe(content.length);
      expect(metadata.mtime).toBeTypeOf('number');
      expect(metadata.path).toBe(filePath);
    });

    it('should store content in blob storage', async () => {
      const filePath = join(testDir, 'test.txt');
      const content = 'test content';
      await writeFile(filePath, content);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      const blob = await handler.bs.getBlob(metadata.blobId);
      expect(blob).toBeDefined();
      expect(blob?.content.toString()).toBe(content);
    });

    it('should exclude path when includePath is false', async () => {
      const filePath = join(testDir, 'test.txt');
      await writeFile(filePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath, {
        includePath: false,
      });

      expect(metadata.path).toBe('');
    });

    it('should use custom blob storage when provided', async () => {
      const filePath = join(testDir, 'test.txt');
      await writeFile(filePath, 'content');

      const customBs = new BsMem();
      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath, { bs: customBs });

      // Check that blob is in custom storage
      const blob = await customBs.getBlob(metadata.blobId);
      expect(blob).toBeDefined();
    });

    it('should handle files with special characters', async () => {
      const filePath = join(testDir, 'file with spaces.txt');
      await writeFile(filePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      expect(metadata.name).toBe('file with spaces.txt');
    });

    it('should handle binary files', async () => {
      const filePath = join(testDir, 'binary.dat');
      const binaryData = Buffer.from([0, 1, 2, 3, 4, 255]);
      await writeFile(filePath, binaryData);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      const retrievedContent = await handler.getFileContent(metadata.blobId);
      expect(Buffer.compare(retrievedContent, binaryData)).toBe(0);
    });
  });

  describe('filesToBlobs', () => {
    it('should convert multiple files to blobs', async () => {
      const file1 = join(testDir, 'file1.txt');
      const file2 = join(testDir, 'file2.txt');
      await writeFile(file1, 'content1');
      await writeFile(file2, 'content2');

      const handler = new FsBlobAdapter();
      const metadataList = await handler.filesToBlobs([file1, file2]);

      expect(metadataList).toHaveLength(2);
      expect(metadataList[0].name).toBe('file1.txt');
      expect(metadataList[1].name).toBe('file2.txt');
    });

    it('should handle empty array', async () => {
      const handler = new FsBlobAdapter();
      const metadataList = await handler.filesToBlobs([]);

      expect(metadataList).toHaveLength(0);
    });
  });

  describe('blobToFile', () => {
    it('should write a file from blob and metadata', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'target.txt');
      const content = 'test content';
      await writeFile(sourcePath, content);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath);

      await handler.blobToFile(metadata, targetPath);

      const writtenContent = await readFile(targetPath, 'utf-8');
      expect(writtenContent).toBe(content);
    });

    it('should create parent directories by default', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'subdir', 'nested', 'target.txt');
      await writeFile(sourcePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath);

      await handler.blobToFile(metadata, targetPath);

      const writtenContent = await readFile(targetPath, 'utf-8');
      expect(writtenContent).toBe('content');
    });

    it('should not create directories when createDirs is false', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'nonexistent', 'target.txt');
      await writeFile(sourcePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath);

      await expect(
        handler.blobToFile(metadata, targetPath, { createDirs: false }),
      ).rejects.toThrow();
    });

    it('should preserve modification time by default', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'target.txt');
      await writeFile(sourcePath, 'content');

      // Get original mtime
      const originalStats = await stat(sourcePath);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath);

      // Wait a bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.blobToFile(metadata, targetPath);

      const targetStats = await stat(targetPath);
      expect(targetStats.mtime.getTime()).toBe(originalStats.mtime.getTime());
    });

    it('should not preserve mtime when preserveMtime is false', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'target.txt');
      await writeFile(sourcePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath);

      // Wait to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      await handler.blobToFile(metadata, targetPath, {
        preserveMtime: false,
      });

      const originalStats = await stat(sourcePath);
      const targetStats = await stat(targetPath);

      // Times should be different (or very close to current time)
      const timeDiff = Math.abs(
        targetStats.mtime.getTime() - originalStats.mtime.getTime(),
      );
      expect(timeDiff).toBeGreaterThan(0);
    });

    it('should throw error if blob not found', async () => {
      const handler = new FsBlobAdapter();
      const metadata = {
        name: 'test.txt',
        blobId: 'non-existent-blob-id',
        size: 100,
        mtime: Date.now(),
        path: '/test.txt',
      };

      await expect(
        handler.blobToFile(metadata, join(testDir, 'test.txt')),
      ).rejects.toThrow('Blob not found');
    });

    it('should use custom blob storage when provided', async () => {
      const sourcePath = join(testDir, 'source.txt');
      const targetPath = join(testDir, 'target.txt');
      await writeFile(sourcePath, 'content');

      const customBs = new BsMem();
      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(sourcePath, { bs: customBs });

      await handler.blobToFile(metadata, targetPath, { bs: customBs });

      const writtenContent = await readFile(targetPath, 'utf-8');
      expect(writtenContent).toBe('content');
    });
  });

  describe('blobsToFiles', () => {
    it('should write multiple files from blobs', async () => {
      const file1 = join(testDir, 'source1.txt');
      const file2 = join(testDir, 'source2.txt');
      await writeFile(file1, 'content1');
      await writeFile(file2, 'content2');

      const handler = new FsBlobAdapter();
      const metadataList = await handler.filesToBlobs([file1, file2]);

      const targetDir = join(testDir, 'output');
      await handler.blobsToFiles(metadataList, targetDir);

      const written1 = await readFile(join(targetDir, 'source1.txt'), 'utf-8');
      const written2 = await readFile(join(targetDir, 'source2.txt'), 'utf-8');

      expect(written1).toBe('content1');
      expect(written2).toBe('content2');
    });

    it('should handle empty metadata array', async () => {
      const handler = new FsBlobAdapter();
      const targetDir = join(testDir, 'output');

      await expect(
        handler.blobsToFiles([], targetDir),
      ).resolves.toBeUndefined();
    });
  });

  describe('getFileContent', () => {
    it('should retrieve file content by blob ID', async () => {
      const filePath = join(testDir, 'test.txt');
      const content = 'test content';
      await writeFile(filePath, content);

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      const retrievedContent = await handler.getFileContent(metadata.blobId);
      expect(retrievedContent.toString()).toBe(content);
    });

    it('should throw error if blob not found', async () => {
      const handler = new FsBlobAdapter();

      await expect(
        handler.getFileContent('non-existent-blob-id'),
      ).rejects.toThrow('Blob not found');
    });
  });

  describe('hasBlob', () => {
    it('should return true if blob exists', async () => {
      const filePath = join(testDir, 'test.txt');
      await writeFile(filePath, 'content');

      const handler = new FsBlobAdapter();
      const metadata = await handler.fileToBlob(filePath);

      const exists = await handler.hasBlob(metadata.blobId);
      expect(exists).toBe(true);
    });

    it('should return false if blob does not exist', async () => {
      const handler = new FsBlobAdapter();

      const exists = await handler.hasBlob('non-existent-blob-id');
      expect(exists).toBe(false);
    });
  });

  describe('example', () => {
    it('should create an example instance', () => {
      const handler = FsBlobAdapter.example();
      expect(handler).toBeInstanceOf(FsBlobAdapter);
    });
  });

  describe('round-trip conversion', () => {
    it('should preserve file content through conversion', async () => {
      const originalPath = join(testDir, 'original.txt');
      const content = 'Round-trip test content!';
      await writeFile(originalPath, content);

      const handler = new FsBlobAdapter();

      // Convert to blob
      const metadata = await handler.fileToBlob(originalPath);

      // Convert back to file
      const restoredPath = join(testDir, 'restored.txt');
      await handler.blobToFile(metadata, restoredPath);

      // Verify content matches
      const restoredContent = await readFile(restoredPath, 'utf-8');
      expect(restoredContent).toBe(content);
    });

    it('should handle large files', async () => {
      const originalPath = join(testDir, 'large.txt');
      const largeContent = 'x'.repeat(1024 * 1024); // 1MB
      await writeFile(originalPath, largeContent);

      const handler = new FsBlobAdapter();

      const metadata = await handler.fileToBlob(originalPath);
      const restoredPath = join(testDir, 'large-restored.txt');
      await handler.blobToFile(metadata, restoredPath);

      const restoredContent = await readFile(restoredPath, 'utf-8');
      expect(restoredContent).toBe(largeContent);
      expect(metadata.size).toBe(largeContent.length);
    });
  });
});
