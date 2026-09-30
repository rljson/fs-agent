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
