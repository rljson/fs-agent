// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// An append-only history of what a folder was made from.
//
// WHY THIS EXISTS
// A tree ref is a content hash of the whole folder, so a folder that returns to
// a state it held earlier re-derives that state's exact hash. "We returned to
// an old state" and "we never left it" are literally the same string — which
// is why two data-loss failures in opposite directions were measured on the
// same day (`doc/known-limits.md`), and why neither could be fixed by reading
// the anti-entropy decision more cleverly. A change that restores earlier
// content is a NEW entry here with a new ref, so the ambiguity cannot occur
// inside the chain.
//
// WHAT IT RECORDS
// One entry per folder-changing scan: the resulting tree ref, what changed,
// what was REMOVED, what it was made from, and a fleet-wide `timeId`. The
// removals are the part the tree cannot express — a deleted file is simply
// absent from the next tree, so nothing today says the absence was deliberate.
//
// WHY THE ROWS ARE WRITTEN BY HAND
// `MultiEditManager` (`@rljson/db`) is the ordinary way to append an edit, and
// it is not usable here, for two reasons:
//
//   - it refuses more than one `previous` ("has multiple previous refs. Not
//     supported"), and an fs MERGE revision has two parents by design
//     (`StoreFsTreeOptions.previous`), so the chain could not express the one
//     revision shape that matters most; and
//   - it is inseparable from the cake model — `edit()` needs a `cakeRef` and a
//     `MultiEditProcessor` that applies edits onto a cake. fs has no
//     components: its content is the tree, which already lives in the trees
//     table. Only the HISTORY is missing.
//
// `EditHistory.previous` is `string[]` in the type and `jsonArray` in the table
// config, so multiple parents are representable — it is only the manager that
// will not walk them. And `createEditHistoryTableCfg(treeKey)` declares
// `dataRef` as a reference to `treeKey` itself, which for fs IS the trees
// table. The fit is exact.
//
// WHAT USES IT
// Nothing yet, deliberately. This is written and announced to nobody, so the
// fleet accumulates real chains before anything depends on their shape — they
// are the fixtures the walk needs, and a week of production ancestry is worth
// more than any fixture we could write. See `PLAN-fs-edit-chain.md` §13.6.
// .............................................................................

import type { Db } from '@rljson/db';
import type { Json } from '@rljson/json';
import {
  createEditHistoryTableCfg,
  createEditTableCfg,
  createMultiEditTableCfg,
  timeId,
  type Edit,
  type EditHistory,
} from '@rljson/rljson';

/** The `EditAction.type` every fs chain entry carries. */
export const FS_EDIT_ACTION = 'putFsTree';

/** What one chain entry says happened. */
export interface FsEditData extends Json {
  /** The tree ref the folder ended up at. */
  treeRef: string;
  /** Relative paths added or modified, `/`-separated, sorted. */
  changed: string[];
  /**
   * Relative paths REMOVED, `/`-separated, sorted.
   *
   * The whole reason the chain carries more than a ref. A tree records what a
   * folder holds; only this records what it deliberately stopped holding.
   */
  removed: string[];
}

/** What {@link FsEditChain.append} records. */
export interface FsAppendOptions {
  /** The state the folder ended up at. */
  treeRef: string;
  /** Relative paths added or modified. Default: none. */
  changed?: readonly string[];
  /** Relative paths removed. Default: none. */
  removed?: readonly string[];
  /**
   * What this entry was made from.
   *
   * Defaults to the current head. Passed explicitly only for a MERGE entry,
   * which has two parents — the one shape `MultiEditManager` refuses and the
   * reason these rows are written by hand.
   */
  previous?: readonly string[];
}

/** One entry of the chain, as read back. */
export interface FsChainEntry {
  /** The `EditHistory` ref — this entry's identity, and the head to announce. */
  head: string;
  /** Fleet-wide order. Minted once, by the node that made the change. */
  timeId: string;
  /** The tree ref the folder ended up at. */
  treeRef: string;
  /** The entries this one was made from. Empty for a lineage root. */
  previous: string[];
  /** Relative paths added or modified. */
  changed: string[];
  /** Relative paths removed. */
  removed: string[];
}

