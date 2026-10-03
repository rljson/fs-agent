// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Announce a state THE WAY A PEER DOES.
//
// A test that stores a tree and advertises its ref is not a peer. A peer
// authors a chain entry saying what it changed and what it removed, and
// announces the entry, because that entry is the only thing that makes an
// absence mean a deletion. Tests built before the chain hand-built the tree and
// left the history out — which is why they could only ever exercise the
// inference the chain exists to replace.
//
// Everything in here is what `FsAgent` itself does on a push, in the same
// order; nothing is simulated.
// .............................................................................

import { Db } from '@rljson/db';

import { CHAIN_HEAD_PREFIX } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';
import type { FsTree } from '../src/fs-scanner.ts';

/** What one peer push consists of. */
export interface PeerPush {
  /** The tree the peer holds now. */
  tree: FsTree;
  /** Paths it wrote or changed to get there. */
  changed?: string[];
  /** Paths it deleted to get there — the half an absence cannot state. */
  removed?: string[];
  /** The entry this push builds on. Omitted means "the chain's own tip". */
  previous?: string[];
}

/** A peer push, as it reaches a receiver. */
export interface Announced {
  /** What to hand to `connector.advertise` — a marked chain head. */
  announcement: string;
  /** The content ref the tree was stored under. */
  treeRef: string;
  /** The entry's own ref, for building a successor on top of it. */
  head: string;
}

/**
 * Stores a tree AND the entry that explains it, and returns the announcement.
 * @param db - The database both sides read.
 * @param treeKey - The tree table.
 * @param push - The tree and what it took to get there.
 * @returns The announcement to advertise, plus the refs behind it.
 */
export const announceAsPeer = async (
  db: Db,
  treeKey: string,
  push: PeerPush,
): Promise<Announced> => {
  const treeRef = await new FsDbAdapter(db, treeKey).storeFsTree(push.tree);
  const chain = new FsEditChain(db, treeKey);
  await chain.init();
  const entry = await chain.append({
    treeRef,
    changed: push.changed,
    removed: push.removed,
    previous: push.previous,
  });
  return {
    announcement: `${CHAIN_HEAD_PREFIX}${entry.head}`,
    treeRef,
    head: entry.head,
  };
};
