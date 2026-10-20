// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// THE HISTORY A PERSON READS — the edit chain, newest first, a page at a time.
//
// WHY NOT THE INSERT HISTORY
// `<treeKey>InsertHistory` records the trees THIS node stored. A node that
// took its state from a peer stored nothing of its own, so its newest row is
// whatever it last authored itself — and a host that called that row "the
// current state" showed a version the folder no longer held. The chain records
// every state the folder was in, whoever authored it, and a merge with both of
// its parents.
//
// THE ORDER
// The chain is a graph: a merge has two parents, and two lineages run side by
// side until one. A list must never show an entry above one made on top of it,
// and it has to be readable a page at a time without walking the whole history
// first — so it is a walk with a priority queue, newest first:
//
//  - by STAMP, the announcement that first carried an entry to the fleet. An
//    announcement carries everything below the head it names, so an entry is
//    never stamped later than one made on top of it. An entry nobody has
//    stamped has not reached the fleet yet, and is newer than all of them;
//  - among equal stamps — one announcement carried a whole stretch of work,
//    made offline — by the time the authoring node minted, which within one
//    node's stretch is its own clock running forward. A merge and a root carry
//    no time; a merge is ordered by the entry it was reached from;
//  - an entry is never taken while an entry made on top of it waits, whatever
//    the two keys say;
//  - then by head, so two walks of one chain list it alike.
//
// The state of the walk is the queue, handed back as an opaque cursor: the
// next page continues exactly where this one stopped.
// .............................................................................

import type { Db } from '@rljson/db';
import {
  compareRefStamp,
  getTimeIdTimestamp,
  type RefStamp,
} from '@rljson/rljson';

import {
  DEFAULT_MAX_WALK,
  FsEditChain,
  type FsChainEntry,
} from './fs-edit-chain.ts';
import { readFsStamps } from './fs-stamps.ts';

/** One entry of the history, as a person is shown it. */
export interface FsHistoryEntry extends FsChainEntry {
  /**
   * `edit` — a change one node made; `merge` — two lineages joined, `previous`
   * names both; `root` — where a lineage began.
   */
  kind: 'edit' | 'merge' | 'root';
  /**
   * When the authoring node made the edit, epoch ms by THAT node's clock.
   * Absent for a merge and a root: both are derived from their content so
   * every node writes the same entry, and carry no time.
   */
  at?: number;
  /**
   * The announcement that first carried the entry to the fleet, as this node
   * learned it — the order no clock decides. Absent until this node learned
   * it, which for its own newest edit is a round trip to the hub.
   */
  stamp?: RefStamp;
}

/** What {@link walkFsHistory} lists. */
export interface FsHistoryOptions {
  /** The entry to start from. The agent defaults it to its own head. */
  from?: string;
  /**
   * Where the previous page stopped: its {@link FsHistoryPage.cursor}. Wins
   * over `from`.
   */
  cursor?: string;
  /**
   * How many entries one page holds. Default {@link FS_HISTORY_PAGE}, at most
   * {@link DEFAULT_MAX_WALK}.
   */
  limit?: number;
}

/** One page of a history. */
export interface FsHistoryPage {
  /** Newest first. */
  entries: FsHistoryEntry[];
  /**
   * Pass back as `cursor` for the next page. Absent when nothing is left to
   * list. Opaque: its shape may change in any release.
   */
  cursor?: string;
  /**
   * Entries this page reached as a `previous` and could not read — history
   * this node does not hold. Nothing older than them can be listed, and a host
   * should say so rather than show the list as complete.
   */
  missing: string[];
}

/** How many entries a page holds when the caller does not say. */
export const FS_HISTORY_PAGE = 50;

/** How a walk reads the chain: one entry, and the stamp it has. */
export interface FsHistorySource {
  /** One entry, or `undefined` when this node cannot read it. */
  entry(head: string): Promise<FsChainEntry | undefined>;
  /** The entry's stamp, or `undefined` while this node does not know it. */
  stamp(head: string): RefStamp | undefined;
}

/** An entry waiting to be listed. */
interface Waiting {
  entry: FsChainEntry;
  stamp: RefStamp | undefined;
  /** The time it is ordered by: its own, or the entry it was reached from. */
  after: number | null;
}

/** What a cursor holds: the queue, as `[head, after]` pairs. */
type CursorQueue = [string, number | null][];

// .............................................................................
/**
 * One page of a chain's history, newest first. See the file header for the
 * order.
 * @param source - How to read the chain.
 * @param options - Where to start, or continue, and how much to list.
 * @returns The page.
 */
