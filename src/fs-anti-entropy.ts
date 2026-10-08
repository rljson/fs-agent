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
// The hub announces the state it holds — on the STATE BEACON
// (`@rljson/server` `stateBeaconMs`, event `${route}:state`), which the
// connector never processes, or on the bootstrap heartbeat — and, since
// `@rljson/server` 0.0.67, what that state descends from. A tree ref is a
// content hash of the whole folder, so comparing it with our own IS the
// per-folder checksum comparison: equal refs cost one string compare. When they
// differ, and keep differing — our own state unchanged — for a grace period
// while nothing else is in
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
// nothing never starts it, and it applies a peer's tombstone without any
// recency check. Here the trigger is the hub's own
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

/**
 * How many content-equivalence verdicts one agent remembers.
 *
 * Keyed on refs a PEER chooses, so it is bounded: a hub whose state changes
 * constantly must not grow this without limit. Large enough that a rollout
 * window's worth of old-build refs all fit.
 */
export const CONTENT_AGREED_MAX = 256;

/** Defaults for {@link AntiEntropyOptions}. */
export const DEFAULT_ANTI_ENTROPY: Required<AntiEntropyOptions> = {
  enabled: true,
  graceMs: 10_000,
  maxBackoffMs: 300_000,
};

/** What a repair does. See the header of this file. */
export type AntiEntropyAction = 'pull' | 'push' | 'merge';

/**
 * What {@link antiEntropyDecision} concluded.
 *
 * `blocked` means the ancestry could not be resolved far enough to decide.
 * Nothing is applied, nothing is latched, and the divergence is retried — the
 * one answer the old signature could not give, because it had nothing to be
 * unsure about.
 */
export type AntiEntropyDecision =
  | 'in-sync'
  | 'unknown'
  | 'blocked'
  | AntiEntropyAction;

/**
 * Where this node's history stands against the hub's, when the chain can say.
 *
 * `behind` — the hub's head descends from ours; we are missing its work.
 * `ahead` — ours descends from the hub's; IT is missing ours.
 * `fork` — neither descends from the other. Both sides have work to keep.
 * `incomplete` — a walk was truncated, so nothing may be concluded.
 */
export type Reachability = 'behind' | 'ahead' | 'fork' | 'incomplete';

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
  /**
   * What the edit chain says about the two histories, when it can say.
   *
   * **This is the field the whole protocol change exists to provide.** Without
   * it the decision has a ref and ONE generation of ancestry, and the two
   * situations that need opposite actions — "a peer deleted what we added" and
   * "a peer forked from an ancestor we share" — arrive at that signature as the
   * SAME VALUE. No rule
   * can separate them, which is why narrowing one was tried twice and cost a
   * discarded folder the first time and a livelock the second.
   *
   * Absent means the chain could not be consulted — an older peer, a node
   * whose chain failed to initialise — and the decision falls back to the
   * heuristics below, which are what shipped before. Absence must never read
   * as `fork`.
   */
  reachability?: Reachability;
}

/**
 * Decides who is behind, from the hub's announcement and our own state.
 * @param hub - What the hub announced.
 * @param view - This agent's state.
 * @param attempt - 1 for the first repair of this divergence, then 2, 3, …
 *   A single push is not a livelock; a repeated one is, and only the repeat
 *   concedes. Default 1, which is what every existing caller had.
 * @returns What to do about it.
 */
