// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// S5 — the two equality predicates must agree (§7.4, §2.1b).
//
// There are TWO definitions of "the same folder" in this codebase, and they
// are asked by different halves of the sync:
//
//   the tree ref                     the whole tree row hash   →  am I diverged?
//   `_treesHaveEquivalentContent`    path → blobId + dirs      →  is there work?
//
// While they can disagree, one of them is lying on every disagreement. Herman
// measured what that costs: after a forced 40 s partition both machines held
// identical content — 38 files, same hashes — and one reported `diverged: true`
// for over EIGHT MINUTES across six merge repairs, logging "equivalent content,
// skipping restore" each time. The apply path correctly concluded there was
// nothing to transfer; the anti-entropy correctly concluded the refs differed;
// neither was wrong, and the system deadlocked against itself by design.
//
// It costs nothing in data. It makes the divergence signal permanently
// untrustworthy, which is the signal every repair decision is built on — and
// in the UI it is a permanent red "weicht ab".
//
// This needs no agents, no partition and no chain: it is a pure function of two
// trees. §2.1b says to COMPUTE which field breaks the biconditional rather than
// reason about it, so the tests below isolate one candidate each.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { mkdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import type { FsTree } from '../src/fs-scanner.ts';

describe('S5 — ref identity vs content identity', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-refcontent-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /** Scans `dir` and hands back the tree plus the agent that read it. */
  const scan = async (): Promise<{ agent: FsAgent; tree: FsTree }> => {
    const agent = new FsAgent(dir, new BsMem());
    agents.push(agent);
    const tree = await agent.scanner.scan();
    return { agent, tree };
  };

  /** Whether the agent considers two trees the same folder. */
  const sameContent = (agent: FsAgent, a: FsTree, b: FsTree): boolean =>
    (
      agent as unknown as {
        _treesHaveEquivalentContent: (x: FsTree, y: FsTree) => boolean;
      }
    )._treesHaveEquivalentContent(a, b);

  /**
   * Every directory node's children, as the scan recorded them.
   * @param tree - The tree to inspect.
   * @returns One array of child refs per parent node.
   */
  const childLists = (tree: FsTree): string[][] => {
    const out: string[][] = [];
    for (const [, node] of tree.trees) {
      if (node.children && node.children.length > 1) {
        out.push([...node.children]);
      }
    }
    return out;
  };

  // ...........................................................................
  it('S5: the scan emits a CANONICAL child order', async () => {
    // THE BICONDITIONAL, at its root. `ref(a) === ref(b)` must hold whenever
    // the content is equivalent — and before this, it did not.
    //
    // `readdir` (`fs-scanner.ts:338`) is not ordered, and the order it returns
    // is a property of the filesystem, not of the folder. The tree ref hashes
    // the children array; `_getFileContentMap` does not. So two machines
    // holding byte-identical content derived DIFFERENT refs for it, and the
    // divergence signal — which every repair decision is built on — said they
    // disagreed when they did not.
    //
    // A canonical order makes the ref a function of CONTENT alone, which is
    // what a content hash was always supposed to be. Asserted on the SCANNER
    // rather than on an arbitrary tree, because that is where the guarantee
    // has to live: any two scans of equivalent content now agree by
    // construction, whatever order their filesystems hand back.
    await mkdir(join(dir, 'nested'), { recursive: true });
    for (const name of ['c.txt', 'a.txt', 'b.txt', 'd.txt', 'e.txt']) {
      await writeFile(join(dir, name), name);
    }
    for (const name of ['z.txt', 'y.txt', 'x.txt']) {
      await writeFile(join(dir, 'nested', name), name);
    }

    const { tree } = await scan();
    const lists = childLists(tree);
    expect(lists.length, 'no directory with siblings to order').toBeGreaterThan(
      0,
    );
    for (const children of lists) {
      expect(children, 'children are not in canonical order').toEqual(
        [...children].sort(),
      );
    }
  });

  // ...........................................................................
  it('S5 GUARD: identical folders scanned twice agree on both predicates', async () => {
    // The easy half, and it must never break: the same folder scanned twice
    // gives one ref and equivalent content.
    await writeFile(join(dir, 'a.txt'), 'a');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'b.txt'), 'b');

    const first = await scan();
    const second = await scan();

    expect(second.tree.rootHash).toBe(first.tree.rootHash);
    expect(sameContent(first.agent, first.tree, second.tree)).toBe(true);
  });

  // ...........................................................................
  it('S5 GUARD: different content disagrees on both predicates', async () => {
    // The other easy half: a real difference must be visible to both.
    await writeFile(join(dir, 'a.txt'), 'a');
    const before = await scan();

    await writeFile(join(dir, 'a.txt'), 'CHANGED');
    const after = await scan();

    expect(after.tree.rootHash).not.toBe(before.tree.rootHash);
    expect(sameContent(before.agent, before.tree, after.tree)).toBe(false);
  });
  // ...........................................................................
  // S7 — the same bytes must give the same ref on two machines.
  //
  // This is the invariant every ancestry check is built on: a receiver prunes
  // only for a sender that names a state the receiver is in, so a ref has to
  // mean the same thing on both ends. Where it does not, a node announces
  // parents nobody can be in and every deletion it sends is refused by
  // everybody — which is `the weakness register` §1, *"deletions do not reliably
  // propagate"*, the register's most-reproduced entry.
  //
  // mtime was in the content identity and broke it. Not for exotic input: any
  // file created independently rather than restored — the same document saved
  // on two machines, a seeded fixture, a folder copied to two laptops — and at
  // MILLISECOND granularity. Measured on four nodes, one `keeper.txt` written
  // by a loop carried `…104.2852`, `…104.4375` and `…104.5483`, and
  // `stats.mtime.getTime()` truncates, so which side of a boundary a write
  // landed on decided the whole folder's ref.
  //
  // Two cases, because the second is the one that bit: a difference of one
  // millisecond is as fatal as a difference of a day, and far easier to hit.
  // ...........................................................................
  it('S7: identical content written at different times gives one ref', async () => {
    await writeFile(join(dir, 'keeper.txt'), 'keeper');
    const now = await scan();

    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, 'keeper.txt'), old, old);
    const aged = await scan();

    expect(aged.tree.rootHash, 'a day apart changed the ref').toBe(
      now.tree.rootHash,
    );
    expect(sameContent(now.agent, now.tree, aged.tree)).toBe(true);
  });

  // ...........................................................................
  it('S7: a one-millisecond difference gives one ref', async () => {
    await writeFile(join(dir, 'keeper.txt'), 'keeper');
    const first = await scan();

    // The measured case, exactly: one millisecond, the width of a loop
    // iteration.
    const shifted = new Date(Date.now() + 1);
    await utimes(join(dir, 'keeper.txt'), shifted, shifted);
    const second = await scan();

    expect(second.tree.rootHash, 'one millisecond changed the ref').toBe(
      first.tree.rootHash,
    );
  });

  // ...........................................................................
  it('S7 GUARD: the scanner still knows each file\'s real mtime', async () => {
    // Excluded from the IDENTITY, not discarded. The restore's skip-a-write
    // optimisation checks a file's mtime against what the last scan saw, and
    // an 80 GB catalogue is rewritten on every sync without it — so dropping
    // mtime from the tree must not drop it from the scanner.
    await writeFile(join(dir, 'keeper.txt'), 'keeper');
    const { agent } = await scan();

    const known = agent.scanner.knownFile('keeper.txt');
    expect(known, 'the scanner forgot what it saw').toBeDefined();
    expect(known!.size).toBe(6);
    expect(known!.mtime).toBeGreaterThan(0);
    expect(known!.blobId).toBeTruthy();
    expect(agent.scanner.knownFile('never-existed.txt')).toBeUndefined();
  });
});
