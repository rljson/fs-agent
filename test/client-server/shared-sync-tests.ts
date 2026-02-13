// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../../src/fs-agent.ts';

// =============================================================================
// Types
// =============================================================================

/** The result of creating a full bidirectional client-server setup. */
export interface ProductionSetup {
  treeKey: string;
  server: { tearDown: () => Promise<void> };
  clientA: { tearDown: () => Promise<void>; bs: any; io: any };
  clientB: { tearDown: () => Promise<void>; bs: any; io: any };
  dbA: any;
  dbB: any;
  connectorA: any;
  connectorB: any;
  agentA: FsAgent;
  agentB: FsAgent;
}

/** Factory function that creates the setup — differs per transport. */
export type SetupFactory = (opts: {
  folderA: string;
  folderB: string;
}) => Promise<ProductionSetup>;

// =============================================================================
// Helpers
// =============================================================================

/** Start bidirectional sync for both clients (mirroring the live demo). */
async function startBidirectionalSync(setup: ProductionSetup) {
  const stopAtoDb = await setup.agentA.syncToDb(
    setup.dbA,
    setup.connectorA,
    setup.treeKey,
  );
  const stopAfromDb = await setup.agentA.syncFromDb(
    setup.dbA,
    setup.connectorA,
    setup.treeKey,
    { cleanTarget: true },
  );
  const stopBtoDb = await setup.agentB.syncToDb(
    setup.dbB,
    setup.connectorB,
    setup.treeKey,
  );
  const stopBfromDb = await setup.agentB.syncFromDb(
    setup.dbB,
    setup.connectorB,
    setup.treeKey,
    { cleanTarget: true },
  );

  // Allow the initial sync cycle (store → broadcast → restore) to settle
  // before letting tests mutate the filesystem.
  await new Promise((r) => setTimeout(r, 500));

  const teardown = async () => {
    stopAtoDb();
    stopAfromDb();
    stopBtoDb();
    stopBfromDb();
    await setup.clientA.tearDown();
    await setup.clientB.tearDown();
    await setup.server.tearDown();
  };

  return { stopAtoDb, stopAfromDb, stopBtoDb, stopBfromDb, teardown };
}