export function antiEntropyDecision(
  hub: HubAnnouncement,
  view: AntiEntropyView,
  attempt = 1,
): AntiEntropyDecision {
  const { origin, currentRef, lastAppliedRef, lastPushedRef } = view;
  const predecessors = hub.predecessors ?? [];

  // A folder that has not settled on a state yet has nothing to compare.
  if (!currentRef) return 'unknown';
  if (hub.ref === currentRef) return 'in-sync';

  // THE CHAIN ANSWERS FIRST, when it can answer at all.
  //
  // Everything below this block is inference from a content hash and one
  // generation of ancestry, and that cannot be made correct: the two situations
  // that need opposite actions arrive here as the same value. Reachability is not a better heuristic, it is the missing
  // fact — and where it is present, no heuristic may overrule it.
  //
  // `ahead` does NOT require `lastPushedRef` to match. That condition exists
  // only because, without a chain, "a state I authored" was the closest
  // available stand-in for "a state the other side does not have yet" — and it
  // is a bad one: a node that ADOPTED a peer's tree and then deleted a file
  // authors nothing, so it could never re-announce the deletion and the delete
  // never propagated. Reachability proves the same thing properly, whoever
  // authored it.
  switch (hub.reachability) {
    case 'behind':
      return 'pull';
    case 'ahead':
      return 'push';
    case 'fork':
      return 'merge';
    case 'incomplete':
      // Not a fork, and not in-sync: an answer this node cannot give. Acting
      // on a truncated walk is how a node decides it is ahead of a peer it is
      // actually behind.
      return 'blocked';
    default:
      break;
  }

  // Only a state this agent AUTHORED may be re-announced (see
  // `lastPushedRef`).
  const authored = currentRef === lastPushedRef;

  // The hub holds an earlier push of OURS: it missed the later one. The
  // origin is the one fact a returning hash cannot fake, so this goes first.
  if (authored && hub.origin === origin) return 'push';

  // The hub's state was made FROM ours: we are the one behind.
  //
  // **`lastAppliedRef` is NOT counted once we have authored something since**,
  // and that narrowing is 0.0.84's — the change that fixed a fork being read as
  // a lag, and was reverted the same afternoon for causing a livelock.
  //
  // The reasoning was always right: a state we have built on is behind us, so
  // a hub state descending from it is a sibling of our work, not a successor
  // to it, and adopting it discards what we made. Measured on node-C as 15
  // files repeatedly replaced by the fleet's 13.
  //
  // What made it unshippable was not the narrowing but its side effect: it
  // removed the only thing making one side YIELD, and a disagreement with
  // nobody yielding is a livelock — a folder flipping between two states
  // roughly twenty times in ninety seconds, both nodes reporting `push`.
  //
  // That is a separate defect with a separate fix, below, and with the two
  // together the narrowing is safe. Enumerated over every pair this space can
  // describe (`test/fs-anti-entropy-level1.spec.ts`), not argued.
  const statesIAmIn = authored ? [currentRef] : [currentRef, lastAppliedRef];
  if (predecessors.some((r) => statesIAmIn.includes(r))) return 'pull';

  // The hub still holds the state our push was made from. Only after the
  // ancestry check: a peer that deletes what we added returns the folder to
  // exactly that state — the same hash, but made FROM ours, and pushing over
  // it would put the deleted file back. Measured: under load, a node that had
  // adopted the seed state re-pushed a peer's deletion away on all three.
  //
  // The hub holds the state our push was made from, so re-announce it — but
  // **not for ever**.
  //
  // This rule is symmetric by construction: two nodes that have each applied
  // the other's current state and then authored their own BOTH match it, both
  // push, and neither yields. That is the 2-of-576 pair the enumeration found
  // still reachable after the 0.0.85 revert, so the livelock was never closed,
  // only made harder to reach — and when it is reached it costs 90 seconds of
  // a production folder rewriting itself.
  //
  // A SINGLE push is not a livelock, and the first attempt is what the
  // measurements are about: "a peer that deletes what we added returns the
  // folder to exactly that state … pushing over it would put the deleted file
  // back" is a statement about pushing ONCE, correctly. Attempt 1 therefore
  // keeps exactly the behaviour that was measured.
  //
  // A REPEAT is different. If the same divergence is still here on a later
  // attempt the push did not work, and repeating it IS the livelock. Then the
  // ORIGIN breaks the tie: both sides can compare it and both compare it the
  // same way, so the smaller pushes and the larger yields to a merge. No
  // coordination, no extra message, and no pair able to both assert
  // indefinitely. Where the hub declares no origin there is nothing to break
  // the tie with and the old behaviour stands, so a deployment without client
  // identity keeps what it had.
  //
  // The same shape as the `merge` repair, which tries the ordinary rules first
  // and drops the ancestry only once that made no progress: optimistic once,
  // then conceding.
  if (authored && hub.ref === lastAppliedRef) {
    const yieldToThem =
      attempt > 1 && hub.origin !== undefined && hub.origin < origin;
    return yieldToThem ? 'merge' : 'push';
  }

  return 'merge';
}

