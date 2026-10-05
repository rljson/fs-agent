// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { ClientId, Route, SyncConfig } from '@rljson/rljson';

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import {
  mkdir,
  readdir,
  rename,
  rm,
  lstat,
  rmdir,
  stat,
  utimes,
} from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';

import {
  AntiEntropyOptions,
  AntiEntropyStatus,
  FsAntiEntropy,
  type Reachability,
} from './fs-anti-entropy.ts';
import {
  ATOMIC_TMP_PREFIX,
  atomicWriteFile,
  atomicWriteStream,
} from './fs-atomic-write.ts';
import { FsBlobAdapter } from './fs-blob-adapter.ts';
import {
  conflictCopyName,
  ConflictResolverDeps,
  FsConflictResolver,
  recoveredName,
  type FsConflictReport,
} from './fs-conflict-resolver.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import {
  FsBucketSync,
  isBucketSync,
  type BucketSyncHost,
} from './fs-bucket-sync.ts';
import {
  ALL_GONE_MIN_FILES,
  compareTimeId,
  FsEditChain,
  planJoin,
  planRemovals,
  type FsChainEntry,
} from './fs-edit-chain.ts';
import { TOMBSTONE_BLOB, type ReconcilePlan } from './fs-manifest.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import { stateBeaconEvent } from '@rljson/db';
import type { Connector, Db } from '@rljson/db';
import type { ConnectorPayload, InsertHistoryRow } from '@rljson/rljson';
import type { FsChange, FsNodeMeta } from './fs-scanner.ts';

// .............................................................................
// Types
// .............................................................................

/**
 * Options for FsAgent operations
 */
export interface FsAgentOptions {
  /**
   * Announce the plain TREE REF instead of the chain head.
   *
   * The migration switch, and it exists so a fleet can roll forward one node
   * at a time instead of all at once. A build that predates the `~H~`
   * announcement cannot parse it: it tries to fetch a tree by that hash and
   * fails, so a new node's pushes are invisible to it.
   *
   * With this on, a new node speaks the OLD wire format and is understood by
   * everyone — and it still resolves its own ancestry, because an entry can be
   * found from the tree ref it produced (`FsEditChain.entryForTreeRef`, a
   * query, measured as served across a real relay). What it gives up is
   * unambiguity: a folder returning to earlier content produces two entries
   * with the same `dataRef`, and the fallback has to pick the newest.
   *
   * **It also switches off bucket sync**, for the same reason and in the same
   * breath: the bucket protocol travels on the ref channel under its own
   * prefixes, and a build that cannot parse `~H~` cannot parse `~BQ~` either.
   * It would try to fetch a tree by each protocol message and log a failure
   * for every one. "Speak the old dialect" has to mean all of it, or the
   * switch only half works and the half it misses is the noisy one.
   *
   * So: on during a rollout, off once the fleet is past the old build.
   * Default: off, which is the better format.
   */
  announceTreeRef?: boolean;
  /**
   * Reconcile a divergence ADDITIVELY instead of replacing a folder.
   *
   * With this on, a divergence the anti-entropy would have answered with
   * `pull` or `merge` runs a bucket-sync round instead: the two sides compare
   * manifests and each fetches what it is missing. Nothing is replaced, so
   * neither side's work can be discarded — which is the property §3.1 of the
   * plan says makes the two measured data losses impossible rather than
   * rarer.
   *
   * **Default off.** It replaces the repair model rather than correcting it,
   * and `src/fs-agent.ts` records that this class of change "has been reverted
   * four times for being shipped on reasoning". On in the mesh, where the
   * additive outcome is asserted; off everywhere else until a lab run says
   * otherwise.
   */
  bucketSync?: boolean;
  /** Ignore patterns for scanning */
  ignore?: string[];
  /** Maximum depth for directory traversal */
  maxDepth?: number;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
  /**
   * Persist a path→(mtime, size, blobId) scan cache at this file path so a RESTART
   * does not re-read + re-hash the whole folder (a cold scan of an 80 GB catalog
   * is ~48 min). Forwarded to the {@link FsScanner}. Requires a PERSISTENT blob
   * store (e.g. `@rljson/bs-fs`). See {@link FsScanOptions.scanCachePath}.
   */
  scanCachePath?: string;
  /** Storage options for database operations */
  storageOptions?: StoreFsTreeOptions;
  /** Restore options applied when syncing from DB */
  restoreOptions?: RestoreOptions;
  /** Timeout configuration for async operations */
  timeouts?: TimeoutConfig;
  /**
   * Centralized sync protocol configuration.
   * When provided, this SyncConfig is forwarded to every Connector
   * created by {@link FsAgent.fromClient}, and governs whether
   * `sendWithAck()` (when `requireAck` is true) or `send()` is used
   * in {@link FsAgent.syncToDb}.
   *
   * The same SyncConfig should also be passed to the Server and Client
   * constructors so that every layer uses the same protocol settings.
   */
  syncConfig?: SyncConfig;
  /**
   * Stable client identity. When provided, it is forwarded to every
   * Connector created by {@link FsAgent.fromClient}. When omitted but
   * `syncConfig.includeClientIdentity` is true, each Connector
   * auto-generates its own identity.
   */
  clientIdentity?: ClientId;
  /**
   * Enable Nextcloud-style conflict resolution. When true, {@link syncFromDb}
   * registers a DAG-branch conflict observer that resolves forks into a single
   * merge revision (winner keeps the path, loser is renamed). This is a
   * **client-only** behaviour — hubs are dumb relays and must leave it off
   * (the default). See `doc/conflict-resolution-design.md`.
   */
  resolveConflicts?: boolean;
  /**
   * Called when a same-file conflict has been resolved, with one entry per
   * conflicting path.
   *
   * This is the only way to learn that it happened. Before it existed,
   * resolving a conflict renamed a file and said nothing — the user's whole
   * evidence was an unexplained `… (conflicted copy …)` appearing in a folder.
   * Nothing is lost either way; what was missing is anybody being told.
   *
   * Not an error channel: two people editing one document at once is ordinary,
   * both versions are kept, and the folder converges. Hosts that want it after
   * a restart should read {@link CONFLICT_LOG_FILE}, which this agent writes
   * regardless of whether a callback is given.
   */
  onConflict?: (reports: FsConflictReport[]) => void;
  /**
   * Repair a divergence from the hub that no message is going to fix — a
   * push the hub never received, a forward this node never received, an
   * apply that gave up. Driven by the hub's periodic announcement: the state
   * beacon (`stateBeaconMs` on the server — the one to use) or the bootstrap
   * heartbeat (`syncConfig.bootstrapHeartbeatMs`). Without either it never
   * fires. On by default. See `src/fs-anti-entropy.ts`.
   */
  antiEntropy?: AntiEntropyOptions;

  /**
   * How long a folder with files and NO history waits for the network's state
   * before saying anything about its own, in milliseconds. `0` disables the
   * wait, which is the default.
   *
   * **The chain applies first; the filesystem only then.** A starting agent
   * authors a lineage root from whatever it happens to hold and announces it
   * as the network's newest claim, and that is one defect wearing two faces:
   * every node gets its own lineage root, so `classify` answers `fork` to
   * every announcement ever made; and a node restored from a backup pushes
   * deleted files back to the whole fleet. With a wait set, such a node defers
   * instead, reconciles against the first head it hears (`planJoin` — write
   * what the head has, keep what the history never named, set aside what it
   * REMOVED, treat a path live on both sides as a conflict) and speaks
   * afterwards.
   *
   * **Bounded, and that is not a detail.** If no head arrives this folder IS
   * the origin and its contents are the first state — a brand-new network has
   * to be startable, so the wait is a deferral and never a refusal. It also
   * cannot deadlock a fleet whose nodes all start with files: they all time
   * out, they all announce, and their roots agree by content.
   *
   * **Off by default, deliberately.** It changes what a node says in its first
   * seconds, which is the class of change this package has reverted four times
   * for being shipped on reasoning. It is proven at the mesh tier
   * (`fs-mesh-matrix.spec.ts`, `J4+J5`) and belongs on after a lab run, in the
   * same way `bucketSync` did — see §13.17 and §13.20 of
   * `PLAN-fs-edit-chain.md`.
   */
  joinWaitMs?: number;

  /**
   * A short name for this agent, shown in every line it logs.
   *
   * **Because a log without it cannot be read when more than one agent runs.**
   * Four nodes in one process produced three identical
   * `applied 3 peer deletions: …` lines with nothing saying who, and a
   * convergence investigation stopped there: the three nodes that applied a
   * removal and the one that stayed silent were indistinguishable. The One
   * Client has the same problem for a different reason — several routes, one
   * console.
   *
   * Omitted, every line reads `[FsAgent]` exactly as before.
   */
  logName?: string;
}

/** Restore options */
export interface RestoreOptions {
  /**
   * Remove files and directories on the target that the tree does not contain.
   *
   * **Destructive, and the peer-apply path never sets it.** Deleting what a
   * tree happens to lack is an INFERENCE, and it is the one this package spent
   * its whole history getting wrong: a tree lacks a path because the sender
   * removed it, or because the sender never had it, and a content hash cannot
   * say which. `syncFromDb` therefore applies additively and takes deletions
   * from the chain, where they are STATED — see `_applyIncomingRemovals`.
   *
   * Still honoured by a direct {@link FsAgent.restore} call, which is a caller
   * saying "make this folder be exactly this tree". That is a different
   * question, and its answer is one the caller already knows.
   *
   * `syncFromDb` still ACCEPTS it, so a configuration carrying
   * `cleanTarget: true` keeps working unchanged; it no longer authorises a
   * prune there.
   */
  cleanTarget?: boolean;
}

/**
 * Timeout configuration for async operations (milliseconds).
 * Every async operation in FsAgent is guarded by a timeout to prevent
 * silent hangs in socket communication, filesystem I/O, or database queries.
 */
export interface TimeoutConfig {
  /** Timeout for a single db.get() query. Default: 10 000 ms */
  dbQuery?: number;
  /** Timeout for fetching an entire tree from the DB. Default: 20 000 ms */
  fetchTree?: number;
  /** Timeout for a filesystem extract / scan. Default: 15 000 ms */
  extract?: number;
  /** Timeout for a filesystem restore. Default: 15 000 ms */
  restore?: number;
  /** Timeout for the overall syncFromDb callback. Default: 25 000 ms */
  syncCallback?: number;
  /**
   * Debounce delay for sync callbacks (milliseconds). Default: 300 ms.
   * Rapid filesystem events (e.g. macOS Finder "Keep Both" copy+rename)
   * are coalesced into a single sync operation after this quiet period.
   * Also applies to incoming database refs in syncFromDb.
   */
  debounceMs?: number;
  /**
   * Number of retries for processRef in syncFromDb. Default: 3.
   * When a ref fails to process (e.g. db.get timeout because the IoPeer
   * transport hasn't connected yet), the ref is retried this many times
   * with increasing delay before being dropped.
   */
  processRefRetries?: number;
  /**
   * Base delay between processRef retries (milliseconds). Default: 5 000 ms.
   * Each retry waits `attempt * processRefRetryDelayMs` (i.e. 5s, 10s, 15s).
   */
  processRefRetryDelayMs?: number;
  /**
   * Number of **recovery re-queues** for a ref whose per-cycle retries were
   * all exhausted (e.g. `db.get` kept timing out because the transport was
   * disconnected/contended during a hub crash, reconnect or restart). Instead
   * of permanently dropping the ref — which loses the file written in that
   * window — it is re-queued up to this many times so it is eventually applied
   * once the transport recovers. A newer incoming ref supersedes a pending
   * recovery; `tearDown()` stops it. Default: 10. Set 0 to restore the old
   * drop-on-exhaustion behaviour.
   */
  recoveryRetries?: number;
}

/** Sensible defaults – every operation is bounded */
const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  dbQuery: 10_000,
  fetchTree: 20_000,
  extract: 15_000,
  restore: 15_000,
  syncCallback: 25_000,
  debounceMs: 300,
  processRefRetries: 3,
  processRefRetryDelayMs: 5_000,
  recoveryRetries: 10,
};

/**
 * Longest a disconnect may keep the watcher paused.
 *
 * Generous enough for an ordinary reconnect, short enough that a reconnect
 * which never arrives costs a few seconds of missed notifications rather than
 * every write from then on.
 */
export const DISCONNECT_PAUSE_MAX_MS = 30_000;

/** Filename for sync error log written to the sync folder */
export const SYNC_ERROR_FILE = '.sync-errors.log';

/**
 * Where resolved same-file conflicts are recorded, newest last.
 *
 * Its own file rather than a line in `.fsagent-state.json`, because that file
 * is rewritten WHOLE on every deletion — appending a growing list to it would
 * make deleting the next file slower in proportion to how many conflicts the
 * folder has ever had, which is the cost {@link TOMBSTONE_LOG_MAX} exists to
 * bound.
 *
 * And JSON rather than the free text of {@link SYNC_ERROR_FILE}, because this
 * is meant to be READ by a UI, not grepped by a person.
 */
export const CONFLICT_LOG_FILE = '.fsagent-conflicts.json';

/**
 * Where a file the history had DELETED is kept when this node joins.
 *
 * **Outside the synced tree, and that is the whole point.** A recovered file
 * must not be announced — it is content the fleet deliberately removed, and a
 * folder restored from last month's backup would otherwise push every one of
 * those deletions back to every node. But leaving it in the folder cannot
 * achieve that: a tree ref carries CONTENT, so the file travels whatever the
 * entry claims about it. Measured exactly that way — the set-aside copy
 * arrived on a peer while the chain entry said nothing about it.
 *
 * So it goes in an ignored directory, which is local by construction, and the
 * user can see it and move it back if they want it. Visible, keepable, and
 * silent.
 */
export const RECOVERED_DIR = '.fsagent-recovered';

/**
 * How often a joining node asks for the network's state, in milliseconds.
 *
 * The hub volunteers it — the connector has a bootstrap channel and a
 * bootstrap heartbeat — but a node that misses those cannot tell "I heard
 * nothing" from "there is nothing", and that is the difference between joining
 * a fleet and announcing a stale folder over it. So it keeps asking, which
 * costs a read of its own database and puts nothing on the wire.
 */
export const JOIN_ASK_INTERVAL_MS = 150;

/**
 * How often a node ASKS whether the fleet has moved on without it.
 *
 * **Because listening is not enough, and the gap is invisible.** The
 * anti-entropy compares this folder against the last state it HEARD the hub
 * announce. Under silent announcement loss — which is what a relay under load
 * does, reporting success and delivering nothing — a receiver hears nothing,
 * so its idea of the hub stays equal to its own state, the two agree, and it
 * reports `diverged: false` with zero repairs. *The repair mechanism's own
 * input is the thing that failed, so the harder the transport fails the
 * healthier the fleet reports itself.* Measured: receivers six versions behind
 * a writer, every one of them claiming health.
 *
 * Asking costs a read of this node's own database and puts nothing on the
 * wire: the fleet's entries replicate there, and the newest one is the
 * question. It cannot help while NOTHING arrives — no local source can — but
 * it closes the window that matters, where the rows are present and the
 * announcement that would have triggered a repair was the thing dropped.
 */
export const ANTI_ENTROPY_ASK_MS = 2_000;


/**
 * How long a joining node asks before concluding it is the origin.
 *
 * The default for every route. Long enough for a hub's bootstrap to arrive on
 * a real connection, short enough that the first client of a brand-new network
 * is not kept waiting — and it is a deferral, never a refusal: when it expires
 * the folder IS the origin and its contents are the first state.
 */
export const DEFAULT_JOIN_WAIT_MS = 1_500;

/**
 * How many resolved conflicts the log keeps.
 *
 * Small on purpose. This is a notification surface, not an audit trail: what a
 * user needs is "here is what recently happened to your documents", and a
 * thousand entries answer a question nobody asked while making the file
 * expensive to write.
 */
export const CONFLICT_LOG_MAX = 200;

// `ATOMIC_TMP_PREFIX` now lives in `fs-atomic-write.ts`, beside the writers
// that use it. Re-exported so this module's surface is unchanged.
export { ATOMIC_TMP_PREFIX };

/**
 * Filename for the agent's own state, kept beside the synced folder's content
 * and ignored by the scanner like the other two above.
 *
 * It holds one thing: the ref this folder was last known to be at. That
 * survives a restart, which is the whole point — a process that comes back
 * with no idea what it descends from cannot declare ancestry, and a push with
 * no ancestry is one every peer has to treat as untrustworthy for deletion.
 */
export const AGENT_STATE_FILE = '.fsagent-state.json';

/**
 * Marks an announced ref as a CHAIN HEAD rather than a tree ref.
 *
 * A tree ref is a content hash and never starts with `~`, so the two are
 * unambiguous on one channel — the trick `@rljson/mongo-agent` uses for its
 * own protocol refs (`~R~`, `~AEQ~`…), blessed by §6 of the plan.
 *
 * The marker is not decoration. Without it a receiver cannot tell a head from
 * a tree ref, so it has to TRY resolving every ref it hears — and a miss goes
 * to the network. Measured: the first version did exactly that, and awaiting
 * that read before scheduling the apply dropped the hub's bootstrap on a late
 * joiner, which then never received a file that already existed. A receive
 * path that awaits a peer read before acting can lose a message to a slow
 * peer, silently.
 */
export const CHAIN_HEAD_PREFIX = '~H~';

// .............................................................................
// FsAgent Class
// .............................................................................

/**
 * Orchestrates filesystem operations with tree structures and blob storage
 */
/**
 * A prune smaller than this many files is always allowed through.
 *
 * Below it, "most of the folder" is not a meaningful statement: emptying a
 * three-file folder is an ordinary edit, and a guard that blocked it would
 * fire constantly on small trees and be turned off.
 */
/**
 * How long an agent waits before answering another refusal.
 *
 * Two nodes can refuse each other — each holding files the other lacks — and an
 * unthrottled answer to every refusal is a loop. Long enough that a genuine
 * catch-up (a restore of the answered ref) completes inside it, short enough
 * that a node joining an idle network is not left waiting.
 */
export const REFUSAL_ANSWER_COOLDOWN_MS = 5_000;

/**
 * How many tree nodes are fetched at once while walking a tree.
 *
 * The walk is latency-bound, so the whole point is to stop waiting for one node
 * before asking for the next. Bounded because "the whole level at once" on a
 * 184 000-file catalogue would be tens of thousands of simultaneous requests,
 * which trades a latency problem for a queueing one.
 */
export const TREE_FETCH_CONCURRENCY = 64;

/**
 * How many restored paths an agent remembers writing.
 *
 * The memory exists so a repeat restore recognises this agent's own work
 * without re-reading the file. Nothing ever removed an entry, so a long-lived
 * agent over a large catalogue held one per file it had ever written. Dropping
 * the oldest costs a stat on a file that has not been touched in a long time,
 * which is the cheap half of the trade.
 */
export const RESTORED_BLOB_MEMORY_MAX = 50_000;


/**
 * How many tree children a restore works on at once.
 *
 * A restore's cost is dominated by `getBlob`, and a blob this node does not
 * already hold is a socket round trip. Walking the tree strictly sequentially
 * makes the whole restore `files × RTT` — invisible on localhost, and about
 * sixteen files a second on the lab, where a 1 200-file folder then takes
 * minutes and reads as a stalled node.
 *
 * Sixteen rather than sixty-four: blobs carry file CONTENT, so the ceiling is
 * memory in flight rather than request count, and a folder of large files at
 * high concurrency is how a client runs out of heap.
 */
export const RESTORE_FETCH_CONCURRENCY = 16;

/**
 * How many heard-but-not-yet-applied peer heads a node parks.
 *
 * A head arrives when an announcement is resolved and is used when the apply
 * for that state runs, which is a debounce later, so the two have to be
 * bridged. Announcements that never reach an apply — superseded by a newer
 * one, dropped by a guard — leave their head behind, so the map is bounded and
 * the oldest is forgotten. Forgetting costs a lineage join, never a file.
 */
export const ANNOUNCED_HEAD_MAX = 200;

/**
 * How many deletions the tombstone log remembers.
 *
 * The log is the one structure in this agent that grows without bound. Measured
 * on 400 deletions: 337 entries, ~11 bytes each in `.fsagent-state.json`, and
 * the file is rewritten SYNCHRONOUSLY on every deletion — so the cost of
 * deleting the next file grows with every file already deleted. A folder with
 * years of churn turns that into a megabyte rewritten per delete.
 *
 * Everything else was measured and is already bounded: the chain grows one
 * entry per PUSH rather than per change (400 deletions produced 7, because the
 * debounce coalesces them), `_localPathTimeIds` is pruned by the removals it
 * records, and `_announcedHeads` has {@link ANNOUNCED_HEAD_MAX}.
 *
 * Ten thousand is chosen to be far past any real partition and still small
 * enough to rewrite cheaply (~110 KB). Evicting a tombstone can RESURRECT a
 * file — that is the whole point of keeping it — so eviction is oldest-first
 * and loud, and the number is deliberately generous rather than tight.
 */
export const TOMBSTONE_LOG_MAX = 10_000;

/**
 * What an agent concluded about an inbound ref.
 *
 * See `FsAgent._inboundRefVerdict` for why this is one decision rather than
 * several conditions.
 */
export type InboundRefVerdict = 'apply' | 'own-echo' | 'stale';

/** How each non-applying verdict reads in a log line. */
export const VERDICT_REASON: Record<Exclude<InboundRefVerdict, 'apply'>, string> =
  {
    'own-echo': "is this agent's own last advertisement echoed back",
    stale: 'is not the newest its sender has advertised',
  };

export const MASS_DELETE_MIN_FILES = 100;

/**
 * Above this share of the folder, a prune is treated as suspicious rather than
 * intentional.
 */
export const MASS_DELETE_MAX_RATIO = 0.3;

/**
 * A restore that could not put the folder into the state the tree describes.
 *
 * The distinction that matters to callers is not why. It is that the folder
 * does NOT match the tree afterwards, so the ref must not be recorded as
 * applied and the resulting state must not be advertised to peers.
 */
export class RestoreIncompleteError extends Error {}

/**
 * Thrown when a restore wrote everything it could but at least one file was
 * held open by another process.
 *
 * Not a failure of the restore so much as a "not yet": the bytes are still
 * available, the file is simply busy. It is an error rather than a silent
 * partial success because the folder does NOT match the tree afterwards, and
 * anything that treats it as if it did — advertising the state, recording the
 * ref as applied — would make one locked file look like an edit that everyone
 * else must adopt.
 */
export class PartialRestoreError extends RestoreIncompleteError {
  constructor(public readonly lockedPaths: string[]) {
    super(
      `restore could not write ${lockedPaths.length} locked file` +
        `${lockedPaths.length === 1 ? '' : 's'}: ${lockedPaths.join(', ')}`,
    );
    this.name = 'PartialRestoreError';
  }
}

/**
 * Thrown when a restore finished but at least one file's bytes could not be
 * fetched at all.
 *
 * The difference from {@link PartialRestoreError} is "not yet" versus "never".
 * A locked file's bytes exist and the file is merely busy, so retrying is the
 * right answer. A blob that cannot be retrieved may never become retrievable —
 * an offline peer that held the only copy, a blob deleted between the tree and
 * the fetch.
 *
 * **Size is no longer one of those reasons.** The case that produced this class
 * was a file larger than the transport's `maxHttpBufferSize`, where no number of
 * retries made 63 MB fit through a 50 MB socket. Since `@rljson/bs` 0.0.27 a
 * blob crosses as a series of ranged pulls, so no single message carries the
 * whole file and the cap no longer bounds file size. The class stays, because a
 * blob can still be genuinely unreachable; the reason it was first needed is
 * gone.
 *
 * It exists because the failure used to be a bare `throw` in the middle of
 * `_restoreTree`, which abandoned the ENTIRE tree: no other file in it was
 * written, and — the part that actually hurt — `_pruneExtraneous` never ran,
 * so no deletion in that tree was ever applied. The node then retried, failed
 * on the same blob, and its state never advanced past that ref. Once its
 * ancestry no longer matched any state its peers were in, every later apply
 * came through with `mayPrune=false`, and it accepted additions forever while
 * silently ignoring every delete.
 *
 * Measured on four nodes: one 63 MB file (120% of the cap) left three of them
 * holding a file the fourth had deleted, permanently, and `projekte-shape`'s
 * deletion had still not propagated after 300 seconds. The customer's largest
 * file was 45.9 MB against the same 50 MB cap — close enough that the next
 * revision of one document would have reproduced it in production.
 */
export class BlobUnavailableError extends RestoreIncompleteError {
  constructor(public readonly unavailablePaths: string[]) {
    super(
      `restore could not fetch ${unavailablePaths.length} blob` +
        `${unavailablePaths.length === 1 ? '' : 's'}: ` +
        `${unavailablePaths.join(', ')}`,
    );
    this.name = 'BlobUnavailableError';
  }
}

/**
 * Thrown when `cleanTarget` would have deleted most of the folder.
 *
 * The dangerous direction of sync is a POPULATED node receiving a tree that
 * lacks its files: a peer that comes up empty — a fresh clone, a folder not
 * yet mounted, a bootstrap that raced its own first scan — advertises an empty
 * tree, and every other node faithfully deletes everything it has.
 *
 * Nothing downstream can tell that apart from a genuine bulk deletion, so the
 * judgement has to be made here, and it is deliberately biased: refusing a
 * real mass delete costs one manual step, applying a false one costs the data.
 */
/**
 * A restore could not write a path this filesystem will not accept.
 *
 * Its own class rather than a {@link BlobUnavailableError}, because the
 * message is what somebody reads in a support request and "could not fetch
 * blob" for a 300-character filename sends them to the network when the
 * problem is the name. The bytes arrived; the path cannot exist here.
 *
 * Not retryable, unlike {@link PartialRestoreError}: a name does not become
 * legal by waiting. The rest of the tree is applied around it.
 */
export class UnwritablePathError extends RestoreIncompleteError {
  constructor(public readonly impossiblePaths: string[]) {
    super(
      `restore could not write ${impossiblePaths.length} path` +
        `${impossiblePaths.length === 1 ? '' : 's'} that cannot be written ` +
        `here: ` +
        `${impossiblePaths.join(', ')}`,
    );
    this.name = 'UnwritablePathError';
  }
}

/**
 * The volume ran out of space mid-restore.
 *
 * Its own class because it is the one restore failure that is not about the
 * tree at all, and because retrying it is pointless until a person acts. It
 * aborts rather than skipping the file: a folder being filled on a full disk
 * would otherwise lose a different file on every attempt.
 */
export class DiskFullError extends RestoreIncompleteError {
  constructor(public readonly path: string) {
    super(`no space left to write "${path}"`);
    this.name = 'DiskFullError';
  }
}

export class MassDeleteRefusedError extends RestoreIncompleteError {
  constructor(
    public readonly wouldPrune: number,
    public readonly totalFiles: number,
    public readonly incomingFiles: number,
  ) {
    super(
      // No pluralisation: the guard only fires above MASS_DELETE_MIN_FILES,
      // so this is never one file.
      `refusing to prune ${wouldPrune} of ${totalFiles} local files: ` +
        `the incoming tree has ` +
        `${incomingFiles === 0 ? 'NO files at all' : `only ${incomingFiles}`}, ` +
        `which looks like a peer that came up empty rather than a deletion. ` +
        `Nothing was deleted.`,
    );
    this.name = 'MassDeleteRefusedError';
  }
}

/** What one push changed, against the state announced before it. */
export interface FsTreeDelta {
  /** Relative paths added or modified, `/`-separated. */
  changed: string[];
  /** Relative paths removed, `/`-separated. */
  removed: string[];
}

export class FsAgent {
  /**
   * The prefix on every line this agent logs — see {@link FsAgentOptions.logName}.
   *
   * `[FsAgent]` when unnamed, so an unnamed agent's output is byte-identical
   * to what it was before this existed.
   */
  private readonly _tag: string;

  private _scanner: FsScanner;
  private _adapter: FsBlobAdapter;
  private _rootPath: string;
  private _bs: Bs;
  private _lastSentRef?: string;

  /**
   * The ref this agent last pushed as its OWN work.
   *
   * Not the same as {@link _lastSentRef}, which an apply also sets when it
   * leaves the folder equal to — or short of — what it applied. Only a state
   * this agent authored may be re-announced by the anti-entropy: re-announcing
   * one it is still catching up to would roll its peers back.
   */
  private _lastPushedRef?: string;

  /** Tuning for the anti-entropy, as passed in. */
  private readonly _antiEntropyOptions?: AntiEntropyOptions;
  /** The running anti-entropy, while {@link syncFromDb} is active. */
  private _antiEntropy?: FsAntiEntropy;

  /**
   * The incoming ref most recently applied. Retired from the connector's dedup
   * sets when the next one supersedes it, so a peer returning the tree to that
   * state can still reach this agent.
   */
  private _lastAppliedRef?: string;
  /** When this agent last answered a refusal, for the cooldown. */
  private _lastRefusalAnswerMs = 0;
  /** Content fingerprint of the last tree we broadcasted (paths+blobIds) */
  private _lastSentContentKey?: string;

  /**
   * True while a ref received from a peer is being applied to disk.
   *
   * The safety rescan cannot tell a local change the watcher missed (which it
   * must broadcast) from a remote change not yet applied here (which it must
   * not). The agent can: while this is set, the disk is mid-way through
   * someone else's revision, so a rescan-driven push would re-assert our stale
   * view — and undo a deletion the peer just made.
   */
  private _remoteApplyInFlight = false;
  /**
   * Whether a safety rescan was suppressed while a remote apply was running.
   *
   * The rescan is what covers a watcher that drops or coalesces events, so a
   * suppressed one has to be re-run rather than forgotten — see the deferral in
   * `syncToDb`'s change handler.
   */
  private _rescanDeferred = false;
  /** Re-runs a deferred rescan once the apply that blocked it has finished. */
  private _flushDeferredRescan: (() => void) | undefined;

  /** Files written vs left alone by the current {@link restore}. */
  private _restoreWritten = 0;
  private _restoreSkipped = 0;



  /**
   * Absolute paths deleted here since the last announcement.
   *
   * The mirror of {@link _announcedFiles}. Between a local unlink and the push
   * that announces it, this node's advertised state still CONTAINS the file —
   * so a peer pushing in that window descends from a state the file is in, and
   * an apply re-creates it. The local scan then sees the file present, and the
   * deletion is never announced at all: silently undone, everywhere.
   */
  private readonly _pendingDeletes = new Set<string>();

  /**
   * This folder's history: one entry per state this node pushed.
   *
   * Created on the first `syncToDb`, and BEST-EFFORT throughout — a chain that
   * cannot be written must never stop a folder syncing. Nothing consumes it
   * yet; see `src/fs-edit-chain.ts`.
   */
  private _chain?: FsEditChain;

  /**
   * The chain entry that names the state this node last pushed.
   *
   * Announcements carry the HEAD rather than the tree ref (see
   * {@link _announceAs}), and a re-announcement has to find the head for a
   * state it did not just append. Cached as a pair so that costs a comparison
   * rather than a read.
   */
  private _chainHead?: { head: string; treeRef: string };

  /**
   * `relativePath → timeId` of the newest edit THIS node made to each path.
   *
   * A peer's removal is refused when this node has newer work on that path
   * (see `planRemovals`), and this is the claim it is judged against. Grown
   * from the `changed` list of every entry this node appends, so it is exactly
   * as complete as the chain is.
   */
  private readonly _localPathTimeIds = new Map<string, string>();

  /**
   * Removals carried by an announcement, waiting for its apply.
   *
   * The resolve happens when the ref arrives and the apply happens later, after
   * a debounce, so the removal list has to be parked in between. Keyed by the
   * tree ref it accompanies and consumed once, because an entry applied twice
   * would delete on the authority of a message already acted on.
   */
  private readonly _incomingRemovals = new Map<
    string,
    { removed: string[]; changed: string[]; timeId: string }
  >();

