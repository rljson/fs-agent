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
  stat,
  unlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { dirname, join } from 'path';

import { FsBlobAdapter } from './fs-blob-adapter.ts';
import {
  ConflictResolverDeps,
  FsConflictResolver,
} from './fs-conflict-resolver.ts';
import { FsDbAdapter, StoreFsTreeOptions } from './fs-db-adapter.ts';
import { FsScanner, FsTree } from './fs-scanner.ts';

import type { Connector, Db } from '@rljson/db';
import type { InsertHistoryRow } from '@rljson/rljson';
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
   * Persist a path→(mtime, size, blobId) scan cache at this file path so a RESTART
   * does not re-read + re-hash the whole folder (a cold scan of an 80 GB catalog
   * is ~48 min). Forwarded to the {@link FsScanner}. Requires a PERSISTENT blob
   * store (e.g. `@rljson/bs-fs`). See {@link FsScanOptions.scanCachePath}.
   */
  scanCachePath?: string;
  /** Database instance for automatic syncing */
  db?: Db;
  /** Tree key for database storage */
  treeKey?: string;
  /** Storage options for database operations */
  storageOptions?: StoreFsTreeOptions;
  /** Enable bidirectional sync (both fs→db and db→fs) */
  bidirectional?: boolean;
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
}

/** Restore options */
export interface RestoreOptions {
  /** Remove files/dirs on target that are not present in the tree */
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
 * Filename prefix for the staging files used by atomic writes. The scanner
 * ignores anything starting with this so the transient temp + rename never
 * pollutes the tree or churns the watcher.
 */
export const ATOMIC_TMP_PREFIX = '.fsagent-tmp-';

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

export class FsAgent {
  private _scanner: FsScanner;
  private _adapter: FsBlobAdapter;
  private _rootPath: string;
  private _bs: Bs;
  private _db?: Db;
  private _treeKey?: string;
  private _stopSync?: () => void;
  private _stopSyncFromDb?: () => void;
  private _lastSentRef?: string;

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

  /** Paths the current {@link restore} could not write because they were held open. */
  private _restoreLocked: string[] = [];

  /**
   * What this agent last wrote to each absolute path, so a repeat restore can
   * recognise its own work without re-reading the file.
   */
  private _restoredBlobs = new Map<
    string,
    { blobId: string; size: number; mtime: number }
  >();
  private _timeouts: Required<TimeoutConfig>;
  /** Client-only: resolve DAG-branch conflicts into merge revisions. */
  private _resolveConflicts: boolean;
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
    this._db = options.db;
    this._treeKey = options.treeKey;
    this._timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this._resolveConflicts = options.resolveConflicts ?? false;
    this._scanner = new FsScanner(rootPath, {
      ...options,
      ignore: [
        ...(options.ignore || []),
        SYNC_ERROR_FILE,
        ATOMIC_TMP_PREFIX,
        AGENT_STATE_FILE,
      ],
      bs: this._bs,
    });
    this._adapter = new FsBlobAdapter(this._bs);