// .............................................................................
// `senderSawMyState` and `PruneAuthorityView` lived here, and they are gone.
//
// They answered *"may this incoming push PRUNE my files?"* — the second
// decision site, from the same insufficient inputs as the first: a declared
// predecessor ref, a flag for whether the transport carried ancestry at all,
// and two names for one state because *"mtimes do not always survive a restore
// byte for byte, and on Windows they regularly do not"*.
//
// **That last reason stopped being true.** Since mtime left the content
// identity a receiver's re-scan of applied content derives the same ref the
// sender announced — which is what makes a receiver able to ADOPT the
// sender's chain entry at all. One state, one name.
//
// And the question itself is gone with them: nothing prunes on absence any
// more. A deletion is STATED in the chain by the node that performed it, so
// there is no inference left to authorise. See `RestoreOptions.cleanTarget`.
// .............................................................................

/** What {@link FsAntiEntropy} can report about itself. */
export interface AntiEntropyStatus {
  /** Whether the last announcement differed from our state. */
  diverged: boolean;
  /** Since when the current divergence has lasted, epoch ms. */
  divergedSince: number | null;
  /** The state the hub last announced. */
  hubRef: string | null;
  /**
   * The state this node is in **now**, not the one it was in when it last
   * compared.
   *
   * It used to be the latter, and the two read identically in a quiet fleet and
   * differently in exactly the case somebody is debugging. A node that moves
   * after the last announcement it processed kept reporting the ref it had then,
   * so `hubRef === localRef` with {@link diverged} false was indistinguishable
   * from genuinely being in sync — and a churn run on CI showed four nodes
   * reporting precisely that while two of them held different bytes for one
   * path. Read live, the pair says what it is: the hub announced X, I am at Y,
   * and {@link diverged} is the verdict of the last comparison rather than of
   * this instant.
   */
  localRef: string | null;
  /**
   * The paths this node and the hub actually disagree about, when that has
   * been established.
   *
   * The register: *"als Statusinfo bleibt: die Prüfsummen sind
   * verschieden"* — which tells
   * an operator nothing they can act on, and tells a user nothing at all. The
   * content comparison that decides {@link diverged} already knows the answer
   * per PATH, so the answer is kept rather than reduced to a boolean.
   *
   * Empty when the two agree, and empty when nothing has compared them yet —
   * which {@link diverged} distinguishes.
   */
  differingPaths: readonly string[];
  /** How many repairs were started over this agent's lifetime. */
  repairs: number;
  /**
   * The most recent repair, or the most recent refusal to attempt one.
   *
   * `action: 'blocked'` means the ancestry could not be resolved far enough to
   * decide; nothing was done and nothing was latched. It is not counted in
   * {@link repairs}, because nothing was repaired.
   */
  lastRepair: {
    action: AntiEntropyAction | 'blocked';
    at: number;
    hubRef: string;
    localRef: string;
    attempt: number;
  } | null;
}

/** What {@link FsAntiEntropy} needs from the agent it runs in. */
/** What a content comparison concluded. See {@link AntiEntropyDeps.sameContent}. */
export interface ContentComparison {
  /** Whether the two folders hold the same content. */
  same: boolean;
  /**
   * The paths they disagree about — on either side, so a path only one of them
   * holds is listed too.
   *
   * Reported even when {@link same} is true, in which case it is empty.
   */
  differing: readonly string[];
}

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
  /**
   * Whether a hub ref describes the same CONTENT as this folder.
   *
   * **This is what stops a divergence being reported on a difference of
   * fingerprints alone.** The decision above compares refs, which is all a
   * state beacon carries — and a beacon, unlike a ref event, triggers no
   * apply, so nothing else in the agent ever fetches that tree and nothing
   * ever discovers that the two folders are identical. measured on a real fleet:
   * `diverged: true` for over EIGHT MINUTES on a node holding exactly the
   * hub's 38 files.
   *
   * Costs one tree fetch per hub ref first seen as a divergence, and the
   * verdict is cached in {@link _contentAgreed}, so a repeating beacon costs
   * nothing. Optional, because a host that cannot answer is no worse off than
   * before: the repair still runs and a bucket round still settles it.
   * @param ref - The hub's ref.
   */
  sameContent?: (ref: string) => Promise<ContentComparison>;
  /** Clock, for tests. */
  now?: () => number;
  /** Log sink. */
  log?: (message: string) => void;
}