  /**
   * `treeRef → chain head`, for announcements heard but not yet applied.
   *
   * **Hearing a head is not holding its state.** The resolve happens when the
   * ref arrives and the apply happens after a debounce, and plenty of
   * announcements never get that far: a newer ref supersedes them, a guard
   * refuses them, the node is already there. Parking the head here and only
   * promoting it at the apply keeps `_adoptedChainHead` to its documented
   * meaning.
   *
   * Measured before this existed: two nodes each saving one file at the same
   * instant. A merely HEARD B's head, recorded it as a parent of its own next
   * entry, and so claimed a lineage descending from a state it never held —
   * whereupon its own `ahead` guard correctly refused B's file as "a state
   * this node has already left". The file never arrived. A false parent is not
   * a cosmetic inaccuracy: reachability is what the whole protocol decides on.
   */
  private readonly _announcedHeads = new Map<string, string>();

  /**
   * A peer head this node has applied, waiting to become a chain parent.
   *
   * **Without this, reachability cannot answer anything.** Every node appends
   * to its OWN lineage and chains are never merged, so if an entry only ever
   * names this node's previous head, A's head can never be an ancestor of B's
   * — and `classify` returns `fork` for every disagreement there has ever
   * been. Measured: adding reachability without this made T4 WORSE, because
   * cases that used to pull or push correctly all became merges.
   *
   * Naming the adopted head as a second parent is what joins the lineages, and
   * it is the shape `FsEditChain` writes its rows by hand to allow.
   */
  private _adoptedChainHead?: string;

  /**
   * `relativePath → content hash` of the tree this node last announced.
   *
   * The chain entry has to say what a push CHANGED and what it REMOVED, and
   * only a comparison against the previously announced content tells those
   * apart from "everything, because this is the first push". Kept beside
   * {@link _announcedFiles}, which answers the coarser question of which paths
   * peers could know about.
   */
  private _announcedContent = new Map<string, string>();

  /**
   * Set while a folder with files and no history waits for a head.
   *
   * The deferral in `syncToDb`: until a head has been seen, nothing in this
   * folder has been established, so the node says nothing about it. Cleared by
   * the reconcile, or by the first push once it turns out this node is the
   * origin.
   */
  private _joinPending: { db: Db; treeKey: string } | undefined;

  /** See {@link FsAgentOptions.joinWaitMs}. */
  private readonly _joinWaitMs: number;

  /** Ends the wait, so a node that is the origin is never silent for good. */
  private _joinWaitTimer: ReturnType<typeof setTimeout> | null = null;

  /** Asks for the network's state, repeatedly, while a join is pending. */
  private _joinAskTimer: ReturnType<typeof setInterval> | null = null;



  /**
   * The two sides of a merge in progress, so its entry claims only its own
   * work.
   *
   * **A merge authors the bytes it PRODUCES, and nothing else.** Where it keeps
   * this side's content, the author is whoever wrote it here; where it adopts
   * the other side's, the author is the peer. The only bytes a merge brings
   * into the world are the ones at paths neither side had — the conflict
   * copies.
   *
   * The merge revision's `changed` was a diff against what this node last
   * ANNOUNCED, which says nothing about authorship. Measured end to end: node
   * C merged against a late v5 announcement, took the writer's v5 bytes, and
   * claimed `doc.txt` — a claim 28 seconds newer than the writer's own v8
   * edit, so the per-path question answered truthfully and still chose v5.
   * Then the writer adopted C's state and claimed v5 as well. Two nodes
   * recorded themselves as the author of a version neither had written.
   */
  private _mergeInputs:
    | { before: ReadonlyMap<string, string>; incoming: ReadonlyMap<string, string> }
    | undefined;





  /**
   * The reconcile that is running, so only ONE ever does.
   *
   * Announcements arrive in bursts and the reconcile awaits a query, a tree
   * read and a restore. A second announcement landing in that window used to
   * take the ordinary path, schedule an apply, and act on the peer's stated
   * removal — which deleted the very file the reconcile was about to set
   * aside. Measured: the joiner's stale copy destroyed instead of recovered,
   * with "set aside 1 file" in the log, because the rename had nothing left to
   * move.
   *
   * `_joinPending` therefore stays set until the reconcile FINISHES, so every
   * announcement in that window funnels into this one promise and none of them
   * schedules anything.
   */
  private _joinInFlight: Promise<void> | undefined;

  /**
   * Whether this node has ever announced anything.
   *
   * Kept separately from {@link _announcedContent} being empty, because an
   * empty folder announced is a real statement and an unspoken node is not.
   */
  private _hasAnnounced = false;

  /**
   * The ref last written to {@link AGENT_STATE_FILE}.
   *
   * Held because the state file now carries two things, and a tombstone write
   * must not blank the ref that was already recorded.
   */
  private _currentRefPersisted: string | undefined;

  /**
   * Absolute paths of the files this agent has actually TOLD anyone about.
   *
   * A prune may only remove a file that peers could know exists. Anything
   * written since the last announcement is invisible to every sender, so a
   * tree that lacks it is not deleting it — it simply predates it.
   */
  private readonly _announcedFiles = new Set<string>();

  /**
   * Files this restore DELETED.
   *
   * Counted and reported because a prune is the only half of a restore that
   * can destroy anything, and until now it was the only half that happened
   * silently: `restore: wrote 0, left 901 already-correct` is what a node
   * printed while removing 77 files. The number that mattered was the one not
   * on the line.
   */
  private _restorePruned = 0;

  /**
   * Files this restore refused to re-create because they are tombstoned.
   *
   * Counted and reported, because the alternative is a guard whose work is
   * invisible. The same mistake was made once already with `_restorePruned`:
   * reported before the prune that sets it, so every restore that deleted
   * files announced itself as one that had deleted none — *"a log that cannot
   * report an event is worse than no log, because it reads as evidence of
   * absence"*. A tombstone that silently stops a write is exactly that shape,
   * and when a deleted file reappears anyway this count is the first thing
   * worth knowing.
   */
  private _restoreTombstoned = 0;



  /** Paths the current {@link restore} could not write because they were held open. */
  private _restoreLocked: string[] = [];

  /**
   * Paths the current {@link restore} could not write because their blob could
   * not be fetched — collected rather than thrown, so one unfetchable file
   * cannot abandon the rest of the tree and, above all, cannot stop the prune.
   */
  private _restoreUnavailable: string[] = [];

  /** Paths this filesystem rejected outright. See {@link UnwritablePathError}. */
  private _restoreImpossible: string[] = [];

  /**
   * Paths whose KIND changed — a file where a directory was, or the reverse.
   *
   * Counted and reported because such a change removes whatever was there,
   * and a restore that silently deletes a subtree is one nobody can audit
   * afterwards.
   */
  private _restoreRetyped = 0;

  /**
   * How long each stage of the last push and the last apply took, in ms.
   *
   * Measured on the lab: *"im Schnitt 3 Sekunden, im schlechtesten Fall 84.
   * Alle Zeitbudgets der Testsuite hängen an dieser Zahl."* And the reason
   * nobody could say more than that: *"bisher wird nur die Gesamtzeit
   * gemessen. Die einzelnen Schritte mitmessen — Scan, Prüfsumme, Ablage,
   * Meldung, Abholen, Schreiben —, sonst rät man."* (`KNOWN-WEAKNESSES.md`
   * F5/C7.)
   *
   * A total tells you a sync was slow. It does not tell you whether the folder
   * was being hashed, a blob was crossing the network, or a disk was writing —
   * and those have different people to talk to. Kept as a plain record so a
   * host can log or display it without this agent deciding how.
   */
  private readonly _stageMs: Record<string, number> = {};

