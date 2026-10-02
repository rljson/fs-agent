// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// F1 / D2 — a file that cannot be written must block only itself.
//
// *"Ein Pfad über 260 Zeichen, ein reservierter Name wie CON.txt, ein
// Leerzeichen am Ende: Der Rechner empfängt gar nichts mehr und versucht es
// endlos mit derselben Datei."* And: *"Ein zu langer Pfad oder ein reservierter
// Name ist heute der billigste Weg, einen ganzen Rechner stillzulegen."*
//
// WHAT IS PORTABLE AND WHAT IS NOT. `CON.txt` and a 260-character limit are
// Windows rules; on this machine both are ordinary names, so asserting them
// here would test nothing. What IS portable is the SHAPE of the fault — one
// path the filesystem refuses, and the question of whether the other files in
// the same tree still arrive. That is reproduced with a name POSIX refuses too:
// a single component longer than 255 bytes, which gives `ENAMETOOLONG`.
//
// The agent must not care which rule was broken. `PartialRestoreError` already
// exists for "the folder could not be put into the state the tree describes",
// and the design decision behind it is that the bytes of one file are worth
// exactly one missing file — never the rest of the tree, and never the tree's
// deletions.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { hip } from '@rljson/hash';
import type { Tree } from '@rljson/rljson';

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FsAgent,
  RestoreIncompleteError,
  UnwritablePathError,
} from '../src/fs-agent.ts';
import type { FsTree } from '../src/fs-scanner.ts';

/** Longer than any POSIX component limit (255), so `open` refuses it. */
const IMPOSSIBLE = `${'x'.repeat(300)}.txt`;

describe('F1/D2 — a path the filesystem refuses', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-badname-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(dir, 'source'), { recursive: true });
    await mkdir(join(dir, 'target'), { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * A tree holding three good files and one impossible name.
   *
   * Built by scanning a real folder of good files and then splicing in the
   * bad node, because the bad name cannot be created on disk to be scanned —
   * which is the whole point of it.
   * @param bs - The blob store to use.
   * @returns The tree, and the agent that produced it.
   */
  const treeWithBadName = async (
    bs: BsMem,
    badNames: string[] = [IMPOSSIBLE],
  ): Promise<{ tree: FsTree; good: string[] }> => {
    const source = join(dir, 'source');
    const good = ['a.txt', 'b.txt', 'c.txt'];
    for (const name of good) await writeFile(join(source, name), name);
    const agent = new FsAgent(source, bs);
    agents.push(agent);
    const scanned = await agent.extract();

    // Real blobs, referenced by unwritable paths.
    const nodes = new Map(scanned.trees);
    const root = nodes.get(scanned.rootHash) as Tree;
    nodes.delete(scanned.rootHash);
    const badHashes: string[] = [];
    for (const name of badNames) {
      const props = await bs.setBlob(Buffer.from(`doomed-${name.length}`));
      const badNode = {
        id: name,
        isParent: false,
        children: null,
        meta: {
          name,
          type: 'file',
          relativePath: name,
          size: 6,
          blobId: props.blobId,
        },
      } as unknown as Tree;
      hip(badNode);
      nodes.set(badNode._hash as string, badNode);
      badHashes.push(badNode._hash as string);
    }

    const rootMeta = { ...(root.meta as Record<string, unknown>) };
    delete (rootMeta as { _hash?: string })._hash;
    const newRoot = {
      ...root,
      meta: rootMeta,
      children: [...(root.children ?? []), ...badHashes].sort(),
    } as Tree;
    delete (newRoot as { _hash?: string })._hash;
    hip(newRoot);
    nodes.set(newRoot._hash as string, newRoot);

    return { tree: { rootHash: newRoot._hash as string, trees: nodes }, good };
  };

  // ...........................................................................
  it('applies every other file in the tree', async () => {
    const bs = new BsMem();
    const { tree, good } = await treeWithBadName(bs);
    const target = join(dir, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // It reports the one path it could not write — and reports it by failing,
    // so a caller cannot mistake a partial apply for a complete one.
    const err = await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch((e: unknown) => e);
    warn.mockRestore();
    // Reported by FAILING, so a caller cannot mistake a partial apply for a
    // complete one — and with its own class, so the message says the name was
    // rejected rather than blaming the network.
    expect(err).toBeInstanceOf(RestoreIncompleteError);
    expect(err).toBeInstanceOf(UnwritablePathError);

    // And the rest of the tree is on disk. This is the assertion the field
    // report is about: *"der Rechner empfängt gar nichts mehr"*.
    for (const name of good) {
      expect(
        await readFile(join(target, name), 'utf-8'),
        `"${name}" was lost because another file in the tree was unwritable`,
      ).toBe(name);
    }
  }, 60_000);

  // ...........................................................................
  it('names the path it could not write', async () => {
    // *"Fehler landen in einer Logdatei im Ordner, die niemand liest"* — so
    // the failure has to be in the thrown error, where a caller can act on it,
    // not only in a log.
    const bs = new BsMem();
    const { tree } = await treeWithBadName(bs);
    const target = join(dir, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = (await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch((e: unknown) => e)) as InstanceType<typeof UnwritablePathError>;
    warn.mockRestore();

    expect(
      err.impossiblePaths.join(' '),
      'the error does not say which path failed',
    ).toContain('x'.repeat(20));
    // And it says the right KIND of thing: a support request that reads
    // "could not fetch blob" for a 300-character filename goes looking at the
    // network.
    expect(err.message).toContain('this filesystem rejects');
  }, 60_000);

  // ...........................................................................
  it('does not retry the same file forever', async () => {
    // *"und versucht es endlos mit derselben Datei"*. A second restore of the
    // same tree must make the same bounded amount of progress rather than
    // spinning: the good files are already correct and are skipped, and the
    // impossible one fails again, once.
    const bs = new BsMem();
    const { tree, good } = await treeWithBadName(bs);
    const target = join(dir, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await receiver.restore(tree, target, { cleanTarget: true }).catch(() => {});
    const second = await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch((e: unknown) => e);
    warn.mockRestore();

    // Still reported, still partial — and the good files survived the second
    // pass rather than being pruned by it.
    expect(second).toBeInstanceOf(UnwritablePathError);
    for (const name of good) {
      expect(await readFile(join(target, name), 'utf-8')).toBe(name);
    }
  }, 60_000);
  // ...........................................................................
  it('names every rejected path, and counts them in the plural', async () => {
    // A message that says "1 path" for two of them is the kind of detail that
    // makes somebody doubt the rest of the report. The sibling error for
    // unfetchable blobs is asserted the same way.
    const bs = new BsMem();
    const second = `${'y'.repeat(300)}.txt`;
    const { tree } = await treeWithBadName(bs, [IMPOSSIBLE, second]);
    const target = join(dir, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = (await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch((e: unknown) => e)) as InstanceType<typeof UnwritablePathError>;
    warn.mockRestore();

    expect(err.impossiblePaths.length).toBe(2);
    expect(err.message).toContain('2 paths');
    // Sorted, so the same two failures always produce the same message and
    // two runs can be compared.
    expect([...err.impossiblePaths]).toEqual(
      [IMPOSSIBLE, second].sort(),
    );
  }, 60_000);
});
