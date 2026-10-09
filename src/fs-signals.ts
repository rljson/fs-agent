// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// ONE CHANNEL FOR EVERYTHING THAT HAPPENED TO SOMEBODY'S FILES.
//
// WHY THIS EXISTS
// The agent knew more than it said. A same-file merge reported itself through
// `onConflict` and a mass-delete refusal through `refusedDeletions`, and
// everything else that touched a user's folder — a bucket round settling two
// edits, a joining machine moving files into `.fsagent-recovered/`, a path that
// could not be written — went to `console.warn` and nowhere a program can read.
// A host application cannot grep a log on a machine it is not running on, and
// *"why is my file called (conflicted copy …)"* is a question it has to answer.
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
// A conflict settled from the edit chain is a fact about what happened. One
// settled by comparing content hashes converges and is otherwise arbitrary —
// the winner has nothing to do with who edited last. Two defects in exactly
// that distinction shipped this quarter, both of which converged on the
// superseded version about half the time they arose, and neither was visible
// from outside. A caller that can see `decidedBy: 'hash'` can ask a person;
// one that cannot has to trust a coin flip.
//
// BOUNDED, BUT NOTHING IS SILENTLY FORGOTTEN
// The list is capped. Counters per kind are not, so a folder that produced two
// thousand refusals still says so after the oldest are dropped — a cap that
// hides the scale of what it dropped is worse than no cap.
// .............................................................................

/** What a {@link FsSignal} is about. */
export type FsSignalKind =
  /** Both versions of a same-file conflict were kept; see `copyPath`. */
  | 'conflict/merged'
  /**
   * Both versions were kept, and which one keeps the path was decided
   * arbitrarily — nothing could say who edited last. Converged, but a person
   * may want to look.
   */
  | 'conflict/arbitrary'
  /**
   * One version won and the other was NOT kept. Only reachable with
   * `resolveConflicts` off, where no resolver is constructed.
   */
  | 'conflict/overwritten'
  /** A deletion was refused by the mass-delete guard and will not arrive. */
  | 'deletion/refused'
  /** A joining machine moved files the history had removed out of the way. */
  | 'join/recovered'
  /** A joining machine kept its own edit of a path beside the network's. */
  | 'join/conflicted'
  /** A divergence was found that cannot be repaired without losing work. */
  | 'repair/blocked'
  /** A path could not be written: locked, impossible, or the disk is full. */
  | 'path/unwritable'
  /**
   * The agent is running in a configuration that keeps less than it could —
   * reported once per agent, not per event.
   */
  | 'config/degraded';

/**
 * Who or what chose the outcome.
 *
 * Ordered by how much it is worth trusting, which is also the order the code
 * tries them in.
 */
export type FsSignalDecidedBy =
  /** The edit chain: a fact about which edit came after which. */
  | 'chain'
  /** A wall-clock timestamp. Correct unless a machine's clock is wrong. */
  | 'clock'
  /** Whose history claims the path. Weaker than the chain, stronger than a hash. */
  | 'claim'
  /** The content hash. Identical on every node and otherwise arbitrary. */
  | 'hash'
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

/** What a signal says before the sink stamps and bounds it. */
export type FsSignalInput = Omit<FsSignal, 'at' | 'paths' | 'pathCount'> & {
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
    const signal: FsSignal = {
      ...input,
      at: input.at ?? Date.now(),
      paths: paths.slice(0, SIGNAL_PATHS_MAX),
      pathCount: paths.length,
    };
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
        this._signals.push(entry);
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