/**
 * Creates the three tables an fs chain needs, idempotently.
 *
 * **fs-agent creates its own tables.** The One Client creates the trees table
 * (`sl-server.ts`, `sl-client.ts`), and an agent that expected tables its host
 * had never created would fail at runtime on any node whose host is one release
 * behind — exactly the mixed-version case a rollout guarantees. `@rljson/db`'s
 * `createTable` is `createOrExtendTable`, so calling this on every init costs
 * nothing and removes the coupling rather than versioning it.
 * @param db - The route's database.
 * @param treeKey - The trees table key, e.g. `fileTree`.
 */
export const createFsChainTables = async (
  db: Db,
  treeKey: string,
): Promise<void> => {
  await db.core.createTable(createEditTableCfg(treeKey));
  await db.core.createTable(createMultiEditTableCfg(treeKey));
  await db.core.createTable(createEditHistoryTableCfg(treeKey));
};

/**
 * The append-only chain for one folder.
 *
 * Append-only and never merged: each node keeps its own lineage, exactly as
 * mongo does. Nothing here rewrites or prunes an entry — that is WP5's job.
 */
export class FsEditChain {
  private _head: string | undefined;
  private _ready = false;

  constructor(
    private readonly _db: Db,
    private readonly _treeKey: string,
  ) {}

  /** The entry this node's lineage currently ends at. */
  get head(): string | undefined {
    return this._head;
  }

  /** Whether {@link init} has completed. */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * Creates the tables and continues this node's lineage where it left off.
   *
   * A process that came back and started a fresh root would orphan everything
   * it wrote before, so the tip is read from the store rather than assumed
   * absent.
   */
  async init(): Promise<void> {
    await createFsChainTables(this._db, this._treeKey);
    this._head = await this._tip();
    this._ready = true;
  }

  /**
   * Appends one entry.
   * @param opts - What the change was; see {@link FsAppendOptions}.
   * @returns The entry that was written.
   */
  async append(opts: FsAppendOptions): Promise<FsChainEntry> {
    const changed = [...(opts.changed ?? [])].sort();
    const removed = [...(opts.removed ?? [])].sort();
    const previous = opts.previous
      ? [...opts.previous]
      : this._head
        ? [this._head]
        : [];

    const data: FsEditData = { treeRef: opts.treeRef, changed, removed };
    const edit = {
      name: `${FS_EDIT_ACTION} ${opts.treeRef}`,
      action: {
        name: FS_EDIT_ACTION,
        type: FS_EDIT_ACTION,
        data: data as unknown as Json,
        _hash: '',
      },
      _hash: '',
    } as unknown as Edit;

    const editRef = this._refOf(
      await this._db.addEdit(this._treeKey, edit),
      'Edits',
    );
    const multiEditRef = this._refOf(
      await this._db.addMultiEdit(this._treeKey, {
        // A single-entry multiEdit per chain link. fs has no notion of several
        // edits landing as one unit, and inventing one here would be a shape
        // nothing produces.
        previous: null,
        edit: editRef,
        _hash: '',
      }),
      'MultiEdits',
    );

    const stamp = timeId();
    const head = this._refOf(
      await this._db.addEditHistory(this._treeKey, {
        timeId: stamp,
        multiEditRef,
        dataRef: opts.treeRef,
        previous,
        _hash: '',
      } as EditHistory),
      'EditHistory',
    );

    this._head = head;
    return { head, timeId: stamp, treeRef: opts.treeRef, previous, changed, removed };
  }

