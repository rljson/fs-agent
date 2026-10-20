// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// ONE CHANNEL FOR EVERYTHING THAT HAPPENED TO SOMEBODY'S FILES.
//
// WHY THIS EXISTS
// Everything that touches a user's folder — a same-file merge, a refused
// deletion, a joining machine moving files into `.fsagent-recovered/`, a path
// that could not be written — is reported here, and only here. A host
// application cannot grep a log on a machine it is not running on, and *"why
// is my file called (conflicted copy …)"* is a question it has to answer.
//
// WHAT A SIGNAL IS FOR
// Three facts, and the third is the one the other surfaces never carried:
//
//   - WHAT happened and to WHICH paths (`kind`, `paths`)
//   - HOW it was decided (`decidedBy`)
//   - whether a PERSON has to do something (`action`)
//
// `action` is the whole point. "Both versions kept" and "your deletion was
// refused and nothing further will happen" are both resolutions, and only one
// of them can be left alone. A UI that cannot tell them apart has to either
// alarm about everything or stay silent about everything, and this package has
// shipped the second one.
//
// WHY `decidedBy` IS NOT A DETAIL
// A conflict settled from the edit chain is a fact about what happened; one
// settled by the hub's stamps is the order in which the fleet heard two
// versions, which is all anybody can know about two concurrent edits. Neither
// compares two machines' clocks. A caller that can see which one decided can
// tell a person what the decision means.
//
// BOUNDED, BUT NOTHING IS SILENTLY FORGOTTEN
// The list is capped. Counters per kind are not, so a folder that produced two
// thousand refusals still says so after the oldest are dropped — a cap that
// hides the scale of what it dropped is worse than no cap.
// .............................................................................

import { createHash } from 'crypto';

/** What a {@link FsSignal} is about. */
export type FsSignalKind =
  /**
   * Two machines changed one file at once, or one deleted what the other
   * edited. Nothing was lost: both versions were kept (see `copyPath`), or the
   * edit was. Which version keeps the path follows the order the fleet heard
   * them in — which is not who edited last, so a person may want to look.
   */
  | 'conflict/arbitrary'
  /** A directory and a file at one path: both kept, a person decides. */
  | 'collision/type'
  /** A deletion was refused by the mass-delete guard and will not arrive. */
  | 'deletion/refused'
  /** A joining machine moved files the history had removed out of the way. */
  | 'join/recovered'
  /** A joining machine kept its own edit of a path beside the network's. */
  | 'join/conflicted'
  /** A divergence was found that cannot be repaired without losing work. */
  | 'repair/blocked'
  /** A path could not be written: locked, impossible, or the disk is full. */
  | 'path/unwritable';

/** Who or what chose the outcome. */
export type FsSignalDecidedBy =
  /** The edit chain: a fact about which edit came after which. */
  | 'chain'
  /** Decided by the hub's stamps: which version reached the fleet later. */
  | 'stamp'
  /** A guard refused, so nothing was chosen. */
  | 'guard';

/** Whether a person has to do something. */
export type FsSignalAction =
  /** Resolved; nothing to do. */
  | 'none'
  /** Resolved, but somebody may want to look — a kept copy, an arbitrary pick. */
  | 'review'
  /** NOT resolved. It stays this way until a person acts. */
  | 'required';

/** One thing that happened to a folder, in a form a program can act on. */
export interface FsSignal {
  /**
   * This signal's identity: a hash of what happened, unique within the log.
   *
   * Derived rather than counted, so a log written before ids existed gets the
   * same ids on every read, and a host can key a row, or remember what a
   * person has seen, by it.
   */
  id: string;
  /** What happened. */
  kind: FsSignalKind;
  /** When, epoch ms. */
  at: number;
  /**
   * The paths it affected, sorted.
   *
   * Capped at {@link SIGNAL_PATHS_MAX} with `pathCount` carrying the true
   * number, because a mass deletion names thousands and a signal has to stay
   * small enough to keep.
   */
  paths: readonly string[];
  /** How many paths were affected, which may exceed `paths.length`. */
  pathCount: number;
  /** Whether a person has to do something. */
  action: FsSignalAction;
  /** How the outcome was chosen, where something chose it. */
  decidedBy?: FsSignalDecidedBy;
  /** Where the version that lost the path was kept, when one was. */
  copyPath?: string;
  /**
   * For a signal about several paths, where each one's own version went:
   * original → copy. Only for the paths in {@link paths}.
   *
   * `join/conflicted` keeps a machine's edit beside the network's version, and
   * `join/recovered` moves a file the history removed into
   * `.fsagent-recovered/`; without this a host could name the files but not
   * show where they went.
   */
  copies?: Readonly<Record<string, string>>;
  /**
   * The chain entry this belongs to, when it belongs to one — for a merge
   * conflict, the merge. A host can show the signal next to that revision.
   */
  head?: string;
  /** The edit this belongs to, when it belongs to one. */
  timeId?: string;
  /** One sentence for a person. Never a stack trace. */
  detail?: string;
}

