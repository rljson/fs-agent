// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Conflict } from '@rljson/db';
import type { InsertHistoryRow } from '@rljson/rljson';

import type { FsTree } from './fs-scanner.js';

/**
 * Nextcloud-style conflict resolution for forked FS-tree DAGs.
 *
 * When two peers edit a shared tree while one is offline, the InsertHistory
 * DAG forks into two tips (B and C, both descending from a common ancestor A).
 * `@rljson/db` fires a `dagBranch` conflict. This module resolves it on the
 * **client** by performing a deterministic three-way file-level merge and
 * writing a single **merge revision D** whose `InsertHistory.previous`
 * references *both* tips — collapsing the fork back to one tip.
 *
 * The pure functions (merge, naming, ancestor walk, winner selection) are
 * deterministic: every peer resolving the same fork produces the identical D,
 * so resolution converges instead of forking again.
 *
 * See `doc/conflict-resolution-design.md`.
 */

/** relativePath → blobId. Directories are recorded as {@link DIR_MARKER}. */
export type ContentMap = Map<string, string>;

/** Sentinel blobId used for directory entries in a {@link ContentMap}. */
export const DIR_MARKER = '<dir>';

/**
 * Builds a {@link ContentMap} (relativePath → blobId) from an FsTree, ignoring
 * mtime so two trees with identical content compare equal regardless of when
 * they were written.
 * @param tree - The FsTree to flatten
 * @returns A map of relativePath → blobId (directories use {@link DIR_MARKER})
 */
export function fsTreeToContentMap(tree: FsTree): ContentMap {
  const map: ContentMap = new Map();
  for (const [, node] of tree.trees) {
    const meta = (node as { meta?: Record<string, unknown> }).meta;
    if (meta?.type === 'file') {
      map.set(
        meta.relativePath as string,
        (meta.blobId as string | undefined) ?? '',
      );
    } else if (meta?.type === 'directory' && meta.relativePath !== '.') {
      // Include directories so adding/removing an empty dir is not silently
      // deduplicated away.
      map.set(meta.relativePath as string, DIR_MARKER);
    }
  }
  return map;
}

/** A branch tip's identity, used for deterministic winner selection. */
export interface BranchTip {
  /** InsertHistory timeId of the tip (per-db; used only for local lookups). */
  timeId: string;
  /** Shared content ref of the tip — the cross-client deterministic tiebreak. */
  ref: string;
  /** Originating client id (InsertHistory `origin`). Empty string if unknown. */
  clientId: string;
  /** InsertHistory client timestamp (ms). 0 if unknown. */
  timestamp: number;
}

/**
 * Total, deterministic order over two tips. Returns a positive number when `a`
 * outranks `b`. Greater timestamp wins; ties broken by greater clientId, then
 * greater **content ref**. The final tiebreak is the ref (not the timeId)
 * because timeIds are per-db — using them would make different peers pick
 * different winners and never converge; the ref is shared, so every peer agrees.
 * @param a - First tip
 * @param b - Second tip
 * @returns Positive if `a` outranks `b`, negative if `b` outranks `a`, else 0
 */
export function compareTips(a: BranchTip, b: BranchTip): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.clientId !== b.clientId) {
    return a.clientId > b.clientId ? 1 : -1;
  }
  if (a.ref !== b.ref) {
    return a.ref > b.ref ? 1 : -1;
  }
  return 0;
}

/**
 * Picks the path-owning winner of a conflict. Per design decision §11.1 the
 * revision with the greater InsertHistory timestamp keeps the original path;
 * the loser's content is preserved under a renamed conflict copy.
 * @param a - First tip
 * @param b - Second tip
 * @returns The winning and losing tips
 */
export function decideWinner(
  a: BranchTip,
  b: BranchTip,
): { winner: BranchTip; loser: BranchTip } {
  return compareTips(a, b) >= 0
    ? { winner: a, loser: b }
    : { winner: b, loser: a };
}

/**
 * Finds the nearest common ancestor timeId of two tips by walking the
 * InsertHistory `previous` chains. Returns null when the tips share no
 * ancestor (treat as an empty ancestor — everything is an add/add).
 * @param rows - All InsertHistory rows for the table
 * @param tipA - First tip timeId
 * @param tipB - Second tip timeId
 * @returns The nearest common ancestor timeId, or null if none
 */
