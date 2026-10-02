// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A TREE IS DATA FROM ANOTHER MACHINE.
//
// Nothing in this repo checked that. `restore` took each node's
// `relativePath`, joined it to the folder, and wrote there — and
// `join(target, '../escaped.txt')` resolves outside the target. Measured
// before the guard existed: a tree carrying `../escaped.txt` put a file NEXT TO
// the sync folder and the restore reported success. On a CARAT machine that is
// an arbitrary file write with the agent's privileges, on every node that
// applies the tree.
//
// It needs no malice to matter, which is why this is not filed as a security
// curiosity. A relative path assembled wrongly, a `relativePath` left absolute
// by some future scanner, a tree hand-edited to reproduce a bug: each becomes
// the same thing.
//
// This is the test class none of the comparable projects leaves out and this
// one had nothing for. Unison and Syncthing both carry dedicated suites for
// paths and file types; the cases below are the ones that are about trust.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { hip } from '@rljson/hash';
import type { Tree } from '@rljson/rljson';

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import type { FsTree } from '../src/fs-scanner.ts';

describe('a tree from a peer is not trusted with paths', () => {
  let base = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    base = join(process.cwd(), `test-temp-hostile-${++nth}`);
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(base, 'source'), { recursive: true });
    await mkdir(join(base, 'target'), { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * A valid tree of one good file, plus one node claiming `claimedPath`.
   * @param bs - Blob store to use.
   * @param claimedPath - The path the extra node claims.
   * @param type - Whether the extra node is a file or a directory.
   * @returns The tree.
   */
  const treeClaiming = async (
    bs: BsMem,
    claimedPath: string,
    type: 'file' | 'directory' = 'file',
  ): Promise<FsTree> => {
    const source = join(base, 'source');
    await writeFile(join(source, 'legitimate.txt'), 'legitimate');
    const agent = new FsAgent(source, bs);
    agents.push(agent);
    const scanned = await agent.extract();

    const props = await bs.setBlob(Buffer.from('ESCAPED'));
    const meta: Record<string, unknown> =
      type === 'file'
        ? {
            name: 'x',
            type: 'file',
            relativePath: claimedPath,
            size: 7,
            blobId: props.blobId,
          }
        : { name: 'x', type: 'directory', relativePath: claimedPath };
    const extra = {
      id: 'x',
      isParent: type === 'directory',
      children: null,
      meta,
    } as unknown as Tree;
    hip(extra);

    const nodes = new Map(scanned.trees);
    const root = nodes.get(scanned.rootHash) as Tree;
    nodes.delete(scanned.rootHash);
    nodes.set(extra._hash as string, extra);
    const rootMeta = { ...(root.meta as Record<string, unknown>) };
    delete (rootMeta as { _hash?: string })._hash;
    const newRoot = {
      ...root,
      meta: rootMeta,
      children: [...(root.children ?? []), extra._hash as string].sort(),
    } as Tree;
    delete (newRoot as { _hash?: string })._hash;
    hip(newRoot);
    nodes.set(newRoot._hash as string, newRoot);
    return { rootHash: newRoot._hash as string, trees: nodes };
  };

  // Every shape of "outside", because only one of them contains the obvious
  // substring and a guard that looks for `..` catches exactly that one.
  const escapes = [
    ['a plain parent reference', '../escaped.txt'],
    ['a parent reference buried mid-path', 'sub/../../escaped.txt'],
    ['several levels up', '../../../escaped.txt'],
    ['an absolute path', '/tmp/rljson-escaped-probe.txt'],
  ] as const;

  for (const [what, claimed] of escapes) {
    // .........................................................................
    it(`refuses ${what}, and applies the rest of the tree`, async () => {
      const bs = new BsMem();
      const tree = await treeClaiming(bs, claimed);
      const target = join(base, 'target');
      const receiver = new FsAgent(target, bs);
      agents.push(receiver);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});

      await receiver
        .restore(tree, target, { cleanTarget: true })
        .catch(() => undefined);
      const said = err.mock.calls.map((c) => String(c[0])).join('\n');
      err.mockRestore();

      // 1. Nothing was written outside.
      const outside = claimed.startsWith('/')
        ? claimed
        : join(target, claimed);
      expect(
        existsSync(outside),
        `a tree wrote OUTSIDE its folder: ${outside}`,
      ).toBe(false);

      // 2. The legitimate half of the tree still arrived — one bad node must
      //    not cost the rest, exactly as an unfetchable blob does not.
      expect(await readFile(join(target, 'legitimate.txt'), 'utf-8')).toBe(
        'legitimate',
      );

      // 3. And it was said out loud, because a refusal nobody hears is how a
      //    broken peer keeps sending.
      expect(said).toContain('leaves the sync folder');
      expect(await readFile(join(target, SYNC_ERROR_FILE), 'utf-8')).toContain(
        'resolves outside',
      );
    }, 60_000);
  }

  // ...........................................................................
  it('refuses an escaping DIRECTORY as well as a file', async () => {
    // The directory branch joins its own path and was guarded separately —
    // two call sites, so two ways out.
    const bs = new BsMem();
    const tree = await treeClaiming(bs, '../escaped-dir', 'directory');
    const target = join(base, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch(() => undefined);
    err.mockRestore();

    expect(existsSync(join(base, 'escaped-dir'))).toBe(false);
    expect(await readFile(join(target, 'legitimate.txt'), 'utf-8')).toBe(
      'legitimate',
    );
  }, 60_000);

  // ...........................................................................
  it('still accepts ordinary nested paths', async () => {
    // The counterpart, and the reason the guard resolves instead of
    // pattern-matching: `a/b/c.txt` and `a/./b.txt` are inside and must stay
    // acceptable. A guard that rejects too much is a sync that stops working.
    const target = join(base, 'target');
    for (const ok of ['plain.txt', 'a/b/c.txt', './dotted.txt', 'a/./d.txt']) {
      expect(
        FsAgent._isInsideRoot(target, ok),
        `${ok} was refused but is inside the folder`,
      ).toBe(true);
    }
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '../../..']) {
      expect(
        FsAgent._isInsideRoot(target, bad),
        `${bad} was accepted but is outside the folder`,
      ).toBe(false);
    }
    // The root itself.
    expect(FsAgent._isInsideRoot(target, '.')).toBe(true);
  });

  // ...........................................................................
  it('does not confuse a sibling folder with a prefix of this one', async () => {
    // `/sync` and `/sync-backup`: a `startsWith` without the separator says
    // the second is inside the first, and then a tree can write into a
    // neighbour that merely shares a name prefix.
    expect(FsAgent._isInsideRoot('/data/sync', '../sync-backup/x')).toBe(false);
    expect(FsAgent._isInsideRoot('/data/sync', 'nested/x')).toBe(true);
  });
});
