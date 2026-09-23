// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Anti-entropy for the filesystem sync.
//
// WHY THIS EXISTS
// Every change reaches a peer as exactly one message, and nothing ever asked
// afterwards whether it arrived. A push the hub never received is not resent
// until the folder changes again; a forward a peer never received is repeated
// only by the hub's heartbeat, which the connector drops as a duplicate or
// delivers as "not newest". Lose one message and the network sits on two
// states for good — and nothing says so.
//
// WHAT THIS DOES
// The hub's heartbeat carries the state the hub holds and, since
// `@rljson/server` 0.0.67, what that state descends from. A tree ref is a
// content hash of the whole folder, so comparing it with our own IS the
// per-folder checksum comparison: equal refs cost one string compare. When they
// differ, and keep differing for a grace period while nothing else is in
// flight, the history decides which side is behind:
//
//   push   The hub holds an earlier announcement of OURS, or the state we
//          applied before our own later push. It missed that push:
//          re-announce, as a descendant of what the hub holds.
//   pull   The hub's state descends from the one we are in. We missed it:
//          apply it under the ordinary rules, with its ancestry, so a
//          deletion it carries is applied as a deletion.
//   merge  Neither can be shown. Apply the hub's state under the ordinary
//          rules; if that makes no progress, apply it additively, so both
//          sides end up holding the union and the next round pushes it.
//
// WHY NOT THE HASH ALONE
// A tree ref is a content hash, so "a ref I have held" does not say who is
// behind. Two cases have exactly the same shape in refs and ancestry:
//
//   B deletes the file A created    hub = S0 (made from S1), A is at S1
//   A deletes its own file, and     hub = S1 (made from S0), A is at S0 —
//   that push is lost                 the SAME S0, re-derived by the deletion
//
// The first must be pulled, the second pushed, and getting either wrong puts
// the deleted file back. What differs is WHO produced the hub's state, and the
// heartbeat says so (`o`): a hub holding an earlier push of ours, while we sit
// on a later one, has missed the later one. That is why `push` is decided
// before `pull`, and why it asks for the origin rather than the history.
//
// NOT COPIED FROM THE MONGO ANTI-ENTROPY
// That one is driven by noticing a PEER's root, so a node that receives
// nothing never starts it (`KNOWN-WEAKNESSES` §10), and it applies a peer's
// tombstone without any recency check (§11). Here the trigger is the hub's own
// periodic announcement, and every destructive step goes through the ordinary
// apply with its ancestry and mass-delete rules — this module never deletes
// anything itself.
// .............................................................................

/** Tuning for {@link FsAntiEntropy}. */
export interface AntiEntropyOptions {
  /** Whether divergence is repaired at all. Default: true. */
  enabled?: boolean;
  /**
   * How long one divergence must persist before it is repaired, in ms.
   *
   * Live traffic produces short divergences constantly — a push in flight is
   * one. Only a divergence that outlives it is a lost message. Default: 10 000.
   */
  graceMs?: number;
  /**
   * Upper bound of the backoff between repeated repairs of the SAME
   * divergence, in ms. Each attempt doubles the wait from `graceMs`, so a
   * repair that cannot succeed (a refusal, an unreachable blob) costs a
   * message every few minutes rather than one per heartbeat. Default: 300 000.
   */
  maxBackoffMs?: number;
}

/** Defaults for {@link AntiEntropyOptions}. */
export const DEFAULT_ANTI_ENTROPY: Required<AntiEntropyOptions> = {
  enabled: true,
  graceMs: 10_000,
  maxBackoffMs: 300_000,
};

/** What a repair does. See the header of this file. */
export type AntiEntropyAction = 'pull' | 'push' | 'merge';

/** What {@link antiEntropyDecision} concluded. */
export type AntiEntropyDecision = 'in-sync' | 'unknown' | AntiEntropyAction;

/** The part of an agent's state the decision reads. */
export interface AntiEntropyView {
  /** The origin this agent's connector announces under. */
  origin: string;
  /** The state the folder is in. */
  currentRef: string | undefined;
  /** The incoming state most recently applied. */
  lastAppliedRef: string | undefined;
  /**
   * The state this agent last pushed as its OWN work.
   *
   * Only such a state may be re-announced. An apply can leave the folder
   * short of the tree it applied — a node still catching up — and announcing
   * that is how a burst turns into a rollback.
   */
  lastPushedRef: string | undefined;
}

/** A hub announcement, as the heartbeat carries it. */
export interface HubAnnouncement {
  /** The state the hub holds. */
  ref: string;
  /** Who produced that state. */
  origin?: string;
  /** What that state declares it descends from. */
  predecessors?: readonly string[];
}

/**
 * Decides who is behind, from the hub's announcement and our own state.
 * @param hub - What the hub announced.
 * @param view - This agent's state.
 * @returns What to do about it.
 */
export function antiEntropyDecision(
  hub: HubAnnouncement,
  view: AntiEntropyView,
): AntiEntropyDecision {
  const { origin, currentRef, lastAppliedRef, lastPushedRef } = view;
  const predecessors = hub.predecessors ?? [];

  // A folder that has not settled on a state yet has nothing to compare.
  if (!currentRef) return 'unknown';
  if (hub.ref === currentRef) return 'in-sync';

  // Only a state this agent AUTHORED may be re-announced (see
  // `lastPushedRef`).
  const authored = currentRef === lastPushedRef;

  // The hub holds an earlier push of OURS: it missed the later one. The
  // origin is the one fact a returning hash cannot fake, so this goes first.
  if (authored && hub.origin === origin) return 'push';

  // The hub's state was made FROM ours: we are the one behind.
  const statesIAmIn = [currentRef, lastAppliedRef];
  if (predecessors.some((r) => statesIAmIn.includes(r))) return 'pull';

  // The hub still holds the state our push was made from. Only after the
  // ancestry check: a peer that deletes what we added returns the folder to
  // exactly that state — the same hash, but made FROM ours, and pushing over
  // it would put the deleted file back. Measured: under load, a node that had
  // adopted the seed state re-pushed a peer's deletion away on all three.
  if (authored && hub.ref === lastAppliedRef) return 'push';

  return 'merge';
}

