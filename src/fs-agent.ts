// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { hip } from '@rljson/hash';
import { ClientId, Route, SyncConfig, Tree } from '@rljson/rljson';

import { appendFileSync, existsSync, readFileSync } from 'fs';
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
  ATOMIC_TMP_PREFIX,
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteStream,
} from './fs-atomic-write.ts';
import { FsBlobAdapter } from './fs-blob-adapter.ts';
import { carriedNodes, fileNode, graftTree } from './fs-carry.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import {
  FsSignals,
  SIGNAL_LOG_FILE,
  type FsSignal,
  } from './fs-signals.ts';
import { ALL_GONE_MIN_FILES, FsEditChain, planJoin } from './fs-edit-chain.ts';
import { compileIgnore } from './fs-ignore.ts';
import {
  DIR_MARKER,
  joinCopyName,
  merge3,
  recoveredName,
  type Introducer,
} from './fs-merge.ts';
import {
  walkFsHistory,
  type FsHistoryEntry,
  type FsHistoryOptions,
  type FsHistoryPage,
} from './fs-history.ts';
import {
  receive,
  type AntiEntropyStatus,
  type ReceiveDeps,
  type ReceiveOutcome,
  type Relation,
} from './fs-receive.ts';
import { planAuthoring } from './fs-send.ts';
import { FsStamps } from './fs-stamps.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import { stateBeaconEvent } from '@rljson/db';
import type { Connector, Db } from '@rljson/db';
import type { ConnectorPayload } from '@rljson/rljson';
import type { FsChange, FsNodeMeta } from './fs-scanner.ts';

// .............................................................................
// Types
// .............................................................................

/**
 * Options for FsAgent operations
 */
export interface FsAgentOptions {
  /** Ignore patterns for scanning */
  ignore?: string[];
  /** Maximum depth for directory traversal */
  maxDepth?: number;
  /** Follow symlinks (default: false) */
  followSymlinks?: boolean;
  /**
   * Persist a path→(mtime, size, blobId) scan cache at this file path so a
   * RESTART does not re-read + re-hash the whole folder (a cold scan of an 80
   * GB catalog is ~48 min). Forwarded to the {@link FsScanner}. Requires a
   * PERSISTENT blob store (e.g. `@rljson/bs-fs`). See
   * {@link FsScanOptions.scanCachePath}.
   */
  scanCachePath?: string;
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
   * Told about everything that happened to this folder that a person might
   * care about — see {@link FsSignal}. The one output channel: a same-file
   * merge, a joining machine moving files aside, a deletion the guard refused,
   * a path that could not be written. Each signal says which paths it touched,
   * how the outcome was chosen, and whether a PERSON still has to do
   * something. {@link signals} holds the same, for a host that starts later.
   */
  onSignal?: (signal: FsSignal) => void;

  /**
   * How long a folder with files and NO history waits for the network's state
   * before saying anything about its own, in milliseconds. Default
   * {@link DEFAULT_JOIN_WAIT_MS}; `0` makes the folder the origin of its
   * history at once.
   *
   * **The chain applies first; the filesystem only then.** A starting agent
   * authors a lineage root from whatever it happens to hold and announces it
   * as the network's newest claim, and that is one defect wearing two faces:
   * every node gets its own lineage root, so every announcement ever made is
   * a fork; and a node restored from a backup pushes
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
   * (`fs-mesh-matrix.spec.ts`, `J4+J5`) and belongs on after an integration
   * run — see `README.architecture.md`, "Joining a Network".
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
  /**
   * Timeout for writing one received head into the folder. Default: 15 000 ms.
   * The receive and send sides share one lock, so an apply that hangs on a
   * blob nobody serves would keep this node from authoring its own work. A
   * timed-out apply changes nothing it had not written yet, and the next time
   * the hub says the head it is tried again.
   */
  restore?: number;
  /**
   * Debounce delay for authoring (milliseconds). Default: 300 ms. Rapid
   * filesystem events (e.g. macOS Finder "Keep Both" copy+rename) are
   * coalesced into a single edit after this quiet period.
   */
  debounceMs?: number;
}

/** Sensible defaults – every operation is bounded */
const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  dbQuery: 10_000,
  fetchTree: 20_000,
  extract: 15_000,
  restore: 15_000,
  debounceMs: 300,
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
 * How long a joining node asks before concluding it is the origin.
 *
 * The default for every route. Long enough for a hub's bootstrap to arrive on
 * a real connection, short enough that the first client of a brand-new network
 * is not kept waiting — and it is a deferral, never a refusal: when it expires
 * the folder IS the origin and its contents are the first state.
 */
export const DEFAULT_JOIN_WAIT_MS = 1_500;

// `ATOMIC_TMP_PREFIX` now lives in `fs-atomic-write.ts`, beside the writers
// that use it. Re-exported so this module's surface is unchanged.
export { ATOMIC_TMP_PREFIX };

/**
 * Filename for the agent's own state, kept beside the synced folder's content
 * and ignored by the scanner like the other two above.
 *
 * `ownHead` — the chain entry this folder stands on, so a restart continues the
 * history rather than starting one. `stampEpochs` — the highest stamp epoch
 * heard, per domain: a hub taking office on this machine passes it as
 * `minEpoch`, so its stamps order after every stamp the fleet has seen.
 */
export const AGENT_STATE_FILE = '.fsagent-state.json';

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
 * sixteen files a second on a real fleet, where a 1 200-file folder then takes
 * minutes and reads as a stalled node.
 *
 * Sixteen rather than sixty-four: blobs carry file CONTENT, so the ceiling is
 * memory in flight rather than request count, and a folder of large files at
 * high concurrency is how a client runs out of heap.
 */
export const RESTORE_FETCH_CONCURRENCY = 16;

export const MASS_DELETE_MIN_FILES = 100;

/** What `antiEntropyStatus` calls each thing receiving a head can do. */
const REPAIR_ACTION: Record<
  Exclude<ReceiveOutcome, 'in-sync'>,
  NonNullable<AntiEntropyStatus['lastRepair']>['action']
> = {
  'no-head': 'blocked',
  applied: 'pull',
  adopted: 'pull',
  refused: 'blocked',
  announced: 'push',
  merged: 'merge',
  deferred: 'blocked',
  blocked: 'blocked',
};

/**
 * Whether two ignore lists are the same list: the same patterns in the same
 * order — order decides what a `!` line rescues.
 * @param a - One list.
 * @param b - The other.
 * @returns True when they are equal.
 */
const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((pattern, i) => pattern === b[i]);

/**
 * How often one head is received again because the folder moved under its
 * apply, before the next announcement has to bring it back.
 */
export const RECEIVE_AGAIN_MAX = 3;

/**
 * How soon a node announces its head again when a merge still lacks its own
 * stamp — doubling each time, up to {@link STAMP_ASK_MAX_MS}.
 */
export const STAMP_ASK_MIN_MS = 500;

/** The longest a node waits between two announcements asking for its stamp. */
export const STAMP_ASK_MAX_MS = 30_000;

/**
 * Above this share of the folder, a prune is treated as suspicious rather than
 * intentional.
 */
export const MASS_DELETE_MAX_RATIO = 0.3;

/**
 * How many passes {@link FsAgent.restoreRevision} makes over a folder that
 * holds a file still being written, before it gives up and changes nothing.
 */
