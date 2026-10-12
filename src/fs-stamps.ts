// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Db } from '@rljson/db';
import {
  compareRefStamp,
  isRefStamp,
  type RefStamp,
  type TableCfg,
} from '@rljson/rljson';

import { DEFAULT_MAX_WALK } from './fs-edit-chain.ts';

/** One stored stamp: which chain entry, and where the fleet first saw it. */
interface StampRow extends RefStamp {
  entry: string;
  /** Whether every entry below it has a stamp too. */
  walked: boolean;
  _hash?: string;
}

/**
 * The table the stamps of one route's chain entries are kept in.
 * @param key - The table key, `${treeKey}EditStamps`.
 * @returns Its table configuration.
 */
const stampTableCfg = (key: string): TableCfg =>
  ({
    key,
    type: 'components',
    isHead: false,
    isRoot: false,
    isShared: true,
    columns: [
      { key: '_hash', type: 'string', titleShort: 'Hash', titleLong: 'Hash' },
      { key: 'entry', type: 'string', titleShort: 'Entry', titleLong: 'Chain entry' },
      { key: 'domain', type: 'string', titleShort: 'Domain', titleLong: 'Domain' },
      { key: 'epoch', type: 'number', titleShort: 'Epoch', titleLong: 'Hub epoch' },
      { key: 'hub', type: 'string', titleShort: 'Hub', titleLong: 'Stamping hub' },
      { key: 'n', type: 'number', titleShort: 'N', titleLong: 'Sequence' },
      { key: 'walked', type: 'boolean', titleShort: 'Walked', titleLong: 'Entries below stamped' },
    ],
  }) as unknown as TableCfg;

// .............................................................................
/**
 * The stamp of every chain entry, as this node learned it.
 *
 * **A version's stamp is the stamp of the announcement that first carried it
 * to the fleet.** A head arrives with a stamp; the entries below it that no
 * earlier announcement carried — the edits a node made offline, say — reached
 * the fleet with it, so they get it too. The walk stops at the first entry that
 * already has a stamp. An entry keeps the first stamp it was given.
 *
 * A walk can stop short — at a row that cannot be read yet, or at the budget.
 * The entry it stopped at stays OPEN: stamped, its ancestors not yet, and
 * {@link settle} resumes it. Without that, everything below the gap stayed
 * unstamped for good, because the next walk stops at the stamped entry above
 * it, and every merge that needed one of those stamps deferred for ever.
 *
 * Kept in the route's own database, because a conflict can be about a version
 * introduced long ago and its stamp has to outlive a restart.
 */
export class FsStamps {
  private readonly _byEntry = new Map<string, RefStamp>();
  /** Stamped entries whose ancestors have not been walked yet. */
  private readonly _open = new Set<string>();
  /** The highest epoch heard, per domain. */
  private readonly _maxEpoch = new Map<string, number>();

  constructor(
    private readonly _db: Db,
    private readonly _treeKey: string,
    private readonly _previousOf: (
      entry: string,
    ) => Promise<readonly string[] | undefined>,
  ) {}

  /** The table the stamps are kept in. */
  get table(): string {
    return `${this._treeKey}EditStamps`;
  }

  /** How many walks stopped short and wait for {@link settle}. */
  get open(): number {
    return this._open.size;
  }

  // ...........................................................................
  /** Creates the table if absent, and loads what it holds. */
  async init(): Promise<void> {
    await this._db.core.createTable(stampTableCfg(this.table));
    const dump = await this._db.core.dumpTable(this.table);
    // An entry has one row, or two once a walk that stopped at it went on:
    // the stamp never changes, `walked` only ever becomes true.
    const walked = new Set<string>();
    for (const row of dump[this.table]._data as StampRow[]) {
      const { entry, domain, epoch, hub, n } = row;
      this._set(entry, { domain, epoch, hub, n });
      if (row.walked) walked.add(entry);
    }
    for (const entry of this._byEntry.keys()) {
      if (!walked.has(entry)) this._open.add(entry);
    }
  }

  /**
   * The stamp an entry reached the fleet with.
   * @param entry - The chain entry.
   * @returns Its stamp, or `undefined` while nobody has told this node.
   */
  get(entry: string): RefStamp | undefined {
    return this._byEntry.get(entry);
  }

