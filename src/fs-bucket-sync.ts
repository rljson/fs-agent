// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// The bucket-sync protocol: four messages that turn a disagreement into a list
// of files to fetch and a list to drop.
//
// WHY THIS IS A PROTOCOL AND NOT A FUNCTION
// `src/fs-manifest.ts` can compare two manifests. The two manifests are on
// different machines, so comparing them means a conversation — and the point of
// the conversation is that it NEVER sends a whole manifest. Roots first, then
// the entries of only the buckets whose roots differed.
//
// NO NEW SOCKETS, NO NEW ROUTES
// Every message travels on the existing ref channel, prefixed, exactly as
// `@rljson/mongo-agent` does it: *"distinguished from collection names because
// a CARAT collection name never starts with `~`"*. A tree ref is a content hash
// and never starts with `~` either, so the ref channel carries both without
// ambiguity. This is also how the chain head travels (`~H~`), so the trick is
// already load-bearing here.
//
// FOUR KINDS, NOT MONGO'S SIX
// Mongo needs `AEW`/`AEH` because a document body has to be requested and
// returned. An fs entry is `path → blobId`, and a blob is already
// content-addressed and already fetchable over the existing path. So a node
// that knows the peer's entries can fetch the bodies itself.
//
//   ~BQ~  → ask for the peer's bucket roots
//   ~BR~  ← the roots, non-empty buckets only
//   ~BG~  → ask for the entries of these buckets
//   ~BE~  ← the entries of those buckets
//
// PULL, NOT PUSH, AND THE REASON IS MEASURED
// Mongo's header records what happens otherwise: broadcasting bodies made *"a
// 453 MB backfill balloon the hub to 3.4 GB and crash it"*, because the hub
// relays a copy to every peer. Nothing here sends file content. The heaviest
// message is a list of paths, and the bodies move over the request/response
// blob path that already exists and is already flow-controlled.
//
// IT IS DRIVEN, NOT AUTONOMOUS
// This module decides what to say and what a reply means. It never touches a
// folder, never reads a socket, and never deletes anything: a host supplies the
// manifest and performs the plan. That is what makes it testable against a stub
// with no sockets, no folders and no peers — and it is why the destructive half
// stays where the mass-delete guard can see it.
// .............................................................................

import {
  bucketOf,
  bucketRoots,
  differingBuckets,
  entriesInBuckets,
  reconcile,
  type BucketRoots,
  type ManifestEntry,
  type ReconcilePlan,
} from './fs-manifest.ts';

/** Ask for the peer's bucket roots. Body: nothing. */
export const BQ = '~BQ~';
/** The roots. Body: `bucket:root` pairs. */
export const BR = '~BR~';
/** Ask for the entries of listed buckets. Body: bucket indices. */
export const BG = '~BG~';
/** The entries. Body: `path:blobId` pairs. */
export const BE = '~BE~';

/** Every prefix this protocol owns. */
export const BUCKET_SYNC_PREFIXES = [BQ, BR, BG, BE] as const;

// EVERY MESSAGE CARRIES A ROUND ID, and it is not decoration.
//
// `@rljson/db`'s `Connector` dedups by ref on BOTH sides, and a protocol
// message is the same string every time it is sent — `~BQ~` asking for roots is
// byte-identical on every round. Marked received once, every later copy is
// dropped, and the second reconciliation a node ever attempts goes unanswered
// for the rest of the session. Mongo sidesteps this with an `emitRaw` that
// bypasses dedup; this `Connector` has no such method, so the messages are made
// UNIQUE instead.
//
// It buys a second thing worth having: a reply can be matched to its request,
// so a late answer from an abandoned round is recognisable rather than merely
// surprising.
//
// The body is JSON, deliberately.
//
// Mongo separates its fields with `|`, on the grounds that the character cannot
// appear in a collection name. A relative PATH has no such guarantee: on a
// POSIX filesystem a filename may contain ANY byte except `/` and NUL —
// pipes, tabs, newlines and control characters included. So no delimiter is
// safe without escaping, and an escaping bug in a message that carries
// DELETIONS is the expensive kind.
//
// JSON costs a few bytes per entry, and the heaviest message here is a list of
// paths, so the trade is easy. It also makes a malformed body throw at the
// parse rather than decode silently into the wrong paths.

/** A decoded message: which round it belongs to, and its payload. */
interface Envelope<T> {
  r: number;
  d: T;
}

/**
 * Wraps a payload in its round.
 * @param prefix - The message kind.
 * @param round - The round id.
 * @param payload - What to carry.
 * @returns A ref.
 */
const envelope = <T>(prefix: string, round: number, payload: T): string =>
  prefix + JSON.stringify({ r: round, d: payload });

/**
 * Unwraps a message.
 * @param prefix - The message kind.
 * @param ref - The ref.
 * @returns The round and the payload, or `undefined` for an unreadable body —
 *   which is a message from a build that speaks a different dialect, not a
 *   reason to stop syncing.
 */
const unwrap = <T>(prefix: string, ref: string): Envelope<T> | undefined => {
  const body = ref.slice(prefix.length);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body) as Envelope<T>;
  } catch {
    return undefined;
  }
};