export const RESTORE_SETTLE_PASSES = 10;

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
 * was a file larger than the transport's `maxHttpBufferSize`, where no number
 * of retries made 63 MB fit through a 50 MB socket. Since `@rljson/bs` 0.0.27 a
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
 * holding a file the fourth had deleted, permanently, and the large-folder
 * shape's deletion had still not propagated after 300 seconds. The largest
 * observed file was 45.9 MB against the same 50 MB cap — close enough that the
 * next revision of one document would have reproduced it in production.
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

  /** Files written vs left alone by the current {@link restore}. */
  private _restoreWritten = 0;
  private _restoreSkipped = 0;

  /**
   * This folder's history: one entry per state this node pushed.
   *
   * Created on the first `syncToDb`, and BEST-EFFORT throughout — a chain that
   * cannot be written must never stop a folder syncing. Nothing consumes it
   * yet; see `src/fs-edit-chain.ts`.
   */
  private _chain?: FsEditChain;

  /** See {@link FsAgentOptions.joinWaitMs}. */
  private readonly _joinWaitMs: number;

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
   * measured on a real fleet: *"im Schnitt 3 Sekunden, im schlechtesten Fall
   * 84. Alle Zeitbudgets der Testsuite hängen an dieser Zahl."* And the reason
   * nobody could say more than that: *"bisher wird nur die Gesamtzeit
   * gemessen. Die einzelnen Schritte mitmessen — Scan, Prüfsumme, Ablage,
   * Meldung, Abholen, Schreiben —, sonst rät man."* (`the weakness register`
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

  /**
   * Everything this folder has signalled, bounded and countable.
   *
   * Seeded from {@link SIGNAL_LOG_FILE} on the first write rather than in the
   * constructor, because the constructor does no I/O and a host may construct
   * an agent for a folder that does not exist yet.
   */
  private readonly _signals = new FsSignals();

  /** Whether {@link SIGNAL_LOG_FILE} has been read back yet this process. */
  private _signalsRestored = false;

  constructor(rootPath: string, bs?: Bs, options: FsAgentOptions = {}) {
    this._rootPath = rootPath;
    this._bs = bs || new BsMem();
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    if (options.onSignal) this._signals.subscribe(options.onSignal);
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
        // The signal log is bookkeeping, not content: a folder that writes a
        // file to itself on every event never stops changing. A file the agent
        // writes inside the folder has to be listed here.
        SIGNAL_LOG_FILE,
        // And the set-aside copies, for the same reason one level up: they are
        // deliberately NOT announced, which a tree ref cannot express about a
        // file inside the folder it describes. See `RECOVERED_DIR`.
        RECOVERED_DIR,
      ],
      bs: this._bs,
    });
    this._ignoreOnRecord = this._scanner.ignore;
    this._adapter = new FsBlobAdapter(this._bs);
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
   * Everything that happened to this folder that a person might care about,
   * oldest first — see {@link FsSignal}.
   *
   * Seeded from {@link SIGNAL_LOG_FILE} the first time it is read, so a host
   * that starts after the event still sees it. Bounded; {@link signalTotals}
   * keeps the count of what was dropped.
   * @returns The signals kept.
   */
  get signals(): readonly FsSignal[] {
    this._restoreSignals();
    return this._signals.all;
  }

  /**
   * The signals a person still has to act on — `action: 'required'`.
   *
   * The list a UI should surface. Everything else is a record of something the
   * agent already dealt with.
   * @returns The unresolved signals.
   */
  get signalsNeedingAction(): readonly FsSignal[] {
    this._restoreSignals();
    return this._signals.needingAction;
  }

  /**
   * How many signals of each kind this folder has EVER produced.
   *
   * Not bounded by the log, so a folder that produced two thousand refusals
   * still says two thousand after the oldest are dropped.
   * @returns Counts keyed by {@link FsSignalKind}.
   */
  get signalTotals(): Readonly<Record<string, number>> {
    this._restoreSignals();
    return this._signals.totals();
  }

  /**
   * Subscribes to signals as they happen.
   *
   * The same channel as the `onSignal` option, for a host that wants to attach
   * later or more than once.
   * @param listener - Called once per signal.
   * @returns Unsubscribes.
   */
  onSignal(listener: (signal: FsSignal) => void): () => void {
    return this._signals.subscribe(listener);
  }

  /**
   * Whether this node and the hub agree, and what the anti-entropy has done
   * about it when they did not. `null` until {@link syncFromDb} runs.
   *
   * A divergence that lasts is the one thing a lost message leaves behind, and
   * until now nothing reported it: this is what a diagnostics view should show.
   */
  get antiEntropyStatus(): AntiEntropyStatus | null {
    return this._hubStatus;
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

  /**
   * Records one signal, tells subscribers, and persists the log.
   *
   * **Never throws.** A notification that cannot be filed must not take the
   * operation it describes with it. Nothing about a sync depends on anybody
   * being told.
   * @param input - What happened; see {@link FsSignal}.
   */
  private _signal(input: Parameters<FsSignals['add']>[0]): void {
    this._restoreSignals();
    this._signals.add(input);
    this._persistSignals();
  }

  /**
   * Reports what joining a network did to this folder.
   *
   * **The case a person is most likely to ask about**, and it had no channel at
   * all: a machine rejoining with files the network has since deleted, or with
   * its own edits of paths that moved on — a restored backup, a laptop back
   * from a fortnight away. Nothing is lost either way, because the files are
   * moved aside rather than removed. But a folder that quietly grows a
   * `.fsagent-recovered/` directory is unexplainable from outside the machine,
   * and a line in that machine's console is not an answer.
   *
   * Extracted from the join body so it can be tested without standing up a
   * chain, a db and a peer — the emission is a separate concern from deciding
   * what to emit about.
   * @param recovered - Paths moved aside because the history removed them.
   * @param conflicted - Paths edited here while away and changed elsewhere.
   * @param copies - Where each moved file went, `path → name`; a path the
   * join could not move has no entry.
   * @param why - `away`: the machine joined the network; `ignore`: it sees
   * paths again that its ignore list had left out.
   */
  private _signalJoinOutcome(
    recovered: readonly string[],
    conflicted: readonly string[],
    copies: Readonly<Record<string, string>>,
    why: 'away' | 'ignore' = 'away',
  ): void {
    if (recovered.length > 0) {
      this._signal({
        kind: 'join/recovered',
        paths: recovered,
        copies,
        action: 'review',
        decidedBy: 'chain',
        detail:
          `${recovered.length} file(s) this machine still held had been ` +
          `deleted by the network, so they were moved into ${RECOVERED_DIR}/ ` +
          `rather than deleted`,
      });
    }
    if (conflicted.length > 0) {
      this._signal({
        kind: 'join/conflicted',
        paths: conflicted,
        copies,
        action: 'review',
        decidedBy: 'chain',
        detail:
          why === 'away'
            ? `${conflicted.length} file(s) were edited on this machine while it ` +
              `was away and also changed on the network; both versions were kept`
            : `${conflicted.length} file(s) this machine had left out of the ` +
              `sync differ from the network's; both versions were kept`,
      });
    }
  }

  /**
   * Records a standing condition at most once per agent.
   * @param key - What is being reported once.
   * @param input - What happened.
   */
  private _signalOnce(
    key: string,
    input: Parameters<FsSignals['add']>[0],
  ): void {
    this._restoreSignals();
    if (this._signals.addOnce(key, input) !== undefined) {
      this._persistSignals();
    }
  }

  /**
   * Reads {@link SIGNAL_LOG_FILE} back, once.
   *
   * Lazily rather than in the constructor, which does no I/O: a host may
   * construct an agent for a folder that is created later, and a signal log is
   * never worth failing a construction over.
   */
  private _restoreSignals(): void {
    if (this._signalsRestored) return;
    this._signalsRestored = true;
    try {
      const file = join(this._rootPath, SIGNAL_LOG_FILE);
      if (!existsSync(file)) return;
      this._signals.restore(JSON.parse(readFileSync(file, 'utf-8')));
    } catch (err) {
      this._writeSyncError('signals/restore', err);
    }
  }

  /**
   * Writes the signal log, best effort.
   *
   * Through a staging file, because a host reads this file while the agent
   * writes it, and a crash between truncate and write left an empty file —
   * which the next start could not parse, so the whole history was dropped and
   * the next signal overwrote it.
   */
  private _persistSignals(): void {
    try {
      atomicWriteFileSync(
        join(this._rootPath, SIGNAL_LOG_FILE),
        JSON.stringify(this._signals.persisted(), null, 1),
      );
    } catch (err) {
      this._writeSyncError('signals/persist', err);
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
   * usually a document the host application still has open for a user, and that
   * one must not abort
   * the rest of the restore either. Conflating them would report an offline
   * peer as a locked file, and the field reports are read by people who act on
   * that distinction.
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
   * platform, for the same reasons — but never materialising the whole file. A
   * 500 MB file used to cost 500 MB of Buffer on the receiving agent, another
   * copy in the socket parser, and — on the serving hub — the same again. That
   * is the shape that exhausted a cloud relay: memory that is work in flight
   * rather than garbage, so no collection can reclaim any of it.
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
   * Abandons a join this agent is still waiting on.
   *
   * **This method used to do nothing at all**, and the host application calls
   * it in
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
    this._endJoinWait();
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
    //
    // And only CONTENT. What the scanner ignores — this agent's own state and
    // signal log, the set-aside copies a person was pointed to, whatever the
    // host told it to leave alone — is in no tree, so a tree that lacks it
    // says nothing about it: never pruned, never counted.
    const preRestore = new Set(
      options?.cleanTarget
        ? [...(await this._collectAllFiles(target))].filter(
            (file) =>
              !this._scanner.ignores(relative(target, file).split(sep).join('/')),
          )
        : [],
    );

    if (options?.cleanTarget) {
      // How much of this folder would the prune take with it?
      //
      // Judged BEFORE anything is written, so a refusal leaves the folder
      // exactly as it was. Judged after, a refused restore had already
      // overwritten what the tree holds, and the watcher recorded that half as
      // an edit of its own.
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
      // `the weakness register` D5 — *"für das System ist ein Umbenennen 'alles
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
        this._refuseDeletion(
          'restore',
          wouldPrune,
          preRestore.size,
          [...preRestore].filter((p) => !expectedFiles.has(p)),
          `The incoming tree has ${expectedFiles.size}.`,
        );
        // AND THIS ONE THROWS: its caller has to know the folder was left
        // alone, and nothing has been written yet.
        throw new MassDeleteRefusedError(
          wouldPrune,
          preRestore.size,
          expectedFiles.size,
        );
      }
    }

    // Recursively restore from tree structure
    this._restoreWritten = 0;
    this._restoreSkipped = 0;
    this._restorePruned = 0;
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
          (this._restorePruned > 0 ? `, DELETED ${this._restorePruned}` : ''),
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
      // `required`, and the only other signal that earns it. A lock clears and
      // a blob arrives later, so neither of those needs a person. A name this
      // filesystem rejects never becomes acceptable: the file will not appear
      // on this machine until somebody renames it somewhere else. Signalled
      // BEFORE the throw, because the throw is what the caller sees and this is
      // what a UI can show.
      this._signal({
        kind: 'path/unwritable',
        paths: [...this._restoreImpossible],
        action: 'required',
        detail:
          `${this._restoreImpossible.length} path(s) cannot be written on ` +
          `this machine — too long, a reserved name, or otherwise rejected by ` +
          `the filesystem. They will not arrive until they are renamed.`,
      });
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
      if (this._leavesOut(meta, isOwnRoot)) return;
      const filePath = join(targetPath, meta.relativePath);
      // A directory may be sitting where this file belongs.
      if (
        !(await this._makeRoomFor(
          filePath,
          'file',
          isOwnRoot ? meta.relativePath : undefined,
        ))
      ) {
        this._restoreImpossible.push(meta.relativePath);
        return;
      }

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
        // The size cap itself is gone as of the streaming fetch below; this
        // rule still holds for every other reason a blob can be unreachable.
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
            if (isOwnRoot) {
              this._scanner.noteWrite(
                meta.relativePath,
                meta.blobId,
                meta.size,
                written.mtime.getTime(),
              );
            }
          }
        } catch (error) {
          // the host application holds .dbf and .PRJZ open for as long as a
          // user has the document. One of those aborted the entire restore, so
          // a single open document stopped every OTHER file in the tree from
          // arriving — one user's lock became everyone's stalled sync.
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
          // derselben Datei"* (`the weakness register` D2/Y2).
          //
          // NOT retried as a lock is, because the name will not become legal.
          // Reported as unavailable, which is what it is: the tree describes a
          // file this machine cannot hold.
          // A full disk, reported as itself.
          //
          // *"Was bei voller Platte passiert, wurde nie getestet"*
          // (`the weakness register` D4), and what happened was a raw errno
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
      if (this._leavesOut(meta, isOwnRoot)) return;
      const dirPath =
        meta.relativePath === '.'
          ? targetPath
          : join(targetPath, meta.relativePath);
      // And a file may be sitting where this directory belongs. Never for the
      // root itself, which is the folder being restored into.
      if (
        meta.relativePath !== '.' &&
        !(await this._makeRoomFor(
          dirPath,
          'directory',
          isOwnRoot ? meta.relativePath : undefined,
        ))
      ) {
        this._restoreImpossible.push(meta.relativePath);
        return;
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
   * @param relativePath - The path in the folder, when restoring into this
   *   node's own: an entry there this node ignores is never removed.
   * @returns Whether the place is free for the node now; `false` when an
   *   entry this node ignores holds it.
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

  /**
   * Whether a restore leaves a node out: what this node does not see, it does
   * not write into its folder — a directory with everything below it. Another
   * node's version of such a path is carried in its edits, never put on its
   * disk. Anywhere else a tree is just a tree.
   * @param meta - The node's meta.
   * @param isOwnRoot - Whether the restore writes into this node's folder.
   * @returns True when the node is not to be written.
   */
  private _leavesOut(meta: FsNodeMeta, isOwnRoot: boolean): boolean {
    return (
      isOwnRoot &&
      meta.relativePath !== '.' &&
      this._scanner.ignores(meta.relativePath, meta.type === 'directory')
    );
  }

  private async _makeRoomFor(
    path: string,
    want: 'file' | 'directory',
    relativePath?: string,
  ): Promise<boolean> {
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) return true;
    const isDir = existing.isDirectory();
    if (isDir === (want === 'directory')) return true;
    // What is there is something this node does not see — a folder its
    // ignore list leaves out, say. It is not the tree's to remove, so the
    // tree's version cannot be written here.
    if (relativePath !== undefined && this._scanner.excludes(relativePath, isDir)) {
      console.warn(
        `${this._tag} restore: "${path}" is a ${isDir ? 'directory' : 'file'} ` +
          `this node ignores and the tree says ${want} — left as it is`,
      );
      return false;
    }
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
    // This awaited one `db.get` per node. On a catalogue-sized folder that is
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
    // Trees are stored as multiple rows - querying by hash only returns one
    // node We need to fetch the root node and recursively fetch all children
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
        map.set(meta.relativePath as string, DIR_MARKER);
      }
    }
    return map;
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
   * @param copies - Where each file that WAS moved went, `path → name`: what
   * the join signal tells a host. A file that could not be moved is left out,
   * because its own version is gone once the restore overwrites it.
   */
  private async _setAside(
    path: string,
    name: string,
    copies: Record<string, string>,
  ): Promise<void> {
    const from = join(this._rootPath, ...path.split('/'));
    const to = join(this._rootPath, ...name.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to).then(
      () => {
        copies[path] = name;
      },
      (err) => {
        this._writeSyncError(`join/setAside/${path}`, err);
      },
    );
  }

  // ...........................................................................
  // THE SYNC — the chain is the only order.
  //
  // One state: the chain entry this node stands on (`_ownHead`). The send
  // side authors an edit when the folder moves past it and announces it; the
  // receive side relates every head that arrives to it and applies, announces
  // or merges (`fs-receive.ts`). Both run under one lock, so an apply never
  // interleaves with an authoring. Nothing compares two machines' clocks.

  /** The chain entry this node stands on, persisted across restarts. */
  private _ownHead?: string;
  /** The own head's tree, `path → blob`: what the folder is diffed against. */
  private _ownContent: ReadonlyMap<string, string> = new Map();
  /** Paths the watcher saw deleted since the own head was authored. */
  private readonly _watched = new Set<string>();
  /**
   * What the last refusal held back and is still gone. A refusal holds its
   * files until they are back — see `planAuthoring`. In memory only: after a
   * restart the floors judge what is gone afresh, as before.
   */
  private _heldBack: ReadonlySet<string> = new Set();
  /**
   * The own head's nodes at the paths this node does not see — see
   * `fs-carry.ts`. Carried into every edit it authors; an apply neither writes
   * nor deletes them. Empty while the head names nothing this node ignores.
   */
  private _carried: ReadonlyMap<string, Tree> = new Map();
  /**
   * Paths this node sees again since a pattern left its ignore list, whose
   * version the own head holds is not in the folder yet. Carried until it is —
   * see {@link FsAgent._uncover}.
   */
  private readonly _uncovered = new Set<string>();
  /** A restart found its ignore list changed, and `_uncover` has not run. */
  private _uncoverDue = false;
  /**
   * The ignore list the state file records: the one the folder is in step
   * with. It becomes the scanner's list once nothing a change of the list
   * uncovered is still missing.
   */
  private _ignoreOnRecord: readonly string[] = [];
  /** Every chain entry's stamp, as this node learned it. */
  private _stamps?: FsStamps;
  /** The route this agent syncs, once a sync started. */
  private _route?: { db: Db; connector: Connector; treeKey: string };
  /** The newest head heard and not yet received. */
  private _heard?: string;
  /** Stamps heard, recorded in arrival order before anything decides. */
  private _stamping: Promise<void> = Promise.resolve();
  /** The lock the send and receive sides share. */
  private _lock: Promise<void> = Promise.resolve();
  /** The receive loop, while it runs. */
  private _receiving?: Promise<void>;
  /** A joining folder's wait for the network's head, while it lasts. */
  private _joinWait?: {
    timer: ReturnType<typeof setTimeout>;
    done: (head: string | undefined) => void;
  };
  /** Authors again shortly, once the watcher has caught up. */
  private _authorSoon?: () => void;
  /** The merge that waited for a stamp last, so a second wait is told. */
  private _deferral?: string;
  /** The last time this node announced its head to learn its stamp. */
  private _stampAsk?: { head: string; at: number; waitMs: number };
  /** What the last state the hub announced made this node do. */
  private _hubStatus: AntiEntropyStatus | null = null;
  /** How many receive sides were started; the newest one owns the status. */
  private _receivers = 0;
  /**
   * What an apply that stopped partway — a locked file, an unreachable blob —
   * had already written, path → blob. Not this node's work: authoring does not
   * claim it, and the next apply recognises it. Cleared when the own head
   * moves.
   */
  private _partiallyApplied = new Map<string, string>();

  /** The chain entry this node stands on, if any. */
  get ownHead(): string | undefined {
    return this._ownHead;
  }

  // ...........................................................................
  // FOR A HOST: where the folder stands, how it got there, and going back.
  //
  // Everything a person is shown about a folder's history is read from the
  // chain, the one order every node agrees on — never from this node's own
  // insert rows, which miss everything it took from a peer.

  /**
   * The entry this folder stands on, with its stamp: what a host shows as the
   * folder's current revision.
   * @returns The entry, or `undefined` while no sync runs or the folder has no
   * head yet.
   */
  async headInfo(): Promise<FsHistoryEntry | undefined> {
    const head = this._ownHead;
    if (head === undefined) return undefined;
    return (await this.history({ from: head, limit: 1 })).entries[0];
  }

  /**
   * One page of the folder's history, newest first: every edit, merge and
   * root below the own head, whichever node made it — see `fs-history.ts` for
   * the order.
   *
   * A host whose agent runs in another process reads the same pages from the
   * store with `readFsHistory`.
   * @param options - Where to start (default: the own head), or the cursor of
   * the previous page, and how many entries.
   * @returns The page; empty while no sync runs or the folder has no head.
   */
  async history(options: FsHistoryOptions = {}): Promise<FsHistoryPage> {
    const chain = this._chain;
    const stamps = this._stamps;
    if (!chain || !stamps) return { entries: [], missing: [] };
    return walkFsHistory(
      {
        entry: (head) => chain.entry(head),
        stamp: (head) => stamps.get(head),
      },
      { from: this._ownHead, ...options },
    );
  }

  /**
   * How this folder's head stands to another — the hub's, a peer's: the same
   * (`same`), behind it, ahead of it, forked from it, or not decidable from
   * what this node can read (`incomplete`).
   *
   * Two different heads can hold the same files — after two nodes merged the
   * same fork, say. Whether they do is a question for the tree refs, not this.
   * @param head - The other head.
   * @returns The relation, or `undefined` while no sync runs or the folder has
   * no head.
   */
  async relationTo(head: string): Promise<Relation | undefined> {
    const own = this._ownHead;
    if (own === undefined || !this._chain) return undefined;
    return this._chain.relate(own, head);
  }

  /**
   * Puts the folder back to a revision of its history, EXACTLY, and makes that
   * the newest edit, so every node follows.
   *
   * Exactly: what the revision holds is written, and what it lacks is
   * deleted. An older `restore` or `loadFromDb` of the same tree only adds and
   * overwrites, so files made after the revision stay and the folder ends up
   * in a state no revision ever had.
   *
   * Nothing is lost by it. Whatever the folder holds beyond its head is
   * recorded first, and the revision being left stays in the history, from
   * where it can be restored in turn.
   *
   * Rejects while no sync runs or the folder has no head; with a
   * `MassDeleteRefusedError`, changing nothing, when the revision would delete
   * a large part of the folder — the guard every prune has; and with a
   * `RestoreIncompleteError` when a file could not be written, the rest of the
   * revision in place.
   * @param head - The revision: a chain entry from {@link history}.
   * @returns `restored`; `unknown` when this node cannot read the entry or its
   * tree; `busy` while a file in the folder is still being written — nothing
   * was changed in either case, and a busy folder can be asked again.
   */
  async restoreRevision(
    head: string,
  ): Promise<'restored' | 'unknown' | 'busy'> {
    if (this._ownHead === undefined || !this._chain) {
      throw new Error(
        `${this._tag} restoreRevision: no history to restore from — the ` +
          `folder is not syncing yet`,
      );
    }
    return this._exclusive(() =>
      this._writing(async () => {
        if (!(await this._recordFolder())) return 'busy';
        const target = await this._treeOf(head);
        if (!target) return 'unknown';

        const content = this._getFileContentMap(target.tree);
        await this.restore(target.tree, undefined, { cleanTarget: true }).finally(
          () => {
            // What the prune removed, a person asked to remove: recorded as a
            // deletion seen, not one a scan inferred, which the guard would
            // hold back. A refused restore removed nothing, and marks nothing.
            for (const path of this._ownContent.keys()) {
              const full = join(this._rootPath, ...path.split('/'));
              if (!content.has(path) && !existsSync(full)) {
                this._watched.add(path);
              }
            }
          },
        );
        await this._author(await this._scanner.scanFresh());
        return 'restored';
      }),
    );
  }

  /**
   * Records what the folder holds before something writes over it, waiting
   * out a file the scan will not read yet.
   *
   * A pass leaves out a file it has never read and one written to while it
   * ran, and reads them once they settle — right for a sync, which only ever
   * adds a later version. A restore overwrites and prunes, and a file no entry
   * holds yet is somebody's work with no copy anywhere: measured, a file
   * saved just before a restore was deleted by it.
   * @returns Whether everything was recorded; `false` while a file is still
   * being written after {@link RESTORE_SETTLE_PASSES} passes.
   */
  private async _recordFolder(): Promise<boolean> {
    for (let pass = 0; pass < RESTORE_SETTLE_PASSES; pass++) {
      await this._author(await this._scanner.scanFresh());
      if (this._scanner.deferred.length === 0) return true;
      await new Promise((resolve) =>
        setTimeout(resolve, this._scanner.settleMs + 50),
      );
    }
    return false;
  }

  /** When this agent last finished something that may write to the folder. */
  private _wroteAt = 0;

  /**
   * Runs `work`, which may write to the folder, and notes when it ended —
   * inside the lock, so nothing queued behind it can read an older note.
   * @param work - A receive or a join.
   * @returns What `work` returned.
   */
  private async _writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      this._wroteAt = Date.now();
    }
  }

  /**
   * The folder for authoring a local change: a pass that began after this
   * agent last wrote to it.
   *
   * A pass that overlapped an apply may have read the apply half-done, and
   * authoring from it announced the version before the apply — a revert
   * (F9). After a write, then, the folder is scanned afresh. Without one, the
   * watcher's last pass already is such a pass, and scanning again only looks
   * at a file mid-copy one more time: a copy that stalls hashed a truncated
   * version for every extra look, two to five times as many as before.
   * @returns The tree.
   */
  private async _passAfterOwnWrites(): Promise<FsTree> {
    const last = this._scanner.tree;
    return last && this._scanner.treeStartedAt > this._wroteAt
      ? last
      : this._scanner.scanFresh();
  }

  /**
   * Runs `work` alone: the send and receive sides never interleave.
   * @param work - What to run.
   * @returns What `work` returned.
   */
  private _exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this._lock.then(work, work);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Opens the chain and the stamp store for a route, once.
   * @param db - The route's database.
   * @param treeKey - The trees table key.
   */
  private async _ensureChain(db: Db, treeKey: string): Promise<void> {
    if (this._chain) return;
    const chain = new FsEditChain(db, treeKey);
    await chain.init();
    const stamps = new FsStamps(
      db,
      treeKey,
      async (entry) => (await chain.entry(entry).catch(() => undefined))?.previous,
    );
    await stamps.init();
    this._chain = chain;
    this._stamps = stamps;
  }

  // ...........................................................................
  // The own head

  /**
   * The head `.fsagent-state.json` names, if it names one.
   * @returns The head, or `undefined`.
   */
  private _persistedHead(): string | undefined {
    const state = this._persistedState();
    return typeof state?.ownHead === 'string' && state.ownHead !== ''
      ? state.ownHead
      : undefined;
  }

  /**
   * The ignore list `.fsagent-state.json` records, if it records one — the
   * list the folder was in step with when this node last ran.
   * @returns The list, or `undefined`.
   */
  private _persistedIgnore(): string[] | undefined {
    const ignore = this._persistedState()?.ignore;
    return Array.isArray(ignore) &&
      ignore.every((pattern) => typeof pattern === 'string')
      ? ignore
      : undefined;
  }

  /**
   * `.fsagent-state.json`, read.
   * @returns What it holds, or `undefined` when it cannot be read.
   */
  private _persistedState():
    | { ownHead?: unknown; ignore?: unknown }
    | undefined {
    try {
      return JSON.parse(
        readFileSync(join(this._rootPath, AGENT_STATE_FILE), 'utf-8'),
      ) as { ownHead?: unknown; ignore?: unknown } | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Makes `head` this node's head, and remembers it across a restart.
   * @param head - The chain entry.
   * @param content - The tree it names, `path → blob`.
   * @param carried - Its nodes at the paths this node does not see.
   */
  private _setOwn(
    head: string,
    content: ReadonlyMap<string, string>,
    carried: ReadonlyMap<string, Tree>,
  ): void {
    this._ownHead = head;
    this._ownContent = content;
    this._carried = carried;
    // A path the network removed is nothing to wait for any more.
    for (const path of this._uncovered) {
      if (!content.has(path)) this._uncovered.delete(path);
    }
    if (this._uncovered.size === 0 && !this._uncoverDue) {
      this._ignoreOnRecord = this._scanner.ignore;
    }
    this._partiallyApplied.clear();
    this._writeState();
  }

  /**
   * What a head's tree holds at the paths this node does not see: those its
   * ignore list leaves out, and those it sees again and does not hold yet.
   * @param tree - The tree.
   * @returns The nodes, by path.
   */
  private _carriedOf(tree: FsTree): Map<string, Tree> {
    const carried = carriedNodes(tree, (path, isDirectory) =>
      this._scanner.ignores(path, isDirectory),
    );
    if (this._uncovered.size > 0) {
      for (const node of tree.trees.values()) {
        const path = (node.meta as unknown as FsNodeMeta).relativePath;
        if (this._uncovered.has(path)) carried.set(path, node);
      }
    }
    return carried;
  }

  /**
   * Writes {@link AGENT_STATE_FILE}: the own head, the stamp epochs, and the
   * ignore list the folder is in step with.
   */
  private _writeState(): void {
    const stampEpochs = (this._stamps as FsStamps).epochs;
    this._writtenEpochs = JSON.stringify(stampEpochs);
    try {
      // Staged, like the signal log: an empty state file after a crash read
      // as no head at all, and the restart joined like a stranger.
      atomicWriteFileSync(
        join(this._rootPath, AGENT_STATE_FILE),
        JSON.stringify({
          ownHead: this._ownHead,
          stampEpochs,
          ignore: this._ignoreOnRecord,
        }),
      );
    } catch (err) {
      this._writeSyncError('state/write', err);
    }
  }

  /** The stamp epochs the state file holds, as written. */
  private _writtenEpochs = '{}';

  /**
   * The tree a chain entry names.
   * @param head - The chain entry.
   * @returns Its tree ref and tree, or `undefined` when either cannot be read.
   */
  private async _treeOf(
    head: string,
  ): Promise<{ treeRef: string; tree: FsTree } | undefined> {
    const { db, treeKey } = this._route as NonNullable<typeof this._route>;
    const entry = await this._chain?.entry(head).catch(() => undefined);
    if (!entry) return undefined;
    const tree = await this._fetchTreeFromDb(db, treeKey, entry.treeRef).catch(
      () => undefined,
    );
    return tree ? { treeRef: entry.treeRef, tree } : undefined;
  }

  /** Announces the own head, with its stamp when this node knows it. */
  private _announceOwn(): void {
    const head = this._ownHead as string;
    const { connector } = this._route as NonNullable<typeof this._route>;
    connector.invalidateSent?.(head);
    const started = Date.now();
    try {
      connector.send(head, { stamp: this._stamps?.get(head) });
    } catch (err) {
      this._writeSyncError('announce', err);
    } finally {
      this._stageMs['push.announce'] = Date.now() - started;
    }
  }

  /**
   * Announces the own head so the hub stamps it — at once the first time,
   * then less and less often while the stamp does not come.
   *
   * Bounded because nothing else bounds it: on a hub that does not stamp,
   * three nodes deferring the same conflict answered each other's
   * announcements with announcements, 245 000 merge attempts in one test.
   * @param head - The own head.
   */
  private _askForStamp(head: string): void {
    const now = Date.now();
    const ask = this._stampAsk;
    if (ask?.head === head && now - ask.at < ask.waitMs) return;
    const waitMs =
      ask?.head === head
        ? Math.min(ask.waitMs * 2, STAMP_ASK_MAX_MS)
        : STAMP_ASK_MIN_MS;
    this._stampAsk = { head, at: now, waitMs };
    this._announceOwn();
  }

  // ...........................................................................
  // Sending

  /**
   * Authors an edit for the folder as `scanned` describes it, if it moved past
   * the own head and the edit is honest — see `planAuthoring`. The paths this
   * node does not see are carried as the own head holds them.
   * @param scanned - The folder, as just scanned.
   */
  private async _author(scanned: FsTree): Promise<void> {
    if (this._joinWait || !this._route || !this._chain) return;
    // What this node does not see, its edit holds as its head holds it.
    const { tree, carried } = graftTree(scanned, this._carried);
    const folder = this._getFileContentMap(tree);

    if (this._ownHead === undefined) {
      // No history anywhere: this folder is its origin. An empty one has
      // nothing to be the origin of, and waits to be told.
      if (folder.size === 0) return;
      const treeRef = await this._storeTree(tree);
      const root = await this._chain.append({ treeRef, previous: [] });
      this._setOwn(root.head, folder, carried);
      this._watched.clear();
      this._announceOwn();
      return;
    }

    // What a cut-short apply wrote counts as unchanged: it is not this
    // node's work, and claiming it would make it the author.
    const head =
      this._partiallyApplied.size === 0
        ? this._ownContent
        : new Map([...this._ownContent, ...this._partiallyApplied]);
    // What it carries is unchanged by construction, and not in the folder:
    // the guard below judges what the folder holds.
    const seen = (content: ReadonlyMap<string, string>) =>
      carried.size === 0
        ? content
        : new Map([...content].filter(([path]) => !carried.has(path)));
    const plan = planAuthoring({
      folder: seen(folder),
      head: seen(head),
      watched: this._watched,
      minFiles: MASS_DELETE_MIN_FILES,
      maxRatio: MASS_DELETE_MAX_RATIO,
      allGoneMinFiles: ALL_GONE_MIN_FILES,
      heldBack: this._heldBack,
    });
    if (plan.kind === 'refused') {
      this._heldBack = new Set(plan.disappeared);
      this._refuseDeletion(
        'author',
        plan.disappeared.length,
        plan.held,
        plan.disappeared,
        'The watcher did not see them go, so the folder keeps its last ' +
          'recorded state until a person decides.',
      );
      return;
    }
    // Nothing a refusal held back is still gone.
    this._heldBack = new Set();
    if (plan.kind === 'unchanged') return;

    // A removal is honest only about a file that is really gone. A scan can
    // lag behind the disk — a file it has not read yet is skipped until it
    // settles — and authoring that absence would delete the file on every
    // node. So wait for the scan to catch up.
    for (const path of plan.removed) {
      if (await lstat(join(this._rootPath, ...path.split('/'))).catch(() => undefined)) {
        this._authorSoon?.();
        return;
      }
    }

    const treeRef = await this._storeTree(tree);
    const entry = await this._chain.append({
      treeRef,
      changed: plan.changed,
      removed: plan.removed,
      previous: [this._ownHead],
    });
    this._setOwn(entry.head, folder, carried);
    this._watched.clear();
    this._announceOwn();
  }

  /**
   * Stores a tree and its blobs for the route.
   * @param tree - The tree.
   * @returns Its ref.
   */
  private async _storeTree(tree: FsTree): Promise<string> {
    const { db, treeKey } = this._route as NonNullable<typeof this._route>;
    return FsAgent._withTimeout(
      new FsDbAdapter(db, treeKey).storeFsTree(tree, { skipNotification: true }),
      this._timeouts.fetchTree,
      `storeFsTree(${treeKey})`,
    );
  }

  /**
   * Watches the folder and keeps the chain in step with it.
   *
   * On start, a folder with a head continues it; a folder without one joins
   * the network (`planJoin`) or, when nobody answers, becomes its origin.
   * @param db - The route's database.
   * @param connector - The transport.
   * @param treeKey - The trees table key.
   * @returns Stops watching.
   */
  async syncToDb(
    db: Db,
    connector: Connector,
    treeKey: string,
  ): Promise<() => void> {
    this._route = { db, connector, treeKey };
    await this._ensureChain(db, treeKey);
    const initial = await FsAgent._withTimeout(
      this.extract(),
      this._timeouts.extract,
      `syncToDb → initial extract(${treeKey})`,
    );

    const persisted = this._persistedHead();
    const resumed = persisted !== undefined && (await this._treeOf(persisted));
    if (resumed) {
      // Restarted with another ignore list: the folder is in step with the
      // one recorded until `_uncover` has looked at what that uncovered.
      const recorded = this._persistedIgnore();
      if (recorded !== undefined && !sameList(recorded, this._scanner.ignore)) {
        this._ignoreOnRecord = recorded;
        this._uncoverDue = true;
      }
      this._setOwn(
        persisted as string,
        this._getFileContentMap(resumed.tree),
        this._carriedOf(resumed.tree),
      );
      await this._exclusive(async () => {
        const moved =
          this._uncoverDue &&
          (await this._writing(() =>
            this._uncover(persisted as string, resumed.tree, initial),
          ));
        await this._author(moved ? await this._scanner.scanFresh() : initial);
      });
      this._announceOwn();
    } else if (this._joinWaitMs > 0) {
      this._startJoinWait();
    } else {
      await this._exclusive(() => this._author(initial));
    }

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onChange = (change?: FsChange) => {
      if (change?.type === 'deleted' && change.path !== '.') {
        this._watched.add(change.path);
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        // A scan started now, under the lock — never the watcher's last pass,
        // which can have run while an apply was still writing and would read
        // as a local edit reverting it.
        void this._exclusive(async () =>
          this._author(await this._passAfterOwnWrites()),
        ).catch((err) => this._writeSyncError('syncToDb', err));
      }, this._timeouts.debounceMs);
    };
    this._scanner.onChange(onChange);
    this._authorSoon = () => onChange();
    await this._ensureWatching();

    return () => {
      this._authorSoon = undefined;
      if (debounce) clearTimeout(debounce);
      this._scanner.offChange(onChange);
      this._scanner.stopWatch();
    };
  }

  // ...........................................................................
  // Joining

  /**
   * Waits up to `joinWaitMs` for the network's head before this folder says
   * anything about itself.
   */
  private _startJoinWait(): void {
    const timer = setTimeout(() => this._joinWait?.done(undefined), this._joinWaitMs);
    timer.unref?.();
    this._joinWait = {
      timer,
      done: (head) => {
        this._endJoinWait();
        void this._exclusive(() => this._writing(() => this._join(head))).catch((err) =>
          this._writeSyncError('join', err),
        );
      },
    };
  }

  /** Ends a join wait without acting on it. */
  private _endJoinWait(): void {
    if (this._joinWait) clearTimeout(this._joinWait.timer);
    this._joinWait = undefined;
  }

  /**
   * Joins the network's head, or — when none came — makes this folder the
   * origin of its history.
   *
   * **The chain applies first; the filesystem only then.** What the folder
   * holds beyond the head is judged by the history: a path the history never
   * named is new work and is authored on top of the head; a path it removed is
   * a stale copy and is set aside, not announced; a path both hold with
   * different bytes keeps the head's version and the local one as a copy.
   * @param head - The network's head, or `undefined`.
   */
  private async _join(head: string | undefined): Promise<void> {
    const folderTree = await this._scanner.scanFresh();
    const joined = head === undefined ? undefined : await this._treeOf(head);
    if (head === undefined || !joined) {
      await this._author(folderTree);
      return;
    }

    const headContent = this._getFileContentMap(joined.tree);
    const folder = this._getFileContentMap(folderTree);
    // Unreadable or incomplete, the history says nothing about what it
    // removed — so nothing is treated as a stale copy, and nothing is lost.
    const walk = await (this._chain as FsEditChain)
      .collectRemovals(head, undefined)
      .catch(() => undefined);
    const plan = planJoin({
      haveHead: true,
      head: headContent,
      folder,
      removedEver: new Set(walk?.complete ? walk.removed : []),
    });

    const taken = new Set<string>([...folder.keys(), ...headContent.keys()]);
    const copies: Record<string, string> = {};
    for (const path of plan.recover) {
      await this._setAside(
        path,
        `${RECOVERED_DIR}/${recoveredName(path, taken)}`,
        copies,
      );
    }
    for (const path of plan.conflict) {
      await this._setAside(path, joinCopyName(path, Date.now(), taken), copies);
    }
    this._signalJoinOutcome(plan.recover, plan.conflict, copies);

    await this.restore(joined.tree, undefined, { cleanTarget: false });
    this._setOwn(head, headContent, this._carriedOf(joined.tree));
    await this._author(await this._scanner.scanFresh());
    this._announceOwn();
  }

  /**
   * Joins the paths this node sees again: a pattern left its ignore list
   * since it last ran.
   *
   * While a path was ignored, this node neither wrote it nor deleted it, so
   * the folder can lack what the head holds there, or hold a version of its
   * own that never went anywhere. Authored as they stand, the first would
   * delete the network's files and the second overwrite them. So these paths
   * are joined as a joining folder is (`planJoin`): a version of this node's
   * own is set aside as a copy, one the history removed goes to
   * {@link RECOVERED_DIR}, one the history never named is new work — and the
   * head's version is written, and carried until it is there.
   * @param head - The own head.
   * @param headTree - Its tree.
   * @param folderTree - The folder, as just scanned.
   * @returns Whether anything in the folder was moved aside.
   */
  private async _uncover(
    head: string,
    headTree: FsTree,
    folderTree: FsTree,
  ): Promise<boolean> {
    const was = compileIgnore(this._ignoreOnRecord);
    const seenAgain = (content: ReadonlyMap<string, string>) =>
      new Map(
        [...content].filter(
          ([path, value]) =>
            !this._carried.has(path) && was.excludes(path, value === DIR_MARKER),
        ),
      );
    const folder = this._getFileContentMap(folderTree);
    const inHead = seenAgain(this._ownContent);
    const inFolder = seenAgain(folder);

    let changed = false;
    if (inHead.size > 0 || inFolder.size > 0) {
      const walk = await (this._chain as FsEditChain)
        .collectRemovals(head, undefined)
        .catch(() => undefined);
      const plan = planJoin({
        haveHead: true,
        head: inHead,
        folder: inFolder,
        removedEver: new Set(walk?.complete ? walk.removed : []),
      });
      const taken = new Set<string>([...folder.keys(), ...this._ownContent.keys()]);
      const copies: Record<string, string> = {};
      for (const path of plan.recover) {
        await this._setAside(
          path,
          `${RECOVERED_DIR}/${recoveredName(path, taken)}`,
          copies,
        );
      }
      for (const path of plan.conflict) {
        await this._setAside(path, joinCopyName(path, Date.now(), taken), copies);
      }
      this._signalJoinOutcome(plan.recover, plan.conflict, copies, 'ignore');
      for (const path of [...plan.write, ...plan.conflict]) {
        this._uncovered.add(path);
      }
      this._carried = this._carriedOf(headTree);
      changed = plan.recover.length + plan.conflict.length > 0;
    }
    // The head's versions are fetched with the next head this node hears,
    // which a node starting offline only does once it can fetch anything.
    this._uncoverDue = false;
    if (this._uncovered.size === 0) this._ignoreOnRecord = this._scanner.ignore;
    this._writeState();
    return changed;
  }

  /**
   * Writes the head's version of every path `_uncover` is waiting for that is
   * not in the folder — and stops carrying each one that is, whichever
   * version: a file somebody saved there meanwhile is their work, and the
   * next edit says so.
   *
   * Asked again with every head this node hears, so a version that could not
   * be fetched — this node started offline — arrives once it can be.
   */
  private async _takeUncovered(): Promise<void> {
    if (this._uncovered.size === 0) return;
    const there = (path: string) =>
      lstat(join(this._rootPath, ...path.split('/'))).then(
        () => true,
        () => false,
      );
    const missing: string[] = [];
    for (const path of this._uncovered) {
      if (!(await there(path))) missing.push(path);
    }
    if (missing.length > 0) {
      try {
        const own = await this._treeOf(this._ownHead as string);
        if (!own) throw new Error('the own head cannot be read');
        await this._restorePaths(own.tree, missing);
      } catch (err) {
        // What arrived is let go below; the rest waits for the next head.
        this._writeSyncError('uncover', err);
      }
    }

    const arrived = new Set<string>();
    for (const path of this._uncovered) {
      if (await there(path)) arrived.add(path);
    }
    if (arrived.size === 0) return;
    for (const path of arrived) this._uncovered.delete(path);
    this._carried = new Map(
      [...this._carried].filter(([path]) => !arrived.has(path)),
    );
    if (this._uncovered.size === 0) {
      this._ignoreOnRecord = this._scanner.ignore;
      this._writeState();
    }
  }

  // ...........................................................................
  // Receiving

  /**
   * Hears a head — from an announcement, a bootstrap or a state beacon.
   * @param head - The head.
   * @param stamp - The stamp it arrived with, if any.
   * @param fromHub - Whether the hub said it: what `antiEntropyStatus` reports.
   */
  private _hear(head: unknown, stamp?: unknown, fromHub = false): void {
    if (typeof head !== 'string' || head === '') return;
    this._recordStamp(head, stamp);
    if (fromHub) this._hubHead = head;
    if (this._joinWait) {
      this._joinWait.done(head);
      return;
    }
    if (this._ownHead === undefined) {
      void this._exclusive(() => this._writing(() => this._join(head))).catch((err) =>
        this._writeSyncError('join', err),
      );
      return;
    }
    this._heard = head;
    this._drain();
  }

  /** The head the hub said last. */
  private _hubHead?: string;

  /**
   * Records the stamp a head arrived with, in arrival order.
   * @param head - The head.
   * @param stamp - Its stamp, if any.
   */
  private _recordStamp(head: string, stamp: unknown): void {
    const stamps = this._stamps;
    if (stamp === undefined || !stamps) return;
    this._stamping = this._stamping
      .then(async () => {
        await stamps.heard(head, stamp);
        // A higher epoch is what a hub taking office here must continue
        // above, and a hub reads it from the state file.
        if (JSON.stringify(stamps.epochs) !== this._writtenEpochs) {
          this._writeState();
        }
      })
      .catch((err) => this._writeSyncError('stamps/heard', err));
  }

  /** Receives the newest head heard, one at a time, until none is left. */
  private _drain(): void {
    if (this._receiving) return;
    this._receiving = (async () => {
      while (this._heard !== undefined) {
        const head = this._heard;
        this._heard = undefined;
        await this._stamping;
        const own = this._ownHead;
        const outcome = await this._exclusive(() =>
          this._writing(() => receive(head, this._receiveDeps())),
        ).catch((err): ReceiveOutcome => {
          this._writeSyncError('receive', err);
          return 'blocked';
        });
        if (outcome !== 'in-sync') {
          console.log(
            `${this._tag} received ${head.slice(0, 8)}… on ` +
              `${own?.slice(0, 8)}… — ${outcome}`,
          );
        }
        this._noteOutcome(head, outcome);
      }
    })().finally(() => {
      this._receiving = undefined;
    });
  }

  /**
   * Keeps `antiEntropyStatus` true to what the last head from the hub made
   * this node do.
   * @param head - The head that was received.
   * @param outcome - What was done.
   */
  private _noteOutcome(head: string, outcome: ReceiveOutcome): void {
    if (head !== this._hubHead) return;
    const now = Date.now();
    const settled = outcome === 'in-sync' || this._ownHead === head;
    const was = this._hubStatus;
    const acted = outcome !== 'in-sync';
    this._hubStatus = {
      diverged: !settled,
      divergedSince: settled ? null : (was?.divergedSince ?? now),
      hubRef: head,
      localRef: this._ownHead as string,
      repairs: (was?.repairs ?? 0) + (acted ? 1 : 0),
      lastRepair: acted
        ? {
            action: REPAIR_ACTION[outcome],
            at: now,
            hubRef: head,
            localRef: this._ownHead as string,
            attempt:
              was?.lastRepair?.hubRef === head ? was.lastRepair.attempt + 1 : 1,
          }
        : (was?.lastRepair ?? null),
    };
  }

  /**
   * How often in a row an apply found the folder moved under this node's own
   * head. Counted per own head, not per incoming one: two heads arriving in
   * turn must not reset each other's count.
   */
  private _movedAgain?: { own: string | undefined; times: number };

  /**
   * Receives a head once more after the folder moved under an apply — the
   * local work is authored first then, which turns the apply into a merge.
   * Bounded, so a cache that never catches up cannot loop; the next head the
   * hub says tries again.
   * @param head - The head.
   */
  private _receiveAgain(head: string): void {
    const own = this._ownHead;
    const was = this._movedAgain;
    const times = was && was.own === own ? was.times + 1 : 1;
    this._movedAgain = { own, times };
    if (times > RECEIVE_AGAIN_MAX) return;
    this._heard ??= head;
  }

  /**
   * What `receive` needs from this agent.
   * @returns The agent's side of a receive.
   */
  private _receiveDeps(): ReceiveDeps {
    const chain = this._chain as FsEditChain;
    return {
      ownHead: () => this._ownHead,
      flushLocal: async () => {
        await this._takeUncovered();
        await this._author(await this._scanner.scanFresh());
      },
      relate: (ours, theirs) => chain.relate(ours, theirs),
      treeRefOf: async (head) => (await chain.entry(head))?.treeRef,
      applyBehind: (head) => this._applyBehind(head),
      adopt: (head) => this._adopt(head),
      announceOwn: () => this._announceOwn(),
      merge: (theirs, base) => this._merge(theirs, base),
      blocked: (head, reason) =>
        this._signalOnce(`blocked\u0000${this._ownHead}\u0000${head}`, {
          kind: 'repair/blocked',
          paths: [],
          action: 'review',
          decidedBy: 'chain',
          detail: `${reason}; nothing was changed. It is retried when the hub says its state again.`,
        }),
    };
  }

  /**
   * Makes a head this node's own without touching the folder: its content
   * is what the folder already holds.
   * @param head - The head.
   */
  private async _adopt(head: string): Promise<void> {
    this._setOwn(head, this._ownContent, this._carried);
  }

  /**
   * Applies a head that descends from the own one: writes what it changed,
   * deletes what it removed — every absence in it is a deletion its author
   * chose, because its author held this node's state.
   *
   * Only what changed between the two heads is touched, and only while the
   * folder still holds the own head's version of it. A file the user changed
   * since is never overwritten: the apply stops, that work is authored, and
   * the head is received again — as a fork, which merges.
   * @param head - The head.
   * A deletion beyond the receiver's floors is the exception: the files stay,
   * the head is adopted all the same, and the files are authored again on top
   * of it — which is what refills a node that lost them.
   * @returns `applied`, or `refused` when the head cannot be read or local
   *   work stopped it.
   */
  private async _applyBehind(head: string): Promise<'applied' | 'refused'> {
    const theirs = await this._treeOf(head);
    if (!theirs) return 'refused';
    const target = this._getFileContentMap(theirs.tree);
    const carried = this._carriedOf(theirs.tree);
    const applied = await this._applyContent(
      target,
      (paths) => this._restorePaths(theirs.tree, paths),
      carried,
    );
    if (applied === 'moved') {
      this._receiveAgain(head);
      return 'refused';
    }
    this._setOwn(head, target, carried);
    if (applied === 'kept') await this._author(await this._scanner.scanFresh());
    return 'applied';
  }

  /**
   * Moves the folder from the own content to `target`: writes what differs,
   * deletes what `target` lacks.
   *
   * The receiver guard: a deletion that would lose more than the floors allow
   * — content `target` holds nowhere else — is not made. Everything else is,
   * and the files kept become this node's work, so the folder never holds a
   * state the chain does not describe.
   * The paths this node does not see are neither written nor deleted, and
   * the guard counts only what the folder holds.
   * @param target - Where the folder should end up, `path → blob`.
   * @param write - Writes the given paths' `target` versions.
   * @param carried - `target`'s nodes at the paths this node does not see.
   * @returns `applied`; `kept` when the guard kept files `target` lacks;
   *   `moved` when the folder had moved past the own head.
   */
  private async _applyContent(
    target: ReadonlyMap<string, string>,
    write: (paths: readonly string[]) => Promise<void>,
    carried: ReadonlyMap<string, Tree>,
  ): Promise<'applied' | 'kept' | 'moved'> {
    const own = this._ownContent;
    const landed = this._partiallyApplied;
    const anyCarried = this._carried.size > 0 || carried.size > 0;
    const seen = (p: string) =>
      !anyCarried || (!this._carried.has(p) && !carried.has(p));
    const writes = [...target.keys()].filter(
      (p) =>
        target.get(p) !== own.get(p) && target.get(p) !== landed.get(p) && seen(p),
    );
    const deletes = [...own.keys()].filter((p) => !target.has(p) && seen(p));

    const isFile = (v: string | undefined) => v !== undefined && v !== DIR_MARKER;
    const filesIn = (content: ReadonlyMap<string, string>): string[] => {
      const blobs: string[] = [];
      for (const [p, v] of content) if (isFile(v) && seen(p)) blobs.push(v);
      return blobs;
    };
    const held = filesIn(own).length;
    const deletedFiles = deletes.filter((p) => isFile(own.get(p)));
    const targetFiles = filesIn(target);
    const stillThere = new Set(targetFiles);
    const lost = deletedFiles.filter((p) => !stillThere.has(own.get(p) as string));
    const keep = new Set(
      (lost.length > MASS_DELETE_MIN_FILES && lost.length / held > MASS_DELETE_MAX_RATIO) ||
        (lost.length > 0 && held > ALL_GONE_MIN_FILES &&
          targetFiles.length <= ALL_GONE_MIN_FILES)
        ? lost
        : [],
    );
    const deleting = deletes.filter((p) => !keep.has(p));

    if (!(await this._unchangedSinceOwn([...writes, ...deleting]))) return 'moved';

    // The watcher stays on: this node's own writes author nothing, because
    // the folder then matches the own content, and an edit a person makes
    // meanwhile is never dropped.
    if (writes.length > 0) {
      try {
        await write(writes);
      } catch (err) {
        for (const path of writes) {
          const blob = target.get(path) as string;
          if ((await this._blobOnDisk(path)) === blob) landed.set(path, blob);
        }
        throw err;
      }
    }
    for (const path of deletedFiles.filter((p) => !keep.has(p))) {
      await rm(join(this._rootPath, ...path.split('/')), { force: true });
    }
    for (const path of deletes
      .filter((p) => own.get(p) === DIR_MARKER)
      .sort()
      .reverse()) {
      await rmdir(join(this._rootPath, ...path.split('/'))).catch(() => undefined);
    }
    if (keep.size === 0) return 'applied';
    this._refuseDeletion(
      'restore',
      keep.size,
      held,
      [...keep],
      'Everything else was applied; the files stay and are authored again.',
    );
    return 'kept';
  }

  /**
   * Whether every given path still holds what the own head says — or what a
   * cut-short apply already wrote there: no local change the watcher has not
   * reported yet.
   * @param paths - Relative paths.
   * @returns `true` when none of them changed since the own head.
   */
  private async _unchangedSinceOwn(paths: readonly string[]): Promise<boolean> {
    for (const path of paths) {
      const expected =
        this._partiallyApplied.get(path) ?? this._ownContent.get(path);
      if (expected === DIR_MARKER) continue;
      const blob = await this._blobOnDisk(path);
      if (expected === undefined ? blob !== null : blob !== expected) {
        return false;
      }
    }
    return true;
  }

  /**
   * The blob a file holds, as far as this agent knows without reading it: what
   * it last wrote there, or what the scanner last read — whichever a `stat`
   * confirms. Both, because either goes stale on its own: a restore's record
   * once anything else rewrites the file, the scanner's until its next pass.
   * @param path - Relative path.
   * @returns The blob; `null` when no file is there; `undefined` when the file
   *   changed since this agent last knew it.
   */
  private async _blobOnDisk(path: string): Promise<string | null | undefined> {
    const full = join(this._rootPath, ...path.split('/'));
    const st = await stat(full).catch(() => undefined);
    if (!st?.isFile()) return null;
    for (const known of [
      this._restoredBlobs.get(full),
      this._scanner.knownFile(path),
    ]) {
      if (
        known &&
        st.size === known.size &&
        Math.abs(st.mtimeMs - known.mtime) < 1
      ) {
        return known.blobId;
      }
    }
    return undefined;
  }

  /**
   * Writes the given paths of a tree into the folder, with everything a
   * restore does for a write: streams, locks, impossible names, a full disk.
   * @param tree - The tree.
   * @param paths - The relative paths to write.
   */
  private async _restorePaths(tree: FsTree, paths: readonly string[]): Promise<void> {
    const wanted = new Set(paths);
    const keep = new Map<string, any>();
    const visit = (hash: string): boolean => {
      const node = tree.trees.get(hash);
      if (!node) return false;
      const path = node.meta?.relativePath as string | undefined;
      if (node.meta?.type === 'file') {
        if (!wanted.has(path as string)) return false;
        keep.set(hash, node);
        return true;
      }
      const children = ((node.children as string[] | undefined) ?? []).filter(visit);
      if (children.length === 0 && !wanted.has(path as string)) return false;
      keep.set(hash, { ...node, children });
      return true;
    };
    visit(tree.rootHash);
    await FsAgent._withTimeout(
      this.restore({ rootHash: tree.rootHash, trees: keep }, undefined, {
        cleanTarget: false,
      }),
      this._timeouts.restore,
      `restore(${paths.length} paths)`,
    );
  }

  /**
   * Merges a forked head into the own one against their common base — the
   * conflict table in `fs-merge.ts` — and authors the merge.
   * @param theirs - The forked head.
   * @param base - Their common ancestor, if any.
   * @returns `merged`; `deferred` when a stamp the verdict needs is not known
   *   yet; `refused` when the merge could not be applied.
   */
  private async _merge(
    theirs: string,
    base: string | undefined,
  ): Promise<'merged' | 'deferred' | 'refused'> {
    const own = this._ownHead as string;
    const chain = this._chain as FsEditChain;
    const stamps = this._stamps as FsStamps;
    const [theirTree, baseTree] = await Promise.all([
      this._treeOf(theirs),
      base === undefined ? Promise.resolve(undefined) : this._treeOf(base),
    ]);
    if (!theirTree || (base !== undefined && !baseTree)) return 'refused';
    const ours = this._ownContent;
    const theirContent = this._getFileContentMap(theirTree.tree);
    console.log(
      `${this._tag} merging ${theirs.slice(0, 8)}… into ${own.slice(0, 8)}… ` +
        `against ${base?.slice(0, 8) ?? 'no common history'}`,
    );
    const baseContent: ReadonlyMap<string, string> = baseTree
      ? this._getFileContentMap(baseTree.tree)
      : new Map();

    // Who introduced each side's version of every path both sides changed.
    const contested = [...new Set([...ours.keys(), ...theirContent.keys()])].filter(
      (p) => ours.get(p) !== theirContent.get(p) && ours.get(p) !== baseContent.get(p) && theirContent.get(p) !== baseContent.get(p),
    );
    const introducers = async (head: string) => {
      const found = new Map<string, Introducer>();
      for (const path of contested) {
        // A version no entry names came with a root, which names nothing:
        // the head that carried it introduced it.
        const entry = (await chain.lastEditOf(head, path))?.head ?? head;
        found.set(path, { entry, stamp: stamps.get(entry), nodeId: '' });
      }
      return found;
    };
    const decide = async () => {
      const [mine, yours] = await Promise.all([introducers(own), introducers(theirs)]);
      const outcome = merge3(
        baseContent,
        { content: ours, introducer: (p) => mine.get(p) as Introducer },
        { content: theirContent, introducer: (p) => yours.get(p) as Introducer },
      );
      const ownUnstamped = outcome.unknownStamps.some((p) => !mine.get(p)?.stamp);
      return { outcome, ownUnstamped };
    };
    let { outcome, ownUnstamped } = await decide();
    if (outcome.unknownStamps.length > 0) {
      // A walk that stopped at a row it could not read holds the stamps back.
      await stamps.settle();
      ({ outcome, ownUnstamped } = await decide());
    }
    if (outcome.unknownStamps.length > 0) {
      // This node's own version gets its stamp only once its head reaches the
      // hub, and a head authored while cut off never did: say it again. Every
      // later beacon would otherwise defer this merge for ever.
      if (ownUnstamped) this._askForStamp(own);
      // The first wait is routine — every node back from a partition has one,
      // and the stamp is a round trip away. A wait that outlives it is what a
      // person should hear about: a hub that does not stamp, say.
      const key = `await-stamp\u0000${own}\u0000${theirs}`;
      if (this._deferral === key) {
        this._signalOnce(key, {
          kind: 'repair/blocked',
          paths: outcome.unknownStamps,
          action: 'review',
          decidedBy: 'stamp',
          detail: 'two versions of these files wait for the hub to say which reached the fleet first; nothing was changed',
        });
      }
      this._deferral = key;
      return 'deferred';
    }

    const theirCarried = this._carriedOf(theirTree.tree);
    const applied = await this._applyContent(
      outcome.merged,
      async (paths) => {
        const fromTheirs = paths.filter((p) => outcome.merged.get(p) === theirContent.get(p));
        if (fromTheirs.length > 0) await this._restorePaths(theirTree.tree, fromTheirs);
        // Not taken from theirs: a conflicted copy, which is always a file.
        for (const path of paths.filter((p) => !fromTheirs.includes(p))) {
          const blob = outcome.merged.get(path) as string;
          const full = join(this._rootPath, ...path.split('/'));
          await mkdir(dirname(full), { recursive: true });
          await FsAgent._atomicWriteFile(full, await this._adapter.getFileContent(blob));
          const st = await stat(full);
          this._scanner.noteWrite(path, blob, st.size, st.mtime.getTime());
        }
      },
      theirCarried,
    );
    if (applied === 'moved') {
      this._receiveAgain(theirs);
      return 'refused';
    }

    const { tree: merged, carried } = graftTree(
      await this._scanner.scanFresh(),
      await this._mergeCarried(outcome.merged, theirContent, theirCarried),
    );
    const mergedContent = this._getFileContentMap(merged);
    const treeRef = await this._storeTree(merged);
    const touched = [...new Set([...mergedContent.keys(), ...ours.keys(), ...theirContent.keys()])];
    const previous = [own, theirs].sort();
    const entry = await chain.append({
      treeRef,
      previous,
      changed: touched.filter((p) => mergedContent.has(p) && (mergedContent.get(p) !== ours.get(p) || mergedContent.get(p) !== theirContent.get(p))).sort(),
      removed: touched.filter((p) => !mergedContent.has(p)).sort(),
      timeId: `0:${(hip({ previous, treeRef, _hash: '' }) as { _hash: string })._hash}`,
    });
    this._setOwn(entry.head, mergedContent, carried);
    for (const conflict of outcome.conflicts) {
      this._signal({
        kind: conflict.kind,
        paths: [conflict.path],
        action: conflict.kind === 'collision/type' ? 'required' : 'review',
        // Only two versions of one file are ordered by the hub's stamps. A
        // collision keeps both by rule, and a deletion against an edit keeps
        // the edit by rule — neither asked a stamp anything.
        decidedBy:
          conflict.kind === 'conflict/arbitrary' && conflict.copyPath
            ? 'stamp'
            : 'chain',
        head: entry.head,
        ...(conflict.copyPath ? { copyPath: conflict.copyPath } : {}),
        detail: conflict.copyPath
          ? `two machines changed "${conflict.path}" at once; both versions were kept and the other one is at "${conflict.copyPath}"`
          : `"${conflict.path}" was deleted on one machine and edited on another; the edit was kept`,
      });
    }
    this._announceOwn();
    return 'merged';
  }

  /**
   * What a merge's result holds at the paths this node does not see: the node
   * of whichever side's version it kept there — and, for a copy a conflict
   * made at such a path, a node for the version the copy keeps, which the
   * merge wrote like any other copy.
   * @param merged - The merge's result, `path → blob`.
   * @param theirs - The forked head's content.
   * @param theirCarried - Its nodes at the paths this node does not see.
   * @returns The nodes to carry, by path.
   */
  private async _mergeCarried(
    merged: ReadonlyMap<string, string>,
    theirs: ReadonlyMap<string, string>,
    theirCarried: ReadonlyMap<string, Tree>,
  ): Promise<Map<string, Tree>> {
    const ours = this._ownContent;
    const carried = new Map<string, Tree>();
    for (const [path, value] of merged) {
      const yours = theirCarried.get(path);
      const mine = this._carried.get(path);
      if (yours && value === theirs.get(path)) {
        carried.set(path, yours);
      } else if (mine && value === ours.get(path)) {
        carried.set(path, mine);
      } else if (
        !ours.has(path) &&
        !theirs.has(path) &&
        this._scanner.excludes(path, false)
      ) {
        const st = await stat(join(this._rootPath, ...path.split('/'))).catch(
          () => undefined,
        );
        if (st?.isFile()) carried.set(path, fileNode(path, value, st.size));
      }
    }
    return carried;
  }

  /**
   * Hears the network: announcements, the stamps of this node's own, and the
   * hub's state beacon.
   * @param db - The route's database.
   * @param connector - The transport.
   * @param treeKey - The trees table key.
   * @returns Stops listening.
   */
  async syncFromDb(
    db: Db,
    connector: Connector,
    treeKey: string,
  ): Promise<() => void> {
    this._route = { db, connector, treeKey };
    await this._ensureChain(db, treeKey);
    await this._ensureWatching();
    connector.resetReceived?.();

    const generation = ++this._receivers;
    // A connector keeps its callbacks past `tearDown`, so a stopped receive
    // side went on applying every head it heard — beside the one started
    // after it, on the same folder, with whatever options it had.
    let listening = true;
    connector.listen(async (ref, _predecessors, info) => {
      if (listening) this._hear(ref, info?.stamp);
    });
    const offStamp = connector.onStamp((ref, stamp) =>
      this._recordStamp(ref, stamp),
    );
    const beacon = (payload: ConnectorPayload) =>
      this._hear(payload?.r, payload?.stamp, true);
    const events = [connector.events.bootstrap, stateBeaconEvent(connector.route.flat)];
    for (const event of events) connector.socket.on(event, beacon);

    return () => {
      listening = false;
      offStamp();
      for (const event of events) connector.socket.off(event, beacon);
      connector.tearDown();
      // A stopped receive side reports nothing: a status left behind keeps
      // describing a divergence nobody watches. Unless a newer one replaced it.
      if (generation === this._receivers) {
        this._hubStatus = null;
        this._hubHead = undefined;
      }
    };
  }

  /**
   * Says, once, that a deletion was refused — in the log and as one
   * `deletion/refused` signal.
   *
   * Three call sites had three copies of this, which is how they came to say
   * three different things about the same decision. A client reading one of
   * them saw a third of the picture.
   * @param route - Which rule refused it.
   * @param wouldRemove - How many paths it would have deleted.
   * @param held - How many this folder holds.
   * @param paths - The paths, of which the first few are kept.
   * @param detail - Extra wording for the log line, where a route has some.
   */
  private _refuseDeletion(
    route: 'restore' | 'removals' | 'author',
    wouldRemove: number,
    held: number,
    paths: readonly string[],
    detail = '',
  ): void {
    // What was withheld differs by side, and the signal is what a person acts
    // on: a receiver did not delete, a sender did not record what it cannot
    // vouch for. So the explanation goes into the signal, not only the log.
    const what =
      route === 'author'
        ? `${wouldRemove} of ${held} files disappeared and were not ` +
          `recorded, so no node deletes them.`
        : `${route} would have removed ${wouldRemove} of ${held} files, so ` +
          `nothing was deleted.`;
    const said =
      what +
      (detail === '' ? '' : ` ${detail}`) +
      ' If the deletion is real it has to be applied deliberately.';
    console.error(
      `${this._tag} MASS DELETE REFUSED on ${this._rootPath}: ${said}`,
    );
    this._signal({
      kind: 'deletion/refused',
      paths,
      action: 'required',
      decidedBy: 'guard',
      detail: said,
    });
  }

  /**
   * Creates a fully configured FsAgent from a Client instance.
   * This factory method provides a simplified API where sync methods don't
   * require db, connector, and treeKey parameters - they are stored internally.
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
    // end to end. So it defaults to that configuration rather than to the
    // primitive one, and a caller's own values still win — the spread is after.
    //
    // What the weak alternative costs: without `includeClientIdentity` the
    // hub cannot tell a node announcing its head again from an echo, and
    // holds the re-announcement back — the one a node makes to learn its
    // stamp, or to answer a peer that is behind it. Without `causalOrdering`
    // the hub keeps no ref log to fill a gap from.
    //
    // Both are no-ops for the host application, which passes all three
    // explicitly (in its sync configuration, at every call site). They
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
    const agent = new FsAgent(filePath, client.bs, options);

    // Add simplified sync methods
    const enhancedAgent = agent as any;

    enhancedAgent.syncToDbSimple = async () =>
      agent.syncToDb(db, connector, treeKey);

    enhancedAgent.syncFromDbSimple = async () =>
      agent.syncFromDb(db, connector, treeKey);

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
