// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { DIR_MARKER, type ContentMap } from './fs-conflict-resolver.ts';

// .............................................................................
/** What {@link planAuthoring} is asked. */
export interface AuthoringQuestion {
  /** The folder as it was just scanned, `path → blobId`. */
  folder: ContentMap;
  /** The folder as this node's own head describes it. */
  head: ContentMap;
  /**
   * Paths the watcher saw deleted since the head was authored. A deleted
   * directory covers everything below it.
   */
  watched: ReadonlySet<string>;
  /** Below this many disappeared files, nothing is refused for its size. */
  minFiles: number;
  /** Above `minFiles`, the largest share of the folder that may disappear. */
  maxRatio: number;
  /** A folder holding more than this may not end up with this many or fewer. */
  allGoneMinFiles: number;
}

/** What {@link planAuthoring} decided. */
export type AuthoringPlan =
  | { kind: 'unchanged' }
  | { kind: 'author'; changed: string[]; removed: string[] }
  | { kind: 'refused'; disappeared: string[]; held: number };

// .............................................................................
/**
 * Whether this node may author an edit for what its folder looks like now.
 *
 * **The sender answers for the honesty of its edits.** A failed mount, an
 * emptied disk or a drive that did not come back looks to the scanner like a
 * person deleting most of the folder. Once authored, every peer would apply
 * it. So a disappearance is refused HERE, at the source, when all of these
 * hold:
 *
 * - the files are gone: their content is nowhere else in the folder, so a
 *   folder renamed while the agent was down is an ordinary edit;
 * - the watcher did not see them go, so a person deleting files while the
 *   agent runs is an ordinary edit;
 * - it is large: more than `minFiles` and more than `maxRatio` of the folder,
 *   or a folder of more than `allGoneMinFiles` left with that many or fewer.
 *
 * A few files deleted while the agent was down stay below the floors and are
 * authored like any other edit.
 * @param q - The folder, the head, and the floors.
 * @returns `unchanged`, `author` with the delta against the head, or
 *   `refused` with the files that disappeared.
 */
export const planAuthoring = (q: AuthoringQuestion): AuthoringPlan => {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, value] of q.folder) {
    if (q.head.get(path) !== value) changed.push(path);
  }
  for (const path of q.head.keys()) {
    if (!q.folder.has(path)) removed.push(path);
  }
  if (changed.length === 0 && removed.length === 0) return { kind: 'unchanged' };

  const isFile = (value: string | undefined) =>
    value !== undefined && value !== DIR_MARKER;
  const held = [...q.head.values()].filter(isFile).length;
  const remaining = [...q.folder.values()].filter(isFile).length;
  const stillHere = new Set([...q.folder.values()].filter(isFile));
  const watched = (path: string): boolean => {
    for (let at = path; ; ) {
      if (q.watched.has(at)) return true;
      const slash = at.lastIndexOf('/');
      if (slash < 0) return false;
      at = at.slice(0, slash);
    }
  };

  const disappeared = removed.filter(
    (path) =>
      isFile(q.head.get(path)) &&
      !stillHere.has(q.head.get(path) as string) &&
      !watched(path),
  );
  const mass =
    disappeared.length > q.minFiles && disappeared.length / held > q.maxRatio;
  const allGone =
    disappeared.length > 0 &&
    held > q.allGoneMinFiles &&
    remaining <= q.allGoneMinFiles;

  if (mass || allGone) return { kind: 'refused', disappeared, held };
  return { kind: 'author', changed: changed.sort(), removed: removed.sort() };
};
