// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { compareRefStamp, type RefStamp } from '@rljson/rljson';

// .............................................................................
/** `path → blobId`, with {@link DIR_MARKER} for a directory. */
export type ContentMap = ReadonlyMap<string, string>;

/** The value a directory has in a {@link ContentMap}. */
export const DIR_MARKER = '<dir>';

/** Who introduced one side's version of a path, and when it reached the fleet. */
export interface Introducer {
  /** The chain entry that introduced the version. */
  entry: string;
  /** Its stamp, or `undefined` while nobody has told this node. */
  stamp: RefStamp | undefined;
  /** The node that authored the entry. Names a conflicted copy. */
  nodeId: string;
}

/** One side of a merge. */
export interface MergeSide {
  /** The side's tree. */
  content: ContentMap;
  /** Who introduced this side's version of `path`. */
  introducer: (path: string) => Introducer;
}

/** A conflict the merge settled, and the signal it owes. */
export interface MergeConflict {
  /** `conflict/arbitrary` for C3 and C4, `collision/type` for C5. */
  kind: 'conflict/arbitrary' | 'collision/type';
  /** The contested path. */
  path: string;
  /** Where the version that lost the name was kept, when one was. */
  copyPath?: string;
}

/** What {@link merge3} decided. */
export interface MergeOutcome {
  /** The merged tree, conflicted copies included. */
  merged: Map<string, string>;
  /** Every conflict the merge settled — one signal each. */
  conflicts: MergeConflict[];
  /**
   * Paths whose C3 verdict needs a stamp this node does not know yet. When
   * non-empty the caller must not apply `merged`: it defers and signals
   * `repair/blocked`, and merges again once the stamp has arrived.
   */
  unknownStamps: string[];
}

// .............................................................................
/**
 * Merges two concurrent versions of a folder against their common ancestor.
 *
 * Per path, with `a` the ancestor's value and `b`/`c` the two sides':
 *
 * | rows | situation | outcome |
 * | --- | --- | --- |
 * | C1/C2 | one side changed, or both changed it the same way | that value |
 * | C3 | both changed one file differently | both kept; the version whose introducing entry has the higher stamp keeps the name |
 * | C4 | one side deleted, the other edited | the edit stays; the deletion is reported, not applied |
 * | C5 | a directory on one side, a file on the other | both kept: the directory keeps the path, the file becomes a conflicted copy |
 *
 * Nothing compares two machines' clocks, and no version is ever dropped.
 * @param base - The common ancestor's tree.
 * @param ours - This node's side.
 * @param theirs - The other side.
 * @returns The merged tree, the conflicts it settled, and the paths it could
 *   not decide yet.
 */
export const merge3 = (
  base: ContentMap,
  ours: MergeSide,
  theirs: MergeSide,
): MergeOutcome => {
  const merged = new Map<string, string>();
  const conflicts: MergeConflict[] = [];
  const unknownStamps: string[] = [];
  const taken = new Set<string>([
    ...base.keys(),
    ...ours.content.keys(),
    ...theirs.content.keys(),
  ]);

  // C5 first: a directory that collides with a file keeps its whole subtree,
  // so nothing below it is decided path by path against a side that has no
  // subtree there. Paths are visited outermost first, and the side holding the
  // file has nothing below it, so no collision can sit inside another.
  const owned = new Map<string, MergeSide>();
  for (const path of [...taken].sort()) {
    const a = base.get(path);
    const b = ours.content.get(path);
    const c = theirs.content.get(path);
    if (b === undefined || c === undefined) continue;
    if ((b === DIR_MARKER) === (c === DIR_MARKER)) continue;
    const dirSide = b === DIR_MARKER ? ours : theirs;
    const fileSide = b === DIR_MARKER ? theirs : ours;
    // Only a CONCURRENT change is a collision. One side turning a directory
    // into a file while the other left the directory and everything in it
    // alone is an ordinary edit — the file wins the path, the folder goes.
    const dirUntouched =
      dirSide.content.get(path) === a && !subtreeChanged(base, dirSide, path);
    const fileUntouched = fileSide.content.get(path) === a;
    if (dirUntouched || fileUntouched) continue;
    owned.set(path, dirSide);
    // No stamp in this name: C5 decides without one, so a node that does not
    // know it yet must still pick the same name.
    const copyPath = copyName(
      path,
      fileSide.introducer(path).nodeId,
      undefined,
      taken,
    );
    merged.set(copyPath, fileSide.content.get(path) as string);
    conflicts.push({ kind: 'collision/type', path, copyPath });
  }

  for (const path of [...taken].sort()) {
    const dir = [...owned.keys()].find(
      (d) => path === d || path.startsWith(`${d}/`),
    );
    if (dir !== undefined) {
      const value = (owned.get(dir) as MergeSide).content.get(path);
      if (value !== undefined) merged.set(path, value);
      continue;
    }

    const a = base.get(path);
    const b = ours.content.get(path);
    const c = theirs.content.get(path);

    if (b === c || c === a) {
      if (b !== undefined) merged.set(path, b);
      continue;
    }
    if (b === a) {
      if (c !== undefined) merged.set(path, c);
      continue;
    }

    // Both sides changed `path`, differently.
    if (b === undefined || c === undefined) {
      // C4: data beats absence.
      merged.set(path, (b ?? c) as string);
      conflicts.push({ kind: 'conflict/arbitrary', path });
      continue;
    }

    // C3: two versions of one file.
    const mine = ours.introducer(path);
    const yours = theirs.introducer(path);
    if (!mine.stamp || !yours.stamp) {
      unknownStamps.push(path);
      continue;
    }
    // Equal stamps happen when one announcement carried both entries; the
    // entries themselves differ, or the two versions would be the same.
    const order =
      compareRefStamp(mine.stamp, yours.stamp) ||
      (mine.entry < yours.entry ? -1 : 1);
    const [winner, loser, loserIntroducer] =
      order >= 0 ? [b, c, yours] : [c, b, mine];
    merged.set(path, winner);
    const copyPath = copyName(
      path,
      loserIntroducer.nodeId,
      loserIntroducer.stamp,
      taken,
    );
    merged.set(copyPath, loser);
    conflicts.push({ kind: 'conflict/arbitrary', path, copyPath });
  }

  return { merged, conflicts, unknownStamps };
};