export const walkFsHistory = async (
  source: FsHistorySource,
  options: FsHistoryOptions,
): Promise<FsHistoryPage> => {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? FS_HISTORY_PAGE) || 1),
    DEFAULT_MAX_WALK,
  );
  const start: CursorQueue =
    options.cursor !== undefined
      ? readCursor(options.cursor)
      : options.from !== undefined
        ? [[options.from, null]]
        : [];

  const seen = new Set<string>();
  const waiting: Waiting[] = [];
  const missing: string[] = [];
  const reach = async (head: string, after: number | null): Promise<void> => {
    if (seen.has(head)) return;
    seen.add(head);
    const entry = await source.entry(head);
    if (!entry) {
      missing.push(head);
      return;
    }
    waiting.push({
      entry,
      stamp: source.stamp(head),
      after: timeOf(entry) ?? after,
    });
  };

  for (const [head, after] of start) await reach(head, after);

  const entries: FsHistoryEntry[] = [];
  while (entries.length < limit && waiting.length > 0) {
    const next = waiting.splice(newest(waiting), 1)[0];
    entries.push(historyEntry(next.entry, next.stamp));
    for (const previous of next.entry.previous) {
      await reach(previous, next.after);
    }
  }

  return {
    entries,
    ...(waiting.length === 0
      ? {}
      : {
          cursor: JSON.stringify(
            waiting.map((w): [string, number | null] => [w.entry.head, w.after]),
          ),
        }),
    missing,
  };
};

/**
 * The history of a chain in a database this process does not own — the store
 * of an fs-agent running in another process, opened read-only by its host.
 *
 * **Writes nothing.** No table is created: the stamps are read when their
 * table is there and are absent when it is not.
 * @param db - The database holding the chain.
 * @param treeKey - The route's trees table key.
 * @param options - Where to start, or continue, and how much to list.
 * @returns The page.
 */
export const readFsHistory = async (
  db: Db,
  treeKey: string,
  options: FsHistoryOptions,
): Promise<FsHistoryPage> => {
  const chain = new FsEditChain(db, treeKey);
  const stamps = await readFsStamps(db, treeKey);
  return walkFsHistory(
    { entry: (head) => chain.entry(head), stamp: (head) => stamps.get(head) },
    options,
  );
};

// .............................................................................
/**
 * A chain entry as the history lists it.
 * @param entry - The entry.
 * @param stamp - Its stamp, if known.
 * @returns The history entry.
 */
const historyEntry = (
  entry: FsChainEntry,
  stamp: RefStamp | undefined,
): FsHistoryEntry => {
  const at = timeOf(entry);
  return {
    ...entry,
    kind:
      entry.previous.length === 0
        ? 'root'
        : entry.previous.length > 1
          ? 'merge'
          : 'edit',
    ...(at === null ? {} : { at }),
    ...(stamp ? { stamp } : {}),
  };
};

/**
 * When an entry was made, if it says.
 * @param entry - The entry.
 * @returns Epoch ms, or `null` for an entry minted without a time.
 */
const timeOf = (entry: FsChainEntry): number | null => {
  const at = getTimeIdTimestamp(entry.timeId);
  return at !== null && at > 0 ? at : null;
};

/**
 * Which waiting entry to list next.
 * @param waiting - The queue; never empty.
 * @returns Its index.
 */
const newest = (waiting: readonly Waiting[]): number => {
  // Nothing is taken while an entry made on top of it waits. Something always
  // can be: an entry's head is a hash over its own `previous`, so no entry can
  // wait below itself, however indirectly.
  const below = new Set(waiting.flatMap((w) => w.entry.previous));
  let best = -1;
  for (let i = 0; i < waiting.length; i++) {
    if (below.has(waiting[i].entry.head)) continue;
    if (best === -1 || newer(waiting[i], waiting[best])) best = i;
  }
  return best;
};

/**
 * Whether `a` is listed before `b`.
 * @param a - One waiting entry.
 * @param b - Another.
 * @returns `true` when `a` is newer.
 */
const newer = (a: Waiting, b: Waiting): boolean => {
  if (!a.stamp !== !b.stamp) return !a.stamp;
  if (a.stamp && b.stamp) {
    const order = compareRefStamp(a.stamp, b.stamp);
    if (order !== 0) return order > 0;
  }
  const ta = a.after ?? Infinity;
  const tb = b.after ?? Infinity;
  if (ta !== tb) return ta > tb;
  return a.entry.head > b.entry.head;
};

/**
 * The queue a cursor holds.
 * @param cursor - A cursor {@link walkFsHistory} returned.
 * @returns The queue.
 */
const readCursor = (cursor: string): CursorQueue => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string' &&
        (item[1] === null || typeof item[1] === 'number'),
    );
  if (!valid) throw new Error(`fs history: not a cursor: ${cursor}`);
  return parsed as CursorQueue;
};
