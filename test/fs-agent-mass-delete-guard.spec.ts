// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';

import {
  FsAgent,
  MASS_DELETE_MIN_FILES,
  MassDeleteRefusedError,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';

// The dangerous direction of sync is a POPULATED node receiving a tree that
// lacks its files. A peer that comes up empty — a fresh clone, a folder not yet
// mounted, a bootstrap that raced its own first scan — advertises an empty
// tree, and every other node faithfully deletes everything it has.
describe('FsAgent — the mass-delete guard', () => {
  const sourceDir = join(process.cwd(), 'test-temp-guard-source');
  const targetDir = join(process.cwd(), 'test-temp-guard-target');

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

  /** Fills a folder with `n` numbered files. */
  const fill = async (dir: string, n: number, prefix = 'f') => {
    for (let i = 0; i < n; i++) {
      await writeFile(join(dir, `${prefix}${i}.txt`), `content-${i}`);
    }
  };

  /** The tree of `sourceDir` as it currently stands. */
  const sourceTree = (bs: BsMem) => new FsAgent(sourceDir, bs).extract();

  /** Files currently in the target. */
  const targetFiles = async () =>
    (await readdir(targetDir)).filter((f) => f !== SYNC_ERROR_FILE);

  const POPULATED = MASS_DELETE_MIN_FILES + 20;

  it('refuses an empty incoming tree against a populated folder', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs); // source is empty
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs).restore(tree, targetDir, {
        cleanTarget: true,
      }),
    ).rejects.toBeInstanceOf(MassDeleteRefusedError);

    // Nothing deleted — that is the entire point.
    expect(await targetFiles()).toHaveLength(POPULATED);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('MASS DELETE REFUSED'),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it('records the refusal where an operator will find it', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new FsAgent(targetDir, bs)
      .restore(tree, targetDir, { cleanTarget: true })
      .catch(() => undefined);

    expect(existsSync(join(targetDir, SYNC_ERROR_FILE))).toBe(true);
    errSpy.mockRestore();
  });

  it('reports what it refused, so the numbers can be judged', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = (await new FsAgent(targetDir, bs)
      .restore(tree, targetDir, { cleanTarget: true })
      .catch((e: unknown) => e)) as MassDeleteRefusedError;

    expect(err.wouldPrune).toBe(POPULATED);
    expect(err.totalFiles).toBe(POPULATED);
    expect(err.incomingFiles).toBe(0);
    expect(err.message).toContain('NO files at all');
    errSpy.mockRestore();
  });

  // The guard has to stay out of the way of ordinary work, or it gets disabled.
  it('allows an ordinary deletion of a few files', async () => {
    const bs = new BsMem();
    await fill(sourceDir, POPULATED);
    await fill(targetDir, POPULATED);
    // Source drops three of them.
    for (const i of [0, 1, 2]) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(POPULATED - 3);
  });

  it('allows a large deletion that is still a minority of the folder', async () => {
    const bs = new BsMem();
    const total = 500;
    await fill(sourceDir, total);
    await fill(targetDir, total);
    // 120 files: over the count floor, but under the ratio.
    for (let i = 0; i < 120; i++) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(total - 120);
  });

  it('refuses a majority deletion even when the tree is not empty', async () => {
    const bs = new BsMem();
    const total = 400;
    await fill(sourceDir, total);
    await fill(targetDir, total);
    for (let i = 0; i < 300; i++) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs).restore(tree, targetDir, {
        cleanTarget: true,
      }),
    ).rejects.toBeInstanceOf(MassDeleteRefusedError);
    expect(await targetFiles()).toHaveLength(total);
    errSpy.mockRestore();
  });

  // Emptying a small folder is an ordinary edit. A guard that blocked it would
  // fire constantly on small trees and be turned off.
  it('allows a small folder to be emptied', async () => {
    const bs = new BsMem();
    await fill(targetDir, 5);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(0);
  });

  it('does not interfere when cleanTarget is off', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir);

    expect(await targetFiles()).toHaveLength(POPULATED);
  });

  // A fresh client with an empty folder must still be able to receive: there is
  // nothing to lose, so the guard has no business firing.
  it('lets a fresh empty client receive a large tree', async () => {
    const bs = new BsMem();
    await fill(sourceDir, POPULATED);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(POPULATED);
  });
});