/**
 * Notices a divergence between this agent and the hub, and repairs it.
 *
 * Fed with every hub announcement; decides nothing while this node's own state
 * is still moving, only once it has sat still and out of step with the hub for
 * {@link AntiEntropyOptions.graceMs} — however often the hub's state changed
 * meanwhile.
 */
export class FsAntiEntropy {
  private readonly _options: Required<AntiEntropyOptions>;
  private readonly _now: () => number;
  private readonly _log: (message: string) => void;

  /**
   * Identifies the divergence being watched: OUR state, and only ours.
   *
   * It used to include the hub's state, so every change on the hub restarted
   * the grace period — and a node that missed every forward while another
   * machine wrote every few seconds never got a repair at all, showing "weicht
   * ab, noch kein Reparaturversuch" for good (review, an earlier change). What makes a
   * divergence a lost message is that THIS node is not moving: a node keeping
   * up with the traffic changes its own state with every forward it applies.
   * Which hub state the repair answers is read from the latest announcement.
   */
  private _key: string | null = null;
  private _divergedSince: number | null = null;
  /** Earliest moment the next repair of {@link _key} may start. */
  private _nextRepairAt = 0;
  /** Repairs started for {@link _key}. */
  private _attempts = 0;

  /**
   * Hub refs proven to describe the same CONTENT as this folder.
   *
   * A tree ref is a hash of the whole tree, and two nodes can derive different
   * ones for byte-identical content — the order a filesystem lists a directory
   * in used to be enough, and during a rollout a node on an older build still
   * derives the old ref. measured on a real fleet: both machines held 38 identical
   * files with identical hashes and one reported `diverged: true` for over
   * EIGHT MINUTES across six merge repairs, logging "equivalent content,
   * skipping restore" every time. The apply path correctly saw nothing to
   * transfer; the anti-entropy correctly saw two refs; neither was wrong.
   *
   * A bucket round settles it: if the per-bucket roots agree, the two folders
   * ARE the same, whatever either calls itself. That verdict is recorded here
   * so the divergence stops being reported instead of being rediscovered every
   * beacon — and so a mixed-version fleet does not spend its rollout window
   * showing red.
   *
   * **KNOWN UNSOUND, AND THE PAIR KEY HAS NOW BEEN TRIED TWICE.** Do not fix
   * this in isolation; read the whole note first.
   *
   * What a bucket round proves is "the hub's ref X describes the same content
   * as the state I am in" — a statement about TWO sides, true only while
   * neither moves. Keyed on X alone it survives this node changing underneath
   * it, so a later announcement of X clears the divergence with no content
   * check at all, for ever.
   *
   * Measured twice, and the second measurement is the one that matters.
   * First as contradictory health signals: all four nodes of a churn run
   * reporting `diverged=false` while their own `differingPaths` named
   * `two.txt`. Then as what that costs, in the churn fuzzer at seed 2:
   *
   *   A: 11 files  diverged=false  hub=goDX1oLq  local=kderYtfA  differing=[]
   *   B: 10 files  diverged=false  hub=goDX1oLq  local=goDX1oLq  differing=[sub/three.txt]
   *
   * B had deleted `sub/three.txt`, nobody re-created it, and A, C and D all
   * held it while reporting no divergence — so none of them ever repaired. The
   * fleet does not merely MISREPORT under this memo; the repair is gated on
   * the signal it falsifies, so **the fleet does not heal.** That is worse
   * than the note here used to claim, and it is why this will have to be
   * fixed rather than tolerated.
   *
   * WHY THE PAIR KEY STILL DOES NOT WORK. The note here used to say it must
   * wait "until the repair can tell 'I am ahead' from 'I am behind' without a
   * chain verdict", and that reads as though a chain verdict were the only
   * missing piece. It is not sufficient. `antiEntropyDecision` does switch on
   * `hub.reachability` before any heuristic — `ahead` answers `push` — and the
   * second attempt still took `I7b` to 0 of 8.
   *
   * Two inputs were found and fixed on the way, and NEITHER was enough:
   *
   *  - bucket-sync envelopes were reaching `observe` as if they were states
   *    (`hub=~BR~{"r"…`), so the folder looked permanently diverged and the
   *    decision came from heuristics on a JSON envelope. Fixed in
   *    `fs-agent.ts` — the note here had already claimed this was fixed
   *    elsewhere, which was wrong;
   *  - a bare hub beacon was observed with no reachability at all, so the
   *    heuristics decided `pull` for a node that was ahead
   *    (`hub=hd3PHz1r… local=_esQ4A0L… — pull`). Now resolved through the
   *    chain and offered as a second observation.
   *
   * THE DEFECT UNDERNEATH IS A LIVELOCK, AND IT HAS ONE ROOT CAUSE. Traced by
   * removing the masks one at a time and then logging the decision inputs:
   *
   *   anti-entropy: hub=_esQ4A0L… local=hd3PHz1r… diverged for 89s — pull (attempt 44)
   *
   * Forty-four attempts over eighty-nine seconds, and every one of them with
   * `reachability` UNDEFINED. With no verdict the switch above falls through
   * and the heuristic answers `pull` for a divergence it cannot close, for
   * ever — the same unbounded retry `@rljson/mongo-agent` bounded in 0.0.52.
   *
   * So the chain never decides here, not because the decision ignores it but
   * because the verdict does not arrive: resolving the announced state is a
   * read, and on this path it still takes the full ten seconds
   * (`Timeout after 10000ms: … resolveAnnouncement`). A verdict that arrives
   * late is indistinguishable from no verdict.
   *
   * THE ORDER THAT FOLLOWS, and it is not "fix the memo":
   *
   *  1. make the reachability read return on the anti-entropy path;
   *  2. then the switch above answers from the chain and the livelock stops;
   *  3. then both masks come off together — this key, and the envelope filter;
   *  4. the memo is one line at the end of that, exactly as the convergence
   *     contract has said all along.
   *
   * The masks, found while attempting step 4 first:
   *
   *   memo pair key applied, both fixes in    I7b 0 of 8
   *   memo reverted, both fixes in            I7b 0 of 6
   *   memo reverted, second observe removed   I7b 0 of 3
   *   memo reverted, envelope filter removed  I7b 3 of 3
   *
   * Dropping bucket envelopes from `observe` is correct in principle — an
   * envelope names no tree — and it BREAKS `I7b` on its own, because the
   * spurious divergence those envelopes produce is what keeps the tracked hub
   * state moving so the livelock above never persists long enough to run.
   *
   * Both masks are therefore load-bearing today, and neither may be removed
   * before step 1. That is why the pair key failed twice with a different
   * explanation each time.
   *
   * The code already knew the rule and applied it to one side only: a `no` is
   * deliberately never cached, because *"caching a `no` would have to be
   * invalidated the moment either side changes"*. A `yes` needs exactly the
   * same invalidation, and the pair key is what provides it — once the repair
   * behind it is safe.
   *
   * Bounded, because it is keyed on refs a peer chooses: a hub that changes
   * state constantly must not grow this without limit.
   */
  private readonly _contentAgreed = new Set<string>();