/**
 * Whether a ref belongs to this protocol.
 * @param ref - The ref as it arrived.
 * @returns `true` when it is a bucket-sync message.
 */
export const isBucketSync = (ref: string): boolean =>
  BUCKET_SYNC_PREFIXES.some((prefix) => ref.startsWith(prefix));

/**
 * Encodes bucket roots for the wire.
 * @param round - The round this answers.
 * @param roots - The roots to send.
 * @returns A ref carrying them.
 */
export const encodeRoots = (round: number, roots: BucketRoots): string =>
  envelope(BR, round, roots);

/**
 * Decodes bucket roots.
 * @param ref - A `~BR~` ref.
 * @returns The round and roots, or `undefined` for an unreadable body. An
 *   EMPTY roots object is a real state — a node with nothing in its folder —
 *   and is not the same as an unreadable one.
 */
export const decodeRoots = (
  ref: string,
): { round: number; roots: BucketRoots } | undefined => {
  const parsed = unwrap<BucketRoots>(BR, ref);
  return parsed ? { round: parsed.r, roots: parsed.d } : undefined;
};

/**
 * Encodes a request for the peer's roots.
 * @param round - The round being started.
 * @returns A ref.
 */
export const encodeQuery = (round: number): string => envelope(BQ, round, 0);

/**
 * Decodes a request for roots.
 * @param ref - A `~BQ~` ref.
 * @returns The round, or `undefined` for an unreadable body.
 */
export const decodeQuery = (ref: string): number | undefined =>
  unwrap<number>(BQ, ref)?.r;

/**
 * Encodes a request for the entries of some buckets.
 * @param round - The round.
 * @param buckets - The bucket indices wanted.
 * @returns A ref carrying them.
 */
export const encodeWanted = (
  round: number,
  buckets: readonly number[],
): string => envelope(BG, round, buckets);

/**
 * Decodes a request for bucket entries.
 * @param ref - A `~BG~` ref.
 * @returns The round and bucket indices, or `undefined`.
 */
export const decodeWanted = (
  ref: string,
): { round: number; buckets: number[] } | undefined => {
  const parsed = unwrap<number[]>(BG, ref);
  return parsed ? { round: parsed.r, buckets: parsed.d } : undefined;
};

/**
 * Encodes manifest entries for the wire.
 * @param round - The round.
 * @param entries - The entries to send.
 * @returns A ref carrying them.
 */
export const encodeEntries = (
  round: number,
  entries: readonly ManifestEntry[],
): string => envelope(BE, round, entries);

/**
 * Decodes manifest entries.
 * @param ref - A `~BE~` ref.
 * @returns The round and entries, or `undefined`. A tombstone arrives as a
 *   path with an empty blob id, which is the whole point of carrying deletions
 *   this way.
 */
export const decodeEntries = (
  ref: string,
): { round: number; entries: ManifestEntry[] } | undefined => {
  const parsed = unwrap<ManifestEntry[]>(BE, ref);
  return parsed ? { round: parsed.r, entries: parsed.d } : undefined;
};

/** What {@link FsBucketSync} needs from the agent it runs in. */
export interface BucketSyncHost {
  /**
   * This folder's manifest: `path → blobId`, with every tombstoned path
   * included at {@link TOMBSTONE_BLOB}.
   *
   * A tombstone must be in here or the delete-wins half cannot work: a peer
   * would see the path simply absent, which is the ambiguity the whole design
   * removes.
   */
  manifest(): ReadonlyMap<string, string>;
  /**
   * Paths this node's own history says it EDITED.
   *
   * Travels with each entry so a same-path conflict is settled by who wrote
   * the file rather than by which content hash sorts higher. Optional: a host
   * without a chain claims nothing, and the hash rule still converges.
   */
  claimed?(): ReadonlySet<string>;

  /**
   * `path → timeId` of the newest edit this node has heard of for each path.
   *
   * Optional for the same reason {@link claimed} is: a host that cannot answer
   * leaves the entries without times, and `reconcile` falls back to the rules
   * that shipped before the field existed.
   */
  editTimes?(): ReadonlyMap<string, string>;

  /** Puts a protocol ref on the wire. */
  send(ref: string): void;
  /**
   * Performs a plan.
   *
   * Only the host may touch the folder. `drop` is destructive and must go
   * through the same mass-delete guard an ordinary prune does — the protocol
   * deliberately has no way to delete anything itself.
   */
  apply(plan: ReconcilePlan): Promise<void>;
  /**
   * Whether this node's manifest is complete enough to compare.
   *
   * Mongo calls this `ready()`, and its header says why: until a baseline is
   * complete the bucket roots are partial *"and would make a peer see spurious
   * differences"*. A node mid-cold-start must neither answer nor ask.
   */
  ready(): boolean;
  /**
   * The roots were identical: the two folders hold the same content.
   *
   * Worth telling the host, because a ref comparison cannot reach this
   * conclusion. Two nodes derive different tree refs for byte-identical
   * content whenever anything outside the content map differs — and during a
   * rollout, a node on an older build always does. Measured as eight minutes
   * of `diverged: true` on 38 identical files.
   */
  agreed?(): void;
  /** Log sink. */
  log?: (message: string) => void;
}

