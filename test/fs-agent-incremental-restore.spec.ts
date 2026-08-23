// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Captures the restore summary line. Asserting on what restore SAYS it did
 * beats inferring it from inode timestamps: ctime moves for reasons outside
 * this code's control, which made the inferred version flake under load.
 */
const captureRestoreLog = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0]));
  });
  return { lines, restore: () => spy.mockRestore() };
};

import { BsMem } from '@rljson/bs';

import { FsAgent } from '../src/fs-agent.ts';

// Every sync used to rewrite the whole tree. On the production catalogue that
// is 80 GB of blob fetches and disk writes per restore — which is why restores
// time out — and almost all of it rewrites bytes that were already identical.
describe('FsAgent — restore only writes what changed', () => {
  const sourceDir = join(process.cwd(), 'test-temp-incr-source');
  const targetDir = join(process.cwd(), 'test-temp-incr-target');

  beforeEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  /** Builds a tree from `sourceDir` against a shared blob store. */
  const treeFrom = async (bs: BsMem) => {
    const agent = new FsAgent(sourceDir, bs);
    return { agent, tree: await agent.extract() };
  };

  it('writes nothing on a second restore of the same tree', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    await writeFile(join(sourceDir, 'b.txt'), 'beta');
    const { tree } = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(tree, targetDir);
    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('alpha');

    // mtime is the observable the restore explicitly manages, so it is the one
    // worth asserting on: an untouched file keeps the tree's mtime exactly.
    const before = await Promise.all(
      ['a.txt', 'b.txt'].map((f) => stat(join(targetDir, f))),
    );
    const log = captureRestoreLog();

    await target.restore(tree, targetDir);

    const after = await Promise.all(
      ['a.txt', 'b.txt'].map((f) => stat(join(targetDir, f))),
    );
    expect(after.map((s) => s.mtimeMs)).toEqual(before.map((s) => s.mtimeMs));
    expect(log.lines.join('\n')).toContain(
      'wrote 0, left 2 already-correct files',
    );
    log.restore();
  });

  it('rewrites a file whose content changed', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    await writeFile(join(sourceDir, 'b.txt'), 'beta');
    const first = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(first.tree, targetDir);

    // Change one file at the source; the other is untouched.
    await writeFile(join(sourceDir, 'b.txt'), 'beta-two');
    const second = await treeFrom(bs);

    const log = captureRestoreLog();
    await target.restore(second.tree, targetDir);

    expect(await readFile(join(targetDir, 'b.txt'), 'utf-8')).toBe('beta-two');
    // Exactly one write, and it was not the unchanged neighbour.
    expect(log.lines.join('\n')).toContain(
      'wrote 1, left 1 already-correct file',
    );
    log.restore();
  });

  // Same byte length, different content — the case the size check alone would
  // wave through. mtime is what catches it.
  it('rewrites a same-size edit', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'aaaaa');
    const first = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(first.tree, targetDir);

    await writeFile(join(sourceDir, 'a.txt'), 'bbbbb');
    const second = await treeFrom(bs);
    await target.restore(second.tree, targetDir);

    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('bbbbb');
  });

  // The reason the decision is anchored on the blobId rather than on size and
  // mtime. Two same-size writes inside one millisecond are indistinguishable by
  // timestamp — the scan cache tolerates that, a restore must not, because the
  // cost there is not a stale cache entry but the wrong bytes left on disk.
  // Forced deterministically here; it otherwise reproduces only by luck.
  it('rewrites a same-size edit that shares the previous mtime exactly', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'aaaaa');
    const first = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(first.tree, targetDir);
    const pinned = (await stat(join(targetDir, 'a.txt'))).mtime;

    // Same length, different content, and the mtime forced back to the value
    // the previous restore left behind.
    await writeFile(join(sourceDir, 'a.txt'), 'bbbbb');
    await utimes(join(sourceDir, 'a.txt'), pinned, pinned);
    const second = await treeFrom(bs);

    const log = captureRestoreLog();
    await target.restore(second.tree, targetDir);
    log.restore();

    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('bbbbb');
  });

  it('writes a file that is missing locally even when the rest is unchanged', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    await writeFile(join(sourceDir, 'b.txt'), 'beta');
    const { tree } = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(tree, targetDir);
    await rm(join(targetDir, 'b.txt'));

    const log = captureRestoreLog();
    await target.restore(tree, targetDir);

    expect(await readFile(join(targetDir, 'b.txt'), 'utf-8')).toBe('beta');
    expect(log.lines.join('\n')).toContain(
      'wrote 1, left 1 already-correct file',
    );
    log.restore();
  });

  // The uncertainty is deliberately one-directional: a needless write costs
  // time, a wrongly skipped write leaves the wrong bytes on disk indefinitely.
  it('rewrites when the local file was edited in place', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    const { tree } = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(tree, targetDir);

    // A local edit moves mtime, so the file no longer looks correct.
    await writeFile(join(targetDir, 'a.txt'), 'tampered');
    await target.restore(tree, targetDir);

    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('alpha');
  });

  it('rewrites when only the mtime was moved, content identical', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    const { tree } = await treeFrom(bs);

    const target = new FsAgent(targetDir, bs);
    await target.restore(tree, targetDir);

    const shifted = new Date(Date.now() + 60_000);
    await utimes(join(targetDir, 'a.txt'), shifted, shifted);
    const before = await stat(join(targetDir, 'a.txt'));

    await target.restore(tree, targetDir);

    // Rewritten, and the tree's mtime restored — the folder is authoritative
    // again rather than quietly diverged.
    const after = await stat(join(targetDir, 'a.txt'));
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
  });

  it('says nothing about skipping when there was nothing to skip', async () => {
    const bs = new BsMem();
    await writeFile(join(sourceDir, 'a.txt'), 'alpha');
    const { tree } = await treeFrom(bs);
    const log = captureRestoreLog();

    await new FsAgent(targetDir, bs).restore(tree, targetDir);

    expect(log.lines.join('\n')).not.toContain('already-correct');
    log.restore();
  });
});