/** Wait for filesystem propagation (file watcher debounce + network round-trip). */
function waitForSync(ms = 3000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a condition every `interval` ms until it returns true or `timeout` is reached.
 * Throws if the timeout expires.
 */
async function waitUntil(
  condition: () => Promise<boolean>,
  timeout = 10_000,
  interval = 100,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitUntil timed out after ${timeout}ms`);
}

/** Poll until a file exists and has the expected content. */
async function waitForFile(
  filePath: string,
  expectedContent: string,
  timeout = 10_000,
): Promise<void> {
  await waitUntil(async () => {
    const content = await readFileSafe(filePath);
    return content === expectedContent;
  }, timeout);
}

/** Poll until a directory exists. */
async function waitForDir(dirPath: string, timeout = 10_000): Promise<void> {
  await waitUntil(async () => {
    try {
      const s = await stat(dirPath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }, timeout);
}

/** Poll until a path no longer exists. */
async function waitForGone(filePath: string, timeout = 10_000): Promise<void> {
  await waitUntil(async () => !(await pathExists(filePath)), timeout);
}

/** Poll until a binary file matches. */
async function waitForBinaryFile(
  filePath: string,
  expected: Buffer,
  timeout = 10_000,
): Promise<void> {
  await waitUntil(async () => {
    try {
      const data = await readFile(filePath);
      return Buffer.compare(data, expected) === 0;
    } catch {
      return false;
    }
  }, timeout);
}

/** Read file safely, returning null if not found. */
async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Check if a path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** List directory entries (filenames only). */
async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// =============================================================================
// Shared Test Definitions
// =============================================================================

/**
 * Registers the full production sync test suite using the given setup factory.
 * Called from both the SocketMock and SocketIO test files.
 */
export function defineProductionSyncTests(
  suiteName: string,
  createSetup: SetupFactory,
) {
  describe(suiteName, () => {
    const baseDir = join(
      process.cwd(),
      'test-tmp',
      suiteName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
    );
    let folderA: string;
    let folderB: string;

    beforeEach(async () => {
      await rm(baseDir, { recursive: true, force: true });
      folderA = join(baseDir, 'folder-a');
      folderB = join(baseDir, 'folder-b');
      await mkdir(folderA, { recursive: true });
      await mkdir(folderB, { recursive: true });
    });

    afterEach(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    // =========================================================================
    // 1. File creation propagation
    // =========================================================================

    describe('file creation propagation', () => {
      it('should propagate a new file from A to B', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'new-file.txt'), 'hello from A');

        await waitForFile(join(folderB, 'new-file.txt'), 'hello from A');

        await teardown();
      });

      it('should propagate a new file from B to A', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderB, 'from-b.txt'), 'hello from B');

        await waitForFile(join(folderA, 'from-b.txt'), 'hello from B');

        await teardown();
      });
    });

    // =========================================================================
    // 2. File modification propagation
    // =========================================================================

    describe('file modification propagation', () => {
      it('should propagate file content changes from A to B', async () => {
        await writeFile(join(folderA, 'data.txt'), 'version 1');
        await writeFile(join(folderB, 'data.txt'), 'version 1');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'data.txt'), 'version 2 - updated by A');

        await waitForFile(
          join(folderB, 'data.txt'),
          'version 2 - updated by A',
        );

        await teardown();
      });
    });

    // =========================================================================
    // 3. File deletion propagation (cleanTarget)
    // =========================================================================

    describe('file deletion propagation', () => {
      it('should propagate file deletions from A to B via cleanTarget', async () => {
        await writeFile(join(folderA, 'keep.txt'), 'keep');
        await writeFile(join(folderA, 'delete-me.txt'), 'will be deleted');
        await writeFile(join(folderB, 'keep.txt'), 'keep');
        await writeFile(join(folderB, 'delete-me.txt'), 'will be deleted');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await rm(join(folderA, 'delete-me.txt'));

        await waitForGone(join(folderB, 'delete-me.txt'));
        expect(await readFileSafe(join(folderB, 'keep.txt'))).toBe('keep');

        await teardown();
      });
    });

    // =========================================================================
    // 4. Directory operations
    // =========================================================================

    describe('directory operations', () => {
      it('should propagate new directory with files from A to B', async () => {
        await writeFile(join(folderA, 'root.txt'), 'root');
        await writeFile(join(folderB, 'root.txt'), 'root');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await mkdir(join(folderA, 'subdir'), { recursive: true });
        await writeFile(
          join(folderA, 'subdir', 'nested.txt'),
          'nested content',
        );

        await waitForFile(
          join(folderB, 'subdir', 'nested.txt'),
          'nested content',
        );

        await teardown();
      });

      it('should propagate directory deletion from A to B', async () => {
        await mkdir(join(folderA, 'subdir'), { recursive: true });
        await writeFile(join(folderA, 'subdir', 'file.txt'), 'content');
        await writeFile(join(folderA, 'root.txt'), 'root');
        await mkdir(join(folderB, 'subdir'), { recursive: true });
        await writeFile(join(folderB, 'subdir', 'file.txt'), 'content');
        await writeFile(join(folderB, 'root.txt'), 'root');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await rm(join(folderA, 'subdir'), { recursive: true });

        await waitForGone(join(folderB, 'subdir'));
        expect(await readFileSafe(join(folderB, 'root.txt'))).toBe('root');

        await teardown();
      });

      it('should propagate deeply nested directory creation', async () => {
        await writeFile(join(folderA, 'root.txt'), 'root');
        await writeFile(join(folderB, 'root.txt'), 'root');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        const deepPath = join(folderA, 'a', 'b', 'c');
        await mkdir(deepPath, { recursive: true });
        await writeFile(join(deepPath, 'deep.txt'), 'deep');

        await waitForFile(join(folderB, 'a', 'b', 'c', 'deep.txt'), 'deep');

        await teardown();
      });
    });

    // =========================================================================
    // 5. Multiple files at once
    // =========================================================================

    describe('bulk operations', () => {
      it('should propagate multiple new files created at once', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'file1.txt'), 'one');
        await writeFile(join(folderA, 'file2.txt'), 'two');
        await writeFile(join(folderA, 'file3.txt'), 'three');

        await waitForFile(join(folderB, 'file3.txt'), 'three');
        expect(await readFileSafe(join(folderB, 'file1.txt'))).toBe('one');
        expect(await readFileSafe(join(folderB, 'file2.txt'))).toBe('two');

        await teardown();
      });
    });

    // =========================================================================
    // 6. Binary files
    // =========================================================================

    describe('binary file sync', () => {
      it('should propagate binary files correctly', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        const binaryData = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        await writeFile(join(folderA, 'image.png'), binaryData);

        await waitForBinaryFile(join(folderB, 'image.png'), binaryData);

        await teardown();
      });
    });

    // =========================================================================
    // 7. Empty files
    // =========================================================================

    describe('empty file sync', () => {
      it('should propagate empty files correctly', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'empty.txt'), '');

        await waitForFile(join(folderB, 'empty.txt'), '');

        await teardown();
      });
    });

    // =========================================================================
    // 8. Special characters in filenames
    // =========================================================================

    describe('special filename handling', () => {
      it('should propagate files with spaces and special chars', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'file with spaces.txt'), 'spaces');
        await writeFile(join(folderA, 'file-with-dashes.txt'), 'dashes');
        await writeFile(join(folderA, 'file_underscores.txt'), 'underscores');

        await waitForFile(join(folderB, 'file_underscores.txt'), 'underscores');
        expect(await readFileSafe(join(folderB, 'file with spaces.txt'))).toBe(
          'spaces',
        );
        expect(await readFileSafe(join(folderB, 'file-with-dashes.txt'))).toBe(
          'dashes',
        );

        await teardown();
      });
    });

    // =========================================================================
    // 9. Convergence — no infinite bounce-back
    // =========================================================================

    describe('convergence behavior', () => {
      it('should converge and stop producing traffic after initial sync', async () => {
        await writeFile(join(folderA, 'shared.txt'), 'shared');
        await writeFile(join(folderB, 'shared.txt'), 'shared');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        const entriesA = (await listEntries(folderA)).sort();
        const entriesB = (await listEntries(folderB)).sort();

        expect(entriesA).toEqual(entriesB);

        // Wait a bit more — if bounce-back is infinite this would diverge
        await waitForSync(1000);

        const entriesA2 = (await listEntries(folderA)).sort();
        const entriesB2 = (await listEntries(folderB)).sort();
        expect(entriesA2).toEqual(entriesB2);
        expect(entriesA2).toEqual(entriesA);

        await teardown();
      });

      it('should converge after a file change in A', async () => {
        await writeFile(join(folderA, 'data.txt'), 'initial');
        await writeFile(join(folderB, 'data.txt'), 'initial');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await writeFile(join(folderA, 'data.txt'), 'changed');

        await waitForFile(join(folderB, 'data.txt'), 'changed');

        // Wait a bit to ensure no further changes (no infinite bounce)
        await waitForSync(1000);

        expect(await readFileSafe(join(folderA, 'data.txt'))).toBe('changed');
        expect(await readFileSafe(join(folderB, 'data.txt'))).toBe('changed');

        await teardown();
      });

      it('should not destroy existing files during initial sync', async () => {
        await writeFile(join(folderA, 'a.txt'), 'alpha');
        await writeFile(join(folderA, 'b.txt'), 'beta');
        await writeFile(join(folderB, 'a.txt'), 'alpha');
        await writeFile(join(folderB, 'b.txt'), 'beta');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        expect(await readFileSafe(join(folderA, 'a.txt'))).toBe('alpha');
        expect(await readFileSafe(join(folderA, 'b.txt'))).toBe('beta');
        expect(await readFileSafe(join(folderB, 'a.txt'))).toBe('alpha');
        expect(await readFileSafe(join(folderB, 'b.txt'))).toBe('beta');

        await teardown();
      });
    });

    // =========================================================================
    // 10. Rename simulation (delete + create)
    // =========================================================================

    describe('rename operations (delete + create)', () => {
      it('should handle file rename in A reflected in B', async () => {
        await writeFile(join(folderA, 'old-name.txt'), 'content');
        await writeFile(join(folderB, 'old-name.txt'), 'content');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await rm(join(folderA, 'old-name.txt'));
        await writeFile(join(folderA, 'new-name.txt'), 'content');

        await waitForFile(join(folderB, 'new-name.txt'), 'content');
        await waitForGone(join(folderB, 'old-name.txt'));

        await teardown();
      });
    });

    // =========================================================================
    // 11. Large file handling
    // =========================================================================

    describe('large file handling', () => {
      it('should propagate a large file (100KB) from A to B', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        const largeContent = 'x'.repeat(100 * 1024);
        await writeFile(join(folderA, 'large.txt'), largeContent);

        await waitForFile(join(folderB, 'large.txt'), largeContent);

        await teardown();
      });
    });

    // =========================================================================
    // 12. Teardown and cleanup
    // =========================================================================

    describe('teardown', () => {
      it('should stop syncing after teardown — changes must NOT propagate', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        await teardown();

        await writeFile(join(folderA, 'after-teardown.txt'), 'orphaned');

        // Short wait — file must NOT appear
        await waitForSync(1000);

        expect(await pathExists(join(folderB, 'after-teardown.txt'))).toBe(
          false,
        );
      });
    });

    // =========================================================================
    // 13. One-shot store + load (non-watcher path)
    // =========================================================================

    describe('one-shot storeInDb + loadFromDb', () => {
      it('should store from A and load to B without watchers', async () => {
        await mkdir(join(folderA, 'src'), { recursive: true });
        await writeFile(join(folderA, 'README.md'), '# Hello');
        await writeFile(join(folderA, 'src', 'index.ts'), 'export {}');

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        expect(await readFileSafe(join(folderB, 'README.md'))).toBe('# Hello');
        expect(await readFileSafe(join(folderB, 'src', 'index.ts'))).toBe(
          'export {}',
        );

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should handle multiple versions via one-shot store + load', async () => {
        const setup = await createSetup({ folderA, folderB });

        await writeFile(join(folderA, 'file.txt'), 'v1');
        const ref1 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        await writeFile(join(folderA, 'file.txt'), 'v2');
        const ref2 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        expect(ref1).not.toBe(ref2);

        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref1);
        expect(await readFileSafe(join(folderB, 'file.txt'))).toBe('v1');

        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref2);
        expect(await readFileSafe(join(folderB, 'file.txt'))).toBe('v2');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });
    });

    // =========================================================================
    // 14. Both folders start empty
    // =========================================================================

    describe('empty folder handling', () => {
      it('should handle both folders starting empty', async () => {
        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        // Short wait for initial (empty) sync to settle
        await waitForSync(500);

        await writeFile(join(folderA, 'first-file.txt'), 'first');

        await waitForFile(join(folderB, 'first-file.txt'), 'first');

        await teardown();
      });

      it('should propagate new empty directory from A to B', async () => {
        // Seed both folders so initial sync has something to agree on
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        // Create an empty directory in folder A
        await mkdir(join(folderA, 'new-empty-dir'), { recursive: true });

        // It should appear in folder B
        await waitForDir(join(folderB, 'new-empty-dir'));

        await teardown();
      });

      it('should propagate nested empty directories from A to B', async () => {
        await writeFile(join(folderA, 'seed.txt'), 'seed');
        await writeFile(join(folderB, 'seed.txt'), 'seed');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        // Create nested empty directories in folder A
        await mkdir(join(folderA, 'parent', 'child', 'grandchild'), {
          recursive: true,
        });

        // All levels should appear in folder B
        await waitForDir(join(folderB, 'parent', 'child', 'grandchild'));

        await teardown();
      });
    });

    // =========================================================================
    // 15. Overwrite with different content sizes
    // =========================================================================

    describe('content size changes', () => {
      it('should handle file growing and shrinking', async () => {
        await writeFile(join(folderA, 'size.txt'), 'short');
        await writeFile(join(folderB, 'size.txt'), 'short');

        const setup = await createSetup({ folderA, folderB });
        const { teardown } = await startBidirectionalSync(setup);

        const large = 'x'.repeat(10000);
        await writeFile(join(folderA, 'size.txt'), large);

        await waitForFile(join(folderB, 'size.txt'), large);

        await writeFile(join(folderA, 'size.txt'), 'tiny');

        await waitForFile(join(folderB, 'size.txt'), 'tiny');

        await teardown();
      });
    });

    // =========================================================================
    // 16. One-shot sync (non-watcher, full-sync-test tests)
    // =========================================================================

    describe('one-shot sync via extract + loadFromDb', () => {
      it('should sync single file from A to B', async () => {
        await writeFile(join(folderA, 'test.txt'), 'Hello from Client A');

        const setup = await createSetup({ folderA, folderB });

        // One-shot: A stores, B loads
        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const contentB = await readFile(join(folderB, 'test.txt'), 'utf8');
        expect(contentB).toBe('Hello from Client A');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync directory structure with multiple files', async () => {
        await mkdir(join(folderA, 'subdir'), { recursive: true });
        await writeFile(join(folderA, 'root.txt'), 'root file');
        await writeFile(join(folderA, 'subdir', 'nested.txt'), 'nested file');
        await writeFile(
          join(folderA, 'subdir', 'data.json'),
          '{"key":"value"}',
        );

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        expect(await readFile(join(folderB, 'root.txt'), 'utf8')).toBe(
          'root file',
        );
        expect(
          await readFile(join(folderB, 'subdir', 'nested.txt'), 'utf8'),
        ).toBe('nested file');
        expect(
          await readFile(join(folderB, 'subdir', 'data.json'), 'utf8'),
        ).toBe('{"key":"value"}');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync empty files correctly', async () => {
        await writeFile(join(folderA, 'empty.txt'), '');

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const content = await readFile(join(folderB, 'empty.txt'), 'utf8');
        expect(content).toBe('');
        const stats = await stat(join(folderB, 'empty.txt'));
        expect(stats.isFile()).toBe(true);
        expect(stats.size).toBe(0);

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync binary files correctly', async () => {
        const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
        await writeFile(join(folderA, 'binary.bin'), binaryData);

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const contentB = await readFile(join(folderB, 'binary.bin'));
        expect(Buffer.compare(contentB, binaryData)).toBe(0);

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync large files correctly', { timeout: 60_000 }, async () => {
        const largeContent = 'x'.repeat(100 * 1024);
        await writeFile(join(folderA, 'large.txt'), largeContent);

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const contentB = await readFile(join(folderB, 'large.txt'), 'utf8');
        expect(contentB.length).toBe(100 * 1024);
        expect(contentB).toBe(largeContent);

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should handle file modifications via sync', async () => {
        const setup = await createSetup({ folderA, folderB });

        await writeFile(join(folderA, 'modify.txt'), 'version 1');
        const ref1 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref1);
        expect(await readFile(join(folderB, 'modify.txt'), 'utf8')).toBe(
          'version 1',
        );

        await writeFile(join(folderA, 'modify.txt'), 'version 2 - modified');
        const ref2 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        expect(ref2).not.toBe(ref1);

        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref2);
        expect(await readFile(join(folderB, 'modify.txt'), 'utf8')).toBe(
          'version 2 - modified',
        );

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should handle file deletions with cleanTarget option', async () => {
        const setup = await createSetup({ folderA, folderB });

        await writeFile(join(folderA, 'keep.txt'), 'keep this');
        await writeFile(join(folderA, 'delete.txt'), 'delete this');
        const ref1 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref1);
        expect(await readFile(join(folderB, 'keep.txt'), 'utf8')).toBe(
          'keep this',
        );
        expect(await readFile(join(folderB, 'delete.txt'), 'utf8')).toBe(
          'delete this',
        );

        await rm(join(folderA, 'delete.txt'));
        const ref2 = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        await setup.agentB.loadFromDb(
          setup.dbB,
          setup.treeKey,
          ref2,
          undefined,
          {
            cleanTarget: true,
          },
        );

        expect(await readFile(join(folderB, 'keep.txt'), 'utf8')).toBe(
          'keep this',
        );
        await expect(
          readFile(join(folderB, 'delete.txt'), 'utf8'),
        ).rejects.toThrow();

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync deeply nested directory structures', async () => {
        const deepPath = join(folderA, 'a', 'b', 'c', 'd', 'e');
        await mkdir(deepPath, { recursive: true });
        await writeFile(join(deepPath, 'deep.txt'), 'deeply nested');

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const content = await readFile(
          join(folderB, 'a', 'b', 'c', 'd', 'e', 'deep.txt'),
          'utf8',
        );
        expect(content).toBe('deeply nested');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should handle special characters in filenames', async () => {
        const specialFiles = [
          'file with spaces.txt',
          'file-with-dashes.txt',
          'file_with_underscores.txt',
          'file.multiple.dots.txt',
        ];

        for (const filename of specialFiles) {
          await writeFile(join(folderA, filename), `content of ${filename}`);
        }

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        for (const filename of specialFiles) {
          const content = await readFile(join(folderB, filename), 'utf8');
          expect(content).toBe(`content of ${filename}`);
        }

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should enforce socket-only communication', async () => {
        await writeFile(join(folderA, 'architecture-test.txt'), 'socket-only');

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);

        // Verify blob exists in Client A's Bs
        const tree = await setup.agentA.extract();
        const rootNode = tree.trees.get(tree.rootHash);
        expect(rootNode).toBeDefined();

        let fileBlobId: string | undefined;
        for (const childHash of rootNode?.children || []) {
          const childNode = tree.trees.get(childHash);
          if (childNode?.meta?.name === 'architecture-test.txt') {
            fileBlobId = childNode.meta.blobId as string;
            break;
          }
        }
        expect(fileBlobId).toBeDefined();

        const blobA = await setup.clientA.bs!.getBlob(fileBlobId as string);
        expect(blobA).toBeDefined();
        expect(blobA?.content?.toString()).toBe('socket-only');

        // Client B loads — blob synced via socket
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);
        const contentB = await readFile(
          join(folderB, 'architecture-test.txt'),
          'utf8',
        );
        expect(contentB).toBe('socket-only');

        const blobB = await setup.clientB.bs!.getBlob(fileBlobId as string);
        expect(blobB).toBeDefined();
        expect(blobB?.content?.toString()).toBe('socket-only');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });

      it('should sync empty directories', async () => {
        await mkdir(join(folderA, 'empty-dir'), { recursive: true });
        await mkdir(join(folderA, 'nested', 'empty'), { recursive: true });
        await writeFile(join(folderA, 'marker.txt'), 'marker');

        const setup = await createSetup({ folderA, folderB });

        const ref = await setup.agentA.storeInDb(setup.dbA, setup.treeKey);
        await setup.agentB.loadFromDb(setup.dbB, setup.treeKey, ref);

        const emptyStats = await stat(join(folderB, 'empty-dir'));
        expect(emptyStats.isDirectory()).toBe(true);

        const nestedStats = await stat(join(folderB, 'nested', 'empty'));
        expect(nestedStats.isDirectory()).toBe(true);

        const markerContent = await readFile(
          join(folderB, 'marker.txt'),
          'utf8',
        );
        expect(markerContent).toBe('marker');

        await setup.clientA.tearDown();
        await setup.clientB.tearDown();
        await setup.server.tearDown();
      });
    });
  });
}
