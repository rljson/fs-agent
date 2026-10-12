// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
/** How two heads stand — see `FsEditChain.relate`. */
export type Relation =
  | { verdict: 'same' | 'behind' | 'ahead' | 'incomplete' }
  | { verdict: 'fork'; base: string | undefined };

/** What {@link receive} needs from the agent. */
export interface ReceiveDeps {
  /** This node's head, or `undefined` before it has one. */
  ownHead(): string | undefined;
  /** Authors whatever the folder holds beyond the own head, first. */
  flushLocal(): Promise<void>;
  /** How the own head and an arrived head stand. */
  relate(ours: string, theirs: string): Promise<Relation>;
  /** The tree ref a head names, or `undefined` when it cannot be read. */
  treeRefOf(head: string): Promise<string | undefined>;
  /**
   * Writes a head's tree into the folder, deleting what it lacks, and makes it
   * this node's head. `refused` when it could not — nothing was adopted then.
   */
  applyBehind(head: string): Promise<'applied' | 'refused'>;
  /** Makes `head` — one state under another name — this node's head. */
  adopt(head: string): Promise<void>;
  /** Announces this node's head again. */
  announceOwn(): void;
  /** Merges a forked head into this node's; see `merge3`. */
  merge(
    theirs: string,
    base: string | undefined,
  ): Promise<'merged' | 'deferred' | 'refused'>;
  /** Says that nothing could be decided about `head`. */
  blocked(head: string, reason: string): void;
}

/**
 * Whether this node agrees with the head the hub said last, and what receiving
 * it made this node do — `FsAgent.antiEntropyStatus`.
 */
export interface AntiEntropyStatus {
  /** Whether this node's head was not the hub's after receiving it. */
  diverged: boolean;
  /** Since when, epoch ms by this node's clock. */
  divergedSince: number | null;
  /** The head the hub said last. */
  hubRef: string | null;
  /** This node's head now. */
  localRef: string | null;
  /** How often the hub's head made this node act. */
  repairs: number;
  /**
   * What it did last: `pull` applied or adopted it, `push` announced this
   * node's own, `merge` merged the two, `blocked` could decide nothing.
   */
  lastRepair: {
    action: 'pull' | 'push' | 'merge' | 'blocked';
    at: number;
    hubRef: string;
    localRef: string;
    /** How often in a row the same hub head made it act. */
    attempt: number;
  } | null;
}

/** What {@link receive} did. */
export type ReceiveOutcome =
  | 'no-head'
  | 'in-sync'
  | 'applied'
  | 'refused'
  | 'announced'
  | 'adopted'
  | 'merged'
  | 'deferred'
  | 'blocked';

// .............................................................................
/**
 * What a node does with a head that arrived.
 *
 * The chain is the only order:
 *
 * | relation | action |
 * | --- | --- |
 * | `behind` — theirs descends from ours | apply it, deleting what it lacks, and adopt it |
 * | `ahead` — ours descends from theirs | announce ours |
 * | `fork`, same content | converge on the smaller ref, on every node |
 * | `fork` | merge against the base |
 * | `incomplete` | nothing; say so |
 *
 * Deleting on `behind` is correct by construction: whoever made the head held
 * this node's state and chose not to have the file. Work this node has not
 * authored yet is authored first, so it can never be overwritten by a head
 * that never saw it — it turns a `behind` into a `fork`.
 * @param head - The head that arrived.
 * @param deps - The agent.
 * @returns What was done.
 */
export const receive = async (
  head: string,
  deps: ReceiveDeps,
): Promise<ReceiveOutcome> => {
  if (deps.ownHead() === undefined) return 'no-head';
  await deps.flushLocal();
  const own = deps.ownHead() as string;
  if (head === own) return 'in-sync';

  const relation = await deps.relate(own, head);
  switch (relation.verdict) {
    case 'same':
      return 'in-sync';
    case 'behind':
      return deps.applyBehind(head);
    case 'ahead':
      deps.announceOwn();
      return 'announced';
    case 'incomplete':
      deps.blocked(head, 'the history between the two heads cannot be read');
      return 'blocked';
  }

  const [ours, theirs] = await Promise.all([
    deps.treeRefOf(own),
    deps.treeRefOf(head),
  ]);
  if (ours === undefined || theirs === undefined) {
    deps.blocked(head, 'a forked head names a tree that cannot be read');
    return 'blocked';
  }
  if (ours === theirs) {
    // One state under two names. Every node keeps the smaller, so they agree
    // without a merge entry and without a round of announcements.
    if (head < own) {
      await deps.adopt(head);
      return 'adopted';
    }
    deps.announceOwn();
    return 'announced';
  }
  return deps.merge(head, relation.base);
};