/**
 * One side of the bucket-sync conversation.
 *
 * Stateless between rounds except for the buckets it is waiting on, so a round
 * that is interrupted — a peer that goes away mid-exchange — costs nothing and
 * is simply started again.
 */
export class FsBucketSync {
  private readonly _log: (message: string) => void;
  /** Buckets we asked for entries of, and the round we asked in. */
  private _awaiting: { round: number; buckets: number[] } | null = null;
  /** Monotonic round ids, so no two messages from this node are identical. */
  private _round = 0;

  constructor(private readonly _host: BucketSyncHost) {
    this._log = _host.log ?? (() => {});
  }

  /** Whether a round is in flight. */
  get busy(): boolean {
    return this._awaiting !== null;
  }

  /**
   * Starts a round by asking a peer for its roots.
   *
   * Refused while this node is not {@link BucketSyncHost.ready}: comparing a
   * partial manifest makes a peer see differences that are not there, and the
   * cheapest outcome of that is a pointless exchange.
   * @returns Whether a round was started.
   */
  start(): boolean {
    if (!this._host.ready() || this.busy) return false;
    this._host.send(encodeQuery(++this._round));
    return true;
  }

  /**
   * Takes one protocol message.
   * @param ref - The message.
   * @returns Whether it was a bucket-sync message this node acted on.
   */
  async receive(ref: string): Promise<boolean> {
    if (!isBucketSync(ref)) return false;
    // A node mid-cold-start neither answers nor asks. Answering with partial
    // roots is worse than silence: the peer concludes there are differences
    // and exchanges entries to discover there are none.
    if (!this._host.ready()) {
      this._log('[FsBucketSync] not ready — ignoring a round');
      return true;
    }

    if (ref.startsWith(BQ)) {
      const round = decodeQuery(ref);
      if (round === undefined) return true;
      this._host.send(encodeRoots(round, bucketRoots(this._host.manifest())));
      return true;
    }

    if (ref.startsWith(BR)) {
      const parsed = decodeRoots(ref);
      if (parsed === undefined) return true;
      const ours = bucketRoots(this._host.manifest());
      const differ = differingBuckets(ours, parsed.roots);
      if (differ.length === 0) {
        this._log('[FsBucketSync] roots agree — nothing to reconcile');
        this._awaiting = null;
        // Not merely "no work": PROOF that the two folders are the same, which
        // no ref comparison can give. The host records it so the divergence
        // stops being reported.
        this._host.agreed?.();
        return true;
      }
      this._awaiting = { round: parsed.round, buckets: differ };
      this._log(
        `[FsBucketSync] ${differ.length} of ${Object.keys(ours).length} ` +
          `buckets differ — asking for their entries`,
      );
      this._host.send(encodeWanted(parsed.round, differ));
      return true;
    }

    if (ref.startsWith(BG)) {
      const parsed = decodeWanted(ref);
      if (parsed === undefined) return true;
      this._host.send(
        encodeEntries(
          parsed.round,
          entriesInBuckets(
            this._host.manifest(),
            parsed.buckets,
            this._host.claimed?.(),
            this._host.editTimes?.(),
          ),
        ),
      );
      return true;
    }

    // `~BE~`: their entries.
    const parsed = decodeEntries(ref);
    if (parsed === undefined) return true;

    // Compared against OUR entries for the SAME buckets — not against the
    // whole manifest, or every path outside the exchange would look like
    // something the peer is missing and a four-message round would turn into a
    // full manifest dump.
    //
    // The buckets come from the round we are waiting on when the reply matches
    // it. A reply from a round we abandoned, or one we never asked for, still
    // carries usable information and its buckets are derivable from the
    // entries themselves — discarding it would waste a round trip already paid
    // for and leave the difference unreconciled until something else noticed.
    const buckets =
      this._awaiting?.round === parsed.round
        ? this._awaiting.buckets
        : [...new Set(parsed.entries.map(([path]) => bucketOf(path)))];
    // OUR times go in too, or the comparison has only one operand: `reconcile`
    // reads `editedAt` from both sides' entries, and the side it is handed as
    // `ours` is built right here. Leaving them off made every tombstone
    // unorderable in the direction that matters most — the one where this node
    // holds the live file.
    const ourEntries = entriesInBuckets(
      this._host.manifest(),
      buckets,
      this._host.claimed?.(),
      this._host.editTimes?.(),
    );
    const plan = reconcile(
      ourEntries,
      parsed.entries,
      this._host.claimed?.(),
    );
    this._awaiting = null;

    const work =
      plan.fetch.length +
      plan.drop.length +
      plan.redelete.length +
      plan.conflict.length;
    if (work === 0) return true;
    this._log(
      `[FsBucketSync] fetch=${plan.fetch.length} drop=${plan.drop.length} ` +
        `redelete=${plan.redelete.length} conflict=${plan.conflict.length}`,
    );
    await this._host.apply(plan);
    return true;
  }
}
