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
// same day (`README.public.md`, "Known constraints"), and why neither could be
// fixed by reading the anti-entropy decision more cleverly. A change that
// restores earlier content is a NEW entry here with a new ref, so the ambiguity
// cannot occur inside the chain.
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
// Everything. This was written to be read by nobody — the fleet was meant to
// accumulate real chains before anything depended on their shape — and that
// phase is over: the chain is the sync mechanism. A node announces this entry's
// ref on every change, a receiver resolves it to a row and then to a tree,
// `relate` walks `previous` to decide, and a deletion is applied because an
// entry here STATES it. A ref that names no entry decides nothing.
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

/**
 * How far back a walk goes before it gives up.
 *
 * A walk this deep is a cold replay of a whole lineage rather than a
 * catch-up, and left unbounded it pins a core on a long chain.
 *
 * Exhausting it is NOT the same as failing to read a row — see
 * {@link FsEditChain.relate}. Conflating the two made any node more than this
 * many pushes into its own history stop repairing, permanently and silently.
 */
export const DEFAULT_MAX_WALK = 500;

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
   * The entry's `timeId`, when it has to be a function of its content: two
   * nodes that merge the same two heads into the same tree write the same
   * entry. Minted otherwise; a root is identified by its tree.
   */
  timeId?: string;
  /**
   * What this entry was made from: none for a root, the own head for an edit,
   * both heads for a merge — the one shape `MultiEditManager` refuses and the
   * reason these rows are written by hand.
   */
  previous: readonly string[];
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
 * **fs-agent creates its own tables.** The host application creates the trees
 * table
 * (in its own server and client entry points), and an agent that expected
 * tables its host had never created would fail at runtime on any node whose
 * host is one release behind — exactly the mixed-version case a rollout
 * guarantees. `@rljson/db`'s `createTable` is `createOrExtendTable`, so calling
 * this on every init costs nothing and removes the coupling rather than
 * versioning it.
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
 * mongo does. Nothing here rewrites or prunes an entry, and nothing collects
 * one either — the chain grows for the life of the folder. See
 * `README.public.md`, "Known constraints".
 */
export class FsEditChain {

  /** The last own-lineage walk, keyed by the head it was computed for. */
  private _lineageCache: { head: string; refs: ReadonlySet<string> } | undefined;

  constructor(
    private readonly _db: Db,
    private readonly _treeKey: string,
  ) {}

  /**
   * Creates the chain's tables if absent. Where this node stands is not the
   * chain's business: a table several nodes write has no tip of its own, and
   * the agent keeps its head in its state file.
   */
  async init(): Promise<void> {
    await createFsChainTables(this._db, this._treeKey);
  }