  /**
   * The memo key: what the hub announced AND the state this node was in.
   * @param hubRef - The ref the hub announced.
   * @param localRef - The state this node is in, read fresh from `view`.
   * @returns A key no other pair can spell.
   */
  private static _agreementKey(
    hubRef: string,
    localRef: string | undefined,
  ): string {
    return `${hubRef}\u0000${localRef ?? ''}`;
  }



  /**
   * Hub refs a content check is already running for.
   *
   * A beacon repeats, and a second fetch of a tree the first fetch is already
   * reading answers the same question at twice the cost.
   */
  private readonly _contentChecking = new Set<string>();

  /** See {@link AntiEntropyStatus.differingPaths}. */
  private _differingPaths: readonly string[] = [];

  private _hubRef: string | null = null;
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

  /**
   * Asks whether a hub ref describes this folder's content, and records a
   * `yes`.
   *
   * Fire and forget: the answer arrives after this announcement is done with,
   * and clears the divergence then. A `no` is not recorded — content really
   * differing is what the repair is for, and caching a `no` would have to be
   * invalidated the moment either side changes.
   * @param ref - The hub ref under consideration.
   */
  private _checkContent(ref: string): void {
    if (!this._deps.sameContent) return;
    const key = FsAntiEntropy._agreementKey(
      ref,
      this._deps.view().currentRef,
    );
    if (this._contentAgreed.has(key) || this._contentChecking.has(ref)) {
      return;
    }
    this._contentChecking.add(ref);
    void this._deps
      .sameContent(ref)
      .then((verdict) => {
        this._differingPaths = verdict.differing;
        if (verdict.same) this.agreedOn(ref);
      })
      .catch(() => {
        // Unreachable tree, timeout, a peer gone. The repair path handles it;
        // this was only ever an opportunity to avoid one.
      })
      .finally(() => {
        this._contentChecking.delete(ref);
      });
  }

