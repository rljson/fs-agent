// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';

import type { FsTree } from '../src/fs-scanner';
import { FsScanner } from '../src/fs-scanner';

// `scan()` is a whole-tree operation: it walks every directory, stats every
// file and writes a blob for anything new. The watcher used to call it once
// per event, and `fs.watch` does not await its callback — so copying 1 200
// tiny files into a watched folder started 1 200 concurrent full scans. The
// CPU sat 82% idle waiting on the filesystem, RSS climbed from 263 MB to
// 785 MB, and the peer received nothing for two minutes. On a customer's
// 3 702-file folder the same burst wedged the client outright.
describe('FsScanner — scan coalescing', () => {
  let root: string;
  let scanner: FsScanner;
  let scans: number;

  /** Reaches the private coalescer the watcher paths go through. */
  const scanAfterNow = (): Promise<FsTree> =>
    (
      scanner as unknown as { _scanAfterNow(): Promise<FsTree> }
    )._scanAfterNow();

  beforeEach(async () => {
    root = join(tmpdir(), `coalesce-${Date.now()}-${Math.random()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.txt'), 'a');
    scanner = new FsScanner(root, { bs: new BsMem() });
    scans = 0;
    const real = scanner.scan.bind(scanner);
    scanner.scan = async (): Promise<FsTree> => {
      scans++;
      return real();
    };
  });

  afterEach(async () => {
    scanner.stopWatch();
    await rm(root, { recursive: true, force: true });
  });

  it('collapses a burst of any size into at most two passes', async () => {
    const burst = Array.from({ length: 200 }, () => scanAfterNow());
    await Promise.all(burst);

    // One pass for the first caller, one shared follow-up for the other 199.
    expect(scans).toBe(2);
  });

  // The part that cannot be traded away for speed. Joining a scan that began
  // BEFORE the event would let a push carry a tree that predates the file that
  // triggered it — which is exactly what the lab saw advertised: trees of 64,
  // then 103, then 204 nodes, each a stale snapshot of a folder that already
  // held twelve hundred files.
  it('never answers with a pass that started before the caller asked', async () => {
    const first = scanAfterNow();

    // The file appears after the running pass began, so the running pass
    // cannot contain it — only a later one can.
    await writeFile(join(root, 'late.txt'), 'late');
    const afterwards = await scanAfterNow();
    await first;

    const paths = [...afterwards.trees.values()]
      .map((t) => (t.meta as { relativePath?: string } | null)?.relativePath)
      .filter(Boolean);
    expect(paths).toContain('late.txt');
  });

  it('starts a fresh pass once the folder falls quiet again', async () => {
    await scanAfterNow();
    await scanAfterNow();

    // Sequential callers are not a burst: each gets its own pass, because
    // each asked when nothing was running.
    expect(scans).toBe(2);
  });

  // A failed pass is not the queued caller's problem: what it asked for is a
  // scan that starts afterwards, and that is what it still gets.
  it('still delivers the follow-up pass when the running one fails', async () => {
    const real = scanner.scan.bind(scanner);
    let failNext = true;
    scanner.scan = async (): Promise<FsTree> => {
      if (failNext) {
        failNext = false;
        throw new Error('scan blew up');
      }
      return real();
    };

    const failing = scanAfterNow();
    const queued = scanAfterNow();

    await expect(failing).rejects.toThrow('scan blew up');
    await expect(queued).resolves.toBeDefined();
  });
});