/** How many signals {@link FsSignals.all} keeps. */
export const SIGNAL_LOG_MAX = 200;

/** How many paths one signal names before it only counts them. */
export const SIGNAL_PATHS_MAX = 20;

/**
 * How many distinct {@link FsSignals.addOnce} keys are remembered.
 *
 * Bounded because a key can be derived from live state — the pair of refs a
 * divergence is between, say — and a churning fleet produces new pairs
 * indefinitely. Dropping the oldest means such a signal may be reported again
 * later, which is noise rather than a falsehood; an unbounded set would be a
 * leak, and this package has shipped two of those.
 */
export const SIGNAL_ONCE_MAX = 500;

/** The file {@link FsSignals} persists to, inside the synced folder. */
export const SIGNAL_LOG_FILE = '.fsagent-signals.json';

/** What {@link FsSignals.persisted} writes and reads. */
export interface FsSignalLog {
  /** The newest signals, oldest first, at most {@link SIGNAL_LOG_MAX}. */
  signals: FsSignal[];
  /**
   * How many of each kind have EVER been recorded, including dropped ones.
   *
   * Survives the cap and survives a restart, so "and 1 240 more" is answerable.
   */
  totals: Record<string, number>;
}

/** What a signal says before the sink stamps, identifies and bounds it. */
export type FsSignalInput = Omit<FsSignal, 'id' | 'at' | 'paths' | 'pathCount'> & {
  /** The affected paths; sorted, capped and counted by the sink. */
  paths: readonly string[];
  /** Overrides the clock, for a test that needs a fixed stamp. */
  at?: number;
};

/**
 * The signal sink: bounded, countable, subscribable.
 *
 * Deliberately has no I/O of its own. The agent owns the folder and the error
 * log, so it owns the writing too — this stays a pure structure that a test can
 * drive without a filesystem, which is also what keeps its own tests honest.
 */
export class FsSignals {
  private readonly _signals: FsSignal[] = [];
  private readonly _totals = new Map<FsSignalKind, number>();
  private readonly _listeners = new Set<(signal: FsSignal) => void>();
  private readonly _once = new Set<string>();

  /**
   * Records one signal.
   * @param input - What happened.
   * @returns The signal as recorded, stamped and bounded.
   */
  add(input: FsSignalInput): FsSignal {
    const paths = [...input.paths].sort();
    const kept = paths.slice(0, SIGNAL_PATHS_MAX);
    const { copies, ...rest } = input;
    const unidentified: Omit<FsSignal, 'id'> = {
      ...rest,
      at: input.at ?? Date.now(),
      paths: kept,
      pathCount: paths.length,
      ...FsSignals._keptCopies(copies, kept),
    };
    const signal: FsSignal = { id: this._uniqueId(unidentified), ...unidentified };
    this._signals.push(signal);
    // The cap drops the OLDEST, because a folder in trouble produces signals
    // faster than anybody reads them and the newest are the ones that still
    // describe the current state.
    while (this._signals.length > SIGNAL_LOG_MAX) this._signals.shift();
    this._totals.set(signal.kind, (this._totals.get(signal.kind) ?? 0) + 1);

    // A listener that throws is the host's problem and must not take the sink
    // with it — the alternative is a UI bug stopping a sync.
    for (const listener of this._listeners) {
      try {
        listener(signal);
      } catch {
        /* reported by the caller, which owns the error log */
      }
    }
    return signal;
  }

  /**
   * Records a signal at most once per agent, for a standing condition.
   *
   * A misconfiguration is true for the life of the process, so reporting it per
   * event would bury everything else.
   * @param key - What is being reported once.
   * @param input - What happened.
   * @returns The signal, or `undefined` if this key was already reported.
   */
  addOnce(key: string, input: FsSignalInput): FsSignal | undefined {
    if (this._once.has(key)) return undefined;
    this._once.add(key);
    while (this._once.size > SIGNAL_ONCE_MAX) {
      this._once.delete(this._once.values().next().value as string);
    }
    return this.add(input);
  }