  /**
   * Reads one entry back.
   * @param head - The `EditHistory` ref to read.
   * @returns The entry, or `undefined` when this node cannot resolve it — a
   *   ref a peer holds and we do not is the ordinary case, not an error.
   */
  async entry(head: string): Promise<FsChainEntry | undefined> {
    const histories = await this._db.getEditHistories(this._treeKey, head);
    if (histories.length === 0) return undefined;
    const history = histories[0];

    const multiEdits = await this._db.getMultiEdits(
      this._treeKey,
      history.multiEditRef,
    );
    if (multiEdits.length === 0) return undefined;
    const edits = await this._db.getEdits(this._treeKey, multiEdits[0].edit);
    if (edits.length === 0) return undefined;

    const data = edits[0].action?.data as unknown as FsEditData | undefined;
    return {
      head,
      timeId: history.timeId,
      treeRef: history.dataRef,
      previous: [...(history.previous ?? [])],
      changed: [...(data?.changed ?? [])],
      removed: [...(data?.removed ?? [])],
    };
  }

  /**
   * The NET removals between a peer's head and a state this node knows.
   *
   * **Why a walk is needed at all, and it cost a red run to see.** A removal is
   * stated ONCE, in the entry that made it. A node that was partitioned when it
   * deleted a file states the removal in an entry nobody received; its next
   * entry, after it rejoins, computes its `changed`/`removed` against its own
   * last announcement and therefore says nothing about that deletion. So a peer
   * reading only the head learns nothing, and the file survives on every node
   * except the one that deleted it — which is the measured failure.
   *
   * Walking `previous` back to a state the receiver recognises closes exactly
   * that gap, and the ancestry is reachable by hash alone (proven in
   * `test/fs-chain-crosses-the-wire.spec.ts`).
   *
   * **Replayed oldest-first, so a re-add cancels a removal.** A path deleted
   * and then created again inside the walked range is not a removal at all,
   * and taking the union of `removed` would delete it. Order is the whole
   * correctness of this function.
   *
   * **`complete` is mongo's contract, and it matters more than the result.**
   * When an entry cannot be resolved the walk is truncated, and the caller MUST
   * NOT treat the answer as authoritative — ancestors beyond the missing row
   * are unknown, and one of them may be the re-add that cancels a removal we
   * did collect. `@rljson/mongo-agent` states it as: *"a caller must not latch
   * the head; ancestors beyond the missing row would otherwise be lost
   * forever"*.
   * @param head - The peer's head.
   * @param stopAt - Tree refs this node already knows. The walk stops at the
   *   first entry producing one of them, exclusive.
   * @param maxWalk - Give up past this many entries. A walk this deep is a
   *   cold replay rather than a catch-up, and left unbounded it pins a core on
   *   a long chain.
   * @returns The net removals, the newest `timeId` seen, and whether the walk
   *   resolved completely.
   */
  async collectRemovals(
    head: string,
    stopAt: ReadonlySet<string>,
    maxWalk = 500,
  ): Promise<{ removed: string[]; timeId?: string; complete: boolean }> {
    const walked: FsChainEntry[] = [];
    const seen = new Set<string>();
    let complete = true;
    let frontier = [head];

    while (frontier.length > 0) {
      const wanted = frontier.filter((ref) => !seen.has(ref) && !!seen.add(ref));
      if (wanted.length === 0) break;
      if (walked.length + wanted.length > maxWalk) {
        complete = false;
        break;
      }
      const next: string[] = [];
      for (const ref of wanted) {
        const entry = await this.entry(ref);
        if (!entry) {
          // Not resolvable through any peer: its `previous`, and everything
          // beyond it, is unknown.
          complete = false;
          continue;
        }
        // Exclusive: a state we already know needs no replay, its own
        // ancestry is already accounted for in how we got there, and its
        // `timeId` is not news — including it in the maximum below would let a
        // removal claim to be newer than it is and weaken the recency guard.
        if (stopAt.has(entry.treeRef)) continue;
        walked.push(entry);
        for (const previous of entry.previous) next.push(previous);
      }
      frontier = next;
    }

    // Oldest first. `previous` points backwards, so the discovery order
    // reversed is the apply order.
    const order = [...walked].reverse();
    const removed = new Set<string>();
    for (const entry of order) {
      for (const path of entry.removed) removed.add(path);
      // A re-add cancels an earlier removal, and only the order says so.
      for (const path of entry.changed) removed.delete(path);
    }

    // The newest id among everything walked, which is what a receiver orders
    // the removal against.
    let timeId: string | undefined;
    for (const entry of walked) {
      if (compareTimeId(entry.timeId, timeId) > 0 || timeId === undefined) {
        timeId = entry.timeId;
      }
    }

    return { removed: [...removed].sort(), timeId, complete };
  }