export function findCommonAncestor(
  rows: InsertHistoryRow<string>[],
  tipA: string,
  tipB: string,
): string | null {
  const prevOf = new Map<string, string[]>();
  for (const row of rows) {
    prevOf.set(row.timeId, row.previous ?? []);
  }

  // All ancestors of A (including A itself).
  const ancestorsOfA = new Set<string>();
  const stack = [tipA];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (ancestorsOfA.has(id)) {
      continue;
    }
    ancestorsOfA.add(id);
    for (const p of prevOf.get(id) ?? []) {
      stack.push(p);
    }
  }

  // Breadth-first from B → first node also in ancestorsOfA is the nearest.
  const visited = new Set<string>();
  let frontier = [tipB];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (ancestorsOfA.has(id)) {
        return id;
      }
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      for (const p of prevOf.get(id) ?? []) {
        next.push(p);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Formats a timestamp as a stable UTC `YYYY-MM-DD HHMMSS` string. UTC keeps the
 * conflict-copy name identical across peers in different timezones.
 * @param ms - Milliseconds since the epoch
 * @returns The formatted UTC timestamp
 */
export function formatConflictTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${date} ${time}`;
}

/**
 * Derives a Nextcloud-style conflict-copy path:
 * `document.txt` → `document (conflicted copy <clientId> <ts>).txt`.
 *
 * - The suffix is inserted before the final extension; dotfiles / extensionless
 *   names get it appended.
 * - Identity + timestamp come from the *losing* revision, so every peer derives
 *   the same name (determinism).
 * - If the candidate name is already taken, a numeric ` (n)` is appended; the
 *   chosen name is added to `taken`.
 * @param relativePath - The original conflicting path
 * @param clientId - The losing revision's client id
 * @param timestamp - The losing revision's InsertHistory timestamp (ms)
 * @param taken - Set of already-used paths; the chosen name is added to it
 * @returns A unique conflict-copy path
 */
export function conflictCopyName(
  relativePath: string,
  clientId: string,
  timestamp: number,
  taken: Set<string>,
): string {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = base.lastIndexOf('.');
  // dot > 0 → a leading-dot name (".gitignore") is treated as extensionless.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  const ts = formatConflictTimestamp(timestamp);
  const marker = `(conflicted copy ${clientId} ${ts})`;

  let candidate = `${dir}${stem} ${marker}${ext}`;
  let n = 1;
  while (taken.has(candidate)) {
    candidate = `${dir}${stem} ${marker} (${n})${ext}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

/** A conflict copy to materialise: the losing content under a renamed path. */
export interface ConflictCopy {
  /** The renamed path the losing content is written to. */
  path: string;
  /** The losing blobId (content preserved, nothing lost). */
  blobId: string;
}

/** The result of a three-way merge. */
export interface MergePlan {
  /** Final tree content (winner-resolved): relativePath → blobId. */
  merged: ContentMap;
  /** Extra files to write beside the merged set (the renamed losers). */
  copies: ConflictCopy[];
  /** Original paths that genuinely conflicted (both sides changed differently). */
  conflictPaths: string[];
}

/**
 * Three-way file-level merge of ancestor `o`, branch `ours`, branch `theirs`.
 * `winnerSide` decides who keeps the path on a real conflict; the loser's
 * content is preserved under a {@link conflictCopyName}. Pure & deterministic.
 *
 * Per relative path (see design §4.4):
 * - both sides equal → keep it (covers unchanged + add-same + delete-both)
 * - only theirs changed (`ours === o`) → take theirs
 * - only ours changed (`theirs === o`) → take ours
 * - both changed differently → CONFLICT: winner keeps path, loser renamed
 * @param o - Ancestor content map
 * @param ours - Our branch content map
 * @param theirs - Their branch content map
 * @param winnerSide - Which side keeps the path on a real conflict
 * @param loserClientId - The losing revision's client id (for copy names)
 * @param loserTimestamp - The losing revision's timestamp (for copy names)
 * @returns The merge plan (merged set, conflict copies, conflicting paths)
 */
export function threeWayMerge(
  o: ContentMap,
  ours: ContentMap,
  theirs: ContentMap,
  winnerSide: 'ours' | 'theirs',
  loserClientId: string,
  loserTimestamp: number,
): MergePlan {
  const merged: ContentMap = new Map();
  const copies: ConflictCopy[] = [];
  const conflictPaths: string[] = [];

  // Seed the taken-set with every real path so conflict copies never collide
  // with an existing path or another copy.
  const taken = new Set<string>([...o.keys(), ...ours.keys(), ...theirs.keys()]);

  const allPaths = new Set<string>(taken);
  for (const path of [...allPaths].sort()) {
    const a = o.get(path);
    const b = ours.get(path);
    const c = theirs.get(path);

    if (b === c) {
      // Both branches agree (incl. both-absent and both-added-same).
      if (b !== undefined) {
        merged.set(path, b);
      }
      continue;
    }
    if (b === a) {
      // Only theirs diverged from the ancestor.
      if (c !== undefined) {
        merged.set(path, c);
      }
      continue;
    }
    if (c === a) {
      // Only ours diverged from the ancestor.
      if (b !== undefined) {
        merged.set(path, b);
      }
      continue;
    }

    // Genuine conflict: both sides diverged differently (or edit/delete).
    conflictPaths.push(path);
    const winnerVal = winnerSide === 'ours' ? b : c;
    const loserVal = winnerSide === 'ours' ? c : b;

    if (winnerVal !== undefined) {
      merged.set(path, winnerVal);
    }
    // Preserve the loser's content as a renamed copy — but only for real files;
    // a losing *directory* marker cannot be a renamed file copy.
    if (loserVal !== undefined && loserVal !== DIR_MARKER) {
      const copyPath = conflictCopyName(
        path,
        loserClientId,
        loserTimestamp,
        taken,
      );
      copies.push({ path: copyPath, blobId: loserVal });
    }
  }

  return { merged, copies, conflictPaths };
}

// ...........................................................................
// Orchestrator
// ...........................................................................

/**
 * The capabilities the resolver needs from its host FsAgent + Db. Injected so
 * the orchestration is unit-testable with in-memory fakes (no real db/fs).
 */
export interface ConflictResolverDeps {
  /** The tree table key (route is `/${treeKey}`). */
  treeKey: string;
  /** All InsertHistory rows for `treeKey`. */
  getInsertHistory: (table: string) => Promise<InsertHistoryRow<string>[]>;
  /** Resolve a tip timeId to its tree root ref. */
  getRefOfTimeId: (table: string, timeId: string) => Promise<string | null>;
  /** Fetch a full FsTree by its root ref. */
  fetchTree: (rootRef: string) => Promise<FsTree>;
  /** Read a blob's bytes by blobId. */
  getBlobContent: (blobId: string) => Promise<Buffer>;
  /** Restore an FsTree onto the working dir, pruning extraneous entries. */
  restoreTree: (tree: FsTree) => Promise<void>;
  /** Write bytes to a relative path under the working dir (mkdir -p). */
  writeFileAt: (relativePath: string, content: Buffer) => Promise<void>;
  /** Remove a relative path under the working dir (best effort). */
  deleteFileAt: (relativePath: string) => Promise<void>;
  /** Re-scan the working dir into a fresh, hashed FsTree. */
  scan: () => Promise<FsTree>;
  /** Store the merge revision with explicit predecessors; returns its root ref. */
  storeMerge: (tree: FsTree, previous: string[]) => Promise<string>;
  /** Notified with the stored merge ref so the host can suppress the echo. */
  onMergeStored?: (ref: string) => void;
  /** Optional structured logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Resolves a single `dagBranch` conflict into a merge revision. For more than
 * two tips it merges the two lowest-identity tips per call; the resulting
 * smaller fork re-fires the observer and converges in further rounds.
 */
export class FsConflictResolver {
  constructor(private readonly deps: ConflictResolverDeps) {}

  private _log(level: 'info' | 'warn' | 'error', msg: string): void {
    /* v8 ignore next -- @preserve */
    this.deps.log?.(level, `[FsConflictResolver] ${msg}`);
  }

  /**
   * Resolves the conflict, returning the stored merge ref, or null when the
   * conflict is not ours / not actionable.
   * @param conflict - The detected DAG-branch conflict
   * @returns The stored merge revision's root ref, or null
   */
  async resolve(conflict: Conflict): Promise<string | null> {
    const { treeKey } = this.deps;
    if (conflict.table !== treeKey) {
      return null; // Not our table.
    }
    const tips = conflict.branches ?? [];
    if (tips.length < 2) {
      return null; // Nothing to merge.
    }

    const rows = await this.deps.getInsertHistory(treeKey);
    const rowByTimeId = new Map<string, InsertHistoryRow<string>>(
      rows.map((r) => [r.timeId, r]),
    );

    // Resolve every tip to its shared content ref up front, so the winner is
    // chosen on cross-client-stable data (refs), not per-db timeIds.
    const branchTips: BranchTip[] = [];
    for (const timeId of tips) {
      const row = rowByTimeId.get(timeId);
      const ref = await this.deps.getRefOfTimeId(treeKey, timeId);
      branchTips.push({
        timeId,
        ref: ref ?? '',
        clientId: (row?.origin as string | undefined) ?? '',
        timestamp: row?.clientTimestamp ?? 0,
      });
    }

    // Resolve the two lowest tips this round (deterministic; ensures progress
    // when there are 3+ tips — the rest re-fire and converge). Sorted ascending
    // by {@link compareTips}, so `loser` is first and `winner` (keeps the path,
    // per design §11.1) is second.
    const ordered = [...branchTips].sort((x, y) => compareTips(x, y));
    const loserTip = ordered[0];
    const winnerTip = ordered[1];

    if (!loserTip.ref || !winnerTip.ref) {
      this._log(
        'warn',
        `missing tree ref for a tip (loser=${loserTip.ref}, winner=${winnerTip.ref})`,
      );
      return null;
    }

    const loserTipId = loserTip.timeId;
    const winnerTipId = winnerTip.timeId;
    const loserTree = await this.deps.fetchTree(loserTip.ref);
    const winnerTree = await this.deps.fetchTree(winnerTip.ref);
    const loserMap = fsTreeToContentMap(loserTree);
    const winnerMap = fsTreeToContentMap(winnerTree);

    // Common ancestor (empty when none → all add/add).
    const ancestorTimeId = findCommonAncestor(rows, loserTipId, winnerTipId);
    let ancestorMap: ContentMap = new Map();
    if (ancestorTimeId) {
      const ancRef = await this.deps.getRefOfTimeId(treeKey, ancestorTimeId);
      /* v8 ignore else -- @preserve a resolvable ancestor always has a ref */
      if (ancRef) {
        ancestorMap = fsTreeToContentMap(await this.deps.fetchTree(ancRef));
      }
    }

    // Winner keeps the path; loser's content survives as a renamed copy.
    const plan = threeWayMerge(
      ancestorMap,
      loserMap,
      winnerMap,
      'theirs',
      loserTip.clientId,
      loserTip.timestamp,
    );

    // Materialise on disk: restore the winner tree (clean slate), then apply the
    // merge delta + conflict copies, then re-scan to a hashed tree.
    await this.deps.restoreTree(winnerTree);

    // Add / modify: merged entries that differ from the winner's on-disk content.
    for (const [path, blobId] of plan.merged) {
      if (blobId === DIR_MARKER) {
        continue;
      }
      if (winnerMap.get(path) === blobId) {
        continue; // Already present from restore.
      }
      await this.deps.writeFileAt(path, await this.deps.getBlobContent(blobId));
    }

    // Delete: files the winner had on disk that the merge resolved away.
    for (const [path, blobId] of winnerMap) {
      if (blobId === DIR_MARKER) {
        continue;
      }
      if (!plan.merged.has(path)) {
        await this.deps.deleteFileAt(path);
      }
    }

    // Conflict copies: the losing content under renamed paths.
    for (const copy of plan.copies) {
      await this.deps.writeFileAt(
        copy.path,
        await this.deps.getBlobContent(copy.blobId),
      );
    }

    const mergedTree = await this.deps.scan();
    const ref = await this.deps.storeMerge(mergedTree, [loserTipId, winnerTipId]);
    this.deps.onMergeStored?.(ref);
    this._log(
      'info',
      `resolved fork ${loserTipId.slice(0, 6)}…/${winnerTipId.slice(0, 6)}… → ` +
        `${ref.slice(0, 8)}… (${plan.conflictPaths.length} conflict(s), ` +
        `${plan.copies.length} copy/ies)`,
    );
    return ref;
  }
}