    // Automatically start syncing if db and treeKey are provided
    /* v8 ignore next -- @preserve */
    if (this._db && this._treeKey) {
      this._startAutoSync().catch(() => {
        // Intentionally ignored - deprecated constructor pattern
      });

      // Start reverse sync if bidirectional is enabled
      this._startAutoSyncFromDb(options.bidirectional || false).catch(() => {
        // Intentionally ignored - deprecated constructor pattern
      });
    }
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
    try {
      writeFileSync(
        join(this._rootPath, AGENT_STATE_FILE),
        JSON.stringify({ currentRef: ref }),
        'utf-8',
      );
    } catch {
      /* v8 ignore next -- @preserve best-effort; see the doc comment */
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
   * Atomically writes a file: stages the content in a sibling `.<rand>.tmp`,
   * then renames over the target. The rename is atomic, so a crash mid-write
   * leaves only the temp behind — never a half-written target file. (We do not
   * `fsync` the temp: it adds significant per-file latency under bursty
   * restores, and durability-on-power-loss is secondary here since the content
   * is replicated and re-synced.) The random suffix keeps concurrent restores
   * of the same path from trampling each other.
   * @param filePath - Destination path
   * @param content - Bytes to write
   */
  private static async _atomicWriteFile(
    filePath: string,
    content: Buffer | string,
  ): Promise<void> {
    // Windows-only. On Windows the temp+rename is atomic AND
    // ReadDirectoryChangesW keeps watching the path across the rename. On
    // Linux/macOS a rename replaces the file's inode, which fs.watch can lose —
    // dropping subsequent change events for that file — so write in place there
    // (still safe enough: content is replicated and re-synced on any crash).
    /* v8 ignore next -- @preserve win32 branch not exercised on Linux/macOS CI */
    if (process.platform !== 'win32') {
      await writeFile(filePath, content);
      return;
    }
    /* v8 ignore start -- @preserve Windows-only atomic path; CI runs on Linux */
    const rnd = `${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1e9,
    ).toString(36)}`;
    // Temp lives in the same directory (so the rename is atomic on one
    // filesystem) but uses the ATOMIC_TMP_PREFIX, which the scanner ignores —
    // otherwise the native watcher (esp. Linux inotify) would catch the
    // transient temp/rename and churn the sync state.
    const tmp = join(dirname(filePath), `${ATOMIC_TMP_PREFIX}${rnd}`);
    try {
      await writeFile(tmp, content);
      await rename(tmp, filePath);
    } catch (err) {
      /* v8 ignore start -- @preserve temp cleanup on a failed write */
      try {
        await unlink(tmp);
      } catch {
        // temp may not exist
      }
      throw err;
    }
    /* v8 ignore stop -- @preserve */
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
    connector.invalidateSent?.(ref);

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
    // Retry on a transient socket-layer failure (e.g. a dropped packet or a
    // reconnect blip) so a single hiccup doesn't lose an entire ref.
    await FsAgent._withRetry(
      async () => {
        if (connector.syncConfig?.requireAck) {
          await connector.sendWithAck(ref);
        } else {
          connector.send(ref);
        }
      },
      3,
      100,
      `sendRef(${ref.slice(0, 12)}…)`,
    );
  }

  /**
   * Starts automatic syncing to database
   * Note: Auto-sync requires Connector which is not available in constructor.
   * Consider using syncToDb() directly instead of constructor options.
   */
  private async _startAutoSync(): Promise<void> {
    /* v8 ignore next -- @preserve */
    if (!this._db || !this._treeKey) {
      return;
    }

    // Cannot create Connector without socket - auto-sync not supported
    /* v8 ignore next -- @preserve */
    throw new Error(
      'Auto-sync from constructor is not supported. ' +
        'Use syncToDb() method directly with a Connector instance.',
    );
  }

  /**
   * Starts automatic syncing from database
   * @param bidirectional - Whether bidirectional sync is enabled
   * Note: Auto-sync requires Connector which is not available in constructor.
   * Consider using syncFromDb() directly instead of constructor options.
   */
  private async _startAutoSyncFromDb(bidirectional: boolean): Promise<void> {
    /* v8 ignore if -- @preserve */
    if (!this._db || !this._treeKey || !bidirectional) {
      return;
    }

    // Cannot create Connector without socket - auto-sync not supported
    /* v8 ignore next -- @preserve */
    throw new Error(
      'Auto-sync from constructor is not supported. ' +
        'Use syncFromDb() method directly with a Connector instance.',
    );
  }

  /**
   * Stops automatic syncing and cleans up resources
   */
  dispose(): void {
    /* v8 ignore if -- @preserve */
    if (this._stopSync) {
      this._stopSync();
      this._stopSync = undefined;
    }
    /* v8 ignore if -- @preserve */
    if (this._stopSyncFromDb) {
      this._stopSyncFromDb();
      this._stopSyncFromDb = undefined;
    }
  }

  /**
   * Extracts filesystem into tree structure with file content in blobs
   * File content is stored in Bs, tree structure returned with blobIds embedded
   * @returns Tree structure with blobIds in file metadata
   */
  async extract(): Promise<FsTree> {
    // Scan filesystem - stores file content in Bs, returns tree structure
    const tree = await this._scanner.scan();

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
    this._restoreLocked = [];
    await this._restoreTree(
      tree.rootHash,
      tree.trees,
      target,
      target === this._rootPath,
    );
    if (this._restoreSkipped > 0) {
      console.log(
        `[FsAgent] restore: wrote ${this._restoreWritten}, left ` +
          `${this._restoreSkipped} already-correct file` +
          `${this._restoreSkipped === 1 ? '' : 's'} untouched`,
      );
    }

    if (options?.cleanTarget) {
      // How much of this folder would the prune take with it?
      //
      // Only files that were here BEFORE the restore can be pruned, so that
      // is the population to judge against — a file written during the
      // restore is a fresh user write and is protected separately.
      let wouldPrune = 0;
      for (const existing of preRestore) {
        if (!expectedFiles.has(existing)) wouldPrune++;
      }
      if (
        wouldPrune > MASS_DELETE_MIN_FILES &&
        (expectedFiles.size === 0 ||
          wouldPrune / preRestore.size > MASS_DELETE_MAX_RATIO)
      ) {
        // Loud, because the alternative to noticing this is discovering it
        // from a user whose folder emptied.
        console.error(
          `[FsAgent] MASS DELETE REFUSED on ${target}: the incoming tree ` +
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
      );
    }

    // Everything writable is now written, and pruning has run. Only now report
    // the locked files — raising earlier would have abandoned the rest of the
    // restore, which is the behaviour this replaces.
    if (this._restoreLocked.length > 0) {
      throw new PartialRestoreError([...this._restoreLocked]);
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
      const filePath = join(targetPath, meta.relativePath);

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

        // Try to fetch the blob
        let fileBlob;
        try {
          fileBlob = await this._bs.getBlob(meta.blobId);
        } catch (error) {
          throw new Error(
            `Failed to retrieve blob for file "${meta.relativePath}" (blobId: ${meta.blobId}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!fileBlob || !fileBlob.content) {
          throw new Error(
            `Missing blob content for file "${meta.relativePath}" (blobId: ${meta.blobId}). ` +
              `The blob may have been deleted or not synced properly.`,
          );
        }

        // Create parent directories
        await mkdir(dirname(filePath), { recursive: true });

        try {
          // Write file atomically (temp + fsync + rename) so a crash
          // mid-restore never leaves a half-written, corrupt file on disk.
          await FsAgent._atomicWriteFile(filePath, fileBlob.content);
          this._restoreWritten++;

          // Preserve mtime
          /* v8 ignore else -- @preserve */
          if (meta.mtime) {
            const mtime = new Date(meta.mtime);
            await utimes(filePath, mtime, mtime);
          }

          // Remember what was put there, so a repeat restore recognises its
          // own work without re-reading the file.
          /* v8 ignore else -- @preserve */
          if (meta.size !== undefined && meta.mtime !== undefined) {
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
              mtime: meta.mtime,
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
          if (!FsAgent._isLocked(error)) throw error;
          console.warn(
            `[FsAgent] restore: "${meta.relativePath}" is held open by another ` +
              `process (${(error as NodeJS.ErrnoException).code}) — skipped, ` +
              `will retry`,
          );
          this._restoreLocked.push(meta.relativePath);
        }
      }
    } else if (meta.type === 'directory') {
      // For directories, create directory and recursively restore children
      const dirPath =
        meta.relativePath === '.'
          ? targetPath
          : join(targetPath, meta.relativePath);

      await mkdir(dirPath, { recursive: true });

      // Recursively restore children
      /* v8 ignore else -- @preserve */
      if (treeNode.children && Array.isArray(treeNode.children)) {
        for (const childHash of treeNode.children) {
          await this._restoreTree(childHash, trees, targetPath, isOwnRoot);
        }
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
    const scanned = this._scanner.getTreeByPath(relativePath)?.meta as
      | FsNodeMeta
      | undefined;
    if (
      scanned?.blobId === undefined ||
      scanned.size === undefined ||
      scanned.mtime === undefined
    ) {
      return undefined;
    }
    return {
      blobId: scanned.blobId,
      size: scanned.size,
      mtime: scanned.mtime,
    };
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
                `[FsAgent] _fetchTreeRecursively: db.get failed for ` +
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
    await this.restore(fsTree, targetPath, options);
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
   */
  private async _pruneExtraneous(
    currentDir: string,
    expectedDirs: Set<string>,
    expectedFiles: Set<string>,
    preRestore: Set<string>,
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
        await rm(fullPath, { force: true });
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
          `[FsAgent] resuming from recorded ref ${persisted.slice(0, 8)}… — ` +
            `this folder can declare its ancestry`,
        );
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

    const initialRef = await FsAgent._withTimeout(
      new FsDbAdapter(db, treeKey).storeFsTree(initialTree, {
        ...options,
        previous: initialPrevious,
        skipNotification: isSilentJoiner ? true : options?.skipNotification,
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
    if (isSilentJoiner) {
      console.warn(
        `[FsAgent] ${this._rootPath} is empty and has no remembered state — ` +
          `joining quietly rather than announcing emptiness.`,
      );
      this._currentRef = initialRef;
      this._persistCurrentRef(initialRef);
      this._lastSentContentKey = this._contentKeyFromTree(initialTree);
    }

    // Send initial ref through connector (self-filtering will prevent loops)
    /* v8 ignore next -- @preserve */
    if (initialRef && !isSilentJoiner) {
      this._lastSentRef = initialRef;
      this._currentRef = initialRef;
      this._persistCurrentRef(initialRef);
      this._lastSentContentKey = this._contentKeyFromTree(initialTree);
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
            const parentRef = this._currentRef;
            const previous = await this._ancestryPrevious(
              db,
              treeKey,
              parentRef ? [parentRef] : undefined,
            );
            const ref = await FsAgent._withRetry(
              () =>
                FsAgent._withTimeout(
                  dbAdapter.storeFsTree(tree, { ...options, previous }),
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

            // Track the ref and content we're sending
            this._lastSentRef = ref;
            this._lastSentContentKey = contentKey;

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
            if (ref) {
              await this._sendRef(
                connector,
                ref,
                parentRef ? [parentRef] : undefined,
              );
            }
          } catch (err) {
            /* v8 ignore start -- @preserve */
            // Don't re-throw — one sync failure must not crash the watcher
            console.error('[FsAgent] syncToDb failed:', err);
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
      // UNION, not overwrite. A content ref can be stored more than once — most
      // commonly by the agent itself, which re-stores its own post-restore tree
      // and lands on the identical ref because the restore preserved the
      // mtimes. That second row carries different predecessors, and overwriting
      // with it severed the chain: the ref was still in the DAG, but no longer
      // reachable from its own descendants, so an ancestor stopped looking like
      // one. Every revision that produced this ref contributes its history.
      const existing = prevRefsOf.get(r[refKey]);
      prevRefsOf.set(r[refKey], existing ? [...existing, ...prev] : prev);
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
    await resolver.resolve({
      table: treeKey,
      type: 'dagBranch',
      detectedAt: Date.now(),
      branches: [...headTimeIds, ...incomingTimeIds],
    });
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
   * Re-announce this folder's current state after refusing an incoming tree.
   *
   * A refusal means the sender holds less than this node does, so it is the one
   * that needs telling. Without this the network settles into a state that is
   * stable and wrong: the sparse node cannot push, the full node has nothing
   * new to push, and nothing moves until an unrelated edit happens somewhere.
   *
   * Rate-limited because two nodes can refuse each other — each holding files
   * the other lacks — and an unthrottled answer to every refusal is a loop.
   * @param connector - Connector to broadcast on.
   */
  private async _readvertiseAfterRefusal(connector: Connector): Promise<void> {
    const ref = this._currentRef;
    if (!ref) return;

    const now = Date.now();
    if (now - this._lastRefusalAnswerMs < REFUSAL_ANSWER_COOLDOWN_MS) return;
    this._lastRefusalAnswerMs = now;

    console.warn(
      `[FsAgent] refused an incoming tree — re-announcing ${ref.slice(0, 8)}… ` +
        `so the sender can catch up.`,
    );
    try {
      await this._sendRef(connector, ref);
    } catch (err) {
      /* v8 ignore next -- @preserve a failed answer must not mask the refusal */
      console.warn(`[FsAgent] re-announcement failed: ${String(err)}`);
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
      fetchTree: (rootRef) => this._fetchTreeFromDb(db, treeKey, rootRef),
      getBlobContent: (blobId) => this._adapter.getFileContent(blobId),
      restoreTree: (tree) =>
        this.restore(tree, undefined, { cleanTarget: true }),
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
        this._lastSentContentKey = this._contentKeyFromTree(tree);
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
            `[FsAgent] ref=${treeRef.slice(0, 8)}… ${VERDICT_REASON[verdict]} ` +
              `— ignoring it.`,
          );
          if (verdict === 'stale') {
            // Hand it back to the connector's dedup. It was marked received on
            // arrival and never applied, so leaving it marked would block a
            // later, genuine return to this exact state — refs are content
            // hashes, and that trap has been paid for once already.
            connector.invalidateReceived(treeRef);
          }
          return;
        }

        this._scanner.pauseWatch();
        this._remoteApplyInFlight = true;

        try {
          // Fetch incoming tree from DB (without restoring yet)
          const incomingTree = await FsAgent._withTimeout(
            this._fetchTreeFromDb(db, treeKey, treeRef),
            this._timeouts.fetchTree,
            `syncFromDb → fetchTree(${treeKey}@${treeRef.slice(0, 8)}…)`,
          );

          // Log fetch result for diagnostics
          const incomingNodeCount = incomingTree.trees.size;
          console.log(
            `[FsAgent] syncFromDb: fetched tree with ${incomingNodeCount} nodes ` +
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
              `[FsAgent] syncFromDb: equivalent content, skipping restore ` +
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
            return;
          }

          // Client-only conflict handling: classify the incoming revision
          // against our head via the shared-ref DAG. `ahead` (an older ancestor,
          // e.g. a reconnect bootstrap) is ignored; `diverged` (concurrent
          // edits) is resolved inline — a 3-way merge into a merge revision D —
          // *before* the destructive restore could clobber local changes, all
          // while the watcher is paused; `behind` falls through to fast-forward.
          // Not gated on the incoming ref declaring ancestry, because the
          // question "is this an ancestor of what I hold" is answered by walking
          // MY history, not the sender's. Requiring predecessors here disabled
          // the check for exactly the refs that need it most: a straggler
          // re-advertised by a peer that restored from it carries whatever
          // ancestry that ORIGINAL push had, which for an early tree in a burst
          // is often none at all.
          if (this._currentRef) {
            const relation = await this._ancestryRelation(
              db,
              treeKey,
              this._currentRef,
              treeRef,
              predecessorRefs ?? [],
            );
            if (relation === 'ahead') {
              // AN ANCESTOR IS NOT NEWS, and this runs whether or not conflict
              // resolution is switched on.
              //
              // It used to be gated with the merge below, which meant the
              // default deployment had no protection against its own past. Refs
              // do not arrive in the order they were sent, and on a large
              // folder there are many of them: measured on four machines,
              // seeding 1 200 files produced trees of 989, then 1 099, then
              // 911 nodes IN THAT ARRIVAL ORDER. The 911 was ten seconds stale
              // by the time it landed, and every node applied it — pruning
              // seventy-seven files each, well under the mass-delete guard's
              // floor — and then re-advertised that older state as its own,
              // because a rescan of a restored folder reproduces the ref it
              // restored from. Three of four nodes converged on a tree with
              // thirty-five files missing, INCLUDING THE NODE THAT CREATED
              // THEM.
              //
              // The guard cannot catch this: it refuses catastrophes, and each
              // individual step here is small. Only causality can, and the
              // sender now always declares it.
              console.warn(
                `[FsAgent] ref=${treeRef.slice(0, 8)}… is an ancestor of the ` +
                  `state this agent already holds — ignoring.`,
              );
              return;
            }
            /* v8 ignore else -- @preserve 'behind' falls through to restore */
            // The merge keeps BOTH of its original preconditions: conflict
            // resolution switched on, and a sender that declared what it
            // descends from. Only the ancestor check above was widened.
            if (
              relation === 'diverged' &&
              this._resolveConflicts &&
              predecessorRefs !== undefined &&
              predecessorRefs.length > 0
            ) {
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

          // Content differs — restore from incoming tree.
          //
          // A ref that declares NO ancestry may ADD but must never PRUNE.
          //
          // Deletion is the destructive half of a restore, and a sender that
          // cannot say what it descends from has not shown it knows the
          // current state. A node that reconnects is exactly that: a fresh
          // process with no `_currentRef`, whose first push therefore carries
          // no predecessors — and until this, every peer applied that stale
          // tree as authoritative and pruned the files created while it was
          // away. Measured on four machines: a file reached all three
          // connected nodes and was deleted from all three, two seconds later,
          // by the fourth coming back.
          //
          // The ancestry guard above cannot catch it, because it is itself
          // conditional on predecessors being present. So the rule lives here
          // instead, and it costs nothing legitimate: a genuine first push has
          // nothing to delete anyway.
          // Gated on `_resolveConflicts`, and that gate is load-bearing: with
          // it off, the rule would read a legitimate deletion as untrustworthy
          // and silently stop deletions propagating — which it did, across
          // eight tests, before the gate was added.
          //
          // ANCESTRY IS NOW ALWAYS TRANSMITTED (see `_sendRef`), which is the
          // groundwork for replacing this gate. It is not replaced yet, and the
          // measurement says why. Flipping it to `true` broke twenty tests:
          // every deployment without `causalOrdering` carries no ancestry, so
          // every deletion looked untrustworthy. Narrowing it to "expect
          // ancestry where the transport actually carries it"
          // (`connector.syncConfig?.causalOrdering === true`) left two, and
          // those two are the real question rather than a fixture problem: a
          // sender only declares ancestry once it HAS a current ref, so a
          // genuinely fresh client's first push never does — and under the new
          // rule its deletions would never prune.
          //
          // For a real client that is arguably right: a restarted one reloads
          // its ref from `.fsagent-state.json` and does declare ancestry, so
          // only a brand-new folder is treated as first contact, which is
          // exactly the wanted behaviour. But it changes what "delete"
          // means on a connection, and this class of change has been reverted
          // four times for being shipped on reasoning. It needs its own
          // rollout and a lab measurement, not a flag flip at the end of
          // another one. See section 11 of doc/large-folder-plan.md.
          const ancestryExpected = this._resolveConflicts;
          const declaresAncestry = (predecessorRefs?.length ?? 0) > 0;

          // Second reason to withhold pruning, and the one that needs no
          // ancestry at all: the sender has already said something later than
          // this.
          //
          // A ref is a content hash — it says WHAT state a sender is in, never
          // whether that is news, and the same state can legitimately recur.
          // The per-sender sequence says whether it is news, and the connector
          // now reports its conclusion. A re-advertisement, or a straggler
          // arriving late, must not be allowed to delete.
          //
          // This is what a node returning from a disconnect emits: the state
          // it held before it left. Applying its FILES is harmless — they are
          // real, just old. Applying its ABSENCES is the data loss, because
          // everything created while it was away is absent from it.
          //
          // Guards the destructive half only, deliberately. Every attempt to
          // fix this class by changing what gets APPLIED has made things
          // worse; the one that has held guards what may be DELETED.
          // Staleness is handled above by ignoring the advertisement
          // outright, so what is left here is the ancestry case: a sender
          // that cannot say what it descends from may add, but not delete.
          const applyOptions =
            restoreOptions?.cleanTarget && ancestryExpected && !declaresAncestry
              ? { ...restoreOptions, cleanTarget: false }
              : restoreOptions;
          if (applyOptions !== restoreOptions) {
            console.warn(
              `[FsAgent] ref=${treeRef.slice(0, 8)}… declares no ancestry — ` +
                `applying additively, not pruning.`,
            );
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
          const postRestoreTree = await this._scanner.scan();
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
          this._lastSentRef = postRestoreRef;
          this._lastSentContentKey = this._contentKeyFromTree(postRestoreTree);
          this._currentRef = postRestoreRef;
          this._persistCurrentRef(postRestoreRef);
          return; // Success — exit retry loop
        } catch (err) {
          if (err instanceof MassDeleteRefusedError) {
            // A refusal is TERMINAL for this ref, and the opposite of the
            // locked-file case below in both respects.
            //
            // No retry: the same tree will be refused for the same reason, so
            // retrying only burns the recovery budget and repeats the error.
            //
            // And no advertisement suppression — this is the correction the
            // lab forced. Suppressing here looked consistent and was wrong:
            // the peer that sent the sparse tree is the one MISSING data, and
            // this node holds the fuller copy. Going quiet leaves it stranded
            // with nothing to catch up from, and with every node that has the
            // files refusing its pushes, the network livelocks — measured on
            // four nodes, where two sat at 5 and 15 of 121 files and could not
            // recover.
            //
            // So this node keeps its state and keeps talking about it. The
            // ref is still not adopted, because it was not applied.
            //
            // "Keeps talking about it" was aspirational. Nothing here made it
            // talk: the refusal only stopped SUPPRESSING this node's
            // advertisements, and with its own content unchanged it had nothing
            // new to say, so it said nothing at all. The sender — the node that
            // is missing data — heard silence.
            //
            // Measured on two clients: an empty joiner sat at 0 of 3642 files
            // for 60 s, unaffected by a 15 s settle, and a single write on the
            // populated side moved all 414 MB in about six seconds. On four
            // nodes the same shape shows as `mass-delete-guard` reporting
            // "did NOT refill on its own — it needs a change elsewhere".
            //
            // That change elsewhere is what this now supplies. A refusal is a
            // fact about the SENDER: it holds less than we do. Answering it
            // with our current state is the whole correction.
            // Retire the refused ref, or the SECOND time this happens is
            // silent. A tree ref is a content hash, so a folder that is emptied
            // twice re-derives the same ref both times — and the first
            // advertisement left it marked "already received" here. The second
            // is dropped by the connector before the agent sees it, so nothing
            // refuses, nothing answers, and the peer stays empty for good.
            //
            // Measured: a client that had already joined and was then emptied
            // sat at 1 of 3642 files with no refusal logged at all, while a
            // FRESH client — whose empty ref this node had never seen — was
            // refused, answered, and converged in eleven seconds.
            //
            // Same shape as the delete fix in 0.0.31: refusing a state is not
            // the same as having consumed it.
            connector.invalidateReceived(treeRef);
            await this._readvertiseAfterRefusal(connector);
            return;
          }
          if (err instanceof PartialRestoreError) {
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
                `[FsAgent] syncFromDb processRef failed after ${maxAttempts} ` +
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
                  `[FsAgent] syncFromDb: ref=${treeRef.slice(0, 8)}… not yet ` +
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
              `[FsAgent] syncFromDb: attempt ${attempt}/${maxAttempts} failed ` +
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
          await processRef(r, ra, pr, newest);
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
      // A freshly-arrived ref resets the recovery budget to 0.
      scheduleProcess(
        treeRef,
        this._timeouts.debounceMs,
        0,
        predecessorRefs,
        info?.isNewestFromSender ?? true,
      );
      return Promise.resolve();
    };

    // Register callback with Connector using the safe, deduplicated API.
    // Client-only conflict resolution happens inline in processRef (see
    // `_resolveConflictInline`), so it runs with the watcher paused and cannot
    // race the sync loop; hubs leave `resolveConflicts` off and stay dumb relays.
    connector.listen(syncCallback);

    // Return cleanup function
    return () => {
      if (fromDbTimer) clearTimeout(fromDbTimer);
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

    // Create Connector with centralized SyncConfig and ClientIdentity
    const connector = new Connector(
      db,
      route,
      socket,
      options?.syncConfig,
      options?.clientIdentity,
    );

    // Create FsAgent with client's blob storage
    const agent = new FsAgent(filePath, client.bs, options);

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