/** What {@link FsAntiEntropy} can report about itself. */
export interface AntiEntropyStatus {
  /** Whether the last announcement differed from our state. */
  diverged: boolean;
  /** Since when the current divergence has lasted, epoch ms. */
  divergedSince: number | null;
  /** The state the hub last announced. */
  hubRef: string | null;
  /** Our state at that moment. */
  localRef: string | null;
  /** How many repairs were started over this agent's lifetime. */
  repairs: number;
  /** The most recent repair. */
  lastRepair: {
    action: AntiEntropyAction;
    at: number;
    hubRef: string;
    localRef: string;
    attempt: number;
  } | null;
}

/** What {@link FsAntiEntropy} needs from the agent it runs in. */
export interface AntiEntropyDeps {
  /** This agent's state, read fresh at every announcement. */
  view: () => AntiEntropyView;
  /**
   * Whether anything is already applying or queued — a repair then waits.
   * @param hubRef - The state the hub is announcing right now.
   */
  busy: (hubRef: string) => boolean;
  /**
   * Starts a repair.
   * @param action - What to do.
   * @param hubRef - The state the hub announced.
   * @param hubPredecessors - What that state descends from.
   * @param attempt - 1 for the first repair of this divergence, then 2, 3, …
   */
  repair: (
    action: AntiEntropyAction,
    hubRef: string,
    hubPredecessors: string[],
    attempt: number,
  ) => void;
  /** Clock, for tests. */
  now?: () => number;
  /** Log sink. */
  log?: (message: string) => void;
}

/**
 * Notices a divergence between this agent and the hub, and repairs it.
 *
 * Fed with every hub announcement; decides nothing on the first sighting of a
 * divergence, only once the same one has lasted {@link AntiEntropyOptions.graceMs}.
 */
export class FsAntiEntropy {
  private readonly _options: Required<AntiEntropyOptions>;
  private readonly _now: () => number;
  private readonly _log: (message: string) => void;

  /** Identifies the divergence being watched: hub state + our state. */
  private _key: string | null = null;
  private _divergedSince: number | null = null;
  /** Earliest moment the next repair of {@link _key} may start. */
  private _nextRepairAt = 0;
  /** Repairs started for {@link _key}. */
  private _attempts = 0;

  private _hubRef: string | null = null;
  private _localRef: string | null = null;
  private _repairs = 0;
  private _lastRepair: AntiEntropyStatus['lastRepair'] = null;

  constructor(
    options: AntiEntropyOptions | undefined,
    private readonly _deps: AntiEntropyDeps,
  ) {
    this._options = { ...DEFAULT_ANTI_ENTROPY, ...options };
    this._now = _deps.now ?? Date.now;
    this._log = _deps.log ?? ((m) => console.warn(m));
  }

  /** Whether repairs are switched on. */
  get enabled(): boolean {
    return this._options.enabled;
  }

  /** A snapshot of what this instance has seen and done. */
  get status(): AntiEntropyStatus {
    return {
      diverged: this._divergedSince !== null,
      divergedSince: this._divergedSince,
      hubRef: this._hubRef,
      localRef: this._localRef,
      repairs: this._repairs,
      lastRepair: this._lastRepair ? { ...this._lastRepair } : null,
    };
  }

  /**
   * Takes one hub announcement into account.
   * @param hub - What the hub announced.
   */
  observe(hub: HubAnnouncement): void {
    const view = this._deps.view();
    const decision = antiEntropyDecision(hub, view);
    if (decision === 'unknown') return;
    const hubRef = hub.ref;
    const hubPredecessors = hub.predecessors ?? [];

    this._hubRef = hubRef;
    this._localRef = view.currentRef as string;

    if (decision === 'in-sync') {
      this._key = null;
      this._divergedSince = null;
      this._attempts = 0;
      return;
    }

    const now = this._now();
    const key = `${hubRef}|${view.currentRef}`;
    if (key !== this._key) {
      // A new divergence. Live traffic makes these all the time; only one
      // that is still here after the grace period is a lost message.
      this._key = key;
      this._divergedSince ??= now;
      this._attempts = 0;
      this._nextRepairAt = now + this._options.graceMs;
      return;
    }

    if (!this._options.enabled) return;
    if (now < this._nextRepairAt) return;
    if (this._deps.busy(hubRef)) return;

    this._attempts++;
    const backoff = Math.min(
      this._options.graceMs * 2 ** (this._attempts - 1),
      this._options.maxBackoffMs,
    );
    this._nextRepairAt = now + backoff;

    this._log(
      `[FsAgent] anti-entropy: hub=${hubRef.slice(0, 8)}… ` +
        `local=${(view.currentRef as string).slice(0, 8)}… diverged for ` +
        `${Math.round((now - (this._divergedSince as number)) / 1000)}s — ` +
        `${decision} (attempt ${this._attempts})`,
    );
    this._repairs++;
    this._lastRepair = {
      action: decision,
      at: now,
      hubRef,
      localRef: view.currentRef as string,
      attempt: this._attempts,
    };
    this._deps.repair(decision, hubRef, [...hubPredecessors], this._attempts);
  }
}
