// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// "Diverged" must mean the CONTENT differs, not that the fingerprints do.
//
// There are two definitions of "the same folder" in this codebase, asked by
// different halves of the sync:
//
//   the tree ref                     a hash of the whole tree   → am I diverged?
//   `_treesHaveEquivalentContent`    path → blobId + dirs       → is there work?
//
// While they can disagree, one of them is lying on every disagreement — and
// Herman measured what that costs. After a forced 40 s partition both machines
// held identical content (38 files, identical hashes) and one reported
// `diverged: true` for over EIGHT MINUTES across six merge repairs, logging
// "equivalent content, skipping restore" each time. The apply path correctly
// concluded there was nothing to transfer; the anti-entropy correctly concluded
// the refs differed; neither was wrong, and the system deadlocked against
// itself by design. It costs nothing in data and it makes the divergence signal
// — which every repair decision and the UI's "weicht ab" are built on —
// permanently untrustworthy.
//
// The mechanism was that the apply path had ALREADY computed the answer and
// kept it to itself. `agreedOn` existed, and only a completed bucket round fed
// it: declare a divergence, wait out the grace period, start a repair, run a
// round, find the roots identical, then clear. Every place that consults the
// content map now reports what it found.
//
// This is also the last structural difference from `@rljson/mongo-agent`, which
// is stable on the lab: mongo's unit of convergence is the DOCUMENT, with
// per-document hashes compared in buckets, so it never asks whether two
// whole-collection fingerprints agree. fs has a whole-folder ref because its
// ancestry rules need one — so it has to answer the question mongo never asks.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { hip } from '@rljson/hash';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route, type Tree } from '@rljson/rljson';

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';
import type { FsTree } from '../src/fs-scanner.ts';

const TREE = 'fsTree';

describe('a divergence is a difference in CONTENT', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-divergence-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * An agent syncing the temp folder, plus a way to announce a hub state.
   * @returns The agent, the db, and a `beacon` that announces a ref.
   */
  const start = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${TREE}`), socket, {
      causalOrdering: true,
      includeClientIdentity: true,
    });
    const agent = new FsAgent(dir, new BsMem(), {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
      // A tiny grace period, so a divergence that IS real shows up at once
      // rather than being hidden by a timer the test would have to outwait.
      antiEntropy: { graceMs: 1, maxBackoffMs: 1 },
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, TREE));
    stops.push(await agent.syncFromDb(db, connector, TREE));
    return {
      agent,
      db,
      beacon: (ref: string) =>
        socket.emit(stateBeaconEvent(connector.route.flat), { r: ref }),
    };
  };

  /**
   * Stores a variant of `tree` whose file nodes carry an `mtime`, and whose
   * ref therefore differs while its CONTENT MAP does not.
   *
   * This is not a contrivance: it is literally what a peer on an older build
   * sends. mtime used to be part of a file node, and taking it out is what
   * made a ref mean the same thing on every machine — so for the length of
   * any rollout, one side derives a ref the other never will, for byte-
   * identical folders.
   * @param db - Where to store it.
   * @param tree - The tree to vary.
   * @returns The variant's root ref.
   */
  const storeOldBuildVariant = async (
    db: Db,
    tree: FsTree,
  ): Promise<string> => {
    const nodes: Tree[] = [];
    const childRefs: string[] = [];
    let root: Tree | undefined;
    for (const [, node] of tree.trees) {
      const meta = node.meta as Record<string, unknown> | undefined;
      if (meta?.type === 'file') {
        // The old shape, with a timestamp back in the hashed meta.
        const nextMeta = { ...meta, mtime: 1_790_000_000_000 };
        // `meta` carries its OWN `_hash`, so both have to go or `hip` keeps
        // the stale one and the insert rejects the node.
        delete (nextMeta as { _hash?: string })._hash;
        const varied = { ...node, meta: nextMeta } as Tree;
        delete (varied as { _hash?: string })._hash;
        hip(varied);
        nodes.push(varied);
        childRefs.push(varied._hash as string);
      } else if (meta?.relativePath === '.') {
        root = node;
      }
    }
    const rootMeta = {
      ...((root as Tree).meta as Record<string, unknown>),
    };
    delete (rootMeta as { _hash?: string })._hash;
    const newRoot = {
      ...(root as Tree),
      meta: rootMeta,
      children: [...childRefs].sort(),
    } as Tree;
    delete (newRoot as { _hash?: string })._hash;
    hip(newRoot);
    nodes.push(newRoot); // root LAST, as the adapter requires
    return await new FsDbAdapter(db, TREE).storeFsTree(
      { rootHash: newRoot._hash as string, trees: new Map(
        nodes.map((n) => [n._hash as string, n]),
      ) },
      { skipNotification: true },
    );
  };

  // ...........................................................................
  it('does not report a divergence for identical content under a different ref', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    await sleep(300);

    // What the folder actually holds, and the same folder as an older build
    // would hash it.
    const mine = await agent.extract();
    const theirs = await storeOldBuildVariant(db, mine);
    expect(theirs, 'the variant must differ, or this test proves nothing').not.toBe(
      mine.rootHash,
    );

    beacon(theirs);
    await sleep(600);

    const status = agent.antiEntropyStatus;
    expect(status, 'the agent is not watching').not.toBeNull();
    expect(
      status!.diverged,
      `reported diverged against content it already holds ` +
        `(mine=${mine.rootHash?.slice(0, 8)}, theirs=${theirs.slice(0, 8)})`,
    ).toBe(false);
  }, 30_000);

  // ...........................................................................
  it('still reports a divergence when the content really differs', async () => {
    // The control, and the reason the test above is not just "never report
    // anything": a signal that cannot go red is as useless as one that cannot
    // go green.
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    await sleep(300);

    // A hub holding a file this node has never heard of. Its blob is absent
    // too, which is what a node genuinely behind looks like.
    const other = join(`${dir}-other`);
    await rm(other, { recursive: true, force: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'a.txt'), 'a');
    await writeFile(join(other, 'only-theirs.txt'), 'theirs');
    const theirTree = await new FsAgent(other, new BsMem()).extract();
    const theirs = await new FsDbAdapter(db, TREE).storeFsTree(theirTree, {
      skipNotification: true,
    });

    beacon(theirs);
    await sleep(800);

    expect(
      agent.antiEntropyStatus!.diverged,
      'a real difference in content was not reported',
    ).toBe(true);
    await rm(other, { recursive: true, force: true });
  }, 30_000);
});
