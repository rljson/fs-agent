// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Conflict } from '@rljson/db';
import type { InsertHistoryRow } from '@rljson/rljson';

import { compareTimeId } from './fs-edit-chain.js';
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
  /**
   * The EDIT CHAIN's `timeId` for this tip, when the chain has an entry for
   * it — `<millis>:<nanoid>`, minted by the authoring node and carried with
   * the row, so it is identical on every node.
   *
   * This is the primary ordering key, and it has to be, because the two that
   * used to be are not populated. Measured end to end on two nodes editing
   * one file: the conflict copy came out named
   *
   *   shared (conflicted copy db.insertTrees 1970-01-01 000000).txt
   *
   * `db.insertTrees` is the DB's label for its own operation, not a client, and
   * the epoch is `clientTimestamp` never being set — `Db.insertTrees` accepts
   * neither, so no caller can supply them. With `timestamp` equal at 0 and
   * `clientId` equal for everybody, both top comparisons collapsed and the
   * winner fell through to *whichever content hash sorts higher*. Deterministic,
   * so the fleet converged; but unrelated to who edited last, which is what
   * `§11.1` says decides.
   *
   * The chain's stamp is what the agent already mints for exactly this kind of
   * question, so nothing new has to be transported. Absent only for a tip no
   * chain entry covers (a peer on an older build), which is why it is optional
   * and why the old keys stay below it as a fallback.
   */
  chainTimeId?: string;
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
 * outranks `b`.
 *
 * The keys, in order:
 *
 *  1. the EDIT CHAIN's `timeId` — the newer edit outranks the older. See
 *     {@link BranchTip.chainTimeId} for why this had to become the first key:
 *     the two below it are not populated by `Db.insertTrees`, so without it
 *     the decision fell through to a content hash comparison.
 *  2. greater InsertHistory `clientTimestamp`;
 *  3. greater `clientId`;
 *  4. greater **content ref**.
 *
 * The last tiebreak is the ref rather than the InsertHistory timeId because
 * timeIds are per-db — using one would make different peers pick different
 * winners and never converge. The ref is shared, so every peer agrees; and
 * that claim is only true now that mtime is out of the content identity, which
 * is what made two peers derive different refs for identical content.
 *
 * `compareTimeId` is a total order over `<millis>:<nanoid>` and is identical
 * on every node, so key 1 preserves the property the rest of this function
 * exists for. A tip with no chain entry compares as "not comparable" and falls
 * through, so a peer on an older build is ordered exactly as before.
 * @param a - First tip
 * @param b - Second tip
 * @returns Positive if `a` outranks `b`, negative if `b` outranks `a`, else 0
 */