  /**
   * Times one stage into {@link _stageMs}.
   *
   * Overwrites rather than accumulates: the question is "what did the last
   * cycle cost", and a running total answers a different one and never resets.
   * @param stage - The stage name.
   * @param work - What to time.
   * @returns Whatever `work` returned.
   */
  private async _timed<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      this._stageMs[stage] = Date.now() - started;
    }
  }

  /**
   * What each stage of the last push and apply cost, in milliseconds.
   *
   * A snapshot, safe to keep: `push.*` is the send side, `apply.*` the receive
   * side, and a stage absent simply has not run yet in this process.
   */
  get stageTimings(): Readonly<Record<string, number>> {
    return { ...this._stageMs };
  }

  /**
   * What this agent last wrote to each absolute path, so a repeat restore can
   * recognise its own work without re-reading the file.
   */
  private _restoredBlobs = new Map<
    string,
    { blobId: string; size: number; mtime: number }
  >();
  private _timeouts: Required<TimeoutConfig>;
  /** Told when a same-file conflict was resolved. See `onConflict`. */
  private readonly _onConflict?: (reports: FsConflictReport[]) => void;

  /** Client-only: resolve DAG-branch conflicts into merge revisions. */
  private _resolveConflicts: boolean;

  /** See {@link FsAgentOptions.announceTreeRef}. */
  private _announceTreeRef: boolean;

  /** See {@link FsAgentOptions.bucketSync}. */
  private _bucketSyncOn: boolean;

  /** The bucket-sync conversation, when {@link _bucketSyncOn}. */
  private _bucketSync?: FsBucketSync;
  /**
   * Ancestry head: the content ref of the revision currently representing the
   * filesystem state. New local revisions descend from it; received revisions
   * advance it. Only tracked when `resolveConflicts` is enabled, so the
   * InsertHistory predecessor DAG forms only where conflict resolution is on.
   */
  private _currentRef?: string;

  constructor(rootPath: string, bs?: Bs, options: FsAgentOptions = {}) {
    this._rootPath = rootPath;
    this._bs = bs || new BsMem();
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this._resolveConflicts = options.resolveConflicts ?? false;
    this._onConflict = options.onConflict;
    this._announceTreeRef = options.announceTreeRef ?? false;
    // `announceTreeRef` means "speak the build before this one", and that
    // build has no bucket protocol. An explicit `bucketSync: true` still wins,
    // so the combination remains testable.
    this._bucketSyncOn =
      options.bucketSync ?? !(options.announceTreeRef ?? false);
    this._antiEntropyOptions = options.antiEntropy;
    this._joinWaitMs = options.joinWaitMs ?? DEFAULT_JOIN_WAIT_MS;
    this._tag =
      options.logName === undefined
        ? '[FsAgent]'
        : `[FsAgent ${options.logName}]`;
    this._scanner = new FsScanner(rootPath, {
      ...options,
      ignore: [
        ...(options.ignore || []),
        SYNC_ERROR_FILE,
        ATOMIC_TMP_PREFIX,
        AGENT_STATE_FILE,
        // Or the notification becomes content: every conflict would write a
        // file inside the synced folder, which is a change, which propagates,
        // which every peer then rewrites with its own copy of the log.
        CONFLICT_LOG_FILE,
        // And the set-aside copies, for the same reason one level up: they are
        // deliberately NOT announced, which a tree ref cannot express about a
        // file inside the folder it describes. See `RECOVERED_DIR`.
        RECOVERED_DIR,
      ],
      bs: this._bs,
    });
    this._adapter = new FsBlobAdapter(this._bs);
    // Before anything can apply a peer's tree: a restart that forgot what it
    // had deleted is how a deletion is undone by the first peer that never
    // heard about it.
    this._loadPersistedTombstones();

  }

  /**
   * Gets the root path
   */
  get rootPath(): string {
    return this._rootPath;
  }

  /**
   * Gets the blob storage instance
   */
  get bs(): Bs {
    return this._bs;
  }

  /**
   * Gets the scanner instance
   */
  get scanner(): FsScanner {
    return this._scanner;
  }

  /**
   * Gets the adapter instance
   */
  get adapter(): FsBlobAdapter {
    return this._adapter;
  }

  /**
   * Gets the current timeout configuration
   */
  get timeouts(): Required<TimeoutConfig> {
    return this._timeouts;
  }

  /**
   * Whether this node and the hub agree, and what the anti-entropy has done
   * about it when they did not. `null` until {@link syncFromDb} runs.
   *
   * A divergence that lasts is the one thing a lost message leaves behind, and
   * until now nothing reported it: this is what a diagnostics view should show.
   */
  get antiEntropyStatus(): AntiEntropyStatus | null {
    return this._antiEntropy?.status ?? null;
  }

  /**
   * Records the ref this folder is now at, so a restart can still say what it
   * descends from.
   *
   * Best-effort on purpose: losing it costs ancestry on the next start, which
   * degrades to an additive-only apply rather than to anything unsafe, so it
   * must never be worth failing a sync over.
   * @param ref - The ref the folder is now at.
   */
  /**
   * Starts the watcher unless it is already running.
   *
   * Both `syncToDb` and `syncFromDb` need a live watcher and either may be
   * started first. `syncToDb` used to call `watch()` unconditionally, so
   * starting them in the order `syncFromDb` then `syncToDb` threw "Already
   * watching" — which quietly forced every caller into push-first, the order
   * that lets a reconnecting client overwrite the network with a stale tree.
   * A crash is a poor reason to choose an unsafe order.
   */
  private async _ensureWatching(): Promise<void> {
    if (!this._scanner.isWatching) {
      await this._scanner.watch();
    }
  }

  private _persistCurrentRef(ref: string): void {
    this._currentRefPersisted = ref;
    this._writeAgentState();
  }

  /**
   * Writes the tombstone log, keeping whatever ref is already recorded.
   *
   * Separate from {@link _persistCurrentRef} because a deletion is recorded the
   * moment the watcher reports it — before the push that moves the ref — and
   * losing it in that window is the whole defect.
   */
  private _persistTombstones(): void {
    // Oldest first, because a `Set` preserves insertion order and the oldest
    // deletion is the one a peer is least likely still to be pushing back.
    //
    // LOUD, because evicting a tombstone can resurrect a file: that is what a
    // tombstone is for, and dropping one is a decision to stop defending a
    // deletion. If this is ever seen in the field it is a signal that the log
    // needs a real garbage-collection rule — one that knows when every peer
    // has seen a deletion — rather than a bigger number.
    while (this._pendingDeletes.size > TOMBSTONE_LOG_MAX) {
      const oldest = this._pendingDeletes.values().next().value as string;
      this._pendingDeletes.delete(oldest);
      console.warn(
        `${this._tag} tombstone log full at ${TOMBSTONE_LOG_MAX} — forgetting ` +
          `the deletion of ${oldest}. A peer that never saw it can now put ` +
          `it back.`,
      );
    }
    this._writeAgentState();
  }

  /**
   * Writes `.fsagent-state.json`: the ref this folder is at, and the paths
   * deleted here.
   *
   * One file for both, written whole, because a partial write of either is
   * indistinguishable from a first run — and both answer `undefined` /
   * "nothing tombstoned", which is the safe direction for each.
   */
  private _writeAgentState(): void {
    try {
      writeFileSync(
        join(this._rootPath, AGENT_STATE_FILE),
        JSON.stringify({
          currentRef: this._currentRefPersisted,
          tombstones: [...this._pendingDeletes].map((abs) =>
            relative(this._rootPath, abs).split(sep).join('/'),
          ),
        }),
        'utf-8',
      );
    } catch {
      /* v8 ignore next -- @preserve best-effort; see the doc comment */
    }
  }

  /**
   * Loads the tombstone log a previous run left behind.
   *
   * A restart that forgot what it had deleted is how a deletion is undone by
   * the first peer that never heard about it.
   */
  private _loadPersistedTombstones(): void {
    try {
      const file = join(this._rootPath, AGENT_STATE_FILE);
      if (!existsSync(file)) return;
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      const paths = (parsed as { tombstones?: unknown })?.tombstones;
      if (!Array.isArray(paths)) return;
      // Capped on the way IN as well. A log written by a build without the
      // cap — or by one with a larger one — must not reintroduce a size this
      // process has decided not to carry, and the newest entries are the ones
      // worth keeping.
      const keep = paths.slice(-TOMBSTONE_LOG_MAX);
      for (const path of keep) {
        if (typeof path === 'string' && path.length > 0) {
          this._pendingDeletes.add(join(this._rootPath, ...path.split('/')));
        }
      }
    } catch {
      /* v8 ignore next -- @preserve best-effort; a lost log is a lost guard */
    }
  }

  /**
   * The ref this folder was last recorded at, from a previous run.
   *
   * Absent, unreadable and malformed all mean the same thing — this process
   * cannot vouch for what it descends from — and all answer `undefined`, which
   * the caller treats as "declare no ancestry".
   * @returns The persisted ref, or `undefined`.
   */
  private _loadPersistedRef(): string | undefined {
    try {
      const file = join(this._rootPath, AGENT_STATE_FILE);
      if (!existsSync(file)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') return undefined;
      const ref = (parsed as { currentRef?: unknown }).currentRef;
      return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Records resolved conflicts and tells the host.
   *
   * Both, not either: the callback is for a UI that is running now, the file is
   * for one that starts later. A conflict the user never hears about is the
   * thing this exists to stop, so it does not depend on anyone having
   * subscribed.
   *
   * The whole file is rewritten rather than appended, because it has to stay
   * valid JSON and bounded. At {@link CONFLICT_LOG_MAX} entries that is a few
   * tens of kilobytes, and conflicts are rare — unlike deletions, which is why
   * the tombstone log made the opposite choice.
   * @param reports - What the resolver resolved, one entry per path.
   */
  private _recordConflicts(reports: readonly FsConflictReport[]): void {
    /* v8 ignore next -- @preserve the resolver never reports an empty list */
    if (reports.length === 0) return;
    try {
      const file = join(this._rootPath, CONFLICT_LOG_FILE);
      let existing: FsConflictReport[] = [];
      if (existsSync(file)) {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
        if (Array.isArray(parsed)) existing = parsed as FsConflictReport[];
      }
      const kept = [...existing, ...reports].slice(-CONFLICT_LOG_MAX);
      writeFileSync(file, JSON.stringify(kept, null, 1), 'utf-8');
    } catch (err) {
      // A notification that cannot be filed must not take the merge with it.
      this._writeSyncError('conflicts/record', err);
    }
    for (const report of reports) {
      console.warn(
        `${this._tag} CONFLICT on "${report.path}": kept both — the other ` +
          `version is at "${report.copyPath}"`,
      );
    }
    try {
      this._onConflict?.(reports as FsConflictReport[]);
    } catch (err) {
      // A host's listener throwing is the host's problem, not the merge's.
      this._writeSyncError('conflicts/onConflict', err);
    }
  }

  /**
   * Appends a sync error entry to the error log file in the sync folder.
   * Uses synchronous I/O to guarantee the write completes even in catch blocks.
   * @param context - Label identifying where the error occurred
   * @param err - The error value caught
   */
  _writeSyncError(context: string, err: unknown): void {
    try {
      const ts = new Date().toISOString();
      const msg =
        err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      const entry = `[${ts}] ${context}: ${msg}\n`;
      appendFileSync(join(this._rootPath, SYNC_ERROR_FILE), entry);
    } catch {
      // If writing itself fails (e.g. rootPath gone), silently ignore
    }
  }

  /**
   * Extracts a human-readable message from a thrown value. The non-`Error`
   * branch is defensive (the DB/transport always throw `Error`s).
   * @param err - The caught value.
   * @returns A message string.
   */
  private static _errMessage(err: unknown): string {
    /* v8 ignore next -- @preserve non-Error throws are defensive */
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Retries an async operation up to `attempts` times with exponential backoff
   * (each delay doubles from `baseDelayMs`). For transient failures — a file
   * briefly locked by antivirus or a save-and-rename editor, a peer briefly
   * unreachable. Non-final failures are logged once at warn level so retry
   * pressure is visible without log-spam.
   * @param fn - The operation to run
   * @param attempts - Maximum number of attempts
   * @param baseDelayMs - Initial backoff delay (doubles each retry)
   * @param label - Human-readable label for log messages
   * @returns The operation's resolved value
   */
  private static async _withRetry<T>(
    fn: () => Promise<T>,
    attempts: number,
    baseDelayMs: number,
    label: string,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = baseDelayMs * Math.pow(2, i);
        console.warn(
          `[FsAgent] ${label} attempt ${i + 1}/${attempts} failed: ` +
            `${FsAgent._errMessage(err)} — retry in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * Writes a file through a staging file and a rename.
   *
   * Kept as a thin named wrapper because the restore path reads as a pair with
   * {@link FsAgent._atomicWriteStream}. The rule, and the byte-level
   * corruption that made it a rule on every platform rather than on Windows
   * only, are in `fs-atomic-write.ts`.
   * @param filePath - Destination path
   * @param content - Bytes to write
   */
  private static async _atomicWriteFile(
    filePath: string,
    content: Buffer | string,
  ): Promise<void> {
    return atomicWriteFile(filePath, content);
  }

  /**
   * Whether this error came from reading the blob rather than writing the file.
   *
   * The two have different answers. A blob that cannot be fetched costs one
   * file and the tree applies without it; a file that cannot be written is
   * usually a CARAT document a user still has open, and that one must not abort
   * the rest of the restore either. Conflating them would report an offline peer
   * as a locked file, and the field reports are read by people who act on that
   * distinction.
   * @param error - The error thrown while writing the file.
   * @returns Whether it came from the blob source.
   */
  private static _isBlobReadError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { __blobRead?: boolean }).__blobRead === true
    );
  }

  /**
   * Writes a file from a stream, holding one chunk at a time.
   *
   * The twin of {@link FsAgent._atomicWriteFile} — temp and rename on every
   * platform, for the same reasons — but never materialising the whole file. A 500 MB
   * file used to cost 500 MB of Buffer on the receiving agent, another copy in
   * the socket parser, and — on the serving hub — the same again. That is the
   * shape that killed the cloud EventHub: memory that is work in flight rather
   * than garbage, so no collection can reclaim any of it.
   *
   * Read failures are tagged, because from here on the bytes arrive during the
   * write rather than before it, and {@link FsAgent._isBlobReadError} is what
   * keeps the caller's two error messages telling the truth.
   * @param filePath - Where the file goes.
   * @param stream - The bytes.
   */
  private static async _atomicWriteStream(
    filePath: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    return atomicWriteStream(filePath, stream, (error) =>
      Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { __blobRead: true },
      ),
    );
  }

  /**
   * Wraps a promise with a timeout.
   * Rejects with a descriptive error if the promise does not settle
   * within the given number of milliseconds.
   * @param promise - The promise to guard
   * @param ms - Maximum allowed time in milliseconds
   * @param label - Human-readable label included in the error message
   */
  private static _withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms: ${label}`));
      }, ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Sends a ref through the connector.
   * Uses `sendWithAck()` when the connector has `requireAck` enabled,
   * otherwise falls back to fire-and-forget `send()`.
   * @param connector - The Connector to send through
   * @param ref - The ref to broadcast
   * @param predecessorRefs - Causal predecessor content refs to attach (for
   *   conflict ancestry); set explicitly here because the FsAgent broadcasts
   *   via an explicit send, which pre-empts the Connector's db-observer path.
   */
  private async _sendRef(
    connector: Connector,
    ref: string,
    predecessorRefs?: string[],
  ): Promise<void> {
    // A tree ref is a pure content hash, so a folder that returns to a state
    // it broadcast earlier re-derives that state's exact ref — and
    // Connector.send() discards it, because it has sent (or received) that ref
    // before. Deleting a file created during the same session is precisely
    // that shape: the folder goes A → B → A, and the deletion reached no peer
    // at all.
    //
    // Every call here has already established that this is genuinely new local
    // state: the caller compares content keys, not refs, and returns early on
    // a match. That decision outranks the connector's ref history, so the ref
    // is cleared from both dedup sets before it goes out. Bounce-backs are
    // still suppressed — they never reach this point.
    connector.invalidateSent?.(this._announceAs(ref));

    // Ancestry travels with every push, not only when conflict resolution is
    // on.
    //
    // It is metadata: what state this one descends from. Nothing acts on it
    // unless asked to, and sending it costs a field on the wire. Withholding it
    // costs the ability to tell two situations apart that look identical
    // without it —
    //
    //   a peer DELETED a file from a state we both had        (subtractive, correct)
    //   a peer has files we never shared a history with       (additive, correct)
    //
    // — because a first push from an independently-populated folder and a
    // deletion from a shared state are the same shape once the ancestry is
    // stripped. Measured: two populated folders joined under one treeKey lose
    // one side's unique files when the difference is small, and merge when it
    // is large, because the only discriminator left is a volume heuristic.
    //
    // Sent on its own, as the identity and sequence metadata was before it, so
    // that the rule which consumes it can be enabled and measured separately.
    connector.setPredecessors(predecessorRefs ?? []);

    // THE WIRE CARRIES THE HEAD, not the tree ref. See `_announceAs`.
    //
    // The predecessors are left as TREE refs deliberately. A receiver's prune
    // rule compares them against `[_currentRef, _lastAppliedRef]`, which are
    // tree refs, so translating them here would break the one rule that
    // separates a deletion from a straggler. The head is an additional
    // identity for the announced state, not a replacement for the ancestry
    // already on the payload.
    const announced = this._announceAs(ref);

    // Retry on a transient socket-layer failure (e.g. a dropped packet or a
    // reconnect blip) so a single hiccup doesn't lose an entire ref.
    await FsAgent._withRetry(
      async () => {
        if (connector.syncConfig?.requireAck) {
          await connector.sendWithAck(announced);
        } else {
          connector.send(announced);
        }
      },
      3,
      100,
      `sendRef(${announced.slice(0, 12)}…)`,
    );
  }

  /**
   * Abandons a join this agent is still waiting on.
   *
   * **This method used to do nothing at all**, and the One Client calls it in
   * six places on shutdown. It read two fields that were never assigned —
   * leftovers of the constructor auto-sync pattern, which was removed — each
   * behind a `v8 ignore` that hid the fact. The real stopping is done by the
   * functions `syncToDb` and `syncFromDb` return, which the client already
   * calls first.
   *
   * What it does now is the one thing those cannot: cancel a pending join. A
   * folder that deferred its first announcement keeps asking the network for a
   * head every {@link JOIN_ASK_INTERVAL_MS} until the wait expires, and a
   * `stop()` does not end it — so a node shut down mid-join went on asking a
   * connector that was being torn down, and every refusal reached the sync
   * error log. The timers are `unref`'d, so this was never a reason the
   * process stayed alive; it was noise at exactly the moment a shutdown is
   * being diagnosed.
   */
  dispose(): void {
    this._joinPending = undefined;
    this._stopAsking();
  }

  /**
   * Extracts filesystem into tree structure with file content in blobs
   * File content is stored in Bs, tree structure returned with blobIds embedded
   * @returns Tree structure with blobIds in file metadata
   */
  async extract(): Promise<FsTree> {
    // Scan filesystem - stores file content in Bs, returns tree structure
    //
    // Timed as `push.scan`: hashing a folder and crossing a network are
    // different costs with different answers, and a single total cannot tell
    // them apart. See {@link stageTimings}.
    const tree = await this._timed('push.scan', () => this._scanner.scan());

    // Return the tree structure (blobIds are already in file metadata)
    return tree;
  }

  /**
   * Restores filesystem from tree structure and blob storage
   * @param tree - Tree structure with blobIds in file metadata
   * @param targetPath - Optional target path (defaults to rootPath)
   * @param options - Restore options
   */
  async restore(
    tree: FsTree,
    targetPath?: string,
    options?: RestoreOptions,
  ): Promise<void> {
    const target = targetPath || this._rootPath;
    const { expectedDirs, expectedFiles } = this._collectExpectedPaths(
      tree,
      target,
    );

    // The same expected paths, indexed by lower case.
    //
    // Needed only by the prune, and only because most of this fleet runs on
    // case-INSENSITIVE filesystems. Renaming `Angebot.docx` to
    // `angebot.docx` does not move anything there — it is one path — so the
    // restore writes the file and then the prune walks the directory, reads
    // the name the filesystem actually kept, fails to find that exact string
    // among the expected paths, and DELETES it. Measured: a case-only rename
    // left the peer with an empty folder.
    //
    // Windows and macOS are both case-insensitive by default, so that is
    // three machines in four.
    const expectedByLowerCase = new Map<string, string>();
    for (const expected of expectedFiles) {
      expectedByLowerCase.set(expected.toLowerCase(), expected);
    }

    // Capture the file set present BEFORE the restore. cleanTarget may only
    // prune files that already existed pre-restore — any file that appears
    // *during* the restore is a fresh user write and must be preserved
    // (protects against the user saving while a restore is in flight).
    const preRestore = options?.cleanTarget
      ? await this._collectAllFiles(target)
      : new Set<string>();

    // Recursively restore from tree structure
    this._restoreWritten = 0;
    this._restoreSkipped = 0;
    this._restorePruned = 0;
    this._restoreTombstoned = 0;
    this._restoreLocked = [];
    this._restoreUnavailable = [];
    this._restoreImpossible = [];
    this._restoreRetyped = 0;
    await this._restoreTree(
      tree.rootHash,
      tree.trees,
      target,
      target === this._rootPath,
    );
    if (options?.cleanTarget) {
      // How much of this folder would the prune take with it?
      //
      // Only files that were here BEFORE the restore can be pruned, so that
      // is the population to judge against — a file written during the
      // restore is a fresh user write and is protected separately.
      //
      // And a path whose CONTENT arrives under a different name in the same
      // tree is a MOVE, not a deletion — so it is not counted.
      //
      // Without that, renaming a folder is refused outright. To this system a
      // rename is "delete everything and re-add", so every path under the old
      // name disappears at once: measured at 140 of 140 files, ratio 1.0,
      // `MASS DELETE REFUSED`, nothing applied. That is
      // `KNOWN-WEAKNESSES.md` D5 — *"für das System ist ein Umbenennen 'alles
      // löschen und neu anlegen'. Damit läuft es in die Löschsperre und
      // blockiert"* — and the register notes there was never a test for it.
      //
      // Judged on the blobId, which is the only thing that survives a rename
      // and the only thing that distinguishes the two cases: bytes that are
      // still in the tree are not being destroyed, wherever they now sit. A
      // real mass deletion removes the content too, so it still trips the
      // guard.
      //
      // Receiver-side, deliberately. The register proposes detecting the move
      // at the scan; four sender-side fixes in this area have been withdrawn,
      // and the rule that holds is the one the receiver can check for itself.
      const incomingBlobs = new Set<string>();
      for (const [, node] of tree.trees) {
        const blobId = node?.meta?.blobId as string | undefined;
        if (blobId) incomingBlobs.add(blobId);
      }
      let wouldPrune = 0;
      let moved = 0;
      for (const existing of preRestore) {
        if (expectedFiles.has(existing)) continue;
        const rel = relative(this._rootPath, existing).split(sep).join('/');
        const known = this._scanner.knownFile(rel)?.blobId;
        if (known !== undefined && incomingBlobs.has(known)) {
          moved++;
          continue;
        }
        wouldPrune++;
      }
      if (moved > 0) {
        console.log(
          `${this._tag} ${moved} file(s) moved rather than deleted — not ` +
            `counted against the mass-delete guard`,
        );
      }
      if (
        wouldPrune > MASS_DELETE_MIN_FILES &&
        (expectedFiles.size === 0 ||
          wouldPrune / preRestore.size > MASS_DELETE_MAX_RATIO)
      ) {
        // Loud, because the alternative to noticing this is discovering it
        // from a user whose folder emptied.
        console.error(
          `${this._tag} MASS DELETE REFUSED on ${target}: the incoming tree ` +
            `would remove ${wouldPrune} of ${preRestore.size} files ` +
            `(incoming tree has ${expectedFiles.size}). Nothing was deleted. ` +
            `If this deletion is real, it has to be applied deliberately.`,
        );
        this._writeSyncError(
          'restore/massDeleteGuard',
          new Error(
            `refused to prune ${wouldPrune}/${preRestore.size} files; ` +
              `incoming tree had ${expectedFiles.size}`,
          ),
        );
        throw new MassDeleteRefusedError(
          wouldPrune,
          preRestore.size,
          expectedFiles.size,
        );
      }

      await this._pruneExtraneous(
        target,
        expectedDirs,
        expectedFiles,
        preRestore,
        expectedByLowerCase,
      );
    }

    // AFTER the prune, because the prune is the only thing that sets
    // `_restorePruned`. Reported before it, this line could never say DELETED:
    // the counter was always still zero, so every restore that removed files
    // announced itself as one that had removed none.
    //
    // That is not a cosmetic fault. `DELETED` absent was read for two days as
    // evidence that a delete had arrived and been refused, and two changes were
    // written to fix a refusal that was never happening. A log that cannot
    // report an event is worse than no log, because it reads as evidence of
    // absence.
    if (this._restoreSkipped > 0 || this._restorePruned > 0) {
      console.log(
        `${this._tag} restore: wrote ${this._restoreWritten}, left ` +
          `${this._restoreSkipped} already-correct file` +
          `${this._restoreSkipped === 1 ? '' : 's'} untouched` +
          (this._restorePruned > 0 ? `, DELETED ${this._restorePruned}` : '') +
          (this._restoreTombstoned > 0
            ? `, REFUSED ${this._restoreTombstoned} tombstoned`
            : ''),
      );
    }

    // Everything writable is now written, and pruning has run. Only now report
    // the locked files — raising earlier would have abandoned the rest of the
    // restore, which is the behaviour this replaces.
    // SORTED, so the message is the same every time it is produced.
    //
    // A restore writes files concurrently and now walks children in a
    // canonical order that is a property of their hashes, not their names, so
    // the order casualties are collected in is meaningless. An error message
    // whose contents depend on which fetch finished first is one nobody can
    // compare between two runs, and a test that pins it is flaky by
    // construction.
    if (this._restoreLocked.length > 0) {
      throw new PartialRestoreError([...this._restoreLocked].sort());
    }

    // Reported the same way and for the same reason: the folder does not match
    // the tree, so this node must not advertise the state or record the ref as
    // applied. What has changed is only WHEN — after the writes and after the
    // prune, so the tree's deletions are applied even though one of its files
    // could not be.
    if (this._restoreUnavailable.length > 0) {
      throw new BlobUnavailableError([...this._restoreUnavailable].sort());
    }

    // Last of the three, because it is the least recoverable: a lock clears
    // and a blob can arrive later, while a name this filesystem rejects never
    // becomes acceptable. Reporting it first would hide a problem somebody
    // can actually act on behind one they cannot.
    if (this._restoreImpossible.length > 0) {
      throw new UnwritablePathError([...this._restoreImpossible].sort());
    }
  }

  /**
   * Recursively collects the absolute paths of all files under `currentDir`.
   * Used to snapshot the pre-restore file set for prune race-protection.
   * @param currentDir - Directory to walk
   * @param out - Accumulator set (created if omitted)
   * @returns The set of absolute file paths
   */
  private async _collectAllFiles(
    currentDir: string,
    out?: Set<string>,
  ): Promise<Set<string>> {
    const result = out ?? new Set<string>();
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      /* v8 ignore next -- @preserve unreadable dir → nothing to collect */
      return result;
    }
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await this._collectAllFiles(fullPath, result);
      } else {
        result.add(fullPath);
      }
    }
    return result;
  }

  /**
   * Recursively restores a tree node and its children
   * @param treeHash - Hash of the tree node to restore
   * @param trees - Map of all tree nodes
   * @param targetPath - Target directory path
   * @param isOwnRoot - Whether `targetPath` is this agent's own folder, which
   *   is the only case where the scanner's view describes these files
   */
  private async _restoreTree(
    treeHash: string,
    trees: Map<string, any>,
    targetPath: string,
    isOwnRoot: boolean,
  ): Promise<void> {
    const treeNode = trees.get(treeHash);
    /* v8 ignore next -- @preserve */
    if (!treeNode) {
      throw new Error(`Tree node not found: ${treeHash}`);
    }

    const meta = treeNode.meta as FsNodeMeta | null | undefined;
    /* v8 ignore if -- @preserve */
    if (!meta) {
      throw new Error(`Tree node is missing meta for hash: ${treeHash}`);
    }

    /* v8 ignore next -- @preserve */
    if (meta.type === 'file') {
      // For files, fetch content using blobId from Bs
      if (!FsAgent._isInsideRoot(targetPath, meta.relativePath)) {
        console.error(
          `${this._tag} REFUSED a tree path that leaves the sync folder: ` +
            `"${meta.relativePath}". Nothing was written. This is a tree ` +
            `that should not exist; the rest of it is still applied.`,
        );
        this._writeSyncError(
          'restore/pathEscapesRoot',
          new Error(`"${meta.relativePath}" resolves outside ${targetPath}`),
        );
        this._restoreImpossible.push(meta.relativePath);
        return;
      }
      const filePath = join(targetPath, meta.relativePath);
      // A directory may be sitting where this file belongs.
      await this._makeRoomFor(filePath, 'file');

      /* v8 ignore else -- @preserve */
      if (meta.blobId) {
        // Is this file already exactly what we are about to write?
        //
        // Every sync used to rewrite the whole tree. On the production
        // catalogue that is 80 GB of blob fetches and disk writes per restore,
        // which is why restores time out — and almost all of it rewrites bytes
        // that were already identical.
        //
        // The check goes BEFORE the fetch deliberately: `getBlob` is the
        // expensive half (it can cross the network), so a skip that still
        // fetched would save the smaller cost and keep the larger one.
        //
        // restore preserves mtime, so a file this agent wrote earlier carries
        // the tree's exact mtime. Size and mtime together are the rsync
        // heuristic the scan cache already relies on. It errs only towards
        // rewriting: a mismatch, an unreadable stat, or a coarse-grained
        // filesystem all fall through to the write.
        if (await this._alreadyOnDisk(filePath, meta, isOwnRoot)) {
          this._restoreSkipped++;
          return;
        }

        // Never re-create a file deleted here and not yet announced.
        //
        // The mirror of the prune rule: peers may not remove what they could
        // not know exists, and they may not restore what they have not yet
        // been told is gone. Between the unlink and the push, this node's
        // advertised state still contains the file, so a peer pushing in that
        // window descends from a state the file is in — and an apply puts it
        // back. The local scan then sees it present and the deletion is never
        // announced: silently undone, on every node including the one that
        // performed it.
        if (this._pendingDeletes.has(filePath)) {
          this._restoreSkipped++;
          this._restoreTombstoned++;
          return;
        }

        // Try to fetch the blob.
        //
        // Recorded and stepped over, NOT thrown. A throw here abandoned the
        // whole tree — every other file in it went unwritten and
        // `_pruneExtraneous`, which runs after this walk, never ran at all, so
        // no deletion the tree carried was applied. The node then retried, hit
        // the same blob, and never advanced past that ref; once its ancestry
        // no longer matched a state its peers were in, every later apply
        // arrived with `mayPrune=false` and it took additions forever while
        // ignoring every delete.
        //
        // One 63 MB file — 120% of the 50 MB socket cap, so its blob could not
        // be fetched at all — left three of four nodes permanently holding a
        // file the fourth had deleted. The bytes of one file are worth exactly
        // one missing file, never the tree's deletions as well.
        //
        // The size cap itself is gone as of the streaming fetch below; this rule
        // still holds for every other reason a blob can be unreachable.
        // A stream, not the whole blob. `getBlobStream` asks the source for its
        // size first, so a blob that is simply not there still fails here with
        // the same message it always did — and a blob that IS there now crosses
        // in chunks, which is what lifts the 50 MB ceiling named above.
        let fileStream;
        try {
          fileStream = await this._bs.getBlobStream(meta.blobId);
        } catch (error) {
          console.warn(
            `${this._tag} cannot fetch blob for "${meta.relativePath}" ` +
              `(blobId: ${meta.blobId}): ` +
              `${error instanceof Error ? error.message : String(error)} — ` +
              `skipping this file and applying the rest of the tree.`,
          );
          this._restoreUnavailable.push(meta.relativePath);
          return;
        }

        if (!fileStream) {
          console.warn(
            `${this._tag} missing blob content for "${meta.relativePath}" ` +
              `(blobId: ${meta.blobId}) — skipping this file and applying the ` +
              `rest of the tree.`,
          );
          this._restoreUnavailable.push(meta.relativePath);
          return;
        }

        // Create parent directories
        await mkdir(dirname(filePath), { recursive: true });

        try {
          // Written to a temp file and renamed into place, so nothing — not a
          // user, not this agent's own scanner — ever sees the file at a
          // partial size under its real name. See `_atomicWriteStream`.
          await FsAgent._atomicWriteStream(filePath, fileStream);
          this._restoreWritten++;

          // Preserve mtime
          /* v8 ignore else -- @preserve */
          if (meta.mtime) {
            const mtime = new Date(meta.mtime);
            await utimes(filePath, mtime, mtime);
          }

          // Remember what was put there, so a repeat restore recognises its
          // own work without re-reading the file.
          //
          // The mtime recorded is the one the file ENDED UP with, read back
          // rather than taken from the tree. A tree node carries no mtime —
          // it is excluded from the content identity (see `FsScanner`) — so
          // taking it from `meta` recorded `undefined` and this whole shortcut
          // stopped applying: measured as `wrote 1, left 1 already-correct`
          // becoming `wrote 2` on a tree where nothing had changed, which on
          // the production catalogue is 80 GB of needless writes per restore.
          //
          // One `stat` against writing the bytes again is not a cost worth
          // avoiding. It is also the honest value either way: when a peer
          // DOES send an mtime the `utimes` above has already applied it, so
          // this reads back what that produced.
          const written = await stat(filePath).catch(
            /* v8 ignore next -- @preserve the file was just written successfully */
            () => undefined,
          );
          /* v8 ignore else -- @preserve */
          if (meta.size !== undefined && written !== undefined) {
            // Bounded. This is a shortcut for recognising this agent's own
            // work, and a shortcut that grows without limit stops being one:
            // it is keyed by absolute path and nothing ever removed an entry,
            // so a long-lived agent over a large catalogue accumulated one per
            // file it had ever written. Dropping the oldest costs a stat on a
            // file that has not been touched in a long time.
            if (this._restoredBlobs.size >= RESTORED_BLOB_MEMORY_MAX) {
              const oldest = this._restoredBlobs.keys().next().value as string;
              this._restoredBlobs.delete(oldest);
            }
            this._restoredBlobs.set(filePath, {
              blobId: meta.blobId,
              size: meta.size,
              mtime: written.mtime.getTime(),
            });
          }
        } catch (error) {
          // CARAT holds .dbf and .PRJZ open for as long as a user has the
          // document. One of those aborted the entire restore, so a single
          // open document stopped every OTHER file in the tree from arriving —
          // one user's lock became everyone's stalled sync.
          //
          // Skip the file and keep going. The bytes are not lost: nothing has
          // been recorded as applied, so the caller retries, and by then the
          // file is usually closed.
          // Now that the bytes arrive DURING the write rather than before it,
          // a peer going away mid-file surfaces here instead of at the fetch
          // above. It is the same fault as a blob that could not be fetched at
          // all and gets the same answer — one file skipped, the tree applied —
          // and it must not be reported as a locked document, which is a
          // different problem with a different person to talk to.
          if (FsAgent._isBlobReadError(error)) {
            console.warn(
              `${this._tag} blob transfer for "${meta.relativePath}" broke off ` +
                `(blobId: ${meta.blobId}): ` +
                `${error instanceof Error ? error.message : String(error)} — ` +
                `skipping this file and applying the rest of the tree.`,
            );
            this._restoreUnavailable.push(meta.relativePath);
            return;
          }
          // A path this filesystem will not accept at all.
          //
          // Same answer as an unfetchable blob, and for the same reason: one
          // file's name is worth exactly one missing file, never the rest of
          // the tree. Without it the raw error escapes and the whole restore
          // aborts — *"ein zu langer Pfad oder ein reservierter Name ist heute
          // der billigste Weg, einen ganzen Rechner stillzulegen"*, and the
          // node then *"empfängt gar nichts mehr und versucht es endlos mit
          // derselben Datei"* (`KNOWN-WEAKNESSES.md` D2/Y2).
          //
          // NOT retried as a lock is, because the name will not become legal.
          // Reported as unavailable, which is what it is: the tree describes a
          // file this machine cannot hold.
          // A full disk, reported as itself.
          //
          // *"Was bei voller Platte passiert, wurde nie getestet"*
          // (`KNOWN-WEAKNESSES.md` D4), and what happened was a raw errno
          // thrown out of the restore — indistinguishable from a bug, retried
          // on a schedule, and described in no message anybody reads. The
          // folder cannot be completed and no amount of retrying changes that
          // until somebody frees space, so it is said once, loudly, and the
          // restore stops.
          if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
            console.error(
              `${this._tag} NO SPACE LEFT on the volume holding ${this._rootPath}` +
                ` — "${meta.relativePath}" could not be written. Sync is ` +
                `stopped for this folder until space is freed.`,
            );
            this._writeSyncError('restore/diskFull', error);
            throw new DiskFullError(meta.relativePath);
          }
          if (FsAgent._isImpossiblePath(error)) {
            console.warn(
              `${this._tag} restore: "${meta.relativePath}" cannot exist on this ` +
                `filesystem (${(error as NodeJS.ErrnoException).code}) — ` +
                `skipped, and the rest of the tree applied.`,
            );
            this._restoreImpossible.push(meta.relativePath);
            return;
          }
          if (!FsAgent._isLocked(error)) throw error;
          console.warn(
            `${this._tag} restore: "${meta.relativePath}" is held open by another ` +
              `process (${(error as NodeJS.ErrnoException).code}) — skipped, ` +
              `will retry`,
          );
          this._restoreLocked.push(meta.relativePath);
        }
      }
    } else if (meta.type === 'directory') {
      // For directories, create directory and recursively restore children
      if (!FsAgent._isInsideRoot(targetPath, meta.relativePath)) {
        console.error(
          `${this._tag} REFUSED a tree directory that leaves the sync folder: ` +
            `"${meta.relativePath}". Nothing was created.`,
        );
        this._writeSyncError(
          'restore/pathEscapesRoot',
          new Error(`"${meta.relativePath}" resolves outside ${targetPath}`),
        );
        this._restoreImpossible.push(meta.relativePath);
        return;
      }
      const dirPath =
        meta.relativePath === '.'
          ? targetPath
          : join(targetPath, meta.relativePath);
      // And a file may be sitting where this directory belongs. Never for the
      // root itself, which is the folder being restored into.
      if (meta.relativePath !== '.') {
        await this._makeRoomFor(dirPath, 'directory');
      }

      await mkdir(dirPath, { recursive: true });

      // Restore children, several at a time.
      //
      // Siblings are independent — each writes its own path, and a directory
      // child creates its own directory before descending — so the only thing
      // the sequential walk bought was one blob fetch in flight. See
      // {@link RESTORE_FETCH_CONCURRENCY}.
      /* v8 ignore else -- @preserve */
      if (treeNode.children && Array.isArray(treeNode.children)) {
        const children = [...treeNode.children];
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = next++;
            if (index >= children.length) return;
            await this._restoreTree(
              children[index],
              trees,
              targetPath,
              isOwnRoot,
            );
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(RESTORE_FETCH_CONCURRENCY, children.length) },
            worker,
          ),
        );
      }
    }
  }

  /**
   * Whether a caught value means "another process is holding this file".
   *
   * Windows reports a locked file as EPERM or EBUSY; EACCES covers the
   * permission-denied shape. Deliberately narrow — anything else is a real
   * write failure and must still abort, because a restore that shrugged off
   * every error would report success while leaving the folder wrong.
   * @param err - The caught value.
   * @returns `true` for a lock-shaped error.
   */
  /**
   * Whether a write failed because the PATH is impossible here, rather than
   * because the file is busy.
   *
   * The rules differ per platform and this agent must not encode them: Windows
   * refuses a component over 255, a total path over 260, the reserved device
   * names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…), a trailing space or dot;
   * POSIX refuses a component over 255 and an embedded NUL. What they share is
   * the errno, so the errno is what this reads.
   *
   * Deliberately NOT retried, unlike a lock: a name does not become legal by
   * waiting. The file is reported as unavailable and the tree is applied
   * around it.
   * @param err - The caught value.
   * @returns Whether the path itself is the problem.
   */
  /**
   * Whether a tree's path stays inside the folder being restored.
   *
   * A tree is DATA FROM ANOTHER MACHINE. Nothing has checked where its paths
   * point, and `join(target, '../escaped.txt')` resolves outside the target —
   * so a peer, or one corrupted node, could write anywhere this process can.
   * Measured before this existed: a tree carrying `../escaped.txt` put a file
   * next to the sync folder, and the restore reported success.
   *
   * It needs no malice to matter. A relative path assembled wrongly, a
   * `relativePath` left absolute by a future scanner, a tree edited by hand to
   * reproduce a bug — all of them become an arbitrary file write on every node
   * that applies the tree.
   *
   * Checked by RESOLVING rather than by looking for `..`, because `a/../../b`,
   * a symlinked parent and an absolute path are all the same question and only
   * one of them contains the obvious substring.
   * @param target - The folder being restored into.
   * @param relativePath - The path the tree claims.
   * @returns Whether it is safe to write.
   */
  /**
   * Clears whatever is at a path so a node of a DIFFERENT KIND can be written
   * there.
   *
   * A path does not only change its contents; it changes what it IS. A user
   * replaces a stray file with the folder it should have been, an export
   * writes a single document where an unpacked directory used to sit. Both
   * mature comparable projects test exactly these transitions —
   * Syncthing as `filetype_test.go`, Unison as "file replacement" and
   * "directory replacement" — and this agent did neither.
   *
   * Measured before this existed, all three aborting the WHOLE restore with a
   * raw errno, so a single type change stopped the folder syncing:
   *
   *   file → directory          EEXIST: file already exists, mkdir
   *   empty directory → file    EISDIR: illegal operation on a directory
   *   directory with files → file   the same
   *
   * Nothing is destroyed that the tree does not already say is gone, and the
   * mass-delete guard has already counted it: the subtree's files are in
   * `preRestore` and absent from `expectedFiles`, which is exactly the
   * population it judges. So a type change that would empty a folder is still
   * refused before the walk reaches here.
   *
   * `lstat`, not `stat`: a symlink is a third kind of thing and must not be
   * followed to decide what to remove.
   * @param path - Where the node is to be written.
   * @param want - What the tree says should be there.
   * @returns Whether something had to be removed.
   */
  /**
   * Whether a path the prune is about to delete is actually the expected file
   * under another spelling of its name.
   *
   * On a case-insensitive filesystem `Angebot.docx` and `angebot.docx` are one
   * file, so the two paths share an inode. On a case-sensitive one they are
   * two files with two inodes, and the entry really is extraneous. Comparing
   * the inode answers both without knowing which kind of filesystem this is.
   * @param fullPath - The entry the prune found on disk.
   * @param expectedByLowerCase - Expected paths indexed by lower case.
   * @returns Whether the entry must be kept.
   */
  private async _isSameFileAsExpected(
    fullPath: string,
    expectedByLowerCase: Map<string, string>,
  ): Promise<boolean> {
    const expected = expectedByLowerCase.get(fullPath.toLowerCase());
    if (expected === undefined || expected === fullPath) return false;
    const [here, there] = await Promise.all([
      lstat(fullPath).catch(() => undefined),
      lstat(expected).catch(() => undefined),
    ]);
    /* v8 ignore next -- @preserve both were just walked or written */
    if (here === undefined || there === undefined) return false;
    const same = here.ino === there.ino && here.dev === there.dev;
    if (same) {
      console.warn(
        `${this._tag} restore: kept "${fullPath}" — the tree spells it ` +
          `"${expected}" and this filesystem treats them as one file`,
      );
    }
    return same;
  }

  private async _makeRoomFor(
    path: string,
    want: 'file' | 'directory',
  ): Promise<boolean> {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) return false;
    const isDir = existing.isDirectory();
    if (isDir === (want === 'directory')) return false;
    await rm(path, { recursive: true, force: true });
    this._restoreRetyped++;
    console.warn(
      `${this._tag} restore: "${path}" was a ${isDir ? 'directory' : 'file'} ` +
        `and the tree says ${want} — replacing it`,
    );
    return true;
  }

  static _isInsideRoot(target: string, relativePath: string): boolean {
    const root = resolve(target);
    const full = resolve(root, relativePath);
    return full === root || full.startsWith(root + sep);
  }

  private static _isImpossiblePath(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return (
      code === 'ENAMETOOLONG' ||
      code === 'EINVAL' ||
      code === 'EILSEQ' ||
      code === 'ENOTDIR'
    );
  }

  private static _isLocked(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
  }

  /**
   * The content identity this agent believes is on disk at `filePath`, or
   * `undefined` when it has no basis for an opinion.
   *
   * Two sources, both anchored on a real blobId rather than a guess:
   * what this agent last wrote there, and what the scanner hashed at its last
   * scan of the folder (which survives a restart, so a fresh process still
   * skips an unchanged 80 GB catalogue).
   * @param filePath - Absolute path of the file.
   * @param relativePath - Its path within the tree.
   * @param isOwnRoot - Whether the restore target is this agent's own folder,
   *   which is the only case where the scanner's view describes this file.
   * @returns The believed content identity, or `undefined`.
   */
  private _knownOnDisk(
    filePath: string,
    relativePath: string,
    isOwnRoot: boolean,
  ): { blobId: string; size: number; mtime: number } | undefined {
    const written = this._restoredBlobs.get(filePath);
    if (written) return written;
    if (!isOwnRoot) return undefined;
    // The scan's own record, not the tree's. A tree node carries no mtime —
    // it is excluded from the content identity so that refs do not depend on
    // it (see `FsScanner`) — and this check needs one, so it comes from the
    // scanner's cache of what it actually saw on disk.
    return this._scanner.knownFile(relativePath);
  }

  /**
   * Whether the file at `filePath` is already the content `meta` describes.
   *
   * The decision is anchored on the blobId: a different blobId is always
   * rewritten, whatever the timestamps say. Hashing the file instead would
   * mean reading 80 GB to avoid writing 80 GB, which saves nothing — so the
   * known blobId is verified against a `stat`, which catches a file edited
   * since this agent last had an opinion about it.
   *
   * Deliberately one-directional in its uncertainty: every unclear case
   * answers `false` and the file is rewritten. A needless write costs time; a
   * wrongly skipped write leaves the wrong bytes on disk indefinitely.
   *
   * Anchoring on the blobId is not belt-and-braces. Size and mtime alone
   * cannot see a same-size edit made inside the same millisecond — the scan
   * cache tolerates that, but a restore must not: there the cost is not a
   * stale cache entry, it is the wrong file contents left in place.
   * @param filePath - Absolute path of the file to check.
   * @param meta - The metadata describing the content that should be there.
   * @param isOwnRoot - Whether the target is this agent's own folder.
   * @returns `true` only when the file is certainly already correct.
   */
  private async _alreadyOnDisk(
    filePath: string,
    meta: FsNodeMeta,
    isOwnRoot: boolean,
  ): Promise<boolean> {
    const known = this._knownOnDisk(
      filePath,
      meta.relativePath,
      isOwnRoot,
    );
    if (!known || known.blobId !== meta.blobId) return false;
    try {
      const st = await stat(filePath);
      // Sub-millisecond tolerance, and it is load-bearing rather than
      // defensive: `utimes` takes a millisecond value but the filesystem
      // stores nanoseconds, and the value read back is routinely the one
      // below — 1787491136425 is written and 1787491136424.999 comes back.
      // Comparing exactly (or flooring) makes every file look modified, which
      // silently turns the whole optimisation off.
      return st.size === known.size && Math.abs(st.mtimeMs - known.mtime) < 1;
    } catch {
      // Not there, or not readable — write it.
      return false;
    }
  }

  /**
   * Gets the current tree structure
   */
  getTree(): FsTree | null {
    return this._scanner.tree;
  }

  /**
   * Checks if a blob exists in storage
   * @param blobId - Blob ID to check
   */
  async hasBlob(blobId: string): Promise<boolean> {
    return await this._adapter.hasBlob(blobId);
  }

  /**
   * Gets file content from blob storage
   * @param blobId - Blob ID
   */
  async getFileContent(blobId: string): Promise<Buffer> {
    return await this._adapter.getFileContent(blobId);
  }

  /**
   * Extracts and stores filesystem tree in database
   * Reads from filesystem, stores trees in DB and blobs in Bs
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param options - Storage options
   * @returns The root tree reference
   */
  async storeInDb(
    db: Db,
    treeKey: string,
    options?: StoreFsTreeOptions,
  ): Promise<string> {
    const tree = await this.extract();

    // Validate tree has content
    /* v8 ignore if -- @preserve */
    if (!tree || !tree.rootHash || !tree.trees) {
      throw new Error(
        'Cannot store empty or invalid tree in database. ' +
          'Ensure the filesystem has been scanned and contains valid data.',
      );
    }

    /* v8 ignore if -- @preserve */
    if (tree.trees.size === 0) {
      throw new Error(
        'Cannot store tree with no nodes. The tree structure is empty.',
      );
    }

    const dbAdapter = new FsDbAdapter(db, treeKey);
    return await dbAdapter.storeFsTree(tree, options);
  }

  /**
   * Recursively fetches all tree nodes starting from a root hash
   * Trees are stored as separate rows with parent-child relationships
   * This method follows the tree structure and fetches all related nodes
   * @param db - Database instance
   * @param route - Route to tree table
   * @param treeKey - Tree table key
   * @param rootHash - Hash of the root node to start fetching from
   * @returns Every node in the tree, keyed by its content hash
   */
  private async _fetchTreeRecursively(
    db: Db,
    route: Route,
    treeKey: string,
    rootHash: string,
  ): Promise<Map<string, any>> {
    const fetchedNodes = new Map<string, any>();
    const seen = new Set<string>([rootHash]);
    let frontier: string[] = [rootHash];

    // A level at a time, concurrently — not a node at a time, in series.
    //
    // This awaited one `db.get` per node. On the customer catalogue that is
    // 4 952 sequential round trips before a single byte of file content moves,
    // and the cost is `nodes × RTT`: invisible on localhost at 0.1 ms, 49 s at
    // 10 ms — which is why the fetch blew its 20 s budget three times running
    // and only succeeded on the fourth attempt. Measured end to end: a 6.2 s
    // cold start at 0 ms became 134.9 s at 10 ms and 332.1 s at 30 ms.
    //
    // A folder tree is wide and shallow — 4 952 nodes across five levels here —
    // so issuing a whole level at once turns thousands of SERIAL round trips
    // into a few concurrent ones. The requests themselves are unchanged: same
    // `db.get`, same route, same rows, same controller path. Only the waiting
    // is shared, which is the part that was costing the time.
    //
    // Bounded, because "the whole level at once" on a 184 000-file catalogue
    // would be tens of thousands of simultaneous requests — trading a latency
    // problem for a queueing one.
    while (frontier.length > 0) {
      const next: string[] = [];
      const collect = (dataArray: any[]): void => {
        for (const node of dataArray) {
          /* v8 ignore next -- @preserve */
          if (!node?._hash) continue;
          fetchedNodes.set(node._hash, node);

          if (node.children && Array.isArray(node.children)) {
            for (const childHash of node.children) {
              /* v8 ignore next -- @preserve */
              if (typeof childHash !== 'string' || seen.has(childHash)) {
                continue;
              }
              seen.add(childHash);
              next.push(childHash);
            }
          }
        }
      };

      // One request for the whole level, where the io can answer one.
      //
      // Concurrency alone only widened the problem: 39 617 nodes at 64 in
      // flight is 620 sequential batches, which at 30 ms is 18.6 s against a
      // 20 s budget — measured, and it timed out twice. That cost is LINEAR in
      // node count, so the 184 000-file catalogue cannot complete at all.
      // A batch read is flat: one round trip per level, whatever the level
      // holds.
      //
      // `Core.readRowsByHashes` uses the io's optional batch read where there
      // is one and falls back to per-hash reads where there is not, so every Io
      // implementation keeps working. What it does NOT always reproduce is
      // `db.get`'s access path — through a peer it returned nothing for a root
      // that `db.get` found — so anything it misses is fetched the proven way
      // below rather than being treated as absent.
      let unresolved = frontier;
      try {
        const rowsByHash = await FsAgent._withTimeout(
          db.core.readRowsByHashes(treeKey, frontier),
          this._timeouts.dbQuery,
          `readRowsByHashes(${treeKey}, ${frontier.length})`,
        );
        if (rowsByHash.size > 0) {
          collect(Array.from(rowsByHash.values()));
          unresolved = frontier.filter((h) => !rowsByHash.has(h));
        }
      } catch {
        // Batch reads are an optimisation. A failure here is not a failure of
        // the walk — every hash simply goes down the per-node path.
        unresolved = frontier;
      }

      for (let i = 0; i < unresolved.length; i += TREE_FETCH_CONCURRENCY) {
        const batch = unresolved.slice(i, i + TREE_FETCH_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (hash) => {
            try {
              return await FsAgent._withTimeout(
                db.get(route, { _hash: hash }),
                this._timeouts.dbQuery,
                `db.get(${treeKey}, _hash=${hash.slice(0, 8)}…)`,
              );
            } catch (error) {
              // A timeout is systemic and must surface; a missing node is
              // ordinary — a blob reference, or one that was deleted — and was
              // tolerated by the per-node walk too.
              if (error instanceof Error && error.message.startsWith('Timeout')) {
                throw error;
              }
              /* v8 ignore start -- @preserve */
              const errMsg =
                error instanceof Error ? error.message : String(error);
              console.warn(
                `${this._tag} _fetchTreeRecursively: db.get failed for ` +
                  `hash=${hash.slice(0, 8)}…: ${errMsg}`,
              );
              this._writeSyncError(
                `fetchTree/db.get(${hash.slice(0, 8)}…)`,
                error,
              );
              return null;
              /* v8 ignore stop -- @preserve */
            }
          }),
        );

        for (const result of results) {
          const treeData = result?.rljson?.[treeKey];
          /* v8 ignore next -- @preserve */
          if (!treeData || !treeData._data) continue;

          /* v8 ignore next -- @preserve */
          collect(
            Array.isArray(treeData._data)
              ? treeData._data
              : Object.values(treeData._data),
          );
        }
      }

      frontier = next;
    }

    return fetchedNodes;
  }

  /**
   * Fetches tree from database without restoring to filesystem.
   * Separated from loadFromDb to allow content comparison before restore.
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param rootRef - Root tree reference (hash)
   * @returns FsTree structure ready for restore
   */
  private async _fetchTreeFromDb(
    db: Db,
    treeKey: string,
    rootRef: string,
  ): Promise<FsTree> {
    // Validate inputs
    if (!rootRef || rootRef.trim() === '') {
      throw new Error('rootRef cannot be empty');
    }

    // Recursively fetch all tree nodes starting from root
    // Trees are stored as multiple rows - querying by hash only returns one node
    // We need to fetch the root node and recursively fetch all children
    const route = Route.fromFlat(treeKey);
    const allNodes = await FsAgent._withTimeout(
      this._fetchTreeRecursively(db, route, treeKey, rootRef),
      this._timeouts.fetchTree,
      `fetchTree(${treeKey}@${rootRef.slice(0, 8)}…)`,
    );

    if (allNodes.size === 0) {
      throw new Error(
        `No tree nodes found for ${treeKey}@${rootRef}. ` +
          `The tree may have been deleted or the reference is invalid.`,
      );
    }

    // The walk already keyed every node by its hash, so this IS the trees map.
    // It used to be flattened to an array and rebuilt into a map: 158 465
    // entries copied twice for no gain.
    const trees = allNodes;

    // Validate root tree exists
    /* v8 ignore if -- @preserve */
    if (!trees.has(rootRef)) {
      throw new Error(
        `Root tree node "${rootRef}" not found in tree data. ` +
          `Available hashes: ${Array.from(trees.keys()).slice(0, 5).join(', ')}${trees.size > 5 ? '...' : ''}`,
      );
    }

    return { rootHash: rootRef, trees };
  }

  /**
   * Loads tree from database and restores to filesystem
   * Writes to filesystem from DB trees and Bs blobs
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param rootRef - Root tree reference (hash)
   * @param targetPath - Optional target path (defaults to rootPath)
   * @param options - Restore options
   */
  async loadFromDb(
    db: Db,
    treeKey: string,
    rootRef: string,
    targetPath?: string,
    options?: RestoreOptions,
  ): Promise<void> {
    const fsTree = await this._fetchTreeFromDb(db, treeKey, rootRef);
    await this._timed('apply.write', () =>
      this.restore(fsTree, targetPath, options),
    );
  }

  /**
   * Collects expected file and directory paths for cleanup
   * @param tree - Tree structure to evaluate
   * @param target - Filesystem root where the tree will be restored
   */
  private _collectExpectedPaths(
    tree: FsTree,
    target: string,
  ): {
    expectedDirs: Set<string>;
    expectedFiles: Set<string>;
  } {
    const expectedDirs = new Set<string>([target]);
    const expectedFiles = new Set<string>();

    for (const [, node] of tree.trees) {
      const meta = node?.meta as FsNodeMeta | null | undefined;
      /* v8 ignore if -- @preserve */
      if (!meta) {
        continue;
      }
      if (meta.type === 'directory') {
        const dirPath =
          meta.relativePath === '.' ? target : join(target, meta.relativePath);
        expectedDirs.add(dirPath);
      } else if (meta.type === 'file') {
        const filePath = join(target, meta.relativePath);
        expectedFiles.add(filePath);
        expectedDirs.add(dirname(filePath));
      }
    }

    return { expectedDirs, expectedFiles };
  }

  /**
   * Remove files/dirs not present in the expected sets, preserving any file
   * that appeared *during* the restore (not in `preRestore`) — a fresh user
   * write that must not be clobbered.
   * @param currentDir - Directory currently being inspected
   * @param expectedDirs - Allowed directory paths
   * @param expectedFiles - Allowed file paths
   * @param preRestore - Files present before the restore (prune candidates)
   * @param expectedByLowerCase - Expected paths indexed by lower case, so a
   *   file the tree spells with different capitalisation is recognised as the
   *   same file rather than pruned.
   */
  private async _pruneExtraneous(
    currentDir: string,
    expectedDirs: Set<string>,
    expectedFiles: Set<string>,
    preRestore: Set<string>,
    // Defaulted so a caller that does not care about case — the tests that
    // drive this directly — gets the behaviour it asks for rather than a
    // crash. An empty index simply matches nothing, which is the same answer
    // as a case-sensitive filesystem.
    expectedByLowerCase: Map<string, string> = new Map(),
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      /* v8 ignore next -- @preserve unreadable dir → nothing to prune */
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Recurse first (pruning contents with the same protection), then
        // remove the directory only if it is unexpected AND now empty — so a
        // fresh file inside an otherwise-extraneous dir is never lost.
        await this._pruneExtraneous(
          fullPath,
          expectedDirs,
          expectedFiles,
          preRestore,
          expectedByLowerCase,
        );
        if (!expectedDirs.has(fullPath)) {
          const remaining = await readdir(fullPath);
          if (remaining.length === 0) {
            await rm(fullPath, { recursive: true, force: true });
          }
        }
      } else if (!expectedFiles.has(fullPath) && preRestore.has(fullPath)) {
        // A file may be pruned only when it existed BEFORE the restore (it's in
        // `preRestore`). A file that appeared *during* the restore is a fresh
        // user write — preserve it so cleanTarget can't delete something the
        // user saved while a restore was in flight.
        //
        // NO "could a peer have known about this file?" guard any more.
        //
        // It existed because this ran on the peer-apply path, where a file
        // written a moment ago and not yet announced was invisible to every
        // sender, so a tree lacking it looked like a deletion. Measured on
        // four machines: with 1 200 files converged, a file was created and
        // vanished from EVERY node including the one that created it, one run
        // in four.
        //
        // The apply no longer prunes at all, so the only caller left is a
        // direct `restore({ cleanTarget: true })` — a caller saying "make this
        // folder be exactly this tree". Second-guessing that with a guard
        // about what peers know would be answering a question nobody asked.
        // Is this the expected file under a different spelling of its name?
        //
        // Decided by INODE rather than by assuming anything about the
        // filesystem, which gets both kinds right with one rule: on a
        // case-insensitive volume the expected path and this entry are the
        // same file and it must be kept; on a case-sensitive one they are two
        // files and this one really is extraneous. No probing, no platform
        // check, no configuration. See `expectedByLowerCase`.
        if (await this._isSameFileAsExpected(fullPath, expectedByLowerCase)) {
          this._restoreSkipped++;
          continue;
        }
        await rm(fullPath, { force: true });
        this._restorePruned++;
      }
    }
  }

  /**
   * Watches filesystem for changes and syncs to database
   * Uses Connector for socket-based broadcast
   * @param db - Database instance
   * @param connector - Connector instance for socket-based sync
   * @param treeKey - Tree table key
   * @param options - Storage options (e.g., skipNotification)
   * @returns Function to stop watching
   */
  async syncToDb(
    db: Db,
    connector: Connector,
    treeKey: string,
    options?: StoreFsTreeOptions,
  ): Promise<() => void> {
    // Store initial state. If we already have an ancestry head (e.g. on
    // reconnect after offline edits), the initial revision descends from it —
    // chain `previous` and broadcast the predecessor so the divergence is
    // detectable as a fork rather than an orphan root.
    // A restart starts with no `_currentRef`, so without this the first push
    // declares no ancestry — and a push with no ancestry is one every peer
    // must apply additively, because it cannot be checked for staleness.
    // Reload what this folder was last recorded at, so a node coming back
    // after a disconnect can still say what it descends from and peers can
    // recognise its tree as the older one it is.
    if (this._currentRef === undefined) {
      const persisted = this._loadPersistedRef();
      if (persisted !== undefined) {
        this._currentRef = persisted;
        console.log(
          `${this._tag} resuming from recorded ref ${persisted.slice(0, 8)}… — ` +
            `this folder can declare its ancestry`,
        );
        // AND WHAT THAT REF CONTAINED, which is the half that was missing.
        //
        // A restart reloaded the NAME of the state it was last in and nothing
        // about its contents, so its first push computed a delta against an
        // empty map — `first`, stating nothing. For an addition that is
        // harmless, because the file is in the tree and travels anyway. For a
        // DELETION it is silent data retention: the folder lost a file the
        // history still names, nobody states the removal, and every peer keeps
        // it for ever.
        //
        // Measured by `J9: a deletion made while the agent was down
        // propagates` (`fs-mesh-matrix.spec.ts`), three runs of three, once
        // the harness could stop and start a node at all. It is what every
        // crash and every "deleted while the client was closed" produces.
        //
        // The tree is read from this node's OWN database — the state it
        // recorded is one it has — so nothing is asked of the network here.
        // Failing to read it leaves the old behaviour, which is additive.
        const wasAt = await this._fetchTreeFromDb(db, treeKey, persisted).catch(
          () => undefined,
        );
        if (wasAt) {
          this._announcedContent = this._getFileContentMap(wasAt);
          this._hasAnnounced = true;
          console.log(
            `${this._tag} recovered ${this._announcedContent.size} known path(s) ` +
              `from that state — changes made while stopped can be stated`,
          );
        }
      }
    }
    const initialParentRef = this._currentRef;
    const initialTree = await FsAgent._withTimeout(
      this.extract(),
      this._timeouts.extract,
      `syncToDb → initial extract(${treeKey})`,
    );
    const initialIsNew =
      initialParentRef !== undefined &&
      initialTree.rootHash !== initialParentRef;
    const initialPrevious = initialIsNew
      ? await this._ancestryPrevious(db, treeKey, [initialParentRef as string])
      : undefined;
    // Decided BEFORE the store, because the store is what announces.
    //
    // Declining to call `_sendRef` is not enough to stay quiet: the connector
    // observes local inserts and broadcasts them, so writing the tree IS the
    // announcement. The quiet-join message printed while the empty ref went out
    // on the very next line — silence in the log and a claim on the wire.
    //
    // Measured at catalogue scale, where it stops being cosmetic: a client
    // joining a network holding 116 544 files announced its own empty tree,
    // that became the network's latest state, and the joiner then received its
    // own emptiness back and sat at 0 files.
    //
    // The row is still written — ancestry and the restore path both need it —
    // just not announced.
    const isSilentJoiner =
      initialParentRef === undefined && this._treeIsEmpty(initialTree);

    // A FOLDER WITH FILES AND NO HISTORY DOES NOT SPEAK FIRST EITHER.
    //
    // It used to: a starting agent authored a lineage root from whatever it
    // happened to hold and announced it as the network's newest claim. That is
    // one defect wearing two faces — every node got its own lineage root, so
    // `classify` answered `fork` to every announcement ever made; and a node
    // restored from a backup pushed deleted files back to the whole fleet.
    //
    // The chain applies FIRST and the filesystem only then. So a node in this
    // state waits for a head, reconciles against it (`_reconcileJoin`), and
    // announces afterwards. If no head arrives it IS the origin, and the
    // ordinary first push states its folder as the first state — which is why
    // this is a deferral and never a refusal: a brand-new network has to be
    // startable.
    const joinsWithUnknownFiles =
      this._joinWaitMs > 0 &&
      initialParentRef === undefined &&
      !this._treeIsEmpty(initialTree);
    if (joinsWithUnknownFiles) {
      this._deferToNetwork(db, connector, treeKey, 'holds files and no history');
    }

    // A node that comes back UNCHANGED has nothing to announce.
    //
    // Its scan reproduces the ref it recorded before it stopped, so
    // `initialIsNew` is false and `initialPrevious` is undefined — but the
    // insert still notifies, and the connector then broadcasts that ref with
    // NO predecessors. An announcement without ancestry is prune-authorising:
    // a receiver cannot ask "does this sender name a state I am in", so it
    // grants the prune by default.
    //
    // Measured on the lab, ten minutes apart:
    //
    //   14:53:18 NB-21624 resuming from recorded ref COpHl4bU… (4 547 files)
    //   14:53:19 NB-21624 sync:out COpHl4bU…
    //   15:03:57 NB-2510  sync:in  COpHl4bU…
    //   15:04:00 NB-2510  applying declaresAncestry=false mayPrune=true
    //                     incomingFiles=4547 currentFiles=4581
    //   15:04:00 NB-2510  restore: wrote 0, left 3617 untouched
    //
    // Two peers rolled back 35 files — under the mass-delete guard's floor, so
    // nothing challenged it — and the file that had just been added was undone
    // rather than lost in transit. One in five probes failed this way.
    //
    // The state is already in the network's history; re-announcing it as
    // current is the whole of the damage. Staying quiet costs nothing: this
    // node needs to RECEIVE what it missed, not to tell anyone about a state
    // it has not changed.
    const resumingUnchanged =
      initialParentRef !== undefined &&
      initialTree.rootHash === initialParentRef;

    const initialRef = await FsAgent._withTimeout(
      new FsDbAdapter(db, treeKey).storeFsTree(initialTree, {
        ...options,
        previous: initialPrevious,
        skipNotification:
          isSilentJoiner || resumingUnchanged || joinsWithUnknownFiles
            ? true
            : options?.skipNotification,
      }),
      this._timeouts.fetchTree,
      `syncToDb → initial storeFsTree(${treeKey})`,
    );

    // A machine with nothing to say does not speak.
    //
    // An agent whose folder is empty AND which has no remembered state has
    // established nothing about this treeKey. Announcing that emptiness is not
    // reporting a fact, it is making a claim — and the network takes the newest
    // claim as the current state, so a machine joining an idle network made
    // emptiness the truth and the bootstrap then handed it back to everyone.
    //
    // The mass-delete guard stops that costing data, but it cannot make the
    // joiner's folder fill: with its own empty tree as the network's latest
    // ref there is nothing for the bootstrap to deliver. Measured on the real
    // customer folder: 0 of 3642 files after 60 s, twice.
    //
    // Staying silent leaves the populated state as the latest one, which is
    // what the existing bootstrap already knows how to send.
    //
    // The remembered ref is what separates the two cases, and it must be: a
    // folder the USER emptied has a remembered state, so that deletion is a
    // fact about a folder this agent was tracking and still goes out.
    await this._ensureChain(db, treeKey);

    if (isSilentJoiner) {
      console.warn(
        `${this._tag} ${this._rootPath} is empty and has no remembered state — ` +
          `joining quietly rather than announcing emptiness.`,
      );
      this._currentRef = initialRef;
      this._persistCurrentRef(initialRef);
      this._lastSentContentKey = this._contentKeyFromTree(initialTree);
      this._rememberAnnounced(initialTree);
    }

    // Send initial ref through connector (self-filtering will prevent loops)
    /* v8 ignore next -- @preserve */
    if (joinsWithUnknownFiles) {
      // Recorded locally so the reconcile has something to compare, but NOT
      // announced and NOT written to the chain: nothing here is established
      // until a head has been seen.
      this._currentRef = initialRef;
      this._lastSentContentKey = this._contentKeyFromTree(initialTree);
    } else if (initialRef && !isSilentJoiner) {
      this._lastSentRef = initialRef;
      this._lastPushedRef = initialRef;
      this._currentRef = initialRef;
      this._persistCurrentRef(initialRef);
      this._lastSentContentKey = this._contentKeyFromTree(initialTree);
      await this._recordChainEntry(
        initialRef,
        this._rememberAnnounced(initialTree),
      );
      await this._sendRef(
        connector,
        initialRef,
        initialIsNew ? [initialParentRef as string] : undefined,
      );
    }

    // Debounced callback: coalesce rapid filesystem events (e.g. macOS
    // Finder "Keep Both" copy + rename) into a single store+broadcast.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Lets the apply path re-run a rescan it had to suppress. Registered here
    // because the handler is what knows how to push.
    this._flushDeferredRescan = () => {
      if (!this._rescanDeferred) return;
      this._rescanDeferred = false;
      debouncedSync({ type: 'safety-rescan', path: '.' });
    };

    const debouncedSync = (change?: FsChange) => {
      // A local deletion, recorded the moment the watcher reports it — before
      // the push that will announce it, which is the window an incoming apply
      // can undo it in.
      if (change?.type === 'deleted' && change.path !== '.') {
        // Only a path this node ANNOUNCED as a file.
        //
        // The watcher's path is not trustworthy on its own. Deleting one
        // nested file on macOS emits TWO deletions — the file, and the ROOT
        // FOLDER'S OWN NAME:
        //
        //   ["deleted:test-temp-diag", "deleted:nested/deep.txt"]
        //
        // It also reports directories as `modified`. That was harmless while
        // this set was cleared on every announcement; a log that outlives the
        // push turns it into a permanent tombstone for a file that never
        // existed, and on a folder deletion into one per file — refused
        // forever if anyone ever restores them.
        //
        // `_announcedFiles` is the set the prune rule already uses for "a file
        // peers could know about", and it answers both problems at once: a
        // directory was never in it, nor was the root, nor was a file deleted
        // before it was ever announced — and that last one needs no tombstone,
        // because no peer can push it back.
        const deleted = join(this._rootPath, change.path);
        if (this._announcedFiles.has(deleted)) {
          this._pendingDeletes.add(deleted);
          this._persistTombstones();
        }
      }
      // A local re-creation supersedes the tombstone. Without this, a path
      // deleted once could never be written again on this node: the guard in
      // `_restoreTree` would refuse every later copy of it, forever.
      //
      // Safe against the agent's own writes: a restore pauses the watcher, so
      // only a real local change reaches here.
      if (
        (change?.type === 'added' || change?.type === 'modified') &&
        this._pendingDeletes.delete(join(this._rootPath, change.path))
      ) {
        this._persistTombstones();
      }
      // A rescan-driven push during a remote apply re-asserts stale state.
      // Real watcher events are unambiguous local changes and still go out.
      if (change?.type === 'safety-rescan' && this._remoteApplyInFlight) {
        // Deferred, NOT discarded.
        //
        // A rescan-driven push during a remote apply would re-assert stale
        // state, so it must not go out now. Dropping it outright loses the
        // change, and how often that happens scales with the folder: an apply
        // on a small folder is instant, so a rescan almost never lands inside
        // one — an apply on a big folder takes seconds, and the rescan runs
        // every five, so nearly every one is thrown away.
        //
        // Reported from a live pair on a 3 702-file folder: fs.watch delivered
        // only coarse directory-level events (Windows coalesces or overflows
        // ReadDirectoryChangesW on a large recursive tree), the rescan that
        // exists to cover exactly that fired and logged — and the files it
        // found never reached the peer. The rescan was working; this line was
        // eating it.
        this._rescanDeferred = true;
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        const tree = this._scanner.tree;
        /* v8 ignore if -- @preserve */
        if (tree) {
          try {
            // Content-level dedup: if the tree has the exact same files +
            // blobIds as the last tree we broadcasted, skip entirely.
            // This catches bounce-backs that have different mtimes (and
            // therefore different tree hashes / refs) but identical content.
            const contentKey = this._contentKeyFromTree(tree);
            if (contentKey === this._lastSentContentKey) {
              return;
            }

            const dbAdapter = new FsDbAdapter(db, treeKey);
            // Ancestry: this local edit descends from the current head ref.
            //
            // **Unless the head IS what this push is about to announce.** The
            // apply path sets `_currentRef` to the post-restore ref whether or
            // not this node had news of its own, and only records the content
            // key when it had none. Holding one file the incoming tree lacked
            // therefore leaves the echo check looking at a stale key: the
            // watcher re-scans the folder it was just given, derives the ref
            // `_currentRef` already names, and announces it — declaring itself
            // as its own parent.
            //
            // A receiver prunes only for a sender that names a state the
            // RECEIVER is in, and no receiver is ever in a state named by the
            // ref being announced. So every deletion such a push carried was
            // refused by everyone it reached. Measured on four machines: 5 of
            // 38 pushes in one run, with the peers saying so —
            // `descends from P5pEmrvZ, not from a state this node is in`.
            //
            // The honest parent in that case is the state it actually built
            // on: the ref it last applied. That is a claim peers can check,
            // and the ones sitting in it can act on.
            //
            // `tree.rootHash` is that ref: a tree's hash is its content, which
            // is what the store derives too — the startup path already
            // compares the two this way.
            // Generalised from the narrower `head === tree.rootHash` case
            // above, because that case was one instance of a wider rule: a
            // parent is only useful if it names a state SOMEBODY ELSE can be
            // in, and `_currentRef` need not be one.
            //
            // The apply path sets `_currentRef` to the ref this node
            // re-derives by re-scanning the folder it was just given — and
            // that is not always the ref it applied. A file node's hash
            // includes its mtime, so two nodes holding the SAME BYTES derive
            // different refs whenever the bytes were created independently
            // rather than restored: the same document saved on two machines, a
            // seeded fixture, a folder copied twice. Measured on four nodes,
            // the same `keeper.txt` carried `…104.2852`, `…104.4375` and
            // `…104.5483`, and which millisecond each truncated to decided the
            // whole folder's ref.
            //
            // Such a ref is PRIVATE: this node derived it and never announced
            // it, so no peer can be in it. A push naming it as parent has its
            // deletions refused by everybody — and that is the mechanism
            // behind `KNOWN-WEAKNESSES.md` §1, the register's
            // most-reproduced entry. A directory removal is what exposes it,
            // exactly as the register says: *"a rename or a directory removal
            // is 'delete everything and re-add' to this system"*, so the
            // folder must return to a state whose ref still agrees.
            //
            // So: descend from the head only when this node ANNOUNCED it.
            // Otherwise descend from what it last applied, which is a ref its
            // sender published and peers can therefore be sitting in.
            //
            // Measured on 10 runs of the four-node directory deletion: 8 of
            // 10 with the old rule, 9 of 10 with this one. So it helps and it
            // does not close §1 — a private ref is still private, and the
            // merge can still resurrect what one node deleted. What closes it
            // is taking mtime out of the content identity, so the refs never
            // diverge in the first place; this rule is what keeps a push
            // honest for the cases that remain, where a node legitimately
            // re-derives something else (a tombstoned refusal, a locked file,
            // an unfetchable blob).
            const head = this._currentRef;
            const announced = head !== undefined && head === this._lastSentRef;
            const parentRef = announced ? head : (this._lastAppliedRef ?? head);
            // BOUNDED, like every other async step — and this one was not.
            //
            // `_ancestryPrevious` is the legacy db-level ancestry: a query per
            // parent ref against the InsertHistory. It was the only `await` in
            // the push path with no timeout around it, and it HANGS when the
            // read has to traverse a peer that cannot answer — a cut node, a
            // half-open socket. Nothing recovered, because the push had not
            // reached the store's own timeout yet: it was still inside this
            // call, for ever, and the node never announced its own work.
            //
            // A failure DEGRADES rather than aborts: `previous` is optional
            // (it is `undefined` whenever ancestry tracking is off), so the
            // push goes out without the db-level predecessors rather than not
            // at all. The edit chain carries the ancestry that matters now.
            // Said out loud, because a push without ancestry is a weaker push.
            const previous = await FsAgent._withTimeout(
              this._ancestryPrevious(
                db,
                treeKey,
                parentRef ? [parentRef] : undefined,
              ),
              this._timeouts.dbQuery,
              `syncToDb → ancestryPrevious(${treeKey})`,
            ).catch((err) => {
              console.warn(
                `${this._tag} ancestry lookup for this push did not finish — ` +
                  `announcing without db-level predecessors: ${String(err)}`,
              );
              this._writeSyncError('syncToDb/ancestryPrevious', err);
              return undefined;
            });
            const ref = await FsAgent._withRetry(
              () =>
                FsAgent._withTimeout(
                  // skipNotification, because THIS AGENT broadcasts the ref
                  // itself a few lines below, with the ancestry attached.
                  //
                  // Letting the insert notify sends the ref twice, and the
                  // first copy is the wrong one: the connector attaches
                  // whatever predecessors it currently holds, and this push has
                  // not set its own yet — so the ref goes out carrying the
                  // PREVIOUS push's parent. `_sendRef` then sets the right
                  // ancestry and sends again, and every receiver drops that
                  // second copy as already-received.
                  //
                  // Measured on the lab, sender against receivers:
                  //
                  //   sent  6guj63Ox parent yNAJN-wC | seen  parent CtAgdd1w
                  //   sent  UBl35ZQQ parent 6guj63Ox | seen  parent yNAJN-wC
                  //
                  // Every push arriving one parent behind. Harmless while
                  // nothing read the ancestry; now that a receiver prunes only
                  // for a sender that names a state it is in, it means a
                  // correctly-formed deletion is refused by everyone — which is
                  // exactly what the large-folder recipe has been reporting.
                  //
                  // The doubled `[sync:out]` line in every log was this, in
                  // plain sight, for the whole investigation.
                  dbAdapter.storeFsTree(tree, {
                    ...options,
                    previous,
                    skipNotification: true,
                  }),
                  this._timeouts.fetchTree,
                  `syncToDb → storeFsTree(${treeKey})`,
                ),
              3,
              200,
              `syncToDb storeFsTree(${treeKey})`,
            );
            this._currentRef = ref;
            this._persistCurrentRef(ref);

            // Skip broadcast if the ref matches what we already sent.
            // This happens after syncFromDb restores files: the watcher
            // fires, we store the same tree, and get the same ref back.
            if (ref === this._lastSentRef) {
              return;
            }

            // A FOLDER THAT HAS LOST EVERYTHING HAS NOT DELETED EVERYTHING.
            //
            // A wipe — a disk failure, a folder unmounted and recreated, a
            // sync root someone moved — looks to a watcher like the user
            // deleting every file at once. The other nodes refuse to follow it
            // (`ALL_GONE_MIN_FILES`), which is why no data is lost; but this
            // node then sits empty for ever, because its own history says it
            // meant it. Its head descends from the fleet's, so the fleet's
            // state arrives as a ROLLBACK and is ignored, while the fleet
            // ignores its emptiness. Both sides are right and nothing moves.
            //
            // So an empty folder with a non-empty history is treated as a
            // LOSS: this node stops claiming anything, forgets the lineage
            // that says it emptied itself, and asks the network for its state
            // as a new machine would.
            //
            // THE FLOOR HERE IS THE MASS-DELETE ONE, NOT `ALL_GONE_MIN_FILES`,
            // and the two differ because the two costs differ. The receiving
            // side refuses to APPLY a state that would empty it, and refusing
            // is free: nothing is lost, the sender re-announces, anti-entropy
            // settles it. Refusing to ANNOUNCE is not free — it suppresses the
            // user's own deletion and then asks the network to put the files
            // back, which is a resurrection. So a receiver may be cautious
            // from ten files; an author may not be, and emptying a folder of
            // fewer than a hundred files is a deletion like any other.
            //
            // `fs-scale`'s T1 caught this: it churns by writing twenty files
            // and deleting all twenty, and with the receiver's floor here that
            // ordinary emptying was swallowed as a wipe, so the tombstone log
            // the test measures stayed at zero on every sample.
            const wasHolding = this._announcedContent.size;
            if (
              this._treeIsEmpty(tree) &&
              wasHolding > MASS_DELETE_MIN_FILES &&
              this._joinPending === undefined
            ) {
              console.warn(
                `${this._tag} ${this._rootPath} is empty and its history holds ` +
                  `${wasHolding} file(s) — treating this as a LOSS, not a ` +
                  `deletion, and re-joining as a new machine.`,
              );
              this._writeSyncError(
                'push/folderLost',
                new Error(
                  `folder emptied while history held ${wasHolding} files; ` +
                    `re-joining rather than announcing it`,
                ),
              );
              // Nothing here was deleted by anybody, so nothing is tombstoned
              // and nothing is claimed. Forgetting the lineage is what stops
              // the fleet's state looking like a rollback.
              this._pendingDeletes.clear();
              this._persistTombstones();
              this._localPathTimeIds.clear();
              this._announcedContent = new Map();
              this._hasAnnounced = false;
              this._chainHead = undefined;
              this._currentRef = undefined;
              this._lastSentRef = undefined;
              this._lastPushedRef = undefined;
              this._lastSentContentKey = undefined;
              this._deferToNetwork(
                db,
                connector,
                treeKey,
                'has lost its contents',
              );
              return;
            }

            // Track the ref and content we're sending
            this._lastSentRef = ref;
            this._lastPushedRef = ref;
            this._lastSentContentKey = contentKey;
            await this._recordChainEntry(ref, this._rememberAnnounced(tree));

            // Leaving a state by our OWN edit retires it, exactly as adopting
            // a state by an incoming one does (`_adoptAppliedRef`). Only the
            // receive side did this, and the asymmetry silently broke deletes.
            //
            // A tree ref is a content hash, so the state a folder returns to
            // re-derives the ref it had before. Deleting a file restores the
            // folder to precisely the state it was in before that file
            // existed — the same ref, every time.
            //
            // So: this agent receives the seed state at startup, marks that
            // ref received, then creates a file and moves off it by its own
            // push. The ref of the state it just LEFT stays marked. A peer
            // that now deletes the file advertises exactly that ref, and the
            // connector drops it as already-received before any listener sees
            // it. The file is gone on the deleter and stays forever on the
            // other.
            //
            // Measured on a four-client local reproduction: a delete issued by
            // a client that had only RECEIVED the file failed roughly one round
            // in six, and failed on whichever peer had not happened to re-send
            // that ref since — which is why it looked like it moved around.
            // Deleting a file you created yourself always worked, because the
            // creator's own push had retired the ref on the way past.
            if (parentRef && parentRef !== ref) {
              connector.invalidateReceived(parentRef);
            }

            // Broadcast the new ref, carrying the predecessor ref so peers can
            // record correct ancestry.
            //
            // The parent is logged because it is now load-bearing: a receiver
            // prunes only for a sender that declares a state the receiver is
            // in, so a push that names a stale parent has its DELETIONS
            // refused. Measured on the lab — a node pushed a new file as
            // 2Rhrtyln, then pushed a deletion one and a half seconds later
            // claiming to descend from zvEHrFbO, the state before it. All three
            // peers refused, correctly, and the file stayed. Nothing in the
            // sender's log said which parent it had used.
            if (ref) {
              console.log(
                `${this._tag} pushing ref=${ref.slice(0, 8)}… ` +
                  `parent=${parentRef?.slice(0, 8) ?? 'none'} ` +
                  `files=${this._getFileContentMap(tree).size}`,
              );
              await this._timed('push.announce', () =>
                this._sendRef(
                  connector,
                  ref,
                  parentRef ? [parentRef] : undefined,
                ),
              );
            }
          } catch (err) {
            /* v8 ignore start -- @preserve */
            // Don't re-throw — one sync failure must not crash the watcher
            console.error(`${this._tag} syncToDb failed:`, err);
            this._writeSyncError('syncToDb', err);
          }
          /* v8 ignore stop -- @preserve */
        }
      }, this._timeouts.debounceMs);
    };

    // Register callback and start watching
    this._scanner.onChange(debouncedSync);
    await this._ensureWatching();

    // Return cleanup function
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      this._scanner.offChange(debouncedSync);
      this._scanner.stopWatch();
    };
  }

  /**
   * Resolves the `previous` (InsertHistory predecessor timeIds) for a new
   * revision from the parent's shared content refs. timeIds are per-db, so we
   * map each shared parent ref to *this* db's local timeId(s). Returns undefined
   * when ancestry tracking is off (default) or no parent is known — in which
   * case the store behaves exactly as before.
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param parentRefs - Parent content refs (local head, or received predecessors)
   */
  private async _ancestryPrevious(
    db: Db,
    treeKey: string,
    parentRefs: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (!this._resolveConflicts || !parentRefs || parentRefs.length === 0) {
      return undefined;
    }
    const timeIds: string[] = [];
    for (const ref of parentRefs) {
      timeIds.push(...(await db.getTimeIdsForRef(treeKey, ref)));
    }
    return timeIds.length > 0 ? timeIds : undefined;
  }

  /**
   * Classifies an incoming revision relative to our current head using the
   * local InsertHistory DAG (keyed on shared content refs):
   *  - `behind`   → incoming descends from our head → fast-forward (restore).
   *  - `ahead`    → our head descends from incoming (e.g. a reconnect bootstrap
   *                 re-sending an older ancestor) → ignore; we are newer.
   *  - `diverged` → siblings produced by concurrent edits → resolve the fork.
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param currentRef - Our current head's content ref
   * @param incomingRef - The incoming revision's content ref
   * @param incomingPredecessorRefs - The incoming revision's predecessor refs
   */
  private async _ancestryRelation(
    db: Db,
    treeKey: string,
    currentRef: string,
    incomingRef: string,
    incomingPredecessorRefs: string[],
  ): Promise<'behind' | 'ahead' | 'diverged'> {
    const dump = await db.getInsertHistory(treeKey);
    /* v8 ignore next -- @preserve the history table exists once revisions stored */
    const rows = (dump[`${treeKey}InsertHistory`]?._data ?? []) as Array<
      InsertHistoryRow<string> & Record<string, string>
    >;
    const refKey = `${treeKey}Ref`;
    const refOfTimeId = new Map<string, string>();
    for (const r of rows) {
      refOfTimeId.set(r.timeId, r[refKey]);
    }
    // ref → predecessor refs (translate the per-db timeIds to shared refs).
    const prevRefsOf = new Map<string, string[]>();
    for (const r of rows) {
      const prev = (r.previous ?? [])
        .map((t) => refOfTimeId.get(t))
        .filter((x): x is string => x !== undefined);
      prevRefsOf.set(r[refKey], prev);
    }
    const ancestorsOf = (startRefs: string[]): Set<string> => {
      const seen = new Set<string>();
      const stack = [...startRefs];
      while (stack.length > 0) {
        const ref = stack.pop() as string;
        if (seen.has(ref)) {
          continue;
        }
        seen.add(ref);
        for (const p of prevRefsOf.get(ref) ?? []) {
          stack.push(p);
        }
      }
      return seen;
    };

    if (ancestorsOf(incomingPredecessorRefs).has(currentRef)) {
      return 'behind';
    }
    if (ancestorsOf([currentRef]).has(incomingRef)) {
      return 'ahead';
    }
    return 'diverged';
  }

  /**
   * Resolves a divergent incoming revision inline (called from `processRef`
   * with the watcher paused, so resolution cannot race the sync loop). Records
   * the incoming revision as a fork tip without clobbering local content, then
   * merges our head and the incoming tip into a single merge revision D that is
   * materialised to disk and broadcast.
   * @param db - Database instance
   * @param treeKey - Tree table key
   * @param incomingRef - The incoming revision's content ref
   * @param incomingTree - The fetched incoming tree
   * @param predecessorRefs - The incoming revision's predecessor content refs
   */
  private async _resolveConflictInline(
    db: Db,
    treeKey: string,
    incomingRef: string,
    incomingTree: FsTree,
    predecessorRefs: string[],
  ): Promise<void> {
    // The folder BEFORE the merge touches it, so `_recordReceived` can tell
    // what was delivered from what was already here. See its doc.
    const beforeMerge = this._scanner.tree ?? { rootHash: '', trees: new Map() };
    const dbAdapter = new FsDbAdapter(db, treeKey);
    const incomingPrevious = await this._ancestryPrevious(
      db,
      treeKey,
      predecessorRefs,
    );
    await dbAdapter.storeFsTree(incomingTree, {
      skipNotification: true,
      previous: incomingPrevious,
    });

    const headTimeIds = await db.getTimeIdsForRef(treeKey, this._currentRef!);
    const incomingTimeIds = await db.getTimeIdsForRef(treeKey, incomingRef);
    const resolver = new FsConflictResolver(
      this._buildConflictResolverDeps(db, treeKey),
    );
    // The two sides, so the merge revision claims only what it produced.
    this._mergeInputs = {
      before: this._getFileContentMap(beforeMerge),
      incoming: this._getFileContentMap(incomingTree),
    };
    try {
      await resolver.resolve({
        table: treeKey,
        type: 'dagBranch',
        detectedAt: Date.now(),
        branches: [...headTimeIds, ...incomingTimeIds],
      });
    } finally {
      this._mergeInputs = undefined;
    }

    // AND THE MERGE DOES NOT AUTHOR THE BYTES IT KEPT.
    //
    // This path RETURNS before the apply's own bookkeeping, so it had none of
    // it: a merge that resolved `doc.txt` by keeping one side's bytes left the
    // node looking as though it had edited the file, and the entry its next
    // push authored said so. That claim is what out-ordered the writer.
    //
    // Choosing between two versions is not writing one. What this node
    // actually made — a conflict copy — sits at a path no peer sent and is
    // still claimed. Safe to scan here: the watcher is paused for the whole
    // apply, so this sees the merge's own result and nothing else.
    const afterMerge = await this._scanner.scan();
    this._recordReceived(incomingTree, beforeMerge, afterMerge);

    // A MERGE'S OWN WORK IS WHAT IT CHANGED, AND KEEPING BYTES IS NOT WRITING
    // THEM.
    //
    // A merge that resolves `doc.txt` by keeping this side's existing bytes has
    // not edited `doc.txt`. But the next push computes its delta against what
    // this node last ANNOUNCED, and after a merge that is some other state — so
    // the diff reports the path as changed and the entry claims it. The claim
    // is then the newest edit of that path in the whole fleet, and it carries
    // the OLDER content.
    //
    // Measured on `every node ends on the last save`, with the per-path
    // verdict already in place and working: the side holding v5 had a LATER
    // edit of `doc.txt` (…253668) than the writer's v8 (…225297), so the
    // per-path question answered truthfully and still chose v5. The question
    // was right; one of its two inputs was a lie.
    //
    // Aligning what this node believes it announced, for the paths the merge
    // left alone, is what stops the lie. The CLAIMS are not touched: a node
    // that legitimately authored a path it then kept through a merge still
    // authored it, and dropping that would lose its work in the other
    // direction.
    this._dontClaimUnchangedPaths(beforeMerge, afterMerge);
  }

  /**
   * Stops a merge from making this node look like the author of what it kept.
   *
   * A merge that resolves `doc.txt` by keeping this side's existing bytes has
   * not EDITED `doc.txt`. But the next push computes its delta against what
   * this node last announced, and after a merge that is some other state — so
   * the diff reports the path as changed and the entry claims it. The claim is
   * then the newest edit of that path in the whole fleet, and it carries the
   * OLDER content.
   *
   * Measured on *every node ends on the last save*, with the per-path verdict
   * already in place and working: the side holding v5 had a LATER edit of
   * `doc.txt` (…253668) than the writer's v8 (…225297), so the per-path
   * question answered truthfully and still chose v5. The question was right;
   * one of its two inputs was a lie.
   *
   * The CLAIMS are not touched. A node that legitimately authored a path and
   * then kept it through a merge still authored it, and dropping that would
   * lose its work in the other direction.
   * @param beforeMerge - This node's tree before the merge.
   * @param afterMerge - Its tree after the merge materialised.
   */
  private _dontClaimUnchangedPaths(
    beforeMerge: FsTree,
    afterMerge: FsTree,
  ): void {
    const wasOnDisk = this._getFileContentMap(beforeMerge);
    const nowOnDisk = this._getFileContentMap(afterMerge);
    let untouched = 0;
    for (const [path, hash] of nowOnDisk) {
      if (wasOnDisk.get(path) !== hash) continue;
      if (this._announcedContent.get(path) === hash) continue;
      this._announcedContent.set(path, hash);
      untouched++;
    }
    if (untouched > 0) {
      // Ordinary operation, not a warning: most merges carry most paths
      // through. It is logged because "who claimed this path" is the question
      // a rollback in the field turns into, and this is the answer.
      console.log(
        `${this._tag} merge left ${untouched} path(s) byte-for-byte unchanged — ` +
          `not claiming them as this node's edits`,
      );
    }
  }

  /**
   * Records the paths whose current bytes CAME FROM A PEER.
   *
   * **`changed` has to mean "I changed this", and it did not.** It is computed
   * by diffing this folder against `_announcedContent` — a pure content diff,
   * with no notion of WHO changed a path. So a node claimed every path where
   * its folder differed from its last announcement, including paths it had
   * merely received, paths it had failed to receive, and paths where a merge
   * had kept one side's bytes. The entry it then authored was a real edit with
   * a correct stamp for the moment of authoring, and that is exactly why it
   * won: it should never have existed.
   *
   * Measured: `changed=[doc (conflicted copy …).txt, doc.txt]` on a node that
   * had edited neither, whose v5 then out-ordered the writer's v8 and rolled
   * the writer's own folder back.
   *
   * Recording the arrival in `_announcedContent` is what keeps the path out of
   * the next delta, and dropping the local claim is what stops a peer's later
   * removal of it looking stale. Peers DO know these bytes — they sent them —
   * so this is not a suppression, it is the truth being written down.
   *
   * The conflict copy in that measurement is genuinely this node's work and
   * keeps being claimed: its bytes sit at a path no peer sent.
   * **Only what actually ARRIVED, which needs the before-state.** Comparing
   * the incoming tree against the folder afterwards cannot tell "the apply
   * delivered this" from "we already had it" — and the second case is a
   * node's OWN work coming back to it, which happens constantly: a peer
   * re-announces a state it adopted, and the author receives its own bytes.
   * Treating those as received drops the author's claim to a file it wrote,
   * and then the bucket round hands the file to whoever is holding a stale
   * copy. Measured: the writer-rollback invariant failing 8 runs of 8, where
   * the rule it was meant to fix fails 6.
   * @param arrived - The tree that came from the peer.
   * @param before - This folder as it stood before the apply.
   * @param after - This folder as it stands now.
   */
  private _recordReceived(arrived: FsTree, before: FsTree, after: FsTree): void {
    const fromPeer = this._getFileContentMap(arrived);
    const was = this._getFileContentMap(before);
    const now = this._getFileContentMap(after);
    for (const [path, hash] of fromPeer) {
      // Not here afterwards: nothing landed.
      if (now.get(path) !== hash) continue;
      // Here already beforehand: nothing was delivered, so nothing changes
      // hands. A path this node authored keeps its claim.
      if (was.get(path) === hash) continue;
      this._announcedContent.set(path, hash);
      this._localPathTimeIds.delete(path);
    }
  }

  /**
   * Builds a map of relativePath → blobId for all files in a tree.
   * Used to compare trees by content rather than by hash (which includes mtime).
   * @param tree - Tree structure to extract file content map from
   */
  private _getFileContentMap(tree: FsTree): Map<string, string> {
    const map = new Map<string, string>();
    for (const [, node] of tree.trees) {
      const meta = node?.meta;
      if (meta?.type === 'file') {
        /* v8 ignore next -- @preserve */
        map.set(meta.relativePath as string, (meta.blobId as string) ?? '');
      } else if (meta?.type === 'directory' && meta.relativePath !== '.') {
        // Include directories so that adding/removing empty dirs changes the
        // content key and is not silently deduplicated.
        map.set(meta.relativePath as string, '<dir>');
      }
    }
    return map;
  }

  /**
   * Derives a deterministic string key from a content map so that two trees
   * with identical file paths + blobIds produce the same key regardless of
   * mtime differences.
   * @param map - Content map (relativePath → blobId)
   */
  private _contentKeyFromMap(map: Map<string, string>): string {
    const sorted = Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return sorted.map(([p, b]) => `${p}:${b}`).join('\n');
  }

  /**
   * Records `treeRef` as the ref describing this folder's current state, and
   * retires the one it supersedes from the connector's dedup sets.
   *
   * A tree ref is a pure content hash, so a folder that returns to an earlier
   * state re-derives that state's exact ref. The connector drops an incoming
   * ref it has already received, which assumes a state is reached once and
   * never returned to — false for content-addressed state, and false in the
   * most ordinary way possible: create a file, then delete it again.
   *
   * Retiring the SUPERSEDED ref is what keeps the return trip deliverable.
   * The ref just adopted stays deduped, so a peer re-advertising the state
   * this folder is actually in is still suppressed as the echo it is. That
   * only works if every adopted state passes through here — a state adopted
   * silently is never retired and blocks its own return for good.
   * @param connector - Connector whose dedup sets to retire from.
   * @param treeRef - The ref that now describes this folder.
   */
  /**
   * Re-announce this folder's state to a sender that holds far less of it.
   *
   * The sender is the one that needs telling. Without this the network settles
   * into a state that is stable and wrong: the sparse node cannot push, the
   * full node has nothing new to push, and nothing moves until an unrelated
   * edit happens somewhere.
   *
   * Rate-limited because two nodes can each hold what the other lacks, and an
   * unthrottled answer is a loop.
   * @param connector - Connector to broadcast on.
   */
  private async _readvertiseAfterRefusal(connector: Connector): Promise<void> {
    const ref = this._currentRef;
    if (!ref) return;

    const now = Date.now();
    if (now - this._lastRefusalAnswerMs < REFUSAL_ANSWER_COOLDOWN_MS) return;
    this._lastRefusalAnswerMs = now;

    console.warn(
      `${this._tag} refused an incoming tree — re-announcing ${ref.slice(0, 8)}… ` +
        `so the sender can catch up.`,
    );
    try {
      await this._sendRef(connector, ref);
    } catch (err) {
      /* v8 ignore next -- @preserve a failed answer must not mask the refusal */
      console.warn(`${this._tag} re-announcement failed: ${String(err)}`);
    }
  }

  /**
   * Whether a tree describes a folder holding nothing whatsoever.
   *
   * Deliberately conservative: an empty DIRECTORY counts as content. A user who
   * creates a folder and puts a directory in it has made a statement about what
   * should be there, and the silence this gates is only correct for an agent
   * that has established nothing at all. Being wrong in that direction would
   * mean a folder that never advertises until something else happens to change.
   * @param tree - The tree to inspect.
   * @returns `true` when the tree carries no entries at all.
   */
  private _treeIsEmpty(tree: FsTree): boolean {
    return this._getFileContentMap(tree).size === 0;
  }

  /**
   * Whether an inbound ref is news to this agent, and if not, why.
   *
   * "Is this ref news to me" is the question this subsystem keeps getting
   * wrong. It has been answered in five separate places — the connector's sent
   * and received dedup sets, `_lastSentContentKey`, `_lastSentRef`,
   * `_lastAppliedRef` — and each has been wrong at least once:
   *
   *  - an agent applied its OWN last advertisement over its own newer edit,
   *    destroying it and then declining to re-send (fixed 0.0.30);
   *  - a delete propagated only from the client that had created the file,
   *    because the send path never retired the state it left (0.0.31);
   *  - a refusal consumed the ref it refused, so the same emptiness arriving
   *    twice was silent the second time (0.0.33);
   *  - a restarted agent inherited its predecessor's conclusions (0.0.34);
   *  - a quiet join announced anyway, because the connector broadcasts on
   *    local insert and the gate was on the send (0.0.38).
   *
   * Collecting the pre-fetch gates here does not fix a sixth. It makes the
   * question answerable in one place, in one order, with the reasoning
   * attached — which is what the previous five each lacked.
   *
   * Order matters and is deliberate. The own-echo check comes first because it
   * is the only one that holds regardless of what the sender believes: the two
   * defences that ought to catch an echo both miss it. The origin filter
   * compares the payload's origin to this connector's, and a bootstrap carries
   * the SERVER as origin rather than the client the ref came from; the
   * staleness check then measures the server's sequence, which did advance, so
   * the echo reads as news.
   *
   * KNOWN LIMIT, stated because the next person will meet it: this compares
   * against the LAST ref this agent sent, so an echo of an OLDER
   * self-originated ref still gets through. Widening it to a set would also
   * suppress a peer's legitimate revert to a state this agent once held. The
   * real fix is for the bootstrap to carry the originating client, so the
   * origin filter works and this check stops being needed at all.
   * @param treeRef - The inbound ref.
   * @param isNewestFromSender - Whether the connector judged it the newest
   *   thing its sender has advertised. Unknown answers `true`.
   * @returns `apply`, or the reason it is not news.
   */
  private _inboundRefVerdict(
    treeRef: string,
    isNewestFromSender: boolean,
  ): InboundRefVerdict {
    // Always right: if the folder still holds this state, applying it is a
    // no-op; if it has moved on, applying it is the data loss above.
    if (treeRef === this._lastSentRef) return 'own-echo';

    // Not news, and not safe to apply additively either: a re-advertised
    // pre-deletion state carries the file that was just deleted, so applying
    // it undoes the deletion by ADDITION rather than by pruning.
    if (!isNewestFromSender) return 'stale';

    return 'apply';
  }

  /**
   * Records the files an announcement carried.
   *
   * Called wherever this agent commits to a state as "what peers know" —
   * its own pushes, and the states it adopts from theirs.
   * @param tree - The tree that just went out, or was adopted as ours.
   */
  /**
   * Announces this folder as it stands, as the ordinary first push would.
   *
   * Used when a deferred join times out: no head arrived, so no history exists
   * anywhere and this folder is the origin. Re-scanned rather than reusing the
   * tree from start-up, because the wait is seconds long and the user may have
   * carried on working through it.
   * @param db - The route's database.
   * @param connector - Connector to announce on.
   * @param treeKey - The trees table key.
   */
  private async _pushCurrentState(
    db: Db,
    connector: Connector,
    treeKey: string,
  ): Promise<void> {
    try {
      const tree = await this._scanner.scan();
      const ref = await new FsDbAdapter(db, treeKey).storeFsTree(tree, {
        skipNotification: true,
      });
      this._currentRef = ref;
      this._lastSentRef = ref;
      this._lastPushedRef = ref;
      this._persistCurrentRef(ref);
      this._lastSentContentKey = this._contentKeyFromTree(tree);
      await this._recordChainEntry(ref, this._rememberAnnounced(tree));
      await this._sendRef(connector, ref);
    } catch (err) {
      /* v8 ignore next -- @preserve a failed origin push leaves the folder
         unannounced; the next local change announces it */
      this._writeSyncError('join/originPush', err);
    }
  }

  /**
   * Reconciles a folder that has files and no history against the fleet's head.
   *
   * **The chain applies first; the filesystem only then.** Every question here
   * is answered by {@link planJoin} against the chain, and the folder is
   * consulted for what it holds — never for what that means.
   *
   * The four answers, and why each is what it is:
   *
   * - **write** — the head has it and this folder does not. The fleet's state
   *   is the starting point, not this folder's.
   * - **announce** — this folder has it and the history has never named it. New
   *   work, made before this node ever joined; dropping it is how a node loses
   *   its own files on joining.
   * - **recover** — this folder has it and the history REMOVED it. A stale
   *   copy: a backup restore, or a folder that sat while a directory was
   *   deleted. Set aside under `(recovered)` and NOT announced, because
   *   announcing would push every one of those deletions back to every node.
   * - **conflict** — live on both sides with different bytes, edited while this
   *   node was away. The head's bytes win because the chain states them, and
   *   the local bytes become an ordinary conflict copy, which IS announced.
   *
   * Returns having adopted the head's entry, so this node's first word to the
   * network is the fleet's own state plus whatever it legitimately adds.
   * @param db - The route's database.
   * @param treeKey - The trees table key.
   * @param entry - The head this node is joining onto.
   */
  private async _reconcileJoin(
    db: Db,
    treeKey: string,
    entry: FsChainEntry,
  ): Promise<void> {
    // ONE reconcile, however many announcements arrive while it runs.
    if (this._joinInFlight) return this._joinInFlight;
    this._joinInFlight = this._reconcileJoinOnce(db, treeKey, entry).finally(
      () => {
        // Cleared together, and only at the end: `_joinPending` is what keeps
        // concurrent announcements out of the ordinary path.
        this._joinPending = undefined;
        this._joinInFlight = undefined;
        this._stopAsking();
      },
    );
    return this._joinInFlight;
  }

  /**
   * The body of {@link _reconcileJoin}, run once under its guard.
   *
   * The watcher is paused for the whole of it. The reconcile renames files and
   * then restores over the result, and a watcher awake for that would read its
   * own work as local edits and announce them.
   * @param db - The route's database.
   * @param treeKey - The trees table key.
   * @param entry - The head this node is joining onto.
   */
  /**
   * Says nothing about this folder until the network's state has been seen.
   *
   * Two situations need it, and they are the same situation: this folder's
   * contents have not been established, so announcing them would make a claim
   * rather than report a fact.
   *
   *  - a folder with files and NO history — a client joining for the first
   *    time, or one whose folder was copied in from somewhere;
   *  - a folder that has LOST its contents while having a history — a wipe,
   *    which is not a deletion anybody performed.
   *
   * It keeps ASKING rather than waiting to be told once. The hub volunteers
   * its state — the connector has a bootstrap channel and a heartbeat — but a
   * node that misses those cannot tell "I heard nothing" from "there is
   * nothing", and those demand opposite actions at the moment it decides
   * whether to speak.
   *
   * BOUNDED: no head anywhere means no history anywhere, so this folder is the
   * origin and the ordinary push states it. A deferral, never a refusal.
   * @param db - The route's database.
   * @param connector - Connector to announce on, once there is something to say.
   * @param treeKey - The trees table key.
   * @param why - How this folder got here, for the log.
   */
  private _deferToNetwork(
    db: Db,
    connector: Connector,
    treeKey: string,
    why: string,
  ): void {
    this._joinPending = { db, treeKey };
    console.warn(
      `${this._tag} ${this._rootPath} ${why} — waiting up to ` +
        `${this._joinWaitMs} ms for the network's state before saying ` +
        `anything about its own.`,
    );
    const ask = async (): Promise<void> => {
      if (this._joinPending === undefined || !this._chain) return;
      const head = await this._chain.refreshHead().catch(() => undefined);
      if (head === undefined) return;
      const entry = await this._chain.entry(head).catch(() => undefined);
      if (!entry || this._joinPending === undefined) return;
      console.warn(
        `${this._tag} asked for the network's state and found ` +
          `head=${head.slice(0, 8)}… — reconciling before saying anything`,
      );
      await this._reconcileJoin(db, treeKey, entry);
    };
    this._joinAskTimer = setInterval(() => {
      void ask().catch((err) => {
        /* v8 ignore next -- @preserve a failed ask is retried by the next
           tick; the bounded wait is what ends it */
        this._writeSyncError('join/ask', err);
      });
    }, JOIN_ASK_INTERVAL_MS);
    this._joinAskTimer.unref?.();

    this._joinWaitTimer = setTimeout(() => {
      this._joinWaitTimer = null;
      if (this._joinPending === undefined) return;
      this._joinPending = undefined;
      this._stopAsking();
      console.warn(
        `${this._tag} no network state arrived in ${this._joinWaitMs} ms — ` +
          `this folder is the origin of its own history.`,
      );
      void this._pushCurrentState(db, connector, treeKey);
    }, this._joinWaitMs);
    this._joinWaitTimer.unref?.();
  }

  /** Stops asking, whichever way the join ended. */
  private _stopAsking(): void {
    if (this._joinAskTimer) clearInterval(this._joinAskTimer);
    this._joinAskTimer = null;
    if (this._joinWaitTimer) clearTimeout(this._joinWaitTimer);
    this._joinWaitTimer = null;
  }

  private async _reconcileJoinOnce(
    db: Db,
    treeKey: string,
    entry: FsChainEntry,
  ): Promise<void> {
    this._scanner.pauseWatch();
    try {
      await this._joinReconcileBody(db, treeKey, entry);
    } finally {
      this._scanner.resumeWatch();
    }
  }

  /**
   * What joining actually does to the folder.
   * @param db - The route's database.
   * @param treeKey - The trees table key.
   * @param entry - The head this node is joining onto.
   */
  /**
   * Moves one file out of the way of the state this node is joining onto.
   *
   * A method rather than a closure inside the join so that the failure can be
   * TESTED. A rename that cannot be performed — the source gone between the
   * scan and the move, the destination occupied by a directory — leaves the
   * file where it is, and the restore then overwrites it. That loses less than
   * refusing to join, which is why it is recorded rather than thrown; and a
   * path that is only ever recorded is a path that needs a test, because
   * nothing else will ever tell anybody it stopped working.
   * @param path - The file to move, relative to the root, `/`-separated.
   * @param name - Where to move it, same form.
   */
  private async _setAside(path: string, name: string): Promise<void> {
    const from = join(this._rootPath, ...path.split('/'));
    const to = join(this._rootPath, ...name.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to).catch((err) => {
      this._writeSyncError(`join/setAside/${path}`, err);
    });
  }


  /**
   * Where an announced state sits relative to this node, per the chain.
   *
   * A method rather than an inline block so the two ways the chain can fail
   * here can be TESTED — both are `.catch`es, so nothing else would ever
   * report them.
   *
   * `classify` compares chain HEADS and what arrived is a TREE ref. The head
   * the ANNOUNCEMENT carried is the right one: it is what the sender said
   * about itself. The lookup by tree ref is only the fallback, for a ref that
   * came without one — the hub's own advertisements, an older peer — and it is
   * ambiguous by nature, because a tree ref is a content hash and two nodes
   * holding the same bytes produce the same one. Two freshly started nodes
   * both have an entry for the EMPTY tree, so asking by hash there can return
   * either node's.
   *
   * `incomplete` means no entry covers this state, which leaves the decision
   * to the caller's own branches rather than guessing — and an unreadable
   * chain has to give the same answer as a missing one, because in both cases
   * the history says nothing.
   * @param treeRef - The announced state.
   * @returns The relation, or `incomplete` when the chain cannot say.
   */
  private async _classifyAnnouncedRef(
    treeRef: string,
  ): Promise<'behind' | 'ahead' | 'fork' | 'incomplete'> {
    /* v8 ignore next -- @preserve the caller checks both before asking */
    if (!this._chain || !this._chainHead) return 'incomplete';
    const theirHead =
      this._announcedHeads.get(treeRef) ??
      (await this._chain.entryForTreeRef(treeRef).catch(() => undefined))?.head;
    if (!theirHead) return 'incomplete';
    return this._chain
      .classify(this._chainHead.head, theirHead)
      .catch(() => 'incomplete' as const);
  }


  private async _joinReconcileBody(
    db: Db,
    treeKey: string,
    entry: FsChainEntry,
  ): Promise<void> {
    const headTree = await this._fetchTreeFromDb(db, treeKey, entry.treeRef);
    /* v8 ignore next -- @preserve a head whose tree cannot be read is not a
       state to reconcile against; the next announcement carries another */
    if (!headTree) return;

    const folderTree = await this._scanner.scan();
    const walk = await this._chain
      ?.collectRemovals(entry.head, undefined)
      .catch(() => undefined);
    const plan = planJoin({
      haveHead: true,
      head: this._getFileContentMap(headTree),
      folder: this._getFileContentMap(folderTree),
      // An incomplete walk means the history could not be read to the root, so
      // "was this path ever removed" is unknown. Unknown must not read as
      // "never removed": that would announce a stale copy. Treating it as
      // removed would destroy new work. So neither — an empty set leaves every
      // extra file in `announce`, which is the non-destructive direction, and
      // the node is at worst noisy about files it holds.
      removedEver: new Set(walk?.complete ? walk.removed : []),
    });

    const taken = new Set<string>([
      ...this._getFileContentMap(folderTree).keys(),
      ...this._getFileContentMap(headTree).keys(),
    ]);
    for (const path of plan.recover) {
      await this._setAside(path, `${RECOVERED_DIR}/${recoveredName(path, taken)}`);
    }
    for (const path of plan.conflict) {
      await this._setAside(
        path,
        conflictCopyName(path, '', Date.now(), taken, 'local'),
      );
    }

    if (plan.recover.length > 0 || plan.conflict.length > 0) {
      console.warn(
        `${this._tag} joining: moved ${plan.recover.length} file(s) the history ` +
          `had deleted into ${RECOVERED_DIR}/ and kept ` +
          `${plan.conflict.length} edited while away as conflict copies`,
      );
    }
    console.log(
      `${this._tag} joining onto head=${entry.head.slice(0, 8)}…: ` +
        `writing ${plan.write.length}, keeping ${plan.announce.length} of ` +
        `this folder's own`,
    );

    // Additively, always. The head's paths are written and nothing is pruned:
    // what this folder legitimately adds is exactly what `announce` names, and
    // a prune here would delete it.
    await this.restore(headTree, undefined, { cleanTarget: false });

    // Adopted, not authored. This node is now at the fleet's state plus its
    // own additions, and the additions are stated by the push that follows.
    this._adoptedChainHead = entry.head;
    this._chainHead = { head: entry.head, treeRef: entry.treeRef };
  }

  /**
   * Agrees with the fleet on ONE entry for the state this folder is in.
   *
   * **This is where the fleet's single history is actually made.** Every node
   * authors an entry for the state it starts in, and those states are usually
   * IDENTICAL — peers already in sync hold the same bytes, so they derive the
   * same tree ref. Without this, the fleet has one lineage per node from the
   * first second, and then nothing is ever `behind` or `ahead`: `classify`
   * finds neither head reachable from the other and answers `fork` to every
   * announcement there has ever been.
   *
   * Measured on `a document never goes backwards while one person edits it`,
   * 6 runs in 8, and the control confirms it predates this session: one writer
   * saving v0…v8, two receivers cut and healed underneath. Each node's seed
   * entry listed `changed=[]` — nothing, because nothing had changed — and was
   * still its own lineage root. A healed receiver's announcement was therefore
   * a FORK of the writer's, the writer merged it, a conflicted copy appeared
   * on a file one person had edited, and the writer's own folder went from v8
   * back to v5.
   *
   * **THE OLDEST ENTRY WINS**, asked BY CONTENT rather than taken from the
   * announcement. Every node can see the same rows, so every node picks the
   * same one without coordination; and adoption that only moves backwards in
   * time is monotone, so it cannot oscillate as rows replicate. Whoever
   * reached this content first described it first.
   *
   * Called wherever a ref is recognised as describing this folder as it
   * stands — and the ECHO path is the one that matters, because that is where
   * identical seed states meet. There is no content to apply, only a name to
   * agree on, so the apply never runs and no other path sees them.
   * @param treeRef - The ref describing this folder's current content.
   */
  private async _agreeOnEntryFor(treeRef: string): Promise<void> {
    if (!this._chain) return;
    const theirs = await this._chain
      .oldestEntryForTreeRef(treeRef)
      .catch(() => undefined);
    if (!theirs || theirs.head === this._chainHead?.head) return;
    const mine = this._chainHead
      ? await this._chain.entry(this._chainHead.head).catch(() => undefined)
      : undefined;
    if (mine !== undefined && compareTimeId(theirs.timeId, mine.timeId) >= 0) {
      return;
    }
    this._chainHead = { head: theirs.head, treeRef };
    // Nothing here is this node's work, so it claims no path. A claim is what
    // makes a peer's later removal of that path look stale.
    for (const path of this._getFileContentMap(
      this._scanner.tree ?? { rootHash: '', trees: new Map() },
    ).keys()) {
      this._localPathTimeIds.delete(path);
    }
    console.log(
      `${this._tag} agreed on the fleet's entry for the state this folder is ` +
        `already in: head=${theirs.head.slice(0, 8)}…`,
    );
  }

  /**
   * Parks the chain head an announcement resolved to, for its apply to find.
   *
   * Bounded by {@link ANNOUNCED_HEAD_MAX}, oldest first — insertion order is
   * arrival order, so the oldest parked head is the one whose apply is least
   * likely to still be coming.
   * @param treeRef - The state announced.
   * @param head - The sender's chain head that produced it.
   */
  private _rememberAnnouncedHead(treeRef: string, head: string): void {
    this._announcedHeads.delete(treeRef);
    this._announcedHeads.set(treeRef, head);
    while (this._announcedHeads.size > ANNOUNCED_HEAD_MAX) {
      const oldest = this._announcedHeads.keys().next().value as string;
      this._announcedHeads.delete(oldest);
    }
  }

  private _rememberAnnounced(tree: FsTree): FsTreeDelta {
    const content = this._getFileContentMap(tree);
    const previous = this._announcedContent;
    // "HAVE I ANNOUNCED BEFORE" IS NOT "IS WHAT I ANNOUNCED EMPTY".
    //
    // This was `previous.size === 0`, which is true both for a node that has
    // never spoken AND for one that has announced an EMPTY FOLDER — the
    // ordinary state of every fresh client. So the first real file written on
    // a new node was never claimed: the push that carried it stated nothing,
    // and nothing in the chain recorded who made it.
    //
    // Found by asking the question directly rather than through the mesh
    // (`fs-agent-authorship.spec.ts`), and it is the same confusion the rest
    // of this work is about: a content diff cannot tell "I know nothing" from
    // "I know it is empty". Only a record of having spoken can.
    const first = !this._hasAnnounced;
    this._hasAnnounced = true;

    // What this push changed, measured against what was announced before it.
    //
    // On the FIRST announcement everything would count as changed, which would
    // make the opening chain entry list a whole folder — 1 200 paths on a real
    // one. It lists nothing instead: a first push removes nothing and
    // establishes a baseline, and the tree ref already says what the baseline
    // is. Only the deltas after it are worth recording.
    const changed: string[] = [];
    const removed: string[] = [];
    if (!first) {
      for (const [path, hash] of content) {
        if (previous.get(path) !== hash) changed.push(path);
      }

      // A REMOVAL MAY ONLY BE STATED IF THIS NODE WATCHED IT HAPPEN.
      //
      // The absence of a path from the folder used to be enough. That is the
      // same inference the chain exists to remove — "an absence is not a
      // deletion" — surviving on the SENDING side: the receiver stopped
      // guessing and the sender went on guessing for it, and the chain then
      // carried the guess as a stated, ordered, authoritative fact that every
      // peer obeyed. Correctly, because obeying a stated removal is the whole
      // design.
      //
      // So the statement is now intersected with what the watcher actually
      // saw. `_pendingDeletes` holds the paths this node observed being
      // deleted, limited to ones peers already knew about, and persisted
      // across a restart. A baseline that has drifted can now cost a MISSED
      // announcement, which the next sync repairs, instead of a deletion
      // nobody performed, which nothing repairs.
      //
      // The baseline still provides "state it exactly once": a path drops out
      // of `_announcedContent` as soon as the push carrying its removal is
      // recorded, so it is never re-stated — and re-stating an old removal is
      // precisely how a delivered deletion beats a later re-creation (I7b).
      //
      // THE PRICE, accepted deliberately: a deletion performed while the agent
      // was NOT RUNNING is invisible — no watcher saw it — so the file comes
      // back from the chain on the next sync. That is a visible, recoverable
      // annoyance; the user deletes it again with the agent running and it
      // propagates properly. The alternative is an unrecoverable one. See
      // `README.public.md` and J9's destructive half, which this withdraws.
      for (const path of previous.keys()) {
        if (content.has(path)) continue;
        const absolute = join(this._rootPath, ...path.split('/'));
        if (!this._pendingDeletes.has(absolute)) continue;
        removed.push(path);
      }
    }
    this._announcedContent = content;

    this._announcedFiles.clear();
    for (const path of content.keys()) {
      this._announcedFiles.add(join(this._rootPath, path));
    }

    // The tombstone log is NOT cleared here, and it used to be.
    //
    // "Once peers have been told, a file's absence is theirs to know about" is
    // true only of a peer that HEARD. A partitioned node's deletion reached
    // nobody, and on rejoin the fleet's tree still contains the file — so the
    // apply puts it back on the node that deleted it, the local scan finds it
    // present, and the deletion is never announced at all. Measured as mesh
    // scenario T4; see `doc/known-limits.md`.
    return { changed, removed };
  }

  /**
   * Creates this folder's history if it does not exist yet.
   *
   * Called from BOTH `syncToDb` and `syncFromDb`, and the second one cost a
   * red run to discover. A node that only RECEIVES — a late joiner, which
   * starts `syncFromDb` alone because scanning its empty folder would push
   * emptiness over everyone else's data — still has to resolve the heads its
   * peers announce. With the chain created on the send path only, such a node
   * dropped every announcement it heard and never received a file that already
   * existed. The chain is per-route state, not per-direction.
   *
   * Idempotent in both senses: this method is a no-op once a chain exists, and
   * `FsEditChain.init` creates its tables with `createOrExtendTable` and
   * continues the lineage a previous process left behind.
   *
   * Best-effort. fs-agent creates its OWN tables — the One Client creates the
   * trees table, and an agent expecting tables its host never created would
   * fail at runtime on any node whose host is one release behind.
   * @param db - The route's database.
   * @param treeKey - The trees table key.
   */
  private async _ensureChain(db: Db, treeKey: string): Promise<void> {
    if (this._chain) return;
    try {
      const chain = new FsEditChain(db, treeKey);
      await chain.init();
      this._chain = chain;
    } catch (err) {
      /* v8 ignore next -- @preserve best-effort; the sync runs without it */
      this._writeSyncError('chain/init', err);
    }
  }

  /**
   * What to put on the wire for a state this node is announcing.
   *
   * **The head, not the tree ref.** A tree ref is a content hash, so a folder
   * that returns to a state it held earlier re-derives that state's exact ref —
   * and a receiver cannot then find the chain row for it by hash, only by
   * query. Announcing the head makes every announcement resolvable to an entry,
   * which is what the `previous` walk needs in order to exist at all (§13.5).
   *
   * It also makes each announcement UNIQUE. An A → B → A deletion produces
   * three entries with three heads, so the returning state is news by
   * construction rather than by clearing the connector's dedup for it.
   * @param treeRef - The state being announced.
   * @returns The head that names it, or `treeRef` when this node has no chain
   *   entry for that state — a re-announcement of something older, or a build
   *   whose chain could not be created.
   */
  private _announceAs(treeRef: string): string {
    if (this._announceTreeRef) return treeRef;
    return this._chainHead?.treeRef === treeRef
      ? `${CHAIN_HEAD_PREFIX}${this._chainHead.head}`
      : treeRef;
  }

  /**
   * The state an incoming announcement is about, with its chain entry.
   *
   * The entry is what carries the sender's REMOVALS, which is the whole point
   * of announcing a head: a removal is a fact the sender states, where an
   * absence from a tree is only something a receiver can try to infer.
   * @param ref - What arrived on the wire.
   * @returns The tree ref and, for a marked head, the entry it resolved to.
   */
  private async _resolveAnnouncement(
    ref: string,
  ): Promise<{ treeRef: string; entry?: FsChainEntry } | undefined> {
    if (!ref.startsWith(CHAIN_HEAD_PREFIX)) return { treeRef: ref };
    const head = ref.slice(CHAIN_HEAD_PREFIX.length);
    // A real case, not an impossible one — and asserting otherwise with a
    // coverage ignore is what hid it for a whole red run. An agent whose chain
    // could not be created still hears its peers, and it must say "I cannot
    // read this" rather than pretend the head is a tree ref.
    if (!this._chain) {
      // SILENT UNTIL NOW, and that silence cost three wrong diagnoses of the
      // same defect.
      //
      // Every `~H~` announcement is discarded here when the chain is not
      // available, with no log, no counter and no error — so a node can be
      // told the hub's state thirty-seven times, ignore every one of them, and
      // report perfect health. The sibling branch below says "the sender will
      // re-announce" out loud for an unresolvable head; this one said nothing
      // for the case where nothing can be resolved at all.
      console.warn(
        `${this._tag} ${this._rootPath}: head=${head.slice(0, 8)}… arrived ` +
          `before this agent has a chain — DISCARDED. Nothing will repair ` +
          `from it; the node is relying entirely on being pushed to.`,
      );
      return undefined;
    }
    try {
      const entry = await this._chain.entry(head);
      if (!entry) {
        console.warn(
          `${this._tag} head=${head.slice(0, 8)}… is not resolvable here — ` +
            `ignoring it; the sender will re-announce.`,
        );
        return undefined;
      }
      return { treeRef: entry.treeRef, entry };
      /* v8 ignore start -- @preserve a chain read that THROWS, rather than
         missing a row, means the store itself is unavailable — and this node
         must stay deaf to that head rather than stop syncing. Not provoked by
         a test because provoking it means breaking the store under a live
         agent, which proves less than the one-line guarantee it makes. */
    } catch (err) {
      this._writeSyncError('chain/resolveHead', err);
      return undefined;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * What the chain says about an announced head, for the decision.
   *
   * Reachability is supplied ONLY when this node has a head of its own.
   * Without one there is nothing to be reachable from, and answering
   * `incomplete` would block a node that is simply new — a late joiner has no
   * entries and must be free to pull. Absent, the decision falls back to the
   * heuristics that shipped before, which is the right behaviour for a node
   * with no history rather than a degraded one.
   * @param announced - The ref as it arrived on the wire.
   * @returns The tree ref and, when both sides have a head, how the two
   *   histories stand; `undefined` for a head this node cannot resolve.
   */
  private async _reachabilityOf(
    announced: string,
  ): Promise<{ treeRef: string; reachability?: Reachability } | undefined> {
    const resolved = await this._resolveAnnouncement(announced);
    if (resolved === undefined) return undefined;
    const ourHead = this._chainHead?.head;
    if (!ourHead || !this._chain) return { treeRef: resolved.treeRef };

    // An older peer announces a plain TREE REF, and its ancestry is still
    // reachable — by query on `dataRef` rather than by hash. Tried only here,
    // where the path is already asynchronous: a query is a peer read, and
    // awaiting one on the apply path is how a late joiner's bootstrap was lost.
    //
    // Ambiguous by nature (a folder returning to earlier content produces a
    // second entry with the same `dataRef`), so the newest wins. That is why
    // it is the fallback and `~H~` is the primary.
    const entry =
      resolved.entry ??
      (await this._chain.entryForTreeRef(resolved.treeRef).catch(() => {
        /* v8 ignore next -- @preserve a failed query falls back to heuristics */
        return undefined;
      }));
    if (!entry) return { treeRef: resolved.treeRef };

    // SAME CONTENT IS NOT A FORK, whatever the two chains call themselves.
    //
    // A tree ref is the content. Two nodes that hold the same one hold the
    // same folder — and they still arrive at DIFFERENT chain heads, because
    // each records its own entry for the state it reached. `classify` has no
    // way to see that: it compares heads, finds neither is an ancestor of the
    // other, and answers `fork`.
    //
    // Measured on the freeze scenario: 24 announcements classified as `fork`
    // where both sides held tree `K0xA_ig0`, the seed. A fork of identical
    // content sends the decision to a MERGE, the merge of two identical
    // folders changes nothing, and the node does it again on the next
    // announcement — forever, while reporting no divergence.
    //
    // This is the same mistake twice over: it is why mtime had to leave the
    // content identity, and it is what `FsAntiEntropy.agreedOn` exists to
    // record. The answer is the same one — ask the content, not the name.
    if (resolved.treeRef === this._currentRef) {
      return { treeRef: resolved.treeRef, reachability: 'ahead' };
    }

    try {
      return {
        treeRef: resolved.treeRef,
        reachability: await this._chain.classify(ourHead, entry.head),
      };
      /* v8 ignore start -- @preserve as above: a THROWN walk leaves the
         decision without the chain's answer, which is exactly the case the
         heuristics are kept for. */
    } catch (err) {
      this._writeSyncError('chain/classify', err);
      return { treeRef: resolved.treeRef };
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Builds the bucket-sync host and the conversation that drives it.
   *
   * The host is the only thing that may touch the folder: the protocol decides
   * what to say and what a reply means and cannot delete anything itself,
   * which is what keeps the destructive half where the mass-delete guard can
   * see it.
   * @param connector - The transport.
   * @param db - The route's database, for fetching what the plan asks for.
   * @param treeKey - The trees table key.
   * @returns The conversation.
   */
  private _makeBucketSync(
    connector: Connector,
    db: Db,
    treeKey: string,
  ): FsBucketSync {
    const host: BucketSyncHost = {
      manifest: () => this._manifest(),
      // The chain's answer to "who changed this file", for the paths this node
      // changed. Only a real local edit sets a claim — receiving a path does
      // not — so a node can never claim bytes it merely holds.
      claimed: () => new Set(this._localPathTimeIds.keys()),
      send: (ref) => {
        // Cleared first, because `Connector` dedups by ref on both sides and a
        // round is only unique by its id — the clear makes a RE-sent message
        // deliverable too, which a retry needs.
        connector.invalidateSent?.(ref);
        connector.send(ref);
      },
      ready: () =>
        // A node mid-cold-start or mid-apply has a partial manifest, and
        // advertising one makes a peer see differences that are not there.
        //
        // **A PENDING JOIN IS MID-COLD-START, and this gate is where that has
        // to be said.** A folder with files and no history has established
        // nothing; its manifest describes files that may be new work or a
        // stale copy, and nothing can tell which until the chain has been
        // consulted. Worse, the round is a THIRD way the folder changes: a
        // peer's tombstone makes the delete-wins half drop a path, and it did
        // — measured as the joiner's stale copy being dropped by a bucket
        // round between the reconcile's scan and its rename, so the rename
        // found nothing to move and the file was destroyed rather than set
        // aside, with "set aside 1 file" still in the log.
        this._scanner.tree !== null &&
        !this._remoteApplyInFlight &&
        this._joinPending === undefined,
      apply: (plan) => this._applyReconcilePlan(plan, db, treeKey),
      agreed: () => {
        // The roots matched, so this folder and the hub's hold the same
        // content whatever either calls itself. Told to the anti-entropy,
        // which is comparing REFS and cannot reach that conclusion — and
        // which otherwise re-reports the same divergence on every beacon.
        const hubRef = this._antiEntropy?.status.hubRef;
        if (hubRef) this._antiEntropy?.agreedOn(hubRef);
      },
      log: (message) => console.log(message),
    };
    return new FsBucketSync(host);
  }

  /**
   * This folder's manifest: `path → blobId`, tombstones included.
   *
   * A tombstoned path is carried at {@link TOMBSTONE_BLOB}, so a deletion
   * travels through the ordinary comparison instead of as an absence — the
   * ambiguity the whole plan exists to remove. A path that is both tombstoned
   * and live is LIVE: the user created it again, and a stale tombstone must
   * not advertise it as gone.
   * @returns The manifest.
   */
  private _manifest(): ReadonlyMap<string, string> {
    const tree = this._scanner.tree;
    const live = tree ? this._getFileContentMap(tree) : new Map<string, string>();
    const out = new Map<string, string>();
    for (const absolute of this._pendingDeletes) {
      out.set(relative(this._rootPath, absolute).split(sep).join('/'), TOMBSTONE_BLOB);
    }
    // Live entries LAST, so a path that was deleted and created again
    // overwrites its own tombstone rather than being advertised as gone.
    for (const [path, blobId] of live) out.set(path, blobId);
    return out;
  }

  /**
   * Performs what a bucket-sync round concluded.
   *
   * **Additive, except for the drops, and those are bounded.** `fetch` only
   * ever writes a path this node does not hold, so nothing it does can
   * destroy work. `drop` is the delete-wins direction and goes through the
   * same mass-delete reasoning an ordinary prune does.
   * @param plan - What to do.
   * @param db - Unused today; kept so a fetch can reach the route's store when
   *   a blob is not already local.
   * @param treeKey - Likewise.
   */
  private async _applyReconcilePlan(
    plan: ReconcilePlan,
    db: Db,
    treeKey: string,
  ): Promise<void> {
    void db;
    void treeKey;

    // ---- additive half ----
    for (const [path, blobId] of plan.fetch) {
      const target = join(this._rootPath, ...path.split('/'));
      // A path this node deliberately deleted is not fetched back. The peer
      // has not heard about the deletion yet; it will, and our manifest
      // already says so.
      if (this._pendingDeletes.has(target)) continue;
      try {
        await this._adapter.blobToFile(
          { name: path, blobId, size: 0, mtime: Date.now(), path: target },
          target,
        );
      } catch (err) {
        // One unreachable blob is worth one missing file, never the whole
        // round — the same rule the restore path learned the hard way.
        this._writeSyncError(`bucketSync/fetch/${path}`, err);
      }
    }

    // ---- destructive half, bounded ----
    if (plan.drop.length > 0) {
      const held = this._scanner.tree
        ? this._getFileContentMap(this._scanner.tree).size
        : 0;
      // THE SAME TWO RULES AS `planRemovals`, because this is the same
      // decision reached by a different route — and the floor's gap was open
      // here too. Emptying the folder is refused whatever the count: 40 drops
      // against 40 held files is a ratio of 1.0 and still under the floor,
      // which is how a wiped peer took every other node's copy with it
      // (`a small folder survives a wiped peer too`).
      //
      // "ALMOST ALL" IS ALSO A LOSS, and reading the rule as "exactly all"
      // left the hole one file wide. Measured under full-suite load: a peer
      // that had been emptied produced a round dropping **39 of 40**, so
      // `drop >= held` was false and `39 > MASS_DELETE_MIN_FILES` was false
      // too — both floors missed it and 39 files were deleted with no refusal
      // logged at all. The node was left holding one file out of forty while
      // `planRemovals` on the very same node correctly refused "40 of 40".
      //
      // What the folder would be LEFT with is the honest measure, and the
      // paths the same round FETCHES count towards it — otherwise renaming a
      // directory, which drops every old name and fetches every new one, reads
      // as a wipe. A rename leaves the folder the same size; a wipe does not.
      const wouldLeave = held - plan.drop.length + plan.fetch.length;
      const wouldEmpty =
        held > ALL_GONE_MIN_FILES && wouldLeave <= ALL_GONE_MIN_FILES;
      const tooMany =
        wouldEmpty ||
        (plan.drop.length > MASS_DELETE_MIN_FILES &&
          plan.drop.length / Math.max(held, 1) > MASS_DELETE_MAX_RATIO);
      if (tooMany) {
        console.error(
          `${this._tag} MASS DELETE REFUSED on ${this._rootPath}: a bucket-sync ` +
            `round would remove ${plan.drop.length} of ${held} files. ` +
            `Nothing was deleted.`,
        );
        this._writeSyncError(
          'bucketSync/massDeleteGuard',
          new Error(`refused ${plan.drop.length}/${held} drops`),
        );
      } else {
        for (const path of plan.drop) {
          const target = join(this._rootPath, ...path.split('/'));
          try {
            await rm(target, { force: true });
            // Tombstoned as well as removed, so a third node pushing the file
            // in the window before this node announces cannot put it back.
            this._pendingDeletes.add(target);
          } catch (err) {
            /* v8 ignore next -- @preserve a file we cannot remove is retried */
            this._writeSyncError(`bucketSync/drop/${path}`, err);
          }
        }
        this._persistTombstones();
      }
    }

    // `redelete` needs no action here: our manifest already advertises those
    // tombstones, so the peer acts on them in its own round. Naming it in the
    // plan is what makes the omission deliberate rather than forgotten.
    if (plan.conflict.length > 0) {
      // NAMED, not resolved. Both sides edited the same file, which no
      // additive step can settle — the ordinary conflict resolver owns it.
      console.warn(
        `${this._tag} bucket-sync: ${plan.conflict.length} path` +
          `${plan.conflict.length === 1 ? '' : 's'} edited on both sides: ` +
          `${plan.conflict.slice(0, 3).join(', ')}`,
      );
    }
  }

  /**
   * Gathers the deletions behind a plain TREE REF, via its chain entry.
   *
   * The bridge from an unmarked announcement to the chain — the hub's
   * announcements and an older peer's both arrive this way. Best-effort and
   * never awaited by the apply path: see the call site.
   * @param treeRef - The state announced, unmarked.
   */
  private async _collectRemovalsForTreeRef(treeRef: string): Promise<void> {
    if (!this._chain) return;
    try {
      const entry = await this._chain.entryForTreeRef(treeRef);
      if (entry) await this._collectIncomingRemovals(entry);
    } catch (err) {
      /* v8 ignore next -- @preserve best-effort; the apply proceeds regardless */
      this._writeSyncError('chain/removalsForTreeRef', err);
    }
  }

  /**
   * Gathers the deletions between a peer's head and a state this node knows.
   *
   * NOT just the head's own `removed` list. A removal is stated once, in the
   * entry that made it, and a node partitioned at that moment states it in an
   * entry nobody received — its next entry says nothing about the deletion,
   * because that is computed against its own last announcement. Reading the
   * head alone therefore learns nothing, and the file survives everywhere
   * except on the node that deleted it. Measured; see
   * `FsEditChain.collectRemovals`.
   *
   * An incomplete walk is DISCARDED rather than applied in part. A missing
   * ancestor may be the re-add that cancels a removal we did collect, so
   * acting on the fragment can delete a live file — mongo's `complete: false`
   * contract, and the reason it exists.
   * @param entry - The entry the announcement resolved to.
   */
  private async _collectIncomingRemovals(entry: FsChainEntry): Promise<void> {
    if (!this._chain) return;
    try {
      // Where the walk stops is THIS NODE'S OWN LINEAGE, which the chain
      // works out from our head. It used to be a set of content refs — the
      // current one, the last applied one, and a thousand remembered states —
      // and a content ref cannot say whether we were ever THERE. See
      // `FsEditChain.collectRemovals`.
      const walk = await this._chain.collectRemovals(
        entry.head,
        this._chainHead?.head,
      );
      if (!walk.complete) {
        console.warn(
          `${this._tag} ancestry of head=${entry.head.slice(0, 8)}… is ` +
            `incomplete — not acting on its deletions; the sender will ` +
            `re-announce.`,
        );
        return;
      }
      // Parked when EITHER half says something. The changes are not here to
      // be written — the restore does that — but to lift the tombstones this
      // node set on its peers' authority. See `FsEditChain.collectRemovals`.
      if (walk.removed.length === 0 && walk.changed.length === 0) return;
      this._incomingRemovals.set(entry.treeRef, {
        removed: walk.removed,
        changed: walk.changed,
        timeId: walk.timeId ?? entry.timeId,
      });
    } catch (err) {
      /* v8 ignore next -- @preserve a failed walk must not stop the apply */
      this._writeSyncError('chain/collectRemovals', err);
    }
  }

  /**
   * Applies the stated delta an announcement carried, if any.
   *
   * Both halves, and the second one has to be here rather than anywhere else:
   * it runs BEFORE the restore, which is the step a tombstone refuses.
   *
   * Every path that is deleted is also TOMBSTONED, for the same reason a local
   * deletion is: between applying a peer's delete and announcing the result,
   * this node's own advertised state still contains the file, and a third node
   * pushing in that window would put it back.
   *
   * **And nothing used to lift a tombstone set that way.** The watcher clears
   * one when the path is written again LOCALLY, but a peer's re-creation can
   * only arrive through the restore the tombstone refuses — so the path was
   * refused for the rest of the session. Measured once the chain started
   * stating these deletions at all: a file created, deleted and created again
   * at the same path never reached the second node, three runs of three,
   * `restore: wrote 0 … REFUSED 1 tombstoned`.
   *
   * Lifted only for a path the sender STATES it changed. A tree that merely
   * contains the path says nothing — every tree predating the deletion
   * contains it, which is the window the tombstone exists for.
   * @param treeRef - The state being applied, which the delta arrived with.
   */
  private async _applyIncomingRemovals(treeRef: string): Promise<void> {
    const incoming = this._incomingRemovals.get(treeRef);
    // Consumed once. An entry applied twice would delete on the authority of a
    // message already acted on.
    this._incomingRemovals.delete(treeRef);
    if (!incoming) return;

    const lifted: string[] = [];
    for (const path of incoming.changed) {
      const absolute = join(this._rootPath, ...path.split('/'));
      if (this._pendingDeletes.delete(absolute)) lifted.push(path);
    }
    if (lifted.length > 0) {
      this._persistTombstones();
      console.log(
        `${this._tag} lifted ${lifted.length} tombstone` +
          `${lifted.length === 1 ? '' : 's'} a peer re-created: ` +
          `${lifted.slice(0, 3).join(', ')}`,
      );
    }

    const held = new Set(
      this._getFileContentMap(this._scanner.tree ?? { rootHash: '', trees: new Map() }).keys(),
    );
    // WHAT THIS NODE HOLDS AND NOBODY HAS HEARD OF.
    //
    // `_announcedContent` is what peers know this node has. A path on disk and
    // absent from it is local work made since the last announcement — and no
    // peer's removal can be about a file no peer has ever seen. Without this
    // the removal wins, because a local creation has no `_localPathTimeIds`
    // entry until the PUSH records one, and the push has not happened yet.
    // See `RemovalQuestion.unannounced` and `I7b`.
    // AND ONLY ONCE THIS NODE HAS SPOKEN AT ALL. `_announcedContent` is empty
    // both for a node that has announced nothing and for one that announced an
    // empty folder, so before the first announcement "held but never
    // announced" means EVERY path — and every stated removal would be refused.
    // Measured immediately: `applies a deletion the sender STATES` and
    // `applies a stated deletion on a transport that carries no ancestry` both
    // went red, because their fixtures apply a removal before the agent has
    // ever pushed.
    //
    // This is the same confusion `_hasAnnounced` was introduced for on the
    // push side — "have I spoken" is not "is what I said empty" — and it is
    // worth stating twice because it looks like a size check both times.
    const unannounced = new Set<string>();
    if (this._hasAnnounced) {
      for (const path of held) {
        if (!this._announcedContent.has(path)) unannounced.add(path);
      }
    }

    const plan = planRemovals({
      removed: incoming.removed,
      timeId: incoming.timeId,
      localTimeIds: this._localPathTimeIds,
      held,
      unannounced,
      // What the same edit CLAIMS, so a renamed folder is not read as a wipe:
      // it drops every old name and claims every new one, and a folder that is
      // renamed does not shrink. See `RemovalQuestion.claims`.
      claims: incoming.changed.length,
      minFiles: MASS_DELETE_MIN_FILES,
      maxRatio: MASS_DELETE_MAX_RATIO,
    });

    if (plan.blocked) {
      // Loud, because the alternative to noticing this is discovering it from
      // a user whose folder emptied.
      console.error(
        `${this._tag} MASS DELETE REFUSED on ${this._rootPath}: a peer's edit ` +
          `would remove ${incoming.removed.length} of ${held.size} files. ` +
          `Nothing was deleted.`,
      );
      this._writeSyncError(
        'removals/massDeleteGuard',
        new Error(
          `refused ${incoming.removed.length}/${held.size} peer removals`,
        ),
      );
      return;
    }

    if (plan.staler.length > 0) {
      console.warn(
        `${this._tag} kept ${plan.staler.length} path` +
          `${plan.staler.length === 1 ? '' : 's'} a peer deleted — this node ` +
          `has newer work on ${plan.staler.slice(0, 3).join(', ')}`,
      );
    }
    if (plan.apply.length === 0) return;


    // DEEPEST FIRST, and a directory is removed only when it is EMPTY.
    //
    // A removal list carries directory paths as well as file paths, and a
    // plain `rm` without `recursive` throws on a directory — so the files went
    // and the folder stayed. Measured as a directory deletion that never
    // reached the peer (`should propagate directory deletion from A to B`,
    // both transports) once absence stopped pruning and this became the only
    // path that deletes.
    //
    // `recursive: true` is NOT the fix. It would delete whatever is inside
    // the directory, including local files the sender never saw and never
    // stated — the exact class of loss this whole change is about. `rmdir`
    // refuses a non-empty directory, which is the correct outcome: what is
    // still in there is somebody's work.
    //
    // Children before parents, so a directory is already empty by the time
    // its own turn comes.
    const deepestFirst = [...plan.apply].sort(
      (a, b) => b.split('/').length - a.split('/').length,
    );
    for (const path of deepestFirst) {
      const absolute = join(this._rootPath, ...path.split('/'));
      try {
        const stats = await lstat(absolute).catch(() => undefined);
        if (stats === undefined) continue;
        if (stats.isDirectory()) {
          // Non-empty means somebody's work is in there; leaving it is right,
          // and it is not an error.
          await rmdir(absolute).catch(() => {});
          continue;
        }
        await rm(absolute, { force: true });
        // Tombstoned, so a peer that has not yet heard about the deletion
        // cannot put the file back. Only files: the restore's guard is about
        // writing a file, and a directory tombstone would refuse one that
        // merely shares the name.
        this._pendingDeletes.add(absolute);
        // And NOT this node's removal to claim. The same rule as
        // `_recordReceived`, for the other half of the delta: a path dropped
        // from what peers know cannot reappear in this node's `removed`.
        this._announcedContent.delete(path);
      } catch (err) {
        /* v8 ignore next -- @preserve a file we cannot remove is retried */
        this._writeSyncError(`removals/${path}`, err);
      }
    }
    this._persistTombstones();
    console.log(
      `${this._tag} applied ${plan.apply.length} peer deletion` +
        `${plan.apply.length === 1 ? '' : 's'}: ` +
        `${plan.apply.slice(0, 3).join(', ')}`,
    );
  }

  /**
   * Appends one entry to this folder's history. Best-effort.
   *
   * A chain that cannot be written must never stop a folder syncing, so every
   * failure is recorded and swallowed — the same discipline as
   * {@link _persistCurrentRef}. Nothing reads the chain yet, so a gap in it
   * costs nothing today; when something does, a gap is what `complete: false`
   * is for.
   * @param treeRef - The state the folder ended up at.
   * @param delta - What that push changed and removed.
   */
  private async _recordChainEntry(
    treeRef: string,
    delta: FsTreeDelta,
  ): Promise<void> {
    if (!this._chain) return;
    // A peer head adopted since the last entry becomes a second parent, which
    // is what makes one node's history reachable from another's. Consumed
    // once: naming it on every later entry would claim to descend from it
    // repeatedly and grow the walk for nothing.
    const adopted = this._adoptedChainHead;
    this._adoptedChainHead = undefined;
    const parents = [this._chainHead?.head, adopted].filter(
      (r): r is string => r !== undefined,
    );
    try {
      const entry = await this._chain.append({
        treeRef,
        changed: delta.changed,
        removed: delta.removed,
        previous: parents,
      });
      this._chainHead = { head: entry.head, treeRef };
      for (const path of entry.changed) {
        this._localPathTimeIds.set(path, entry.timeId);
      }
      // A path this node deletes has no live claim any more. Leaving one would
      // make a peer's later removal of the same path look stale.
      for (const path of entry.removed) {
        this._localPathTimeIds.delete(path);
      }
    } catch (err) {
      /* v8 ignore next -- @preserve best-effort; see the doc comment */
      this._writeSyncError('chain/append', err);
    }
  }

  private _adoptAppliedRef(connector: Connector, treeRef: string): void {
    if (this._lastAppliedRef && this._lastAppliedRef !== treeRef) {
      connector.invalidateSent?.(this._lastAppliedRef);
    }
    this._lastAppliedRef = treeRef;
  }

  /**
   * Derives a deterministic content key from an FsTree.
   * @param tree - Tree structure to derive content key from
   */
  private _contentKeyFromTree(tree: FsTree): string {
    return this._contentKeyFromMap(this._getFileContentMap(tree));
  }

  /**
   * Compares two trees by file content (relativePath + blobId).
   * Ignores mtime differences — trees are equivalent if they have the same
   * files with the same content. This prevents bounce-back restores from
   * destroying locally-created files during bidirectional sync.
   * @param a - First tree to compare
   * @param b - Second tree to compare
   */
  private _treesHaveEquivalentContent(a: FsTree, b: FsTree): boolean {
    const aFiles = this._getFileContentMap(a);
    const bFiles = this._getFileContentMap(b);

    if (aFiles.size !== bFiles.size) return false;

    for (const [path, blobId] of aFiles) {
      if (bFiles.get(path) !== blobId) return false;
    }

    return true;
  }

  /**
   * Builds the dependency surface a {@link FsConflictResolver} needs, wiring it
   * to this agent's db, blob store, scanner, and working directory.
   *
   * The merge store records the merged ref/content key as the last-sent state,
   * so the watcher-driven re-scan that follows the on-disk materialisation
   * settles to a no-op instead of re-broadcasting.
   * @param db - Database instance
   * @param treeKey - Tree table key
   */
  private _buildConflictResolverDeps(
    db: Db,
    treeKey: string,
  ): ConflictResolverDeps {
    return {
      treeKey,
      getInsertHistory: async (table) => {
        const dump = await db.getInsertHistory(table);
        /* v8 ignore next -- @preserve the history table exists once a conflict fired */
        const rows = dump[`${table}InsertHistory`]?._data ?? [];
        return rows as InsertHistoryRow<string>[];
      },
      getRefOfTimeId: (table, timeId) => db.getRefOfTimeId(table, timeId),
      // The chain's stamp for a branch tip, which is what decides a conflict.
      //
      // It has to come from here rather than from InsertHistory because
      // `Db.insertTrees` writes its own operation name as the row's `origin`
      // and never sets `clientTimestamp` — so the two keys the resolver used
      // to order by were a constant and a zero on every node, and the winner
      // fell through to a content-hash comparison. See
      // `BranchTip.chainTimeId`.
      //
      // Swallowed on failure: an unanswerable stamp orders as "not
      // comparable" and the resolver falls back, which is strictly better
      // than failing a merge.
      onConflicts: (reports) => this._recordConflicts(reports),
      chainTimeIdOfRef: async (treeRef) => {
        await this._ensureChain(db, treeKey);
        return (
          await this._chain?.entryForTreeRef(treeRef).catch((err) => {
            this._writeSyncError('chain/timeIdOfRef', err);
            return undefined;
          })
        )?.timeId;
      },
      // WHO LAST CHANGED THIS FILE, read out of the shared history.
      //
      // The resolver asks it per conflicting path, so a branch can no longer
      // win files it never touched. The answer comes from the chain and not
      // from a clock, which is what makes every node work out the same winner
      // on its own.
      // A LOG SINK, which this never had.
      //
      // `FsConflictResolver` logs through `deps.log?.()`, and with no sink
      // supplied every line it writes — including the one that says which
      // paths a per-path verdict moved, and the warning about paths that
      // cannot be written here — went nowhere. A resolver that resolves in
      // silence is the defect this package already fixed once at the report
      // level; it was still true of its log.
      //
      // It also cost hours of this investigation: diagnostics added through
      // this sink produced no output, and the absence was read as the code not
      // running.
      log: (level, message) => {
        if (level === 'error') console.error(message);
        else if (level === 'warn') console.warn(message);
        else console.log(message);
      },
      lastEditOfPath: async (treeRef, path) => {
        await this._ensureChain(db, treeKey);
        const entry = await this._chain
          ?.entryForTreeRef(treeRef)
          .catch(() => undefined);
        if (!entry) return undefined;
        return (
          await this._chain?.lastEditOf(entry.head, path).catch((err) => {
            /* v8 ignore next -- @preserve a failed walk leaves the branch
               order to decide, which is the behaviour this replaces */
            this._writeSyncError('chain/lastEditOfPath', err);
            return undefined;
          })
        )?.timeId;
      },
      fetchTree: (rootRef) => this._fetchTreeFromDb(db, treeKey, rootRef),
      getBlobContent: (blobId) => this._adapter.getFileContent(blobId),
      restoreTree: (tree) =>
        // ADDITIVE, unconditionally, and no longer only under bucket sync.
        //
        // The inline merge is what handles two people editing the same file,
        // so it must keep running — removing it cost three conflict-resolution
        // tests. But it MATERIALISES its result with a prune, and a merged
        // tree that could not resolve the common ancestor is missing one
        // side's files: measured, the partitioned node lost the file it had
        // created, 6 runs in 8.
        //
        // It used to be `!this._bucketSyncOn`, which left the destructive
        // variant alive for a build with `announceTreeRef` on. That is the
        // same inference by absence as everywhere else, with the same answer:
        // the merge contributes everything it worked out, nothing it could not
        // account for is deleted on its authority, and a real deletion comes
        // from the chain. This was the last path inside the agent that could
        // delete a file no peer had ever stated a removal for.
        this.restore(tree, undefined, { cleanTarget: false }),
      writeFileAt: async (relativePath, content) => {
        const filePath = join(this._rootPath, relativePath);
        await mkdir(dirname(filePath), { recursive: true });
        await FsAgent._atomicWriteFile(filePath, content);
      },
      deleteFileAt: async (relativePath) => {
        await rm(join(this._rootPath, relativePath), {
          force: true,
          recursive: true,
        });
      },
      scan: () => this._scanner.scan(),
      storeMerge: async (tree, previous) => {
        const dbAdapter = new FsDbAdapter(db, treeKey);
        const ref = await dbAdapter.storeFsTree(tree, { previous });
        // Echo suppression: the materialisation touched disk, so record the
        // merged state as last-sent; the watcher's re-scan then settles to a
        // no-op rather than re-broadcasting the merge. The merge revision D is
        // also the new ancestry head.
        this._lastSentRef = ref;
        this._lastPushedRef = ref;
        this._lastSentContentKey = this._contentKeyFromTree(tree);
        // A merge revision is the one state with TWO parents, and that is
        // exactly the shape `FsEditChain` writes its rows by hand to allow.
        // The chain entry is still LINEAR here, because naming both parents
        // means mapping two tree refs to two chain heads, and nothing resolves
        // that direction yet. It belongs with the walk.
        //
        // AND IT CLAIMS ONLY WHAT THE MERGE PRODUCED. See `_mergeInputs`: a
        // path whose merged bytes came from either side was authored by
        // whoever wrote those bytes, not by the act of choosing between them.
        const mergeDelta = this._rememberAnnounced(tree);
        const inputs = this._mergeInputs;
        if (inputs) {
          const merged = this._getFileContentMap(tree);
          mergeDelta.changed = mergeDelta.changed.filter((path) => {
            const bytes = merged.get(path);
            return (
              bytes !== inputs.before.get(path) &&
              bytes !== inputs.incoming.get(path)
            );
          });
        }
        await this._recordChainEntry(ref, mergeDelta);
        this._currentRef = ref;
        return ref;
      },
      // Resolution failures are surfaced by `_onConflict`; success is silent.
    };
  }


  /**
   * Watches database for tree changes and syncs to filesystem
   * Uses Connector for socket-based notifications
   * @param db - Database instance
   * @param connector - Connector instance for socket-based sync
   * @param treeKey - Tree table key
   * @param restoreOptions - Restore options (e.g., cleanTarget)
   * @returns Function to stop watching
   */
  async syncFromDb(
    db: Db,
    connector: Connector,
    treeKey: string,
    restoreOptions?: RestoreOptions,
  ): Promise<() => void> {
    // This agent has never been told anything, whatever the connector believes.
    //
    // A connector outlives the agent consuming it: `Node.restartAgent()`
    // rebuilds the agent from the EXISTING transport, so a fresh agent starts
    // against a received-dedup set full of conclusions drawn for its
    // predecessor. Those conclusions were about a folder state this agent does
    // not have.
    //
    // Measured: an agent restarted onto an emptied folder needs its peers to
    // re-send what it lost, and those peers answer with exactly the ref the
    // connector had already delivered to the previous agent — dropped before
    // this one saw it, leaving the folder empty. That is `snapshot-bootstrap`
    // on the lab, red on every run the suite has ever produced.
    //
    // A no-op on a first start, and cheap when it is not: a redelivered ref
    // whose state the folder already holds costs one content comparison.
    connector.resetReceived?.();

    // Said once, loudly, because the alternative is finding out from a user
    // whose file disappeared.
    //
    // THE DATA-LOSS REASON FOR THIS WARNING IS CLOSED. The warning stays,
    // because `causalOrdering` is still a requirement — for a narrower reason,
    // and the history matters more than the line of code.
    //
    // It used to read: without ancestry on the wire, a tree that simply
    // predates this node's newest write is indistinguishable from one deleting
    // it, so the prune rule needed a deliberate escape hatch — and the hatch
    // was where `KNOWN-WEAKNESSES.md` §3 lived, *"two people save different
    // files at the same moment on different machines, one file disappears, and
    // the node that lost it is the one that created it"*. It then said the
    // case could not be closed from inside this agent, because no fact
    // available on one machine separates the two trees.
    //
    // That was true of the mechanism it was written about, and that mechanism
    // is gone. **There is no prune rule and no escape hatch**: an absence is
    // never a deletion, and a removal arrives STATED in the chain by the node
    // that performed it. The distinction the comment said was impossible is no
    // longer needed, because nothing is inferred from a tree's silence. Mesh
    // F2 — *two nodes writing DIFFERENT files at the same instant keep both* —
    // asserts §3's exact scenario and passes.
    //
    // What `causalOrdering` is still needed for: the predecessor refs it
    // carries are what let the merge gate in `processRef` fire at all, so a
    // transport without it resolves no conflicts. That is a real loss and
    // worth one loud line — but it is not silent data loss any more, so the
    // sync-error entry below says what it now costs.
    if (connector.syncConfig?.causalOrdering !== true) {
      console.warn(
        `${this._tag} ${this._rootPath}: this transport carries no ancestry ` +
          `(syncConfig.causalOrdering is not true). Deletions and ` +
          `simultaneous writes cannot be told apart, so a file written here ` +
          `at the same moment as one written on a peer can be removed from ` +
          `this node. Turn causalOrdering on.`,
      );
      this._writeSyncError(
        'syncFromDb/noAncestry',
        new Error(
          'causalOrdering is off: no predecessors on the wire, so conflicting ' +
            'edits to one file are not merged (both copies are kept, but ' +
            'nothing reconciles them)',
        ),
      );
    }

    // Before any announcement can arrive: a node that only receives still has
    // to resolve the heads its peers announce. See `_ensureChain`.
    await this._ensureChain(db, treeKey);

    if (this._bucketSyncOn && !this._bucketSync) {
      this._bucketSync = this._makeBucketSync(connector, db, treeKey);
    }

    // Start watching filesystem (if not already watching)
    await this._ensureWatching();

    // Debounced incoming ref handler: when multiple refs arrive in rapid
    // succession (e.g. the other side is doing a multi-step Finder operation),
    // only the LAST ref is processed after a quiet period.
    let pendingRef: string | null = null;
    let fromDbTimer: ReturnType<typeof setTimeout> | null = null;
    // Recovery budget carried alongside the pending ref: a freshly-arrived ref
    // starts at 0; a re-queued (recovered) ref carries its incremented count.
    let pendingRecoveryAttempt = 0;
    // Predecessor content refs carried with the pending ref (causalOrdering).
    let pendingPredecessorRefs: string[] | undefined;
    /** Whether the pending ref was the newest thing its sender had said. */
    let pendingIsNewest = true;
    /**
     * Whether a `processRef` is running, including the pauses between its
     * retries — `_remoteApplyInFlight` is clear during those, and a repair
     * started then would run a second apply alongside the first.
     */
    let processing = false;

    const processRef = async (
      treeRef: string,
      recoveryAttempt = 0,
      predecessorRefs?: string[],
      isNewestFromSender = true,
    ) => {
      const maxAttempts = this._timeouts.processRefRetries + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Pause filesystem watching to prevent loops
        // A stale advertisement is not news, and is therefore not acted on
        // AT ALL.
        //
        // This corrects the previous version of the guard, which applied a
        // stale advertisement additively and only withheld pruning, on the
        // reasoning that "its files are real, just old". That is wrong when
        // the stale state predates a deletion: its files include the one that
        // was just deleted, so the deletion is undone by ADDITION rather than
        // by pruning. Measured — with the guard in its additive form, a
        // periodic re-advertisement made modify-delete fail two runs in four.
        //
        // Nothing is lost by ignoring it. The sender's current state arrives
        // in its own advertisement, and a peer that already holds the newer
        // state needs nothing from the older one.
        //
        // ONE place decides whether an inbound ref is news to this agent. The
        // question used to be answered in scattered conditions, and every one of
        // them has been wrong at least once — see `inboundRefVerdict`.
        const verdict = this._inboundRefVerdict(treeRef, isNewestFromSender);
        if (verdict !== 'apply') {
          console.warn(
            `${this._tag} ref=${treeRef.slice(0, 8)}… ${VERDICT_REASON[verdict]} ` +
              `— ignoring it.`,
          );
          // Hand it back to the connector's dedup, WHATEVER the verdict was.
          // It was marked received on arrival and never applied, so leaving it
          // marked blocks a later, genuine return to this exact state — refs
          // are content hashes, so that state re-derives the identical ref.
          //
          // This used to run for `stale` only, and the gap cost a class of lost
          // deletions. Delete a file and the folder returns to the state it
          // held before the file existed; that state's ref is the one a peer
          // may already have sent us and we may already have suppressed. The
          // delete then never reaches this verdict at all — the connector
          // dedups it on arrival — so nothing is logged, nothing is applied,
          // and it never heals, because every re-announcement carries the same
          // content hash.
          //
          // Safe for a true own-echo too: invalidating only means the ref is
          // judged again if it comes back. If this agent is still in that
          // state, `_lastSentRef` still matches and it is suppressed again at
          // no cost; if it has moved on, the ref is genuinely news.
          connector.invalidateReceived(treeRef);
          // An ECHO is the strongest possible statement that two folders hold
          // the same content: this node sent that exact ref. So it is the
          // right moment to agree on one entry describing it — and the only
          // moment, because nothing else on this path runs.
          if (verdict === 'own-echo') await this._agreeOnEntryFor(treeRef);
          return;
        }

        this._scanner.pauseWatch();
        this._remoteApplyInFlight = true;

        try {
          // THE SENDER'S DELETIONS, before any branch can return without them.
          //
          // A deletion carried in the chain is a FACT the sender states, and
          // acting on it is not conditional on adopting the sender's tree.
          // Several paths below return early and correctly — the content is
          // already equivalent, the sender is behind us, the ancestry forbids a
          // prune, the fork is resolved by an inline merge — and a removal
          // parked inside the restore branch is reached on NONE of them.
          //
          // The merge path is the one that matters, and it only became the
          // common case once reachability started classifying forks correctly:
          // `_resolveConflictInline` returns before the restore, so every
          // deletion that arrived with a fork was silently dropped.
          //
          // Safe before the fetch because it needs no tree, and safe under the
          // paused watcher because the resume rescans what it missed, so the
          // deletion is announced like any local one. Bounded twice regardless
          // of the path: `timeId` recency and the mass-delete circuit breaker.
          // See `planRemovals`.
          await this._applyIncomingRemovals(treeRef);

          // Fetch incoming tree from DB (without restoring yet)
          const incomingTree = await this._timed('apply.fetchTree', () =>
            FsAgent._withTimeout(
              this._fetchTreeFromDb(db, treeKey, treeRef),
              this._timeouts.fetchTree,
              `syncFromDb → fetchTree(${treeKey}@${treeRef.slice(0, 8)}…)`,
            ),
          );

          // Log fetch result for diagnostics
          const incomingNodeCount = incomingTree.trees.size;
          console.log(
            `${this._tag} syncFromDb: fetched tree with ${incomingNodeCount} nodes ` +
              `for ref=${treeRef.slice(0, 8)}…`,
          );

          // Extract current filesystem state for content comparison
          const currentTree = await FsAgent._withTimeout(
            this.extract(),
            this._timeouts.extract,
            `syncFromDb → extract(${this._rootPath})`,
          );

          // Compare file content (paths + blobIds, ignoring mtime).
          // If identical, this is a bounce-back — skip restore to avoid
          // cleanTarget deleting locally-created files.
          if (this._treesHaveEquivalentContent(currentTree, incomingTree)) {
            const incomingFiles = this._getFileContentMap(incomingTree);
            const currentFiles = this._getFileContentMap(currentTree);
            console.log(
              `${this._tag} syncFromDb: equivalent content, skipping restore ` +
                `(incoming=${incomingFiles.size} entries, ` +
                `current=${currentFiles.size} entries, ` +
                `ref=${treeRef.slice(0, 8)}…)`,
            );
            // Equivalent content means this ref DESCRIBES the folder as it
            // stands — the same conclusion the restore path reaches, reached
            // without any work to do. It has to update the dedup bookkeeping
            // for the same reason, and skipping that was a silent hole:
            // `invalidateSent` retires the ref this agent is LEAVING, so the
            // chain only stays unbroken while every state the agent passes
            // through is recorded as it is adopted. A state adopted here was
            // never recorded, so it was never retired, and it sat in the
            // connector's received set for the rest of the session — the
            // bootstrap ref most of all, which every agent reaches this way.
            // A peer that later returned the folder to that state re-derived
            // its exact ref (refs are content hashes) and the advertisement
            // was dropped as already-received, so the change reached no peer
            // at all. Deleting a file created earlier in the session is
            // precisely that shape. See `doc/safety-rescan.md`.
            this._adoptAppliedRef(connector, treeRef);
            // And tell the anti-entropy, which is comparing REFS and cannot
            // reach this conclusion on its own.
            //
            // This is the hole the eight-minute red came through. The agent
            // had ALREADY computed the answer one line above — the per-path
            // content map says the two folders are the same — and kept it to
            // itself. The anti-entropy then rediscovered the same fact the
            // long way round: declare a divergence, wait out the grace
            // period, start a repair, run a bucket round, find the roots
            // identical, and only then clear. Measured on the lab: 38
            // identical files with identical hashes, `diverged: true` for over
            // EIGHT MINUTES across six merge repairs, logging "equivalent
            // content, skipping restore" each time — the apply path saying the
            // right thing to nobody.
            //
            // The content map is the authority on "is this the same folder",
            // and every place that consults it has to report what it found.
            this._antiEntropy?.agreedOn(treeRef);
            // And record the state as OURS, which this path used to leave
            // half-done — the connector's bookkeeping was updated, the agent's
            // was not.
            //
            // The consequence was the laundering step in the large-folder
            // rollback, traced on the lab to this exact path. The folder now
            // matches `treeRef`, but `_lastSentContentKey` still described some
            // earlier state, so the next debounced push saw a content key that
            // did not match, concluded it had news, and re-derived a ref —
            // which, refs being content hashes, was `treeRef` itself. `_sendRef`
            // then deliberately clears the connector's dedup so a genuine
            // A → B → A deletion can go out, and that carried this one out too.
            //
            // The effect is that a node re-advertises a state it ADOPTED as
            // though it authored it. That turns a stale tree into fresh-looking
            // news from a new sender, which defeats the per-sender staleness
            // check that would otherwise have caught it, and peers that had
            // moved on prune back to it — 77 files at a time, under the
            // mass-delete guard's floor.
            //
            // Recording the content key cannot suppress a real local change:
            // any actual edit gives a different key, and the push proceeds.
            this._currentRef = treeRef;
            this._persistCurrentRef(treeRef);
            this._lastSentContentKey = this._contentKeyFromTree(currentTree);
            this._rememberAnnounced(currentTree);

            // And agree with the fleet on ONE entry for it. Equivalent
            // content is the same statement an echo makes, reached the long
            // way round. See `_agreeOnEntryFor`.
            await this._agreeOnEntryFor(treeRef);
            return;
          }

          // Client-only conflict handling: classify the incoming revision
          // against our head via the shared-ref DAG. `ahead` (an older ancestor,
          // e.g. a reconnect bootstrap) is ignored; `diverged` (concurrent
          // edits) is resolved inline — a 3-way merge into a merge revision D —
          // *before* the destructive restore could clobber local changes, all
          // while the watcher is paused; `behind` falls through to fast-forward.
          // THE CHAIN DECIDES FIRST, and unconditionally.
          //
          // An incoming state whose entry is an ANCESTOR of this node's head
          // is a state this node has already left. Applying it is a rollback,
          // and it is the defect `_inboundRefVerdict` documents as its own
          // known limit: that check recognises only the LAST ref this node
          // sent as its own echo, so *"an echo of an OLDER self-originated ref
          // still gets through"*. Measured: a writer at v20 had its own v19
          // delivered back and applied, and the whole fleet settled one
          // revision behind the last save — about one run in five.
          //
          // The chain answers this exactly and without heuristics: v19 is
          // reachable from v20 by walking `previous`, so it is an ancestor and
          // there is nothing to do. No clock, no origin, no content
          // comparison, no guessing from how many predecessors a payload
          // happened to carry.
          //
          // UNCONDITIONAL, unlike the branch below it, which asks only when
          // `resolveConflicts` is on AND the payload brought predecessors.
          // Rolling backwards is not a conflict-resolution concern and not
          // something to opt into — a node must never move to a state it has
          // already left, whatever else is configured.
          // What the CHAIN says about the two histories, when it can say.
          // Read twice: by the rollback guard immediately below, and by the
          // merge gate after it.
          let chainRelation: 'behind' | 'ahead' | 'fork' | 'incomplete' =
            'incomplete';
          if (this._chain && this._chainHead) {
            // `classify` compares chain HEADS, and what arrived is a TREE ref.
            //
            // The head the ANNOUNCEMENT carried is the right one: it is what
            // the sender said about itself. The lookup by tree ref is only the
            // fallback, for a ref that came without one — the hub's own
            // advertisements, an older peer — and it is ambiguous by nature,
            // because a tree ref is a content hash and two nodes holding the
            // same bytes produce the same one. Two freshly started nodes both
            // have an entry for the EMPTY tree, so asking by hash there can
            // return either node's.
            //
            // Neither available means no entry covers this state, which leaves
            // the decision to the branches below rather than guessing.
            const relation = await this._classifyAnnouncedRef(treeRef);
            // Kept for the merge gate below, so the chain's answer is used
            // there too rather than recomputed from the whole history.
            chainRelation = relation;
            if (relation === 'ahead') {
              // A state this node REFUSES is never a parent of anything it
              // records later. Dropping the parked head is what keeps the
              // claim and the refusal from contradicting each other.
              this._announcedHeads.delete(treeRef);
              // `warn`, not `log`: a peer pushing a state this node has left
              // means that peer is behind and does not know it. The node
              // protects itself here, but somebody still has to catch up.
              console.warn(
                `${this._tag} ref=${treeRef.slice(0, 8)}… is a state this node ` +
                  `has already left — ignoring it.`,
              );
              return;
            }
          }

          if (
            this._resolveConflicts &&
            this._currentRef &&
            predecessorRefs &&
            predecessorRefs.length > 0
          ) {
            // THE CHAIN ANSWERS FIRST; `_ancestryRelation` IS THE OLD PATH.
            //
            // `_ancestryRelation` reads the WHOLE InsertHistory table and
            // builds two maps over every row in it, on every announcement
            // that reaches here — and it answers the same question
            // `classify` just answered above with a bounded, cached walk. It
            // predates the chain and it is kept for one case only: a peer the
            // chain cannot speak for, which is a node on the old wire format
            // (`announceTreeRef`) or one whose chain failed to initialise.
            // The same condition keeps the heuristics in
            // `antiEntropyDecision` alive, and both go when the fleet is on
            // the chain.
            //
            // Where the chain HAS an answer it is authoritative, so there is
            // nothing to recompute: `fork` is the merge, `behind` is the
            // fast-forward that falls through to the restore below, and
            // `ahead` already returned above.
            const relation =
              chainRelation !== 'incomplete'
                ? chainRelation
                : await this._ancestryRelation(
                    db,
                    treeKey,
                    this._currentRef,
                    treeRef,
                    predecessorRefs,
                  );
            /* v8 ignore next -- @preserve the unconditional guard above
               returns on `ahead` before this is reached; only the old path
               can produce it here, and only for a peer the chain cannot
               speak for */
            if (relation === 'ahead') {
              return; // We already have a newer revision; ignore the ancestor.
            }
            /* v8 ignore else -- @preserve 'behind' falls through to restore */
            if (relation === 'diverged' || relation === 'fork') {
              await this._resolveConflictInline(
                db,
                treeKey,
                treeRef,
                incomingTree,
                predecessorRefs,
              );
              return;
            }
          }

          // Content differs — restore from incoming tree. ADDITIVELY, AND
          // THAT IS NOT A SETTING.
          //
          // **An absence is not a deletion.** A tree lacks a path because the
          // sender removed it, or because the sender never had it, and a
          // content hash cannot tell the two apart. Every attempt to decide it
          // from the outside failed, and this is the graveyard: a rule asking
          // *"could the sender have seen my state?"* from a declared
          // predecessor ref, a flag for whether the transport carried ancestry
          // at all, a guard for files this node had not yet announced, and a
          // set of a thousand remembered past states. Four reverts, 155 files
          // of measured drift on four machines, and a file deleted from 3 642
          // that was back moments later.
          //
          // Deletions now arrive STATED, in the chain, where the node that
          // performed one wrote it down: `_applyIncomingRemovals`, ordered by
          // `timeId`, bounded by the mass-delete guard, and walked back through
          // `previous` so a deletion made during a partition is still found.
          // That walk is the only authority, and it runs before this point.
          //
          // The failure mode changes from *files silently deleted* to
          // *deletions silently delayed* — a walk that cannot complete simply
          // does nothing and the next announcement carries it. That is the
          // right direction to be wrong in, and it is what this package is
          // for: a non-destructive decentral sync.
          //
          // `cleanTarget` is still accepted and still honoured by a direct
          // `restore()` call. See {@link RestoreOptions.cleanTarget}.
          const applyOptions =
            restoreOptions?.cleanTarget === true
              ? { ...restoreOptions, cleanTarget: false }
              : restoreOptions;

          // What this agent believed at the moment it applied. A rollback is
          // always SOMEONE deciding a deletion is real, and until this line the
          // decision left no record — only its consequence, in a count of files
          // that were suddenly gone.
          const incomingFileMap = this._getFileContentMap(incomingTree);
          const currentFileMap = this._getFileContentMap(currentTree);
          console.log(
            `${this._tag} applying ref=${treeRef.slice(0, 8)}… ` +
              `newestFromSender=${isNewestFromSender} ` +
              `incomingFiles=${incomingFileMap.size} ` +
              `currentFiles=${currentFileMap.size}`,
          );

          // A SENDER HOLDING FAR LESS THAN THIS NODE IS THE ONE THAT NEEDS
          // TELLING, and an additive apply alone will never tell it.
          //
          // This used to happen inside the mass-delete guard's refusal, which
          // is also where the measurement comes from: a client that had joined
          // and was then emptied sat at **1 of 3 642 files** with no refusal
          // logged at all, while a fresh client was refused, answered, and
          // converged in eleven seconds. And on four nodes, two sat at 5 and
          // 15 of 121 files and could not recover, because every node holding
          // the files refused their pushes and then went quiet.
          //
          // Nothing prunes on absence any more, so there is no refusal to hang
          // this off — but the liveness problem it solved is untouched: a
          // sparse peer pushes, this node applies nothing (there is nothing
          // new in it), this node's own content does not change, so it has
          // nothing to announce and says nothing. The sparse peer hears
          // silence and stays sparse.
          //
          // Non-destructive by construction — it only re-announces what this
          // node already holds — and rate-limited, because two nodes can each
          // hold what the other lacks and answer each other forever. The
          // thresholds are the guard's, so "far less" means the same thing it
          // has always meant here.
          let missingFromSender = 0;
          for (const path of currentFileMap.keys()) {
            if (!incomingFileMap.has(path)) missingFromSender++;
          }
          if (
            missingFromSender > MASS_DELETE_MIN_FILES &&
            (incomingFileMap.size === 0 ||
              missingFromSender / currentFileMap.size > MASS_DELETE_MAX_RATIO)
          ) {
            console.warn(
              `${this._tag} ref=${treeRef.slice(0, 8)}… holds ` +
                `${incomingFileMap.size} where this node holds ` +
                `${currentFileMap.size} — the sender is the one missing data.`,
            );
            // RETIRE IT, or the SECOND time this happens is silent. A tree ref
            // is a content hash, so a folder emptied twice re-derives the same
            // ref both times — and the first advertisement left it marked
            // "already received" here, so the connector drops the second
            // before this agent ever sees it. Nothing answers and the peer
            // stays empty for good.
            //
            // Measured: a client that had already joined and was then emptied
            // sat at 1 of 3 642 files with nothing logged at all, while a FRESH
            // client — whose empty ref this node had never seen — was answered
            // and converged in eleven seconds. Same shape as the delete fix in
            // 0.0.31: hearing a state is not the same as having consumed it.
            connector.invalidateReceived(treeRef);
            await this._readvertiseAfterRefusal(connector);
          }
          await FsAgent._withTimeout(
            this.restore(incomingTree, undefined, applyOptions),
            this._timeouts.restore,
            `syncFromDb → restore(${treeKey})`,
          );

          // After restore: re-scan the filesystem so the scanner's internal
          // tree matches the just-restored state, then store and record the
          // ref.  When the watcher fires (because restore touched files on
          // disk), debouncedSync will produce the same content key → skip.
          //
          // IMPORTANT: skipNotification must be true here.  This store is
          // just bookkeeping — recording the current state after restore.
          // If we let notify fire, Connector broadcasts a ref, the other
          // side processes it, stores again (also broadcasting), and we get
          // an extra bounce-back cycle that can race with real file
          // mutations happening right after the settling period.
          const postRestoreTree = await this._timed('apply.rescan', () =>
            this._scanner.scan(),
          );
          const dbAdapter = new FsDbAdapter(db, treeKey);
          // Ancestry: this revision descends from the sender's predecessor refs
          // (mapped to local timeIds). restore preserves mtime, so the stored
          // ref equals the incoming ref — shared identity across clients.
          const previous = await this._ancestryPrevious(
            db,
            treeKey,
            predecessorRefs,
          );
          const postRestoreRef = await dbAdapter.storeFsTree(postRestoreTree, {
            skipNotification: true,
            previous,
          });
          this._adoptAppliedRef(connector, treeRef);
          // A tree ref is supposed to be a SHARED IDENTITY: restore the tree
          // and the folder re-derives the ref it came as. Everything built on
          // ancestry assumes it — a receiver prunes only for a sender that
          // names a state the receiver is in, so a node whose own re-scan
          // disagrees with what it just applied announces a parent nobody can
          // be in, and every deletion it ever sends is refused.
          //
          // So when the two disagree, the CONTENT MAP decides which kind of
          // disagreement it is, because the two readings call for opposite
          // responses:
          //
          //  - same content, different ref — benign, and NOT a divergence.
          //    The anti-entropy compares refs and would report it as one
          //    forever, so it is told. A tombstone this node refused, a
          //    rollout where a peer still derives the old ref: the folders
          //    agree and nothing needs repairing.
          //  - different content — this node really is short of what it
          //    applied (a locked file, an unfetchable blob), and a divergence
          //    is the correct signal. Said out loud, because it went unnoticed
          //    for exactly as long as nothing said it.
          //
          // Either way not an error: the folder holds the bytes it could get,
          // and the agent converges on content.
          if (postRestoreRef !== treeRef) {
            const sameContent = this._treesHaveEquivalentContent(
              postRestoreTree,
              incomingTree,
            );
            if (sameContent) {
              this._antiEntropy?.agreedOn(treeRef);
            }
            console.warn(
              `${this._tag} applied ${treeRef.slice(0, 8)}… but re-derived ` +
                `${postRestoreRef.slice(0, 8)}… — ` +
                (sameContent
                  ? 'same content, so not a divergence'
                  : "this node is short of what it applied"),
            );
          }
          // NOT recorded when the refs already match. `_contentAgreed` is
          // bounded, and an entry saying "these two equal refs describe equal
          // content" answers a question ref equality has already settled —
          // while evicting one of the mismatches that is the only reason the
          // set exists.
          this._currentRef = postRestoreRef;
          this._persistCurrentRef(postRestoreRef);

          // ADOPT THE SENDER'S ENTRY. Do not author one.
          //
          // An edit exists where a change was MADE. A node that applies a
          // peer's state changed nothing, so it has nothing to say — and
          // saying it anyway is what broke the model: the receiver
          // re-announced the state it had just applied as its OWN edit,
          // because the echo guard on the push path compares `_lastSentRef`,
          // which an apply never updates. The result was one LINEAGE PER NODE
          // stitched at adoption points instead of one shared history, so a
          // receiver's head was never inside the sender's ancestry,
          // `classify` answered `fork` where the truth was `behind`, and
          // "I am behind" became unobservable.
          //
          // THE THREE FACTS THIS KEEPS APART, because conflating them is what
          // made the first attempt at this unsafe:
          //
          //   where the folder IS      `_currentRef` + `_chainHead`
          //   what I TOLD the network  `_lastSentRef`, `_lastSentContentKey`
          //   what I last RECEIVED     `_lastAppliedRef`
          //
          // Adoption changes the first and must not touch the second.
          // Writing the adopted ref into `_lastSentRef` as well seems
          // equivalent and is not: `_inboundRefVerdict` reads that field to
          // recognise this node's own echo, so overloading it with "a state I
          // hold but never announced" weakens the echo check. Only the CONTENT
          // KEY is set, which is what stops the watcher's re-scan pushing the
          // state straight back out as news.
          //
          // ONLY WHEN THE FOLDER REALLY IS IN THAT STATE. If the re-derived
          // ref differs, this node is NOT where the sender is — a refused
          // tombstone, a locked file, an unfetchable blob — and claiming the
          // sender's head would assert a state it does not hold. It then
          // authors its own entry on the next push, which is correct: being
          // short of what you applied IS a state of your own.
          //
          // This only became possible when mtime left the content identity.
          // While a receiver's own re-scan produced a different ref for the
          // same bytes, authoring was the only truthful option — which is how
          // the code drifted here, and why the same symptom kept coming back
          // under different names.
          // Promoted HERE, at the apply, for the state that was applied — not
          // when the announcement was heard.
          const senderHead = this._announcedHeads.get(treeRef);
          this._announcedHeads.delete(treeRef);
          if (postRestoreRef === treeRef && senderHead !== undefined) {
            this._adoptedChainHead = undefined;
            this._chainHead = { head: senderHead, treeRef };
            this._lastSentContentKey =
              this._contentKeyFromTree(postRestoreTree);
            // No claim on any path either: a claim is what makes a peer's
            // later removal of that path look stale, and this node changed
            // nothing.
            for (const path of this._getFileContentMap(postRestoreTree).keys()) {
              this._localPathTimeIds.delete(path);
            }
          } else if (senderHead !== undefined) {
            // Applied, but the folder landed somewhere else: a merge, a refused
            // tombstone, a blob that would not fetch. This node still WENT
            // THROUGH the sender's state, so its own next entry names that head
            // as a second parent and the lineages join there instead.
            this._adoptedChainHead = senderHead;
          }

          // RECEIVING A PATH IS NOT EDITING IT.
          //
          // Whatever else happened, every path whose bytes now equal the bytes
          // that arrived came from the sender. This node did not change it, so
          // its next entry must not say it did — `_announcedContent` is what
          // the delta is computed against, so recording the arrival here is
          // what keeps the path out of `changed`.
          //
          // **The second half of the rollback.** With the roots unified a
          // healed receiver is no longer a fork of the writer at the root, but
          // one that landed SHORT still authors an entry of its own — correctly,
          // being short of what you applied is a state of your own. That entry
          // used to list the received paths as its own changes, stamped with a
          // fresh `timeId` at heal time, so OLD content carried a NEW time.
          // The writer then merged against it and the receiver's v5 out-ordered
          // the writer's v8. Measured: `changed=[doc (conflicted copy …).txt,
          // doc.txt]` on a node that had edited neither.
          //
          // The conflict copy in that list is genuinely local work and stays.
          this._recordReceived(incomingTree, currentTree, postRestoreTree);

          // NOT recording the incoming tree's files as prunable.
          //
          // 0.0.61 did exactly that, reasoning that a file which ARRIVED from a
          // peer is by definition one the peers know about, so a later tree
          // lacking it is deleting it. The reasoning is sound and the effect
          // was not: `_announcedFiles` is a GUARD, and widening it made far
          // more files prunable by any tree that happened to lack them.
          //
          // Measured on four machines, from an agreed 3 648 files: with nobody
          // doing anything but adding one file, the nodes drifted to
          // 3 493 / 3 513 / 3 630 / 3 553 — 155 files apart, actively losing
          // data. Before the change the same folder held steady at 3 642–3 647
          // across dozens of runs; deletion failed, but nothing decayed.
          //
          // Losing files is worse than failing to delete one. The guard stays
          // as it was until the deletion path has a fix that does not trade
          // convergence for it.

          // Claim this state as ADVERTISED only if it IS the sender's state.
          //
          // An apply does not always leave the folder equal to the incoming
          // tree: with `cleanTarget` off — or held off by one of the guards
          // above — the result is a SUPERSET, our files plus theirs. Recording
          // that merged state as last-sent tells the debounce there is nothing
          // left to say, and `ref === this._lastSentRef` then swallows the
          // push outright. The peer never learns about the files only we have.
          // A change the safety rescan finds while an apply is running is
          // exactly that shape, and it is what the field reported as never
          // arriving.
          //
          // Equal content is the opposite case, and the one that must stay
          // quiet: re-announcing a state we just adopted launders a stale tree
          // into news from a new sender — traced on the lab to this very path —
          // and peers that had moved on prune back to it, 77 files at a time,
          // under the mass-delete guard's floor.
          //
          // Same question, two answers, one condition: did this apply leave us
          // where the sender is, or somewhere only we are?
          // "Different" is not the same as "ahead", and 0.0.46 conflated them.
          //
          // Three outcomes, not two. Equal — their news, stay quiet. A superset
          // — we hold files they lack, so we have something to say. But a node
          // in the middle of catching up is a SUBSET: its folder is behind the
          // sender's, and announcing that is how a burst turns into a rollback.
          //
          // The lab measured it directly. Trees arrived at the writer carrying
          // 1 008 files, then 892, then 907, each stamped
          // `newestFromSender=true` — and they were, because they came from
          // DIFFERENT peers, each monotonic for itself. A per-sender sequence
          // cannot order two senders against each other, so nothing downstream
          // could tell that 892 was a node still catching up rather than a node
          // deleting 116 files.
          //
          // Which means the node that is behind has to stay quiet on its own
          // account. It knows something no receiver can work out: that what it
          // holds came FROM the tree it just applied, minus what has not landed
          // yet.
          const postRestoreFiles = this._getFileContentMap(postRestoreTree);
          const incomingFiles = this._getFileContentMap(incomingTree);
          let hasNewsOfOurOwn = false;
          for (const path of postRestoreFiles.keys()) {
            if (!incomingFiles.has(path)) {
              hasNewsOfOurOwn = true;
              break;
            }
          }
          if (!hasNewsOfOurOwn) {
            this._lastSentRef = postRestoreRef;
            this._lastSentContentKey = this._contentKeyFromTree(postRestoreTree);
            this._rememberAnnounced(postRestoreTree);
            if (postRestoreFiles.size < incomingFiles.size) {
              console.log(
                `${this._tag} ref=${treeRef.slice(0, 8)}… left this node behind ` +
                  `(${postRestoreFiles.size} of ${incomingFiles.size} files) — ` +
                  `not announcing a state that is catching up.`,
              );
            }
          }
          return; // Success — exit retry loop
        } catch (err) {
          // NO `MassDeleteRefusedError` BRANCH HERE, and that is not an
          // omission.
          //
          // It is thrown only from inside `restore`'s `cleanTarget` block, and
          // every apply on this path passes `cleanTarget: false` — deliberately,
          // because the chain made deletions STATED rather than inferred from
          // a tree being sparse. So the whole-folder prune this used to catch
          // cannot happen here any more, and the branch that handled it sat
          // dead with its own re-announcement machinery behind it.
          //
          // The live mass-delete guards are `planRemovals` and the bucket
          // round's destructive half; both refuse in place and log, neither
          // throws. **If a prune is ever re-enabled on this path, the refusal
          // handling has to come back with it** — including telling the sender,
          // because a node that refuses a sparse tree and then goes quiet
          // leaves the sender stranded with nothing to catch up from, and the
          // fleet livelocks. That was measured on four nodes sitting at 5 and
          // 15 of 121 files.
          if (
            err instanceof PartialRestoreError ||
            err instanceof BlobUnavailableError
          ) {
            // Both mean the same thing here: the folder is a half-applied
            // version of a newer state, and re-announcing it would assert the
            // half. For an unfetchable blob the danger is sharper than for a
            // locked file — this node's folder LACKS the file entirely, so a
            // broadcast of its own scan reads to every peer as a deletion of
            // it, and the one node that could not receive a file would order
            // everyone else to destroy their copy.
            //
            // The mirror image. Here the incoming ref is the NEWER state and
            // this folder holds a half-applied version of it, with the OLD
            // bytes still in the files that were locked. The watcher wakes on
            // resume, sees hundreds of changed files, and would broadcast
            // that — re-asserting the old bytes to every peer and undoing the
            // change being applied. One user with a document open would
            // silently revert it for everyone.
            //
            // Recording it as the last state SENT suppresses exactly that,
            // without claiming the ref was applied: the ref bookkeeping is
            // untouched so the retry below still re-applies it, and a genuine
            // local edit afterwards still differs and still goes out.
            try {
              const halfApplied = await this._scanner.scan();
              this._lastSentContentKey =
                this._contentKeyFromTree(halfApplied);
            } catch {
              /* v8 ignore next -- @preserve a failed scan here just means the
                 echo is not suppressed; the retry still runs */
            }
          }
          if (attempt === maxAttempts) {
            if (recoveryAttempt >= this._timeouts.recoveryRetries) {
              // Recovery budget exhausted (or disabled) — give up and record it.
              console.error(
                `${this._tag} syncFromDb processRef failed after ${maxAttempts} ` +
                  `attempts and ${recoveryAttempt} recoveries:`,
                err,
              );
              this._writeSyncError('syncFromDb/processRef', err);
              // Don't make the loss permanent. The ref was added to the
              // Connector's received-dedup set the moment it arrived, so the
              // server's bootstrap heartbeat (which re-advertises the latest
              // ref) is suppressed as a duplicate and can never re-trigger this
              // failed apply once the transient fetch/blob-pull condition
              // clears. Invalidating it lets the next heartbeat re-deliver the
              // ref, turning permanent loss into eventually-consistent recovery.
              connector.invalidateReceived(treeRef);
            } else {
              /* v8 ignore else -- @preserve a newer ref superseding mid-
                 recovery (pendingRef set while this ref was being processed)
                 is a timing race that cannot be reproduced deterministically */
              if (pendingRef === null) {
                // Per-cycle retries exhausted, but rather than DROP the ref (and
                // lose the file written during a transport disruption) we
                // re-queue it for a later recovery cycle. tearDown() stops it.
                console.warn(
                  `${this._tag} syncFromDb: ref=${treeRef.slice(0, 8)}… not yet ` +
                    `fetchable after ${maxAttempts} attempts, re-queueing ` +
                    `(recovery ${recoveryAttempt + 1}/${this._timeouts.recoveryRetries}): ` +
                    `${FsAgent._errMessage(err)}`,
                );
                scheduleProcess(
                  treeRef,
                  this._timeouts.processRefRetryDelayMs * maxAttempts,
                  recoveryAttempt + 1,
                  predecessorRefs,
                );
              }
              // else: a newer ref already arrived (pendingRef set) → it will be
              // processed and supersedes this one; nothing to do.
            }
          } else {
            const delaySec =
              (attempt * this._timeouts.processRefRetryDelayMs) / 1000;
            console.warn(
              `${this._tag} syncFromDb: attempt ${attempt}/${maxAttempts} failed ` +
                `for ref=${treeRef.slice(0, 8)}…, retrying in ${delaySec}s: ` +
                `${FsAgent._errMessage(err)}`,
            );
          }
        } finally {
          this._remoteApplyInFlight = false;
          // Always resume watching, even if there was an error
          this._scanner.resumeWatch();
          // And re-run whatever the apply made us postpone.
          this._flushDeferredRescan?.();
        }

        // Wait before next attempt (only reached on non-final failure)
        /* v8 ignore next -- @preserve */
        await new Promise((r) =>
          setTimeout(r, attempt * this._timeouts.processRefRetryDelayMs),
        );
      }
    };

    // Schedule (or re-schedule) processing of `ref` after `delayMs`, carrying
    // the recovery-attempt budget. Single-flight: the latest scheduled ref
    // wins, so a fresh incoming ref supersedes a pending recovery.
    const scheduleProcess = (
      ref: string,
      delayMs: number,
      recoveryAttempt: number,
      predecessorRefs?: string[],
      isNewestFromSender = true,
    ) => {
      // A ref is marked "already received" by the connector the instant it
      // ARRIVES, but single-flight means the one it supersedes here is
      // dropped without ever being looked at. It describes a state this agent
      // never adopted, so leaving it marked received is a lie that never
      // expires: refs are content hashes, and a peer that later puts the
      // folder back into that exact state re-derives that exact ref and the
      // advertisement is discarded before any agent sees it.
      //
      // Three peers is where this starts to bite, and the reason is just
      // arithmetic — each node receives a bootstrap ref from every other
      // node at once, so with three there is a second one to supersede and
      // with two there is not. Hand the dropped ref back, the same way an
      // apply that fails terminally does.
      if (pendingRef && pendingRef !== ref) {
        connector.invalidateReceived(pendingRef);
      }
      pendingRef = ref;
      pendingRecoveryAttempt = recoveryAttempt;
      pendingPredecessorRefs = predecessorRefs;
      pendingIsNewest = isNewestFromSender;
      if (fromDbTimer) clearTimeout(fromDbTimer);
      fromDbTimer = setTimeout(async () => {
        fromDbTimer = null;
        const r = pendingRef;
        const ra = pendingRecoveryAttempt;
        const pr = pendingPredecessorRefs;
        const newest = pendingIsNewest;
        pendingRef = null;
        /* v8 ignore if -- @preserve a scheduled timer always has a pending ref */
        if (r) {
          processing = true;
          try {
            await processRef(r, ra, pr, newest);
          } finally {
            processing = false;
          }
        }
      }, delayMs);
    };

    // Create callback to sync on DB changes.
    // listen() already handles origin-filtering and ref-level dedup,
    // so we only need content-level bounce-back detection (in processRef)
    // and debouncing for rapid incoming refs.
    // Returns a Promise to satisfy the Connector's `ConnectorCallback`
    // ((ref) => Promise<any>); the actual work is debounced via scheduleProcess.
    const syncCallback = (
      treeRef: string,
      predecessorRefs?: string[],
      info?: { isNewestFromSender?: boolean },
    ): Promise<void> => {
      // Validate the tree reference
      if (!treeRef || typeof treeRef !== 'string') {
        return Promise.resolve();
      }

      // A bucket-sync message is not a state and must never reach the apply
      // path: it is a question or an answer about manifests. Claimed here,
      // before anything tries to fetch a tree by it.
      if (isBucketSync(treeRef)) {
        return this._bucketSync
          ? this._bucketSync.receive(treeRef).then(() => undefined)
          : Promise.resolve();
      }

      const schedule = (ref: string) =>
        // A freshly-arrived ref resets the recovery budget to 0.
        scheduleProcess(
          ref,
          this._timeouts.debounceMs,
          0,
          predecessorRefs,
          info?.isNewestFromSender ?? true,
        );

      // A TREE REF IS SCHEDULED SYNCHRONOUSLY, exactly as it always was.
      //
      // Not an optimisation — a correctness requirement, and it cost a red run
      // to learn. Making this whole callback `async` deferred the schedule by a
      // microtask even for an unmarked ref, and that was enough to lose a late
      // joiner's bootstrap: it never received a file that already existed. The
      // connector's own bookkeeping runs around this call, and inserting an
      // await between hearing a ref and queuing it reorders the two.
      //
      // Only a marked head needs a read, and only that path becomes async.
      if (!treeRef.startsWith(CHAIN_HEAD_PREFIX)) {
        // A PENDING JOIN TAKES THE UNMARKED PATH TOO, and that is the path it
        // actually arrives on. **The hub's own announcements are unmarked** —
        // it advertises from the server's TREES table, not from the ref log it
        // relayed — so the first thing a joining node hears is a bare tree ref
        // and never a `~H~` head. Handling only the marked path meant the
        // reconcile never ran once: measured as the joiner's stale copy being
        // deleted by the peer's stated removal instead of set aside.
        //
        // Awaiting a query here is safe for exactly this case, because a
        // pending join deliberately schedules NOTHING. The rule it would
        // otherwise break — never await before scheduling an apply — exists to
        // stop a late joiner's bootstrap being lost, and this is the bootstrap
        // being used rather than queued.
        // WHILE JOINING, AN ANNOUNCEMENT IS IGNORED — the ask loop is the
        // only way in.
        //
        // Both have to be refused, not just the apply: scheduling an ordinary
        // apply here would restore the hub's state over a folder whose extras
        // nobody has judged yet, and the join protocol exists precisely to
        // judge them first (new work is announced, a file the history deleted
        // is set aside). Measured before that existed: the joiner's stale copy
        // was deleted by a peer's stated removal instead of being kept.
        //
        // Reconciling from the announcement was the other option and it was
        // what this did. It is redundant now — `_deferToNetwork` polls the
        // chain every `JOIN_ASK_INTERVAL_MS` and reconciles the moment it has
        // a head, and it reads the SAME chain, so it offers no resilience the
        // ask loop lacks. Two routes to one reconcile, racing each other, with
        // only one of them ever measured.
        //
        // If no head ever arrives the bounded wait expires and this folder IS
        // the origin — a deferral, never a refusal.
        if (this._joinPending) return Promise.resolve();
        schedule(treeRef);
        // AND look its chain entry up anyway, in parallel.
        //
        // **The hub's own announcements are unmarked**, and that is where most
        // refs come from after a partition heals: the bootstrap and the state
        // beacon advertise from the server's TREES table, not from the ref log
        // it relayed. So a plain tree ref is not only an older peer — it is the
        // hub, every time, and a chain consulted only on `~H~` is a chain the
        // hub routes around.
        //
        // Traced on a failing T4: the marked heads stopped arriving once the
        // partition healed, every walk returned `removed=[]`, and the peer
        // deletion path never fired ONCE in the scenario it was built for.
        //
        // Scheduled FIRST and synchronously, then the lookup — because a query
        // is a peer read and awaiting one before queueing an apply is how a
        // late joiner's bootstrap was lost. The apply is debounced, so the
        // removals have that window to arrive; if they miss it, the next
        // announcement carries them.
        void this._collectRemovalsForTreeRef(treeRef);
        return Promise.resolve();
      }
      // BOUNDED, AND A FAILURE IS SAID OUT LOUD.
      //
      // Resolving a `~H~` head is a READ, and a read may have to travel to a
      // peer — which, if that peer cannot answer, never returns. Measured in
      // `I7b`: a node heard a peer's head and sat inside this call for the
      // rest of the run, so the announcement was swallowed with no log, no
      // retry and no fallback.
      //
      // It is the third unbounded read that scenario found, and the other two
      // were on the push side. The rule this package states about itself —
      // every async step is bounded, because an unbounded one is a silent hang
      // — has to hold on the receive path too.
      //
      // `invalidateReceived` is the half that makes a retry possible. The ref
      // was marked on arrival; leaving it marked means the NEXT announcement
      // of the same head is dropped by the connector before the agent sees it,
      // and a head is derived from content, so it does not change. That is the
      // shape recorded for a refused tree a few hundred lines down: refusing a
      // state is not the same as having consumed it. Anti-entropy then closes
      // the gap, because the hub's beacon advertises a plain tree ref that
      // needs no resolution at all.
      return FsAgent._withTimeout(
        this._resolveAnnouncement(treeRef),
        this._timeouts.dbQuery,
        `syncFromDb → resolveAnnouncement(${treeRef.slice(0, 12)}…)`,
      )
        .catch((err) => {
          console.warn(
            `${this._tag} could not resolve announced head ` +
              `${treeRef.slice(0, 12)}… — leaving it for anti-entropy: ` +
              `${String(err)}`,
          );
          this._writeSyncError('syncFromDb/resolveAnnouncement', err);
          connector.invalidateReceived(treeRef);
          return undefined;
        })
        .then((resolved) => {
        if (resolved === undefined) return;
        // Parked for the apply, which happens after a debounce. The sender's
        // removals are the authorisation the ancestry rule cannot give, so
        // they have to survive the gap between hearing and acting.
        if (resolved.entry) {
          // THE FIRST HEAD A JOINING NODE SEES IS NOT AN ORDINARY APPLY.
          //
          // A folder with files and no history has established nothing, so it
          // deferred its first word (`syncToDb`). This is the head it was
          // waiting for, and the reconcile is what the chain applying FIRST
          // actually means: the fleet's state is written, this folder's extras
          // are judged against the history, and only then does the node speak.
          //
          // An ordinary apply here would do the opposite — restore the head
          // over the folder and let the next push announce whatever survived,
          // which cannot tell new work from a stale copy.
          // Same rule as the unmarked path above: while a join is pending the
          // ask loop owns the reconcile, and this ref is dropped rather than
          // applied over an unjudged folder.
          if (this._joinPending) return;
          // PARKED, not claimed. The peer's head becomes a parent of whatever
          // this node records next — but only once the apply for this state has
          // actually run, so the two lineages join on work this node did hold.
          // See `_announcedHeads`.
          this._rememberAnnouncedHead(resolved.treeRef, resolved.entry.head);
          void this._collectIncomingRemovals(resolved.entry).then(() =>
            schedule(resolved.treeRef),
          );
          return;
        }
        schedule(resolved.treeRef);
      });
    };

    // Register callback with Connector using the safe, deduplicated API.
    // Client-only conflict resolution happens inline in processRef (see
    // `_resolveConflictInline`), so it runs with the watcher paused and cannot
    // race the sync loop; hubs leave `resolveConflicts` off and stay dumb relays.
    connector.listen(syncCallback);

    // Anti-entropy: compare every hub announcement with our own state, and
    // repair a divergence that no message is going to fix.
    //
    // Read off the socket rather than through `listen`, on purpose. The
    // connector drops a heartbeat it has already delivered, and delivers an
    // invalidated one as "not newest" — both correct for deciding whether an
    // announcement is NEWS, and both exactly what hides a lost message: the
    // repeat that would show the hub and this node disagree never arrives.
    // Nothing is applied from here directly; every repair goes through the
    // same `processRef` / `_sendRef` as an ordinary message.
    const antiEntropy = new FsAntiEntropy(this._antiEntropyOptions, {
      view: () => ({
        origin: connector.origin,
        // `_currentRef`, deliberately: a state this node HAS ESTABLISHED.
        //
        // Reporting the scan's live root hash here instead was tried and is
        // wrong. It makes a node's OWN unannounced work look like divergence,
        // so the anti-entropy repairs TOWARDS the hub and deletes it — which
        // is the `fork-is-not-a-lag` defect this package already fixed and
        // reverted once (`revert(anti-entropy): restore lastAppliedRef as a
        // state we are in`, 0.0.85). Measured again: I7b, *a delivered
        // deletion does not beat a later re-creation*, went from 5 of 5 to 0
        // of 6 — the re-creating node's own file was repaired away.
        //
        // A node holding work nobody has heard about is AHEAD, and the answer
        // to being ahead is to PUSH. The anti-entropy is the wrong instrument
        // for it, and a stale `_currentRef` is a push-path problem.
        currentRef: this._currentRef,
        lastAppliedRef: this._lastAppliedRef,
        lastPushedRef: this._lastPushedRef,
      }),
      // A pending ref that IS the announced state does not count. The
      // connector hears the same heartbeat first, and after a failed apply it
      // queues every repeat of it — as "not newest", to be ignored. Counting
      // that as busy would block the repair on exactly the node that needs it,
      // on every heartbeat, forever. The repair takes over that pending slot.
      busy: (hubRef) =>
        (pendingRef !== null && pendingRef !== hubRef) ||
        processing ||
        this._remoteApplyInFlight,
      // Does that ref describe the folder this node already has?
      //
      // A state beacon carries a ref and nothing else, and unlike a ref event
      // it triggers no apply — so without this, nothing in the agent ever
      // reads that tree and nothing ever discovers the two folders are
      // identical. The divergence then stands until a repair happens to run a
      // bucket round, which is how `diverged: true` lasted eight minutes on a
      // node holding exactly the hub's files.
      //
      // The comparison is the per-path content map, which is the authority on
      // "the same folder" — the same question `@rljson/mongo-agent` asks per
      // DOCUMENT, and the reason it has no equivalent of this failure: it
      // never compares two whole-collection fingerprints at all.
      //
      // One fetch per ref, and the verdict is cached, so a repeating beacon
      // costs nothing. A folder mid-scan answers `false` rather than
      // comparing against a partial picture.
      sameContent: async (hubRef) => {
        const mine = this._scanner.tree;
        if (mine === null || this._remoteApplyInFlight) {
          return { same: false, differing: [] };
        }
        const theirs = await this._fetchTreeFromDb(db, treeKey, hubRef);
        const same = this._treesHaveEquivalentContent(mine, theirs);
        // The paths, not just the verdict. The comparison has them, and
        // "die Prüfsummen sind verschieden" is not something an operator can
        // act on. See `AntiEntropyStatus.differingPaths`.
        if (same) return { same, differing: [] };
        const ours = this._getFileContentMap(mine);
        const hub = this._getFileContentMap(theirs);
        const differing = new Set<string>();
        for (const [path, blob] of hub) {
          if (ours.get(path) !== blob) differing.add(path);
        }
        for (const path of ours.keys()) {
          if (!hub.has(path)) differing.add(path);
        }
        return { same, differing: [...differing].sort() };
      },
      repair: (action, hubRef, hubPredecessors, attempt) => {
        if (action === 'push') {
          // The hub missed our push. Re-announce the state we are in, as a
          // descendant of the one the hub holds — which it is: the decision
          // only says `push` when the hub holds an earlier push of ours or
          // the state our push was made from.
          const ref = this._currentRef as string;
          this._lastSentRef = ref;
          this._sendRef(connector, ref, [hubRef]).catch((err) =>
            this._writeSyncError('antiEntropy/push', err),
          );
          return;
        }
        // ADDITIVE RECONCILIATION, when it is switched on.
        //
        // `pull` replaces this folder with the hub's and `merge` applies the
        // hub's tree under the ordinary rules — both are whole-folder, so both
        // can discard work. A bucket round cannot: the two sides compare
        // manifests and each fetches what it is missing. That is the property
        // §3.1 of the plan says makes the two measured data losses impossible
        // rather than rarer, and it is why this is the last work package and
        // its own switch.
        if (this._bucketSync?.start()) {
          console.log(
            `${this._tag} divergence answered by a bucket-sync round rather ` +
              `than a ${action}`,
          );
          return;
        }

        // `merge` first tries the ordinary rules, ancestry included. Only if
        // that made no progress does it drop the ancestry, which makes the
        // apply additive: nothing is pruned, both sides end up with the union,
        // and the next round pushes it. Losing a deletion that way is
        // recoverable; guessing which side deleted is not.
        const predecessors =
          action === 'pull' || attempt === 1 ? hubPredecessors : [];
        scheduleProcess(hubRef, 0, 0, predecessors, true);
      },
    });
    this._antiEntropy = antiEntropy;
    const onHubAnnouncement = (payload: ConnectorPayload) => {
      if (typeof payload?.r !== 'string') return;
      const announced = payload.r;

      const observe = (ref: string) =>
        antiEntropy.observe({
          ref,
          origin: payload.o,
          predecessors: Array.isArray(payload.p) ? payload.p : [],
        });

      // Mapped here too, and forgetting it would be invisible and total: the
      // anti-entropy compares what it hears with `_currentRef`, a TREE ref, so
      // an unmapped head never matches and every node reports a permanent
      // divergence against a fleet it agrees with. That is the §2.1b symptom
      // arriving by a second route.
      //
      // An unmarked ref is observed SYNCHRONOUSLY, exactly as it always was.
      // Deferring even by a microtask changes when the status is readable, and
      // three tests that read it straight after a beacon say so.
      if (!announced.startsWith(CHAIN_HEAD_PREFIX)) {
        observe(announced);
        return;
      }
      void this._reachabilityOf(announced).then((verdict) => {
        // A head we cannot read is not evidence of anything. Concluding
        // "diverged" from it would report a disagreement we cannot describe.
        if (verdict === undefined) return;
        antiEntropy.observe({
          ref: verdict.treeRef,
          origin: payload.o,
          predecessors: Array.isArray(payload.p) ? payload.p : [],
          reachability: verdict.reachability,
        });
      });
    };
    // AND IT ASKS, rather than only listening. See `ANTI_ENTROPY_ASK_MS`.
    //
    // The same question the join path asks, for the same reason: a node that
    // only ever hears cannot tell silence from agreement. Here it is the
    // fleet's newest entry, read locally, offered to the anti-entropy as
    // though it had been announced — which is what it would have been.
    const askTheFleet = async (): Promise<void> => {
      if (!this._chain || this._joinPending !== undefined) return;
      const head = await this._chain.refreshHead().catch(() => undefined);
      if (head === undefined) return;
      const entry = await this._chain.entry(head).catch(() => undefined);
      if (!entry) return;
      // Our own state needs no repair, and neither does one we have left.
      if (entry.treeRef === this._currentRef) return;
      if (this._chainHead?.head === head) return;

      // ONLY WHEN WE ARE GENUINELY BEHIND, which is the only question this ask
      // is entitled to raise.
      //
      // `refreshHead` returns A tip, and during churn there can be several —
      // a sibling branch is a tip too. Offering one to the anti-entropy as
      // though the hub had announced it starts a repair that nothing asked
      // for: measured as a node ending on round 5 of 10 because a `fork`
      // verdict sent it into a merge against a branch it was not behind.
      //
      // A fork needs no prompting from here. It arrives as an announcement and
      // the ordinary path resolves it. What an announcement cannot tell us is
      // that we are MISSING work, because the announcement is the thing that
      // went missing — so that is the only case worth asking about.
      if (!this._chainHead) return;
      const relation = await this._chain
        .classify(this._chainHead.head, head)
        .catch(() => undefined);
      if (relation !== 'behind') return;
      antiEntropy.observe({
        ref: entry.treeRef,
        predecessors: [...entry.previous],
        reachability: relation,
      });
    };
    const askTimer = setInterval(() => {
      void askTheFleet().catch((err) => {
        /* v8 ignore next -- @preserve a failed ask is retried on the next tick */
        this._writeSyncError('antiEntropy/ask', err);
      });
    }, ANTI_ENTROPY_ASK_MS);
    askTimer.unref?.();

    // Two sources of the same announcement. The bootstrap (and its optional
    // heartbeat) reaches every connector anyway. The STATE BEACON is the one a
    // deployment should run: `@rljson/server`'s `stateBeaconMs` sends the same
    // payload on an event the connector never processes, so it costs nothing
    // in the apply path — the CARAT One Client runs with the heartbeat OFF
    // because a periodic one was measured net-harmful there.
    const hubEvents = [
      connector.events.bootstrap,
      stateBeaconEvent(connector.route.flat),
    ];
    for (const event of hubEvents) {
      connector.socket.on(event, onHubAnnouncement);
    }

    // Return cleanup function
    return () => {
      if (fromDbTimer) clearTimeout(fromDbTimer);
      clearInterval(askTimer);
      for (const event of hubEvents) {
        connector.socket.off(event, onHubAnnouncement);
      }
      // A stopped sync reports nothing: a status left behind would keep
      // describing a divergence nobody is watching any more. Only if it is
      // still ours — a later syncFromDb may already have replaced it.
      if (this._antiEntropy === antiEntropy) this._antiEntropy = undefined;
      connector.tearDown();
    };
  }

  /**
   * Creates a fully configured FsAgent from a Client instance.
   * This factory method provides a simplified API where sync methods don't require
   * db, connector, and treeKey parameters - they are stored internally.
   * @param filePath - Directory path to sync
   * @param treeKey - Tree table key (route will be `/${treeKey}`)
   * @param client - Client instance with io and bs properties
   * @param socket - Socket instance for connector communication
   * @param options - Optional FsAgent options (db and treeKey are set automatically).
   *   `syncConfig` and `clientIdentity` from these options are forwarded to
   *   the Connector so that a single config origin governs all layers.
   * @returns Configured FsAgent instance with simplified sync API
   * @example
   * ```typescript
   * const syncConfig: SyncConfig = { requireAck: true, maxDedupSetSize: 5000 };
   * const agent = await FsAgent.fromClient(
   *   './my-folder', 'sharedTree', client, socket, { syncConfig },
   * );
   * // Simplified sync methods - no db/connector/treeKey needed
   * await agent.syncToDbSimple();
   * await agent.syncFromDbSimple({ cleanTarget: true });
   * // Original methods still work
   * await agent.syncToDb(db, connector, treeKey);
   * ```
   */
  static async fromClient(
    filePath: string,
    treeKey: string,
    client: any, // Client type from \@rljson/server
    socket: any, // Socket type from \@rljson/io
    options?: Omit<FsAgentOptions, 'db' | 'treeKey'>,
  ): Promise<
    FsAgent & {
      syncToDbSimple: (options?: StoreFsTreeOptions) => Promise<() => void>;
      syncFromDbSimple: (options?: RestoreOptions) => Promise<() => void>;
    }
  > {
    // Validate client has required properties
    if (!client.io) {
      throw new Error('Client.io is not initialized');
    }

    if (!client.bs) {
      throw new Error('Client.bs is not initialized');
    }

    // Import Db and Connector dynamically to avoid circular deps
    const { Db, Connector } = await import('@rljson/db');

    // Create Db from client.io
    const db = new Db(client.io);

    // Create Route from treeKey
    const route = Route.fromFlat(`/${treeKey}`);

    // THE INTEGRATION PATH GETS THE FULLY TESTED MODE, by default.
    //
    // `fromClient` is how a real client joins a real hub, and it is the only
    // configuration that is integrated into the product and measured in the
    // lab. So it defaults to that configuration rather than to the primitive
    // one, and a caller's own values still win — the spread is after.
    //
    // What the weak alternative costs, and why it must not be the default
    // here: without `causalOrdering` the wire carries no predecessor refs, so
    // the merge gate in `processRef` cannot fire and a conflicting edit to one
    // file is never reconciled. Without `resolveConflicts` the resolver is
    // never constructed at all. A client set up that way runs, logs one
    // warning, and quietly keeps less than the package promises — which is
    // exactly what the old README example did.
    //
    // Both are no-ops for the One Client, which passes all three explicitly
    // (`src/config/fs-sync-options.ts`, and both `sl-node` call sites). They
    // are here for the next integrator.
    //
    // `new FsAgent(...)` keeps the primitive defaults: it is the building
    // block, it is what every test in this package constructs, and a hub that
    // wants to relay without arbitrating uses it.
    const connector = new Connector(
      db,
      route,
      socket,
      {
        causalOrdering: true,
        includeClientIdentity: true,
        ...options?.syncConfig,
      },
      options?.clientIdentity,
    );

    // Create FsAgent with client's blob storage
    const agent = new FsAgent(filePath, client.bs, {
      resolveConflicts: true,
      ...options,
    });

    // Add simplified sync methods
    const enhancedAgent = agent as any;

    enhancedAgent.syncToDbSimple = async (syncOptions?: StoreFsTreeOptions) => {
      return agent.syncToDb(db, connector, treeKey, syncOptions);
    };

    enhancedAgent.syncFromDbSimple = async (restoreOpts?: RestoreOptions) => {
      return agent.syncFromDb(db, connector, treeKey, restoreOpts);
    };

    // Register reconnect handling if client supports it.
    // On disconnect: pause the filesystem watcher to prevent sync attempts
    // that will fail while the connection is down.
    // On reconnect: resume the watcher so filesystem changes are processed.
    // The server automatically sends a bootstrap ref on reconnect, which
    // triggers syncFromDb to catch up on any missed changes.
    if (typeof client.onDisconnect === 'function') {
      client.onDisconnect(() => {
        // Bounded: `onReconnect` is the only thing that releases this pause,
        // and a disconnect whose reconnect never fires left the node silent
        // for weeks — initial sync fine, then no reaction to any write.
        agent.scanner.pauseWatch(DISCONNECT_PAUSE_MAX_MS);
      });
    }

    if (typeof client.onReconnect === 'function') {
      client.onReconnect(() => {
        agent.scanner.resumeWatch();
      });
    }

    return enhancedAgent;
  }

  /** Example instance for test purposes */
  static get example(): FsAgent {
    return new FsAgent(process.cwd());
  }
}