  /**
   * The newest entry nothing else descends from.
   *
   * **A single slot, and that is a known limit.** Every node keeps its own
   * lineage and chains are never merged, so once the walk starts pulling peers'
   * rows (WP3) this table holds several tips and "the newest" can be somebody
   * else's. `@rljson/mongo-agent` had exactly this bug — lost updates
   * root-caused to a single `_lastApplied` slot rather than per-node lineages —
   * and fixed it by tracking lineages. Nothing reads this chain yet, so the
   * limit is not reachable; WP3 must replace it rather than build on it.
   *
   * "Newest" is by `timeId`, which is `<millis>:<nanoid>` — so two entries
   * minted in the same millisecond are separated by a random tail. That order
   * is arbitrary in wall-clock terms and IDENTICAL on every node, which is the
   * property that matters; nothing may depend on it meaning "later in time".
   * @returns The tip's ref, or `undefined` on an empty chain.
   */
  private async _tip(): Promise<string | undefined> {
    // No optional chaining on the dump: `init` creates this table on the line
    // before, so a missing one is not a state this code can be in, and a
    // fallback for it would be a branch no test could ever reach.
    const table = `${this._treeKey}EditHistory`;
    const dump = await this._db.core.dumpTable(table);
    const rows = dump[table]._data as Array<EditHistory & { _hash: string }>;
    if (rows.length === 0) return undefined;

    const claimed = new Set<string>();
    for (const row of rows) {
      for (const ref of row.previous ?? []) claimed.add(ref);
    }
    const tips = rows.filter((row) => !claimed.has(row._hash));
    /* v8 ignore next -- @preserve every row claimed means a cycle, not reachable */
    if (tips.length === 0) return undefined;

    // A single pass for the greatest `timeId`, rather than a sort whose
    // comparator is only fully exercised when the random tails happen to fall
    // the right way. Coverage that depends on luck is how a gate reads 98% and
    // 99% on identical runs.
    let tip = tips[0];
    for (const row of tips) {
      if (row.timeId > tip.timeId) tip = row;
    }
    return tip._hash;
  }

  /**
   * Pulls the generated ref out of an insert result.
   * @param result - What `db.add*` returned.
   * @param suffix - The table suffix, e.g. `Edits`.
   * @returns The ref.
   */
  private _refOf(result: unknown, suffix: string): string {
    const rows = result as Array<Record<string, string>>;
    const ref = rows?.[0]?.[`${this._treeKey}${suffix}Ref`];
    /* v8 ignore next -- @preserve a successful insert always returns its ref */
    if (!ref) throw new Error(`FsEditChain: no ref for ${suffix}`);
    return ref;
  }
}

// .............................................................................
/**
 * Orders two `timeId`s (`<millis>:<nanoid>`).
 *
 * Compares the millisecond part numerically and breaks ties on the random
 * suffix, so the order is TOTAL and IDENTICAL on every node — which is the
 * property that makes convergence a guarantee rather than a matter of who
 * spoke last. It is not "later in wall-clock time": two ids minted in the same
 * millisecond are separated by a random tail, and nothing may read the result
 * as a timestamp comparison.
 *
 * A missing or malformed id orders as "not comparable" (`0`), so a caller
 * cannot accidentally treat "unknown" as "older".
 *
 * Same semantics as `@rljson/mongo-agent`'s `compareTimeId`, restated here
 * rather than depended on: fs must not take a dependency on mongo-agent, which
 * already depends on fs-agent.
 * @param a - The first timeId, or `undefined`.
 * @param b - The second timeId, or `undefined`.
 * @returns `-1` if `a` is older, `1` if newer, `0` when equal or not
 *   comparable.
 */
