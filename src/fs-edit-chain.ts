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

/**
 * How far back a walk goes before it gives up.
 *
 * A walk this deep is a cold replay of a whole lineage rather than a
 * catch-up, and left unbounded it pins a core on a long chain.
 *
 * Exhausting it is NOT the same as failing to read a row — see
 * {@link FsEditChain.classify}. Conflating the two made any node more than this
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

  /** The last own-lineage walk, keyed by the head it was computed for. */
  private _lineageCache: { head: string; refs: ReadonlySet<string> } | undefined;
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
   * Re-reads the tip, for a node waiting to learn the network's state.
   *
   * `init` reads it once. A joining node has none of its own and is waiting
   * for the fleet's to replicate, so it has to be able to look again — the
   * rows arrive after the connection, not before it.
   * @returns The tip now, or `undefined` while nothing has arrived.
   */
  async refreshHead(): Promise<string | undefined> {
    this._head = await this._tip();
    return this._head;
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

    // A ROOT ENTRY IS IDENTIFIED BY ITS CONTENT, NOT BY WHO BOOTED FIRST.
    //
    // An entry with no parents and nothing stated is not an edit — it is the
    // name a node gives the state it starts in. Every node authors one, and
    // those states are usually IDENTICAL, because peers already in sync hold
    // the same bytes and derive the same tree ref. With a minted `timeId` each
    // node's root is a different row, so the fleet has one lineage per node
    // from the first second — and then nothing is ever `behind` or `ahead`:
    // `classify` finds neither head reachable from the other and answers
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
    const stamp = isRoot ? `0:${opts.treeRef}` : timeId();
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
   * The newest entry that produced a given tree ref.
   *
   * **The migration bridge.** A build that predates the `~H~` announcement
   * sends a plain tree ref, and a receiver holding one cannot find its chain
   * row by hash — `dataRef` is the field, but finding a row BY a field is a
   * query rather than a content read. Measured across a real relay
   * (`test/fs-chain-crosses-the-wire.spec.ts`): the query is served, so an
   * older peer's push can still carry ancestry.
   *
   * **Ambiguous by nature, which is why it is the fallback and not the
   * primary.** A tree ref is a content hash, so a folder that returns to an
   * earlier state produces a SECOND entry with the same `dataRef` — §2.1,
   * exactly the ambiguity the chain exists to remove. The newest by `timeId`
   * is the right pick: it is the entry that most recently produced this
   * content, and the one whose ancestry describes how the folder got here now.
   *
   * Never called on the apply path. A query is a peer read, and awaiting one
   * before scheduling an apply is how a late joiner's bootstrap was lost.
   * @param treeRef - The state announced.
   * @returns The newest entry producing it, or `undefined` if none is found.
   */
  /**
   * The OLDEST entry that produced a given tree ref.
   *
   * **How a fleet agrees on one name for one state.** Every node authors an
   * entry for the state it starts in, and those states are usually identical —
   * peers already in sync hold the same bytes, so they derive the same tree
   * ref. Each node then sits on its own lineage root and `classify` answers
   * `fork` to every announcement forever.
   *
   * The oldest entry is the one to converge on because the choice is the same
   * for everybody who can see the rows, and because adoption that only ever
   * moves BACKWARDS in time is monotone: it cannot oscillate as rows arrive.
   * Whoever reached this content first described it first.
   *
   * The counterpart of {@link entryForTreeRef}, which answers the opposite
   * question — *"how did this folder get here NOW"* — and therefore wants the
   * newest.
   * @param treeRef - The state to name.
   * @returns The oldest entry producing it, or `undefined` if none is found.
   */
  async oldestEntryForTreeRef(
    treeRef: string,
  ): Promise<FsChainEntry | undefined> {
    const rows = (await this._db.getEditHistories(this._treeKey, {
      dataRef: treeRef,
    })) as Array<EditHistory & { _hash: string }>;
    // SORTED rather than scanned for a minimum, and the reason is coverage
    // rather than taste. A running-minimum loop takes its "this one is older"
    // branch only when the rows arrive in an order that has an older row after
    // a newer one — so whether that branch is exercised depends on what the
    // database happened to return. Measured: the same test covered it standalone
    // and left it uncovered in the full suite, which is the 98.22 %/99.11 %
    // pattern this repository has been bitten by before.
    //
    // `compareTimeId` is a total order, so the first element is the oldest
    // whatever order the rows come in, and there is no branch left to be lucky
    // about.
    const sorted = [...rows].sort((a, b) => compareTimeId(a.timeId, b.timeId));
    return sorted.length > 0 ? this.entry(sorted[0]._hash) : undefined;
  }

  async entryForTreeRef(treeRef: string): Promise<FsChainEntry | undefined> {
    const rows = await this._db.getEditHistories(this._treeKey, {
      dataRef: treeRef,
    });
    let newest: (EditHistory & { _hash: string }) | undefined;
    for (const row of rows as Array<EditHistory & { _hash: string }>) {
      if (!newest || compareTimeId(row.timeId, newest.timeId) > 0) {
        newest = row;
      }
    }
    return newest ? this.entry(newest._hash) : undefined;
  }

  /**
   * Where two heads stand relative to each other.
   *
   * `behind` — theirs descends from ours, so we are the one missing work.
   * `ahead` — ours descends from theirs; they are missing ours.
   * `fork` — neither descends from the other. Both sides have work.
   * `incomplete` — an entry could not be RESOLVED, so nothing may be concluded.
   *
   * **A hole and the walk bound are not the same truncation**, and treating
   * them alike was a latent permanent failure. A hole means an entry exists and
   * this node cannot read it: the ref it was looking for may be inside the part
   * it could not reach, so the honest answer is "I do not know". Exhausting the
   * walk bound means the opposite — everything asked for WAS readable, and no
   * relation was found within {@link DEFAULT_MAX_WALK} entries of history.
   *
   * Conflating them meant any node more than `DEFAULT_MAX_WALK` pushes into its
   * own history answered `incomplete` forever, which the decision turns into
   * `blocked`, which never repairs. A long-lived node would simply stop
   * healing, silently. Measured on the growth run that was meant to be about
   * storage.
   *
   * A bounded walk with no relation therefore answers `fork`: both sides keep
   * their work and reconciliation is additive. Less precise than the truth and
   * never destructive, which is the right direction to be wrong in.
   * @param ourHead - This node's head, or `undefined` when it has none.
   * @param theirHead - The head that arrived.
   * @returns How the two histories stand.
   */
  async classify(
    ourHead: string | undefined,
    theirHead: string,
  ): Promise<'behind' | 'ahead' | 'fork' | 'incomplete'> {
    if (ourHead === undefined) return 'incomplete';
    if (ourHead === theirHead) return 'ahead';

    // Is ours an ancestor of theirs? Then they moved forward from us.
    const fromTheirs = await this._ancestorsOf(theirHead);
    if (fromTheirs.holed) return 'incomplete';
    if (fromTheirs.refs.has(ourHead)) return 'behind';

    const fromOurs = await this._ancestorsOf(ourHead);
    if (fromOurs.holed) return 'incomplete';
    if (fromOurs.refs.has(theirHead)) return 'ahead';

    return 'fork';
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
   * many entries of history. See {@link classify}.
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
    // found really is our lineage — just not all of it. See `classify`.
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

    // NEAREST TO THE HEAD WINS, and ties within one step are broken by
    // `timeId`. **Not the greatest `timeId` overall**, which was the first
    // version of this and is wrong on the commonest history there is: two
    // edits a second apart are usually minted in the same millisecond, and
    // `compareTimeId` then breaks the tie on a RANDOM tail. So the later edit
    // of a file could compare as older than the one it replaced — the
    // function would name an entry its own successor had superseded.
    //
    // Walking back generation by generation asks the causal question instead:
    // an entry closer to the head is one the head descends FROM, so anything
    // deeper has been built on and cannot be the latest word. Two entries the
    // same distance away really are concurrent — two parents of a merge — and
    // `timeId` is the right answer for those, being a total order every node
    // computes identically.
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
      // SORTED rather than scanned for a maximum, and for coverage rather than
      // taste: a running maximum takes its "this one is greater" branch only
      // when the entries arrive in one particular order, and these are ordered
      // by a RANDOM tail whenever two were minted in the same millisecond. The
      // branch would then be covered or not by luck — the 98 %/99 % pattern
      // this repository has been bitten by twice.
      if (here.length > 0) {
        return here.sort((a, b) => compareTimeId(b.timeId, a.timeId))[0];
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
   * **Both halves of the net delta are returned**, and the second one is not
   * bookkeeping. A receiver holds a TOMBSTONE for every path it has deleted,
   * including the ones a peer told it to delete, and that tombstone refuses
   * the path if anyone writes it again. Only a peer that STATES it created
   * the path may lift it — a tree merely containing the path states nothing,
   * since every tree that predates the deletion contains it too. Measured: a
   * file created, deleted and created again at the same path never reached the
   * second node, in three runs of three, because nothing could clear the
   * tombstone the node had set on its peer's authority.
   * @returns The net removals, the net changes, the newest `timeId` seen, and
   *   whether the walk resolved completely.
   */
  async collectRemovals(
    head: string,
    ourHead: string | undefined,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<{
    removed: string[];
    changed: string[];
    timeId?: string;
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
        // Exclusive: a state we already know needs no replay, its own
        // ancestry is already accounted for in how we got there, and its
        // `timeId` is not news — including it in the maximum below would let a
        // removal claim to be newer than it is and weaken the recency guard.
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

    // The newest id among everything walked, which is what a receiver orders
    // the removal against.
    let timeId: string | undefined;
    for (const entry of walked) {
      if (compareTimeId(entry.timeId, timeId) > 0 || timeId === undefined) {
        timeId = entry.timeId;
      }
    }

    return {
      removed: [...removed].sort(),
      changed: [...changed].sort(),
      timeId,
      complete,
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

  // EVERYTHING GONE AT ONCE HAS ITS OWN, LOWER FLOOR.
  //
  // The ratio rule needs `minFiles` for the reason its own test gives:
  // *"below the floor, 'most of the folder' is not a meaningful statement"*,
  // and a guard that fires on ordinary small-folder work gets turned off. A
  // folder holding one file legitimately loses it; a rename in a small folder
  // removes every path it holds and adds them back under new names.
  //
  // But the floor was ALSO the only thing standing between a wiped peer and
  // every other node's copy: 40 removals against 40 held files is a ratio of
  // 1.0 and still under 100, so it passed unchallenged. Measured as `a small
  // folder survives a wiped peer too` — every node emptied by one peer's loss.
  //
  // So the two cases get two floors. "Most of it" stays at `minFiles`,
  // because below that the ratio says nothing. "ALL of it" gets
  // {@link ALL_GONE_MIN_FILES}, which is low enough to catch a wipe and high
  // enough to leave the folders where emptying is ordinary work alone.
  const allGone =
    opts.held.size > ALL_GONE_MIN_FILES && apply.length >= opts.held.size;
  const blocked =
    allGone ||
    (apply.length > opts.minFiles &&
      apply.length / Math.max(opts.held.size, 1) > opts.maxRatio);

  return blocked
    ? { apply: [], staler, blocked: true }
    : { apply, staler, blocked: false };
};

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
 * its own lineage root, so `classify` answered `fork` to every announcement
 * ever made; and a node restored from a backup pushed deleted files back to the
 * whole fleet.
 *
 * Every question here is answered against the chain. The folder is consulted
 * only for what it holds — never for what that means.
 * @param q - The head, the folder, and what the history says was removed.
 * @returns The per-path plan; every path appears in at most one bucket.
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
