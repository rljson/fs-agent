// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// F1 / D5 — renaming a folder is not a mass deletion.
//
// *"Für das System ist ein Umbenennen 'alles löschen und neu anlegen'. Damit
// läuft es in die Löschsperre und blockiert."* The register also notes there is
// no test for it: *"Vorher zwei Tests dafür schreiben — es gibt bis heute
// keinen."*
//
// Two claims, and they are separable, so they get a test each:
//
//  1. the rename must not be REFUSED as a mass deletion — every file under the
//     old name disappears at once, which is precisely the shape the guard
//     exists to stop;
//  2. it must not RE-TRANSFER the content — the blobs are unchanged, only the
//     paths move, and a folder of any size would otherwise cross the network
//     again for a rename.
//
// The second only became true when mtime left the content identity: a renamed
// file keeps its timestamp, so its blobId and its node now hash identically on
// every machine, which is what lets the receiver recognise the bytes it
// already has.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { mkdir, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent, MASS_DELETE_MIN_FILES } from '../src/fs-agent.ts';

/** Comfortably over the guard's floor, so a refusal is possible at all. */
const FILES = MASS_DELETE_MIN_FILES + 40;

describe('F1/D5 — renaming a folder', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-rename-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(dir, 'before'), { recursive: true });
    for (let i = 0; i < FILES; i++) {
      await writeFile(join(dir, 'before', `f-${i}.txt`), `content-${i}`);
    }
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * A fresh agent over the folder, sharing one blob store.
   * @param bs - The store to share.
   * @returns The agent.
   */
  const agentFor = (bs: BsMem): FsAgent => {
    const agent = new FsAgent(dir, bs);
    agents.push(agent);
    return agent;
  };

  // ...........................................................................
  it('is applied, not refused as a mass deletion', async () => {
    // The receiving half: a peer is handed the renamed tree and must adopt it.
    // Every path under `before/` vanishes at once, which is exactly what the
    // mass-delete guard is for — and a rename is the one case where it is
    // wrong, because the same files arrive under a new name in the same tree.
    const bs = new BsMem();
    const target = join(dir, 'target');
    await mkdir(target, { recursive: true });

    const source = agentFor(bs);
    const before = await source.extract();
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    await receiver.restore(before, target, { cleanTarget: true });
    // As a live agent does after applying: scan, so the node knows what it is
    // holding. The guard below compares blobIds, and a receiver that has never
    // looked at its own folder has none to compare — it cannot tell a move
    // from a deletion, and correctly refuses.
    await receiver.extract();

    await rename(join(dir, 'before'), join(dir, 'after'));
    const after = await source.extract();

    // The guard counts what WOULD be pruned against the folder size. The
    // renamed tree prunes all of `before/` — over the ratio — so this is the
    // assertion that matters.
    await receiver.restore(after, target, { cleanTarget: true });

    const landed = (await receiver.extract()).trees;
    const paths = [...landed.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => !!p && p !== '.');
    expect(paths.filter((p) => p.startsWith('after/')).length).toBe(FILES);
    expect(paths.filter((p) => p.startsWith('before/'))).toEqual([]);
  }, 120_000);

  // ...........................................................................
  it('moves paths without putting content on the wire', async () => {
    // The sending half, and the claim has to be stated precisely because
    // there are two costs and only one of them is D5's.
    //
    // What must not happen is CONTENT CROSSING THE NETWORK: a renamed folder
    // of any size would otherwise transfer again. It does not, and the reason
    // is that blobs are content-addressed — a renamed file keeps its bytes, so
    // its blobId is unchanged, no new blob object exists, and a receiver
    // fetches nothing. That only holds because mtime left the content
    // identity; with it in, the node hashed differently on every machine.
    //
    // What DOES still happen is a local re-read: the scan cache is keyed by
    // path, so after a rename every file is read and hashed again from disk.
    // No bytes leave the machine, and it is the same cost as the first scan —
    // which is D8's problem (*"erster Start am echten Katalog rund 48
    // Minuten"*), not this one. Asserting it away here would be asserting a
    // fix nobody has written.
    const bs = new BsMem();
    const agent = agentFor(bs);
    const before = await agent.extract();
    const blobsBefore = bs.size;

    await rename(join(dir, 'before'), join(dir, 'after'));
    const after = await agent.extract();

    // Not one new blob: nothing for a peer to fetch.
    expect(
      bs.size,
      'renaming a folder created new blob content',
    ).toBe(blobsBefore);

    // Same blobIds, different tree — which is what makes the above meaningful
    // rather than a tree that simply did not change.
    const idsOf = (t: typeof before) =>
      [...t.trees.values()]
        .map((n) => (n.meta as { blobId?: string })?.blobId)
        .filter((b): b is string => !!b)
        .sort();
    expect(idsOf(after)).toEqual(idsOf(before));
    expect(after.rootHash).not.toBe(before.rootHash);
  }, 120_000);
});