  // ...........................................................................
  /**
   * Records the stamp a head arrived with, for it and for every entry below it
   * no earlier announcement carried.
   * @param head - The announced head.
   * @param stamp - The stamp it arrived with. A malformed one is ignored.
   * @param maxWalk - How many rows to read; past it the walk stays open.
   */
  async heard(
    head: string,
    stamp: unknown,
    maxWalk = DEFAULT_MAX_WALK,
  ): Promise<void> {
    if (!isRefStamp(stamp) || this._byEntry.has(head)) return;
    const { domain, epoch, hub, n } = stamp;
    this._set(head, { domain, epoch, hub, n });
    this._open.add(head);
    await this._walk([head], new Set([head]), maxWalk);
  }

  /**
   * Resumes every walk that stopped short.
   *
   * Not part of {@link heard}: a row that cannot be read can cost a blocked
   * read each time it is asked for, and an announcement arrives every few
   * seconds. Only a merge that is missing a stamp calls this.
   * @param maxWalk - How many rows to read; past it the walks stay open.
   */
  async settle(maxWalk = DEFAULT_MAX_WALK): Promise<void> {
    await this._walk([...this._open], new Set(), maxWalk);
  }

  /**
   * The highest epoch this node has heard in a domain — what a hub taking
   * office here has to continue above.
   * @param domain - The domain.
   * @returns The epoch, or `0` when none was heard.
   */
  maxEpoch(domain: string): number {
    return this._maxEpoch.get(domain) ?? 0;
  }

  /** The highest epoch heard in every domain this node has heard of. */
  get epochs(): Readonly<Record<string, number>> {
    return Object.fromEntries(this._maxEpoch);
  }

  /**
   * Records an entry's stamp, and the epoch it carries.
   * @param entry - The chain entry.
   * @param stamp - Its stamp.
   */
  private _set(entry: string, stamp: RefStamp): void {
    this._byEntry.set(entry, stamp);
    if (stamp.epoch > this.maxEpoch(stamp.domain)) {
      this._maxEpoch.set(stamp.domain, stamp.epoch);
    }
  }

  // ...........................................................................
  /**
   * Walks down from open entries, giving every unstamped entry it reaches the
   * stamp it was reached with, and stores what changed.
   *
   * Earliest stamp first: an entry two announcements carried belongs to the
   * earlier one, and a walk resumed late must not lose it to a later walk that
   * happens to be fewer steps away.
   * @param seeds - The open entries to walk from.
   * @param changed - Entries stamped by the caller, to be stored too.
   * @param maxWalk - How many rows to read.
   */
  private async _walk(
    seeds: readonly string[],
    changed: Set<string>,
    maxWalk: number,
  ): Promise<void> {
    const pending = new Set(seeds);
    for (let reads = 0; pending.size > 0 && reads < maxWalk; reads++) {
      const entry = [...pending].reduce((a, b) => (this._before(b, a) ? b : a));
      pending.delete(entry);
      const previous = await this._previousOf(entry);
      // Cannot be read yet: stays open.
      if (previous === undefined) continue;
      const stamp = this._byEntry.get(entry) as RefStamp;
      for (const parent of previous) {
        if (this._byEntry.has(parent)) continue;
        this._set(parent, stamp);
        this._open.add(parent);
        pending.add(parent);
        changed.add(parent);
      }
      this._open.delete(entry);
      changed.add(entry);
    }
    if (changed.size === 0) return;

    await this._db.core.import(
      {
        [this.table]: {
          _type: 'components',
          _data: [...changed].map(
            (entry): StampRow => ({
              entry,
              ...(this._byEntry.get(entry) as RefStamp),
              walked: !this._open.has(entry),
            }),
          ),
        },
      } as never,
      { validate: false },
    );
  }

  /**
   * Whether `a` was stamped before `b`.
   * @param a - A stamped entry.
   * @param b - Another.
   * @returns `true` when `a`'s stamp is the earlier, ties broken on the entry.
   */
  private _before(a: string, b: string): boolean {
    const order = compareRefStamp(
      this._byEntry.get(a) as RefStamp,
      this._byEntry.get(b) as RefStamp,
    );
    return order < 0 || (order === 0 && a < b);
  }
}
