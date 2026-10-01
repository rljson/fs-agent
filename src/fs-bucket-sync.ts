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

/**
 * Whether a ref belongs to this protocol.
 * @param ref - The ref as it arrived.
 * @returns `true` when it is a bucket-sync message.
 */
export const isBucketSync = (ref: string): boolean =>
  BUCKET_SYNC_PREFIXES.some((prefix) => ref.startsWith(prefix));

/**
 * Encodes bucket roots for the wire.
 * @param roots - The roots to send.
 * @returns A ref carrying them.
 */
export const encodeRoots = (roots: BucketRoots): string =>
  BR + JSON.stringify(roots);

/**
 * Decodes bucket roots.
 * @param ref - A `~BR~` ref.
 * @returns The roots. An empty body means an empty manifest, which is a real
 *   state a node can be in rather than a malformed message.
 */
export const decodeRoots = (ref: string): BucketRoots => {
  const body = ref.slice(BR.length);
  if (body.length === 0) return {};
  return JSON.parse(body) as BucketRoots;
};

/**
 * Encodes a request for the entries of some buckets.
 * @param buckets - The bucket indices wanted.
 * @returns A ref carrying them.
 */
export const encodeWanted = (buckets: readonly number[]): string =>
  BG + JSON.stringify(buckets);

/**
 * Decodes a request for bucket entries.
 * @param ref - A `~BG~` ref.
 * @returns The bucket indices.
 */
export const decodeWanted = (ref: string): number[] => {
  const body = ref.slice(BG.length);
  if (body.length === 0) return [];
  return JSON.parse(body) as number[];
};

/**
 * Encodes manifest entries for the wire.
 * @param entries - The entries to send.
 * @returns A ref carrying them.
 */
export const encodeEntries = (entries: readonly ManifestEntry[]): string =>
  BE + JSON.stringify(entries);

/**
 * Decodes manifest entries.
 * @param ref - A `~BE~` ref.
 * @returns The entries. A tombstone arrives as a path with an empty blob id,
 *   which is the whole point of carrying deletions this way.
 */
export const decodeEntries = (ref: string): ManifestEntry[] => {
  const body = ref.slice(BE.length);
  if (body.length === 0) return [];
  return JSON.parse(body) as ManifestEntry[];
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
  /** Buckets we asked for entries of, and are waiting for. */
  private _awaiting: number[] | null = null;

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
    this._host.send(BQ);
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
      this._host.send(encodeRoots(bucketRoots(this._host.manifest())));
      return true;
    }

    if (ref.startsWith(BR)) {
      const theirs = decodeRoots(ref);
      const ours = bucketRoots(this._host.manifest());
      const differ = differingBuckets(ours, theirs);
      if (differ.length === 0) {
        this._log('[FsBucketSync] roots agree — nothing to reconcile');
        this._awaiting = null;
        return true;
      }
      this._awaiting = differ;
      this._log(
        `[FsBucketSync] ${differ.length} of ${Object.keys(ours).length} ` +
          `buckets differ — asking for their entries`,
      );
      this._host.send(encodeWanted(differ));
      return true;
    }

    if (ref.startsWith(BG)) {
      const wanted = decodeWanted(ref);
      this._host.send(
        encodeEntries(entriesInBuckets(this._host.manifest(), wanted)),
      );
      return true;
    }

    // `~BE~`: their entries. Compare against ours for the SAME buckets — not
    // against the whole manifest, or every path outside the exchange would
    // look like something they are missing.
    const theirEntries = decodeEntries(ref);
    const buckets =
      this._awaiting ??
      // A reply we did not ask for still carries usable information, and its
      // buckets are derivable from the entries themselves. Ignoring it would
      // waste a round trip that has already been paid for.
      [...new Set(theirEntries.map(([path]) => bucketOf(path)))];
    const ourEntries = entriesInBuckets(this._host.manifest(), buckets);
    const plan = reconcile(ourEntries, theirEntries);
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