  /**
   * Appends one entry.
   * @param opts - What the change was; see {@link FsAppendOptions}.
   * @returns The entry that was written.
   */
  async append(opts: FsAppendOptions): Promise<FsChainEntry> {
    const changed = [...(opts.changed ?? [])].sort();
    const removed = [...(opts.removed ?? [])].sort();
    const previous = [...opts.previous];

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

    // A ROOT ENTRY IS IDENTIFIED BY ITS CONTENT, NOT BY WHO BOOTED FIRST.
    //
    // An entry with no parents and nothing stated is not an edit — it is the
    // name a node gives the state it starts in. Every node authors one, and
    // those states are usually IDENTICAL, because peers already in sync hold
    // the same bytes and derive the same tree ref. With a minted `timeId` each
    // node's root is a different row, so the fleet has one lineage per node
    // from the first second — and then nothing is ever `behind` or `ahead`:
    // `relate` finds neither head reachable from the other and answers
    // `fork` to every announcement there has ever been.
    //
    // Measured on `a document never goes backwards while one person edits it`,
    // 6 runs in 8, and a control run confirms it predates the audit: one
    // writer saving v0…v8, two receivers cut and healed underneath. Each
    // node's root listed `changed=[]` and was still its own lineage. A healed
    // receiver's announcement was a FORK of the writer's, the writer merged
    // it, a conflicted copy appeared on a file one person had edited, and the
    // writer's own folder went from v8 back to v5.
    //
    // DERIVED rather than agreed. Every other field of this row is already a
    // function of the content, so fixing the stamp makes the whole row — and
    // therefore its hash — identical on every node that starts from the same
    // folder. No replication has to have happened, no node has to have spoken
    // first, and there is nothing to race: the two nodes write the same row
    // and it IS the same entry.
    //
    // `0:` orders before every minted id, which is what the beginning of a
    // history should do.
    const isRoot =
      previous.length === 0 && changed.length === 0 && removed.length === 0;
    const stamp = opts.timeId ?? (isRoot ? `0:${opts.treeRef}` : timeId());
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

    // EXTENDED, not invalidated, for the ordinary case of appending onto our
    // own head: the ancestors of the new entry are exactly the cached ones
    // plus itself. Without this, every push would cost a fresh walk of the
    // node's whole history on the next announcement.
    //
    // Only for `previous` being exactly our cached head. Any other shape — a
    // merge, an entry parented on an older head — may reach a strict subset of
    // what is cached, and a stop set that is too LARGE stops the walk early.
    if (
      this._lineageCache !== undefined &&
      previous.length === 1 &&
      previous[0] === this._lineageCache.head
    ) {
      const refs = new Set(this._lineageCache.refs);
      refs.add(head);
      this._lineageCache = { head, refs };
    }

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
   * How two heads stand, and for a fork the ancestor to merge against.
   *
   * `same` — the one head. `behind` — theirs descends from ours. `ahead` —
   * ours descends from theirs. A descent found is proof, whatever else in
   * either history cannot be read. `fork` — neither descends from the other:
   * `base` is a common ancestor no other common ancestor descends from, the
   * smallest ref of them when there are several, so every node merging the
   * same two heads merges against the same base. `undefined` when the two
   * share no history within the walk. `incomplete` — no descent was found and
   * an entry could not be read, so a fork cannot be told from a lag.
   *
   * A walk that exhausts `maxWalk` with everything readable answers `fork`:
   * less precise than the truth, never destructive.
   * @param ours - This node's head.
   * @param theirs - The head that arrived.
   * @param maxWalk - Give up past this many entries per side.
   * @returns The relation, and the merge base of a fork.
   */
  async relate(
    ours: string,
    theirs: string,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<
    | { verdict: 'same' | 'behind' | 'ahead' | 'incomplete' }
    | { verdict: 'fork'; base: string | undefined }
  > {
    if (ours === theirs) return { verdict: 'same' };
    const fromTheirs = await this._parentsOf(theirs, maxWalk);
    if (fromTheirs.parents.has(ours)) return { verdict: 'behind' };
    const fromOurs = await this._parentsOf(ours, maxWalk);
    if (fromOurs.parents.has(theirs)) return { verdict: 'ahead' };
    if (fromTheirs.holed || fromOurs.holed) return { verdict: 'incomplete' };

    const common = [...fromOurs.parents.keys()].filter((ref) =>
      fromTheirs.parents.has(ref),
    );
    // Every ancestor of a common ancestor is common too, so a ref met on the
    // way down from one has been dealt with on the way down from any other.
    const dominated = new Set<string>();
    for (const ref of common) {
      const stack = [...(fromOurs.parents.get(ref) as string[])];
      while (stack.length > 0) {
        const below = stack.pop() as string;
        if (dominated.has(below)) continue;
        dominated.add(below);
        stack.push(...(fromOurs.parents.get(below) ?? []));
      }
    }
    const best = common.filter((ref) => !dominated.has(ref)).sort();
    return { verdict: 'fork', base: best[0] };
  }

  /**
   * The `previous` of every entry reachable from `head`, by generation.
   * @param head - Where to start.
   * @param maxWalk - Give up past this many entries.
   * @returns Each entry read, mapped to its parents, and whether an entry
   *   could not be read.
   */
  private async _parentsOf(
    head: string,
    maxWalk: number,
  ): Promise<{ parents: Map<string, string[]>; holed: boolean }> {
    const parents = new Map<string, string[]>();
    let holed = false;
    let frontier = [head];
    while (frontier.length > 0 && parents.size < maxWalk) {
      const next: string[] = [];
      for (const ref of new Set(frontier)) {
        if (parents.has(ref)) continue;
        const entry = await this.entry(ref);
        if (!entry) {
          holed = true;
          continue;
        }
        parents.set(ref, entry.previous);
        next.push(...entry.previous);
      }
      frontier = next;
    }
    return { parents, holed };
  }

  /**
   * Every entry reachable from `head`, itself included.
   *
   * `holed` — an entry could not be RESOLVED. The caller must conclude
   * nothing: the unreachable part may contain the very ref it was looking for,
   * and a walk that answers "not an ancestor" on that basis is how a node
   * decides it is ahead of a peer it is actually behind.
   *
   * `bounded` — the walk ran out of budget with everything it asked for
   * readable. A different statement, and a usable one: no relation within this
   * many entries of history. See {@link relate}.
   * @param head - Where to start.
   * @param maxWalk - Give up past this many entries.
   * @returns The refs reached, whether anything was unreadable, and whether
   *   the budget ran out.
   */
  private async _ancestorsOf(
    head: string,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<{ refs: Set<string>; holed: boolean; bounded: boolean }> {
    const refs = new Set<string>();
    let holed = false;
    let bounded = false;
    let frontier = [head];

    while (frontier.length > 0) {
      const wanted = frontier.filter((ref) => !refs.has(ref) && !!refs.add(ref));
      if (wanted.length === 0) break;
      if (refs.size > maxWalk) {
        bounded = true;
        break;
      }
      const next: string[] = [];
      for (const ref of wanted) {
        const entry = await this.entry(ref);
        if (!entry) {
          holed = true;
          continue;
        }
        for (const previous of entry.previous) next.push(previous);
      }
      frontier = next;
    }

    return { refs, holed, bounded };
  }

  /**
   * Every entry this node's own head descends from, itself included.
   *
   * Cached on the head it was computed for. Announcements arrive in bursts and
   * this node's head changes only when it records an entry, so the walk is
   * done once per state rather than once per announcement.
   * @param ourHead - This node's head, or `undefined` when it has none.
   * @param maxWalk - Give up past this many entries.
   * @returns The refs reached, or `undefined` when the walk could not be
   *   trusted — an unreadable entry means the stop set is unknown, not empty.
   */
  private async _ourLineage(
    ourHead: string | undefined,
    maxWalk: number,
  ): Promise<ReadonlySet<string> | undefined> {
    if (ourHead === undefined) return new Set<string>();
    if (this._lineageCache?.head === ourHead) return this._lineageCache.refs;
    const walk = await this._ancestorsOf(ourHead, maxWalk);
    if (walk.holed) return undefined;
    // A BOUNDED walk is cached and used as it is. It means "everything asked
    // for was readable and there is more history than the budget", so what it
    // found really is our lineage — just not all of it. See `relate`.
    this._lineageCache = { head: ourHead, refs: walk.refs };
    return walk.refs;
  }

  /**
   * The newest edit on this lineage that CHANGED or REMOVED a given path.
   *
   * **The per-path question, and the one the conflict resolver could not ask.**
   * `compareTips` orders a BRANCH by its tip, and the caller then uses that one
   * verdict for every path the two branches disagree about — so a tip wins
   * paths it never touched. Measured: a node that had been offline came back,
   * wrote one file of its own, and that newer tip took `doc.txt` as well,
   * rolling the writer's own folder from v8 back to v5.
   *
   * Asking per path answers it exactly: the last edit naming `doc.txt` is the
   * writer's, and the returning node's entry does not name it at all, so it
   * does not count for it. No clock is involved — the answer is read out of the
   * shared history, so every node computes the same winner on its own.
   *
   * **A removal counts as touching the path.** An edit/delete conflict is still
   * two people acting on one file, and the one who acted later decides it.
   *
   * `undefined` means "cannot say": either nothing on this lineage ever named
   * the path, or the walk could not be read to the end. The caller must not
   * read that as "nobody edited it" — it falls back to the branch-level order.
   * @param head - The lineage's tip.
   * @param path - The relative path being decided.
   * @param maxWalk - Give up past this many entries.
   * @returns The newest entry naming `path`, or `undefined`.
   */
  async lastEditOf(
    head: string,
    path: string,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<FsChainEntry | undefined> {
    const seen = new Set<string>();
    let frontier = [head];

    // NEAREST TO THE HEAD WINS: an entry closer to the head is one the head
    // descends FROM, so anything deeper has been built on and cannot be the
    // latest word. Two entries the same distance away are concurrent — the
    // two parents of a merge — and the greater `timeId` breaks that tie. A
    // tie-break, not an order: identical on every node, and meaning nothing
    // about when anything happened.
    while (frontier.length > 0) {
      const wanted = frontier.filter((ref) => !seen.has(ref) && !!seen.add(ref));
      if (wanted.length === 0) break;
      if (seen.size > maxWalk) break;
      const next: string[] = [];
      const here: FsChainEntry[] = [];
      for (const ref of wanted) {
        const entry = await this.entry(ref);
        // A hole makes the answer unknowable rather than empty: the edit being
        // looked for may be inside the part that cannot be read.
        if (!entry) return undefined;
        if (entry.changed.includes(path) || entry.removed.includes(path)) {
          here.push(entry);
        }
        for (const previous of entry.previous) next.push(previous);
      }
      if (here.length > 0) {
        const newest = here.map((entry) => entry.timeId).sort().pop();
        return here.find((entry) => entry.timeId === newest);
      }
      frontier = next;
    }

    return undefined;
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
   * **Where the walk stops is THIS NODE'S OWN LINEAGE, asked of the chain.**
   * It used to be a set of content refs: the current one, the last applied one,
   * and a thousand remembered past states. That set approximated "everywhere I
   * have been" — capped, so a long-lived node forgot its oldest states, and
   * matched BY CONTENT, so an entry on a lineage this node never travelled
   * stopped the walk whenever it happened to produce bytes this node also
   * holds. Identical content across nodes was rare while mtime was in the
   * identity; now it is the norm.
   *
   * Neither is a measured data loss — stopping early collects FEWER removals,
   * which is the safe direction, and content equality does mean the folder was
   * in that state. It is a heuristic standing in for a question the chain can
   * answer exactly, which is the whole reason the chain exists.
   * @param head - The peer's head.
   * @param ourHead - This node's own head, or `undefined` when it has none —
   *   a node with no history of its own recognises no state, so nothing stops
   *   the walk short of `maxWalk`.
   * @param maxWalk - Give up past this many entries. A walk this deep is a
   *   cold replay rather than a catch-up, and left unbounded it pins a core on
   *   a long chain.
   * **Both halves of the net delta are returned**: a path deleted and created
   * again inside the walked range is a change, not a removal, and only the
   * second half can say so.
   * @returns The net removals, the net changes, and whether the walk resolved
   *   completely.
   */
  async collectRemovals(
    head: string,
    ourHead: string | undefined,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<{
    removed: string[];
    changed: string[];
    complete: boolean;
  }> {
    const stopAt = await this._ourLineage(ourHead, maxWalk);
    // Our OWN history unreadable is not a licence to walk past it: the entry
    // that would have stopped the walk may be inside the unreadable part, and
    // continuing collects removals from a lineage we may already have left
    // behind. `complete: false` is the contract for "conclude nothing".
    if (stopAt === undefined) {
      return { removed: [], changed: [], complete: false };
    }
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
        // Exclusive: a state we already know needs no replay, and its own
        // ancestry is already accounted for in how we got there.
        if (stopAt.has(ref)) continue;
        walked.push(entry);
        for (const previous of entry.previous) next.push(previous);
      }
      frontier = next;
    }

    // Oldest first. `previous` points backwards, so the discovery order
    // reversed is the apply order.
    const order = [...walked].reverse();
    const removed = new Set<string>();
    const changed = new Set<string>();
    for (const entry of order) {
      for (const path of entry.removed) {
        removed.add(path);
        // And the mirror: a removal cancels an earlier change, or a path
        // written and then deleted inside the walked range would be reported
        // as created.
        changed.delete(path);
      }
      // A re-add cancels an earlier removal, and only the order says so.
      for (const path of entry.changed) {
        changed.add(path);
        removed.delete(path);
      }
    }

    return {
      removed: [...removed].sort(),
      changed: [...changed].sort(),
      complete,
    };
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
 * Above this many files, a removal covering the WHOLE folder is refused.
 *
 * The user's rule — *protect whenever ALL files would vanish* — against the
 * reason the ratio guard has a floor at all: a folder of one or four files
 * loses all of them as ordinary work, and so does a rename, which removes
 * every path it holds and adds them back under new names.
 *
 * Ten is the line between those two facts. Below it, "the whole folder" is a
 * handful of files and emptying it is an edit; above it, one peer's loss
 * taking everybody's copy is the measured failure
 * (`a small folder survives a wiped peer too`, 40 files).
 *
 * It is a refusal and not a question, because the agent has no one to ask.
 * The decision called for *"protect, and ask"*; the asking belongs to a host
 * that can show a user a dialogue, and until one does this errs towards
 * keeping files.
 */
export const ALL_GONE_MIN_FILES = 10;

/** What {@link planJoin} is asked. */
export interface JoinQuestion {
  /**
   * The hub head's tree, `path → content hash`.
   *
   * Materialised VIRTUALLY — nothing is written until the plan says so. The
   * point of the whole exercise is to decide before touching the folder.
   */
  head: ReadonlyMap<string, string>;

  /** This folder as it stands, `path → content hash`. */
  folder: ReadonlyMap<string, string>;

  /**
   * Paths the history states were REMOVED and never re-added.
   *
   * The net removals over the WHOLE history — `collectRemovals` with no stop
   * state, which walks to the root and lets a re-add cancel a removal in
   * order. This is the one fact that separates a stale copy from new work, and
   * no filesystem can supply it.
   */
  removedEver: ReadonlySet<string>;

  /**
   * Whether a head was found at all.
   *
   * No head means no history exists anywhere, so this folder IS the origin and
   * its contents are its first state. Absence of a head is NOT the same as an
   * empty head: an empty head is a fleet that has agreed the folder is empty,
   * and its emptiness is a fact to be applied.
   */
  haveHead: boolean;
}

/** What {@link planJoin} concluded, per path. */
export interface JoinPlan {
  /** In the head and missing or differing here — write the head's bytes. */
  write: string[];

  /**
   * Here, unknown to the history — new local work. Announce it.
   *
   * A file nobody has ever mentioned cannot be a deletion anybody made, and
   * dropping it is how a node loses its own work on joining.
   */
  announce: string[];

  /**
   * Here, and REMOVED by the history — a stale copy. Rename aside; do NOT
   * announce.
   *
   * The restored-backup case. Announcing these would push content the fleet
   * deliberately deleted back to every node, one file at a time, under names
   * nobody deleted — for a folder restored from last month's backup that is
   * thousands of files. So the bytes are kept where their owner can see them
   * and nothing is said about them. **That is a deliberate, visible local
   * divergence**, chosen over resurrecting a deletion or destroying a file.
   */
  recover: string[];

  /**
   * In the head AND here with different bytes — a real conflict.
   *
   * The case the stated algorithm does not name, because it is neither
   * "missing here" nor "additional here": the path is live on both sides and
   * was edited while this node was away. The head's bytes are written (the
   * chain wins on what it states) and the local bytes are kept aside as an
   * ordinary conflict copy, which IS announced — an edit to a live path is
   * exactly what conflict copies exist for.
   */
  conflict: string[];
}

/**
 * Decides what joining a network does to a folder, before anything is written.
 *
 * **The chain applies first; the filesystem only then.** A joining node used to
 * author a lineage root from whatever it happened to hold and push it as the
 * network's newest claim. That is one defect wearing two faces: every node got
 * its own lineage root, so `relate` answered `fork` to every announcement
 * ever made; and a node restored from a backup pushed deleted files back to the
 * whole fleet.
 *
 * Every question here is answered against the chain. The folder is consulted
 * only for what it holds — never for what that means.
 * @param q - The head, the folder, and what the history says was removed.
 * @returns The per-path plan; every path appears in at most one list.
 */
export const planJoin = (q: JoinQuestion): JoinPlan => {
  const write: string[] = [];
  const announce: string[] = [];
  const recover: string[] = [];
  const conflict: string[] = [];

  // No history anywhere: this folder is the origin and everything in it is its
  // first state, which the ordinary first push states as a root.
  if (!q.haveHead) {
    return { write: [], announce: [], recover: [], conflict: [] };
  }

  for (const [path, hash] of q.head) {
    const here = q.folder.get(path);
    if (here === undefined) {
      write.push(path);
    } else if (here !== hash) {
      conflict.push(path);
    }
  }

  for (const path of q.folder.keys()) {
    if (q.head.has(path)) continue;
    if (q.removedEver.has(path)) {
      recover.push(path);
    } else {
      announce.push(path);
    }
  }

  return {
    write: write.sort(),
    announce: announce.sort(),
    recover: recover.sort(),
    conflict: conflict.sort(),
  };
};