  /**
   * Records that a hub ref describes the same content as this folder.
   *
   * Called when a bucket round finds the per-bucket roots identical. See
   * {@link _contentAgreed}.
   * @param ref - The hub ref that was compared.
   */
  agreedOn(ref: string): void {
    this._contentAgreed.add(
      FsAntiEntropy._agreementKey(ref, this._deps.view().currentRef),
    );
    // Agreement means there is nothing to list, and a stale list is worse than
    // none: it is what a UI shows somebody.
    this._differingPaths = [];
    // Oldest out first. A `Set` keeps insertion order, and the oldest verdict
    // is the one least likely to be asked about again.
    while (this._contentAgreed.size > CONTENT_AGREED_MAX) {
      const oldest = this._contentAgreed.values().next().value as string;
      this._contentAgreed.delete(oldest);
    }
    if (this._hubRef === ref) {
      // Resolve the divergence being watched right now, rather than waiting
      // for the next announcement to notice.
      this._key = null;
      this._divergedSince = null;
      this._attempts = 0;
    }
  }

  /** Whether repairs are switched on. */
  get enabled(): boolean {
    return this._options.enabled;
  }

  /**
   * A snapshot of what this instance has seen and done.
   *
   * `localRef` is read from `view` here rather than from a remembered field,
   * because this node's own state is the one fact that is always available and
   * never needs remembering — see {@link AntiEntropyStatus.localRef}. The field
   * that held it is gone rather than left unread.
   */
  get status(): AntiEntropyStatus {
    return {
      differingPaths: this._differingPaths,
      diverged: this._divergedSince !== null,
      divergedSince: this._divergedSince,
      hubRef: this._hubRef,
      localRef: (this._deps.view().currentRef as string | undefined) ?? null,
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
    // `_attempts` counts repairs already made for this divergence, so the
    // decision is asked about the attempt it is about to become.
    const decision = antiEntropyDecision(hub, view, this._attempts + 1);
    if (decision === 'unknown') return;
    const hubRef = hub.ref;
    const hubPredecessors = hub.predecessors ?? [];

    this._hubRef = hubRef;

    // A ref already proven content-equivalent is not a divergence, however
    // different the two hashes look. (`unknown` has already returned above.)
    if (
      this._contentAgreed.has(
        FsAntiEntropy._agreementKey(hubRef, view.currentRef),
      )
    ) {
      this._key = null;
      this._divergedSince = null;
      this._attempts = 0;
      return;
    }

    if (decision === 'in-sync') {
      this._key = null;
      this._divergedSince = null;
      this._attempts = 0;
      return;
    }

    const now = this._now();
    const key = view.currentRef as string;
    if (key !== this._key) {
      // Our state moved (or this is the first sighting). A node that keeps
      // moving is keeping up; only one that sits still, out of step, for the
      // whole grace period has lost a message.
      this._key = key;
      this._divergedSince ??= now;
      this._attempts = 0;
      this._nextRepairAt = now + this._options.graceMs;
      this._checkContent(hubRef);
      return;
    }

    // Our state has not moved, but the hub's may have. A ref never asked
    // about is one this node could still be agreeing with.
    this._checkContent(hubRef);

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
    this._lastRepair = {
      action: decision,
      at: now,
      hubRef,
      localRef: view.currentRef as string,
      attempt: this._attempts,
    };

    // `blocked` is REPORTED and not repaired.
    //
    // The ancestry could not be resolved far enough to say who is behind, and
    // every action available here is destructive in one direction or the
    // other. So the divergence stays open, the backoff keeps growing, and the
    // next announcement tries again — by which time the missing rows may have
    // arrived. It is counted out of `repairs` because nothing was repaired,
    // and it is visible in `lastRepair.action` because a node stuck this way
    // must be diagnosable.
    if (decision === 'blocked') return;

    this._repairs++;
    this._deps.repair(decision, hubRef, [...hubPredecessors], this._attempts);
  }
}