export function compareTips(a: BranchTip, b: BranchTip): number {
  const byChain = compareTimeId(a.chainTimeId, b.chainTimeId);
  if (byChain !== 0) {
    return byChain;
  }
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
 * What `Db.insertTrees` writes into an InsertHistory row's `origin`: the name
 * of its own operation, not an identity.
 *
 * `Db.insertTrees` accepts no `origin`, so every row this agent writes carries
 * this, on every node. It is the reason a conflict copy came out named
 * `shared (conflicted copy db.insertTrees 1970-01-01 000000).txt` — see
 * {@link BranchTip.chainTimeId}.
 */
export const DB_OPERATION_ORIGIN = 'db.insertTrees';

/**
 * The wall-clock millisecond a tip was authored, as well as it can be known.
 *
 * The chain's `timeId` is `<millis>:<nanoid>` and its millisecond half is the
 * authoring node's clock at the moment of the edit — which is the only real
 * time available here, because `clientTimestamp` is never set (see
 * {@link BranchTip.chainTimeId}). Without this a conflict copy was dated
 * `1970-01-01 000000`.
 *
 * Used ONLY for the copy's human-readable name. Ordering uses
 * {@link compareTimeId} on the whole id, never this number, so two edits in
 * the same millisecond are still totally ordered.
 * @param tip - The tip to date.
 * @returns Milliseconds since the epoch, or `0` when nothing knows.
 */
export function tipTimestamp(tip: BranchTip): number {
  const millis = Number(tip.chainTimeId?.split(':')[0]);
  return Number.isFinite(millis) && millis > 0 ? millis : tip.timestamp;
}

/**
 * An `origin` only when it identifies a client, else the empty string.
 *
 * A name in a filename a user has to read must be true or absent. Printing the
 * DB's operation label as the machine that made the edit is worse than
 * printing nothing: it reads as information and is not.
 *
 * Carrying the real author needs `Db.insertTrees` to accept an origin, which
 * it does not — a follow-up outside this package. Until then the copy is named
 * by its time alone.
 * @param origin - The InsertHistory row's origin, if any.
 * @returns A usable client id, or `''`.
 */
export function usableClientId(origin: string | undefined): string {
  return !origin || origin === DB_OPERATION_ORIGIN ? '' : origin;
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
 *
 * **The name has to distinguish distinct losing CONTENT, and without an
 * identity it did not.** `usableClientId` returns empty whenever the origin is
 * the DB's own label, which is the ordinary case, and the timestamp has
 * second granularity — so two nodes losing DIFFERENT content in the same
 * second derived the same copy name. The copies then conflicted with each
 * other, producing a copy of a copy:
 *
 *   two (conflicted copy 2026-10-03 142610) (conflicted copy 2026-10-03 142611).txt
 *
 * Measured on the seeded fuzz run as up to 14 nested copies, and present
 * before this session's work as well (0–5 on the same four runs). The losing
 * revision's content ref is carried in only when there is no identity to use:
 * it is identical on every peer for the same losing revision and differs
 * whenever the content does, which is exactly the property that was missing.
 * A name that is already readable stays readable.
 * @param relativePath - The original conflicting path
 * @param clientId - The losing revision's client id
 * @param timestamp - The losing revision's InsertHistory timestamp (ms)
 * @param taken - Set of already-used paths; the chosen name is added to it
 * @param loserRef - The losing revision's content ref, used to tell two
 *   same-second losers apart when neither has a usable identity.
 * @returns A unique conflict-copy path
 */
export function conflictCopyName(
  relativePath: string,
  clientId: string,
  timestamp: number,
  taken: Set<string>,
  loserRef = '',
): string {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = base.lastIndexOf('.');
  // dot > 0 → a leading-dot name (".gitignore") is treated as extensionless.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  const ts = formatConflictTimestamp(timestamp);
  // The identity is omitted when there is none, rather than printed empty —
  // `(conflicted copy  2026-10-01 ...)` with a double space is the kind of
  // detail a user reports as a bug. See {@link usableClientId}.
  const marker = clientId
    ? `(conflicted copy ${clientId} ${ts})`
    : loserRef
      ? `(conflicted copy ${ts} ${loserRef.slice(0, 6)})`
      : `(conflicted copy ${ts})`;

  let candidate = `${dir}${stem} ${marker}${ext}`;
  let n = 1;
  while (taken.has(candidate)) {
    candidate = `${dir}${stem} ${marker} (${n})${ext}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Derives the name a file is set aside under when the history DELETED its path.
 *
 * `document.txt` → `document (recovered).txt`.
 *
 * **Not a conflict copy, and the difference is who is told.** A conflict copy
 * is live work on a live path and is announced, because the network needs it.
 * A recovered file is content the fleet deliberately removed — a folder
 * restored from last month's backup, or a client that was away while a
 * directory was deleted — and announcing it would push every one of those
 * deletions back to every node, under names nobody deleted. So it is kept
 * where its owner can see it and nothing is said about it.
 *
 * That is a deliberate, visible local divergence, chosen over the two
 * alternatives: resurrecting a deletion, or destroying a file somebody may
 * still want. No timestamp and no identity, because unlike a conflict there is
 * nothing to tell apart — the path is simply gone from the history, and one
 * name per path is what a user can act on.
 * @param relativePath - The path the history removed
 * @param taken - Paths already used; the chosen name is added to it
 * @returns A unique set-aside path
 */
export function recoveredName(
  relativePath: string,
  taken: Set<string>,
): string {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : '';
  const base = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = base.lastIndexOf('.');
  // dot > 0 → a leading-dot name (".gitignore") is treated as extensionless,
  // the same rule `conflictCopyName` uses.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  let candidate = `${dir}${stem} (recovered)${ext}`;
  let n = 1;
  while (taken.has(candidate)) {
    candidate = `${dir}${stem} (recovered) (${n})${ext}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * One same-file conflict, in the terms a user needs to see it in.
 *
 * WHY THIS EXISTS. A fork on two DIFFERENT files is merged as a union and
 * nobody should be asked about it. A fork on the SAME file is a real conflict,
 * and until now resolving one produced a renamed file and silence: nothing was
 * lost, but the only evidence was a strange filename appearing in a folder,
 * with no statement of what happened, which version is live, or where the
 * other one went.
 *
 * Deliberately NOT an error. Two people editing one document at the same time
 * is ordinary, both versions are kept, and the folder converges. It is an event
 * to report, which is why it does not go through `_writeSyncError`.
 *
 * And deliberately not a question. The winner is already decided — it has to
 * be, or peers would not converge — so this says what was decided and leaves
 * reversing it to whoever looks: the losing content is on disk under
 * {@link copyPath}, so swapping the two files is all it takes.
 */
export interface FsConflictReport {
  /** The path both sides edited. The winner's content is here. */
  path: string;
  /** Where the losing version was kept, intact. */
  copyPath: string;
  /** Content ref of the branch that keeps {@link path}. */
  winnerRef: string;
  /** Content ref of the branch whose version moved to {@link copyPath}. */
  loserRef: string;
  /**
   * When the losing edit was made, in epoch ms, or `0` when nothing knows —
   * see {@link tipTimestamp} for why that is not always answerable.
   */
  loserAt: number;
  /** When this node resolved the conflict, in epoch ms. */
  resolvedAt: number;
}

/** A conflict copy to materialise: the losing content under a renamed path. */
export interface ConflictCopy {
  /** The renamed path the losing content is written to. */
  path: string;
  /** The losing blobId (content preserved, nothing lost). */
  blobId: string;
  /**
   * The path the two sides actually disagreed about.
   *
   * Recoverable from {@link path} only by un-parsing a filename, which is the
   * kind of thing that works until somebody's document is called
   * `report (conflicted copy ...).txt`.
   */
  originalPath: string;
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
        loserVal,
      );
      copies.push({ path: copyPath, blobId: loserVal, originalPath: path });
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
  /**
   * The edit chain's `timeId` for a tree ref, if the chain covers it.
   *
   * Optional: a host without a chain, or a tip authored by a peer on an older
   * build, simply has no answer — and {@link compareTips} falls back to the
   * keys it used before. See {@link BranchTip.chainTimeId}.
   */
  chainTimeIdOfRef?: (treeRef: string) => Promise<string | undefined>;
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
  /**
   * Notified once per merge with every same-file conflict it resolved.
   *
   * Never called with an empty list, so a host can treat any call as "there is
   * something to tell the user about".
   */
  onConflicts?: (reports: FsConflictReport[]) => void;
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
        chainTimeId: ref
          ? await this.deps.chainTimeIdOfRef?.(ref)
          : undefined,
        clientId: usableClientId(row?.origin as string | undefined),
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
      tipTimestamp(loserTip),
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

    // Delete: every path EITHER branch held that the merge resolved away.
    //
    // Both maps, not just the winner's. The winner's alone was enough while
    // `restoreTree` ran with `cleanTarget` — the prune swept up anything in
    // neither tree. That prune is now off under bucket sync, because a merged
    // tree whose common ancestor could not be resolved is missing one side's
    // files and pruning on its authority destroyed the partitioned node's own
    // work, 6 runs in 8.
    //
    // So the deletions are TARGETED instead: exactly the paths the merge
    // decided were gone, which is what it actually knows. Strictly better than
    // a blanket prune even where the prune was safe — it cannot remove a file
    // the merge never had an opinion about.
    const resolvedAway = new Set<string>();
    for (const [path, blobId] of [...winnerMap, ...loserMap]) {
      // Directories are not deleted by path: an empty one is removed by the
      // prune that walks the tree, and removing it here would race the files
      // still being written into it.
      if (blobId !== DIR_MARKER) resolvedAway.add(path);
    }
    for (const path of resolvedAway) {
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

    // Reported BEFORE the merge is stored, so a host that fails on its own
    // notification cannot leave the fork unresolved. The copies are already on
    // disk at this point, which is what the report describes.
    if (plan.copies.length > 0) {
      const resolvedAt = Date.now();
      const loserAt = tipTimestamp(loserTip);
      this.deps.onConflicts?.(
        plan.copies.map((copy) => ({
          path: copy.originalPath,
          copyPath: copy.path,
          winnerRef: winnerTip.ref,
          loserRef: loserTip.ref,
          loserAt,
          resolvedAt,
        })),
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