  /** Every signal kept, oldest first. */
  get all(): readonly FsSignal[] {
    return this._signals;
  }

  /** Only the signals a person still has to act on. */
  get needingAction(): readonly FsSignal[] {
    return this._signals.filter((s) => s.action === 'required');
  }

  /**
   * How many of each kind have ever been recorded, dropped ones included.
   * @returns The counts, keyed by kind.
   */
  totals(): Readonly<Record<string, number>> {
    return Object.fromEntries(this._totals);
  }

  /**
   * Subscribes to signals as they happen.
   * @param listener - Called once per signal.
   * @returns Unsubscribes.
   */
  subscribe(listener: (signal: FsSignal) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * What to persist.
   * @returns The log, ready to serialise.
   */
  persisted(): FsSignalLog {
    return { signals: [...this._signals], totals: this.totals() };
  }

  /**
   * Restores a persisted log, so a host that starts later still sees what
   * happened while it was not running.
   *
   * Tolerant by construction: a log that cannot be understood is skipped
   * rather than thrown, because a corrupt notification file must never stop a
   * folder from syncing.
   * @param raw - What was read from disk.
   */
  restore(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const log = raw as Partial<FsSignalLog>;
    if (Array.isArray(log.signals)) {
      for (const entry of log.signals) {
        if (!FsSignals._isSignal(entry)) continue;
        // A log written before ids existed is given them now, derived from
        // what each signal says, so every read of one log names its signals
        // alike.
        this._signals.push(
          typeof entry.id === 'string' && entry.id !== ''
            ? entry
            : { ...entry, id: this._uniqueId(entry) },
        );
      }
      while (this._signals.length > SIGNAL_LOG_MAX) this._signals.shift();
    }
    if (typeof log.totals === 'object' && log.totals !== null) {
      for (const [kind, count] of Object.entries(log.totals)) {
        if (typeof count === 'number' && Number.isFinite(count)) {
          this._totals.set(kind as FsSignalKind, count);
        }
      }
    }
  }

  /**
   * The copies of the paths a signal kept, or nothing.
   *
   * The cap bounds the signal, and a copy of a path the signal no longer names
   * could not be explained; an empty map is left out rather than kept.
   * @param copies - Original → copy, as the caller gave it.
   * @param kept - The paths the signal names.
   * @returns The `copies` field to spread, if any.
   */
  private static _keptCopies(
    copies: Readonly<Record<string, string>> | undefined,
    kept: readonly string[],
  ): Pick<FsSignal, 'copies'> {
    if (!copies) return {};
    const named = kept.filter((path) =>
      Object.prototype.hasOwnProperty.call(copies, path),
    );
    return named.length === 0
      ? {}
      : { copies: Object.fromEntries(named.map((path) => [path, copies[path]])) };
  }

  /**
   * An id for a signal: a hash of what it says, made unique within the log.
   *
   * Two signals that say the same thing in the same millisecond are possible —
   * a refusal raised twice at once — and must still be two rows, so a repeat
   * gets a counter rather than the same id.
   * @param signal - The signal, without its id.
   * @returns The id.
   */
  private _uniqueId(signal: Omit<FsSignal, 'id'>): string {
    const base = createHash('sha256')
      .update(
        JSON.stringify([
          signal.kind,
          signal.at,
          signal.paths,
          signal.pathCount,
          signal.copyPath ?? '',
          signal.detail ?? '',
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    let id = base;
    for (let n = 2; this._signals.some((kept) => kept.id === id); n++) {
      id = `${base}.${n}`;
    }
    return id;
  }

  /**
   * Whether a restored entry is shaped like a signal.
   *
   * Only the fields something downstream reads without checking. A log written
   * by a newer build may carry a `kind` this one has never heard of, and that
   * is kept rather than dropped: an unknown kind is still a true record of
   * something that happened, and dropping it would make a downgrade lose
   * history.
   * @param value - The entry.
   * @returns Whether it can be kept.
   */
  private static _isSignal(value: unknown): value is FsSignal {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Partial<FsSignal>;
    return (
      typeof entry.kind === 'string' &&
      typeof entry.at === 'number' &&
      Array.isArray(entry.paths) &&
      typeof entry.pathCount === 'number' &&
      typeof entry.action === 'string'
    );
  }
}