export const compareTimeId = (
  a: string | undefined,
  b: string | undefined,
): number => {
  if (!a || !b) return 0;
  if (a === b) return 0;
  const [aMillis, aTail] = a.split(':');
  const [bMillis, bTail] = b.split(':');
  const aNum = Number(aMillis);
  const bNum = Number(bMillis);
  if (Number.isNaN(aNum) || Number.isNaN(bNum)) return 0;
  if (aNum !== bNum) return aNum < bNum ? -1 : 1;
  return (aTail ?? '') < (bTail ?? '') ? -1 : 1;
};

// .............................................................................
/** What {@link planRemovals} is asked. */
export interface RemovalQuestion {
  /** Relative paths the peer says it deleted. */
  removed: readonly string[];
  /** The `timeId` of the edit carrying them. */
  timeId: string;
  /**
   * `path → timeId` of the newest LOCAL edit that touched each path.
   *
   * A path absent from this map has no local claim, and a removal for it is
   * applied — "unknown" must never read as "older".
   */
  localTimeIds: ReadonlyMap<string, string>;
  /** Relative paths this node currently holds. */
  held: ReadonlySet<string>;
  /** Below this many removals, nothing is bounded. */
  minFiles: number;
  /**
   * Above `minFiles`, the largest fraction of `held` one removal may take.
   */
  maxRatio: number;
}

/** What {@link planRemovals} decided about a peer's deletions. */
export interface RemovalPlan {
  /** Paths to delete here. */
  apply: string[];
  /**
   * Paths refused because this node has NEWER work on them.
   *
   * A removal is a statement about a state. A node that has since re-created
   * the path has moved past that state, and applying the removal would undo
   * newer work on the authority of an older edit.
   */
  staler: string[];
  /**
   * Whether the whole set was refused for being too large.
   *
   * The mass-delete circuit breaker, applied here for the same reason
   * `@rljson/mongo-agent` applies it to tombstone application: an explicit
   * removal list bypasses the ancestry check by design, so it must not also
   * bypass the bound on how much one message may destroy.
   */
  blocked: boolean;
}

/**
 * Which of a peer's deletions to apply here.
 *
 * **Why an explicit list is needed at all.** A tree records what a folder
 * holds, so a deletion reaches a peer only as an absence — and an absence is
 * indistinguishable from a state that merely predates the file. fs infers the
 * difference from ancestry (`senderSawMyState`), which works only while the
 * ancestor can be resolved. A partitioned node's ancestor cannot, and that is
 * the measured data loss: the deleted file comes back on the node that deleted
 * it. A removal carried in the chain is a FACT rather than an inference, and it
 * is the authorisation ancestry could not supply.
 *
 * **Which is exactly why it is bounded twice.** It deletes without asking the
 * ancestry rule, so recency and volume are the only guards left:
 *
 * - **recency**, by `timeId`. Minted once by the node that made the edit, so
 *   every node orders the same pair the same way. A removal older than this
 *   node's own newest edit to that path is refused.
 * - **volume**, by the mass-delete circuit breaker. Below
 *   `minFiles` nothing is bounded — emptying a three-file folder is an
 *   ordinary edit — and above it a removal of more than `maxRatio` of what
 *   this node holds is refused wholesale.
 * @param opts - The removal and this node's state; see
 *   {@link RemovalQuestion}.
 * @returns What to delete, what was refused as stale, and whether the whole
 *   set was blocked.
 */
export const planRemovals = (opts: RemovalQuestion): RemovalPlan => {
  const apply: string[] = [];
  const staler: string[] = [];

  for (const path of opts.removed) {
    // Nothing to delete is not a refusal. It is the ordinary case: the peer
    // and this node already agree the path is gone.
    if (!opts.held.has(path)) continue;
    const local = opts.localTimeIds.get(path);
    if (local !== undefined && compareTimeId(opts.timeId, local) < 0) {
      staler.push(path);
      continue;
    }
    apply.push(path);
  }

  const blocked =
    apply.length > opts.minFiles &&
    apply.length / Math.max(opts.held.size, 1) > opts.maxRatio;

  return blocked
    ? { apply: [], staler, blocked: true }
    : { apply, staler, blocked: false };
};