// .............................................................................
/**
 * Whether one side changed anything below `dir` since the common ancestor.
 * @param base - The common ancestor's tree.
 * @param side - The side to look at.
 * @param dir - The directory path.
 * @returns `true` when a path under `dir/` differs from the ancestor's.
 */
const subtreeChanged = (
  base: ContentMap,
  side: MergeSide,
  dir: string,
): boolean => {
  const prefix = `${dir}/`;
  for (const path of new Set([...base.keys(), ...side.content.keys()])) {
    if (path.startsWith(prefix) && base.get(path) !== side.content.get(path)) {
      return true;
    }
  }
  return false;
};

// .............................................................................
// Names

/**
 * The name a version that lost a contested path is kept under:
 * `<stem> (conflicted copy <hub>-<n> <nodeId>)<ext>`, leaving out what is not
 * known — the stamp, the node — and numbered when taken.
 *
 * A function of the loser's author and stamp only, so every node that settles
 * the same conflict picks the same name.
 * @param path - The contested path.
 * @param nodeId - The node that introduced the losing version.
 * @param stamp - Its stamp, when the name should carry it.
 * @param taken - Paths already in use; the chosen name is added.
 * @returns The copy's path.
 */
export const copyName = (
  path: string,
  nodeId: string,
  stamp: RefStamp | undefined,
  taken: Set<string>,
): string => {
  const who = [stamp ? `${stamp.hub}-${stamp.n}` : '', nodeId]
    .filter((part) => part !== '')
    .join(' ');
  return unusedName(
    path,
    `(conflicted copy${who === '' ? '' : ` ${who}`})`,
    taken,
  );
};

/**
 * The name a joining folder's own version of a path is set aside under when
 * the network holds a different one, numbered when taken:
 *
 * `<stem> (conflicted copy <UTC time> local)<ext>`
 *
 * No stamp can order it — the version never reached the fleet — so the name
 * says when it was set aside and that it is this machine's.
 * @param path - The path.
 * @param at - When it was set aside, epoch ms.
 * @param taken - Paths already in use; the chosen name is added.
 * @returns The copy's path.
 */
export const joinCopyName = (
  path: string,
  at: number,
  taken: Set<string>,
): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return unusedName(path, `(conflicted copy ${date} ${time} local)`, taken);
};

/**
 * The name a file is set aside under when the history DELETED its path:
 * `<stem> (recovered)<ext>`, numbered when taken.
 *
 * **Not a conflict copy, and the difference is who is told.** A conflict copy
 * is live work on a live path and is announced, because the network needs it.
 * A recovered file is content the fleet deliberately removed — a folder
 * restored from last month's backup, or a client that was away while a
 * directory was deleted — and announcing it would push every one of those
 * deletions back to every node, under names nobody deleted. So it is kept
 * where its owner can see it and nothing is said about it. No time and no
 * identity: the path is simply gone from the history, and one name per path is
 * what a user can act on.
 * @param path - The path the history removed.
 * @param taken - Paths already in use; the chosen name is added.
 * @returns The set-aside path.
 */
export const recoveredName = (path: string, taken: Set<string>): string =>
  unusedName(path, '(recovered)', taken);

/**
 * `<dir>/<stem> <marker><ext>`, numbered ` (n)` while taken. A leading-dot
 * name (`.gitignore`) has no extension.
 * @param path - The path.
 * @param marker - What goes between the stem and the extension.
 * @param taken - Paths already in use; the chosen name is added.
 * @returns The name.
 */
const unusedName = (path: string, marker: string, taken: Set<string>): string => {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  let candidate = `${dir}${stem} ${marker}${ext}`;
  for (let n = 1; taken.has(candidate); n++) {
    candidate = `${dir}${stem} ${marker} (${n})${ext}`;
  }
  taken.add(candidate);
  return candidate;
};
