// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { hip } from '@rljson/hash';
import { Json } from '@rljson/json';
import { Tree, TreeRef } from '@rljson/rljson';

import { FSWatcher, watch } from 'fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * How often the safety rescan runs.
 *
 * It is the only thing that notices a write while the watcher is deaf — a
 * dropped native event, or a pause that was never resumed — so the interval is
 * the worst-case latency for those writes, not a background-maintenance knob.
 * Thirty seconds made a stuck node look broken rather than slow.
 *
 * Five seconds was blocked for months because shortening it made a
 * three-client delete test fail consistently, which read as "the rescan lands
 * inside a delete round trip and undoes the deletion". It does not: tracing
 * every sync trigger showed no push comes from the rescan at all. The interval
 * only shifted which bootstrap refs landed in a window where they were marked
 * received and never delivered, and that is fixed at its source. See
 * `doc/safety-rescan.md`.
 *
 * Overridable per deployment so a large or deep tree can back it off (the scan
 * is O(N), though {@link FsScanOptions.scanCachePath} makes a warm one cheap)
 * without a code change.
 */
/* v8 ignore start -- @preserve env-overridable interval */
const _envRescan = Number(process.env['RLJSON_FS_RESCAN_MS']);
export const SAFETY_RESCAN_INTERVAL_MS =
  Number.isFinite(_envRescan) && _envRescan > 0 ? _envRescan : 5_000;
/* v8 ignore stop -- @preserve */

/**
 * How long a pause must last before the safety rescan treats it as stuck and
 * reports through it.
 *
 * Longer than any restore takes, so ordinary loop-suppression is untouched;
 * short enough that a pause whose resume never arrives costs seconds, not
 * every write from then on.
 */
export const STUCK_PAUSE_MS = 15_000;

// .............................................................................
// Types
// .............................................................................

/**
 * Metadata stored in Tree.meta for file system nodes
 */
export interface FsNodeMeta extends Json {
  /** Node name (file or directory name) */
  name: string;
  /** Type of node */
  type: 'file' | 'directory';
  /** Relative path from scan root (the cross-client-stable content identity) */
  relativePath: string;
  /** File size in bytes (for files) */
  size?: number;
  /** Blob ID for file content (files only) */
  blobId?: string;
  /**
   * Absolute path — informational only, NOT part of the content identity.
   * Excluded from stored meta so tree refs are folder-independent (shared
   * across clients). Retained in the type for back-compat.
   */
  path?: string;
  /**
   * Last modified timestamp — NOT part of the content identity (environment-
   * specific). Excluded from stored meta so refs are mtime-independent.
   */
  mtime?: number;
}

/**
 * Tree structure with hash mapping
 */
export interface FsTree {
  /** Root tree hash */
  rootHash: TreeRef;
  /** Map of hash to tree node */
  trees: Map<TreeRef, Tree>;
}

/**
 * Type of file system change
 */
export type FsChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'safety-rescan';

/**
 * File system change event
 */
export interface FsChange {
  /** Type of change */
  type: FsChangeType;
  /** Path that changed (relative to scan root) */
  path: string;
  /** Tree node (for added/modified) */
  tree?: Tree;
}

/**
 * Callback for file system changes
 */
export type FsChangeCallback = (change: FsChange) => void | Promise<void>;

/**
 * Options for scanning
 */
export interface FsScanOptions {
  /** Patterns to ignore (glob patterns) */
  ignore?: string[];
  /** Maximum depth to scan (undefined = unlimited) */
  maxDepth?: number;
  /** Follow symbolic links */
  followSymlinks?: boolean;
  /** Blob storage implementation (defaults to BsMem) */
  bs?: Bs;
  /**
   * Persist a path→(mtime, size, blobId) scan cache at this file path. When set,
   * a file whose mtime AND size are unchanged since the last scan is NOT re-read
   * or re-hashed — its cached `blobId` is reused. The cache is loaded once on the
   * first {@link FsScanner.scan} and re-written after every scan, so a RESTART
   * does not re-read the whole folder (a cold scan of an 80 GB catalog is ~48
   * min) and the periodic safety-rescan stays cheap. Requires a PERSISTENT blob
   * store (e.g. `@rljson/bs-fs`) — with an in-RAM store the cached blob is gone
   * after a restart. Omit to disable (default: full read+hash every scan).
   */
  scanCachePath?: string;
}

// .............................................................................
// FsScanner Class
// .............................................................................

/**
 * Scans and watches file system changes, extracting RLJSON tree structure
 */
export class FsScanner {
  private _rootPath: string;
  private _tree: FsTree | null = null;
  private _watcher: FSWatcher | null = null;
  private _changeCallbacks: FsChangeCallback[] = [];
  private _options: FsScanOptions;
  private _bs: Bs;
  private _paused: boolean = false;
  private _missedChangesDuringPause: boolean = false;
  /** Periodic full-rescan timer that catches events the native watcher drops. */
  private _safetyTimer: ReturnType<typeof setInterval> | null = null;
  /** When the current pause began, or null when not paused. */
  private _pausedAt: number | null = null;

  /** Releases a pause whose resume never arrived (see {@link pauseWatch}). */
  private _autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set by stopWatch() so a pending watcher reinstall / rescan bails out. */
  private _stopRequested: boolean = false;

  /** Path→content cache backing {@link FsScanOptions.scanCachePath} (unused when unset). */
  private _scanCachePath?: string;
  /** Last-scan cache (loaded from disk); consulted to skip re-read/re-hash. */
  private _blobCache = new Map<
    string,
    { mtime: number; size: number; blobId: string }
  >();
  /** Cache rebuilt during the CURRENT scan; becomes `_blobCache` at the end (self-pruning). */
  private _nextBlobCache = new Map<
    string,
    { mtime: number; size: number; blobId: string }
  >();
  /** Ensures the persisted cache is read from disk only once. */
  private _cacheLoaded = false;

  /** Entries that vanished mid-scan, counted per {@link scan} for one summary. */
  private _vanishedDuringScan = 0;

  /** The scan pass running right now, if any. See {@link _scanAfterNow}. */
  private _activeScan: Promise<FsTree> | null = null;

  /** The single follow-up pass everyone who arrived mid-scan is waiting on. */
  private _pendingScan: Promise<FsTree> | null = null;

  constructor(rootPath: string, options: FsScanOptions = {}) {
    this._rootPath = rootPath;
    this._options = {
      ignore: options.ignore || ['node_modules', '.git', 'dist', 'coverage'],
      maxDepth: options.maxDepth,
      followSymlinks: options.followSymlinks ?? false,
      bs: options.bs,
      scanCachePath: options.scanCachePath,
    };
    this._bs = options.bs || new BsMem();
    this._scanCachePath = options.scanCachePath;
  }

  get tree(): FsTree | null {
    return this._tree;
  }

  /** Whether a watcher is currently installed. */
  get isWatching(): boolean {
    return this._watcher !== null;
  }

  get rootPath(): string {
    return this._rootPath;
  }

  get bs(): Bs {
    return this._bs;
  }

  async scan(): Promise<FsTree> {
    // Validate root path exists
    try {
      const stats = await stat(this._rootPath);
      if (!stats.isDirectory()) {
        throw new Error(
          `Root path "${this._rootPath}" exists but is not a directory`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Root path "${this._rootPath}" does not exist. Cannot scan non-existent directory.`,
        );
      }
      /* v8 ignore start -- @preserve */
      throw new Error(
        `Cannot access root path "${this._rootPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    /* v8 ignore stop -- @preserve */

    // Load the persisted scan cache once, and start a fresh cache for this scan
    // (only files still present are re-added → the cache self-prunes deletions).
    if (this._scanCachePath) {
      await this._loadPersistedCache();
      this._nextBlobCache = new Map();
    }

    const trees = new Map<TreeRef, Tree>();
    this._vanishedDuringScan = 0;
    let rootTree;
    try {
      rootTree = await this._scanDirectory(this._rootPath, '.', 0, trees);
    } catch (error) {
      /* v8 ignore start -- @preserve */
      throw new Error(
        `Failed to scan directory "${this._rootPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    /* v8 ignore stop -- @preserve */

    // Hash root tree in place (content-addressed by JSON)
    hip(rootTree);
    const rootHashStr = rootTree._hash as string;

    /* v8 ignore if -- @preserve */
    if (!rootHashStr) {
      throw new Error(
        'Failed to generate hash for root tree. Tree structure may be invalid.',
      );
    }

    // One line per scan rather than one per entry: under real churn this is
    // routine, and a message per file would bury everything else.
    if (this._vanishedDuringScan > 0) {
      console.warn(
        `[fs-scanner] ${this._vanishedDuringScan} entr` +
          `${this._vanishedDuringScan === 1 ? 'y' : 'ies'} vanished during the ` +
          `scan of ${this._rootPath} — this scan is a partial picture`,
      );

      // A scan that skipped entries is NOT this folder's state. Tolerating a
      // vanished child keeps the walk alive, which is the point — but
      // publishing the result would trade a stalled watcher for something
      // worse: peers apply a tree as authoritative, so a file merely MISSED
      // reads as a file DELETED, on every other machine.
      //
      // Measured, not theorised: making the walk survive without this guard
      // turned a four-node concurrency recipe from green into two failures in
      // three runs, with the writer keeping its file and every peer losing it.
      //
      // So keep the last picture that WAS complete. Nothing is lost — the
      // safety rescan comes back within its interval, and the first scan that
      // completes cleanly reports the drift. The cache swap is skipped too: a
      // cache rebuilt from a partial walk would prune entries for files that
      // are still there.
      if (this._tree) {
        return this._tree;
      }
      // No previous picture — the very first scan. A partial tree beats
      // refusing to start; the same rescan settles it.
      console.warn(
        `[fs-scanner] no previous scan of ${this._rootPath} to fall back on — ` +
          `starting from the partial one`,
      );
    }

    // Add the root tree to the map
    trees.set(rootHashStr, rootTree);

    this._tree = {
      rootHash: rootHashStr,
      trees,
    };

    // Swap in the freshly-built cache and persist it (best-effort).
    if (this._scanCachePath) {
      this._blobCache = this._nextBlobCache;
      await this._persistCache();
    }

    return this._tree;
  }

  private async _scanDirectory(
    absolutePath: string,
    relativePath: string,
    depth: number,
    trees: Map<TreeRef, Tree>,
  ): Promise<Tree> {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const childTrees: Tree[] = [];
    const childRefs: TreeRef[] = [];

    for (const entry of entries) {
      if (this._shouldIgnore(entry.name)) {
        continue;
      }

      const childPath = join(absolutePath, entry.name);
      const childRelPath =
        relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`;

      if (entry.isSymbolicLink() && !this._options.followSymlinks) {
        continue;
      }

      // Check max depth before processing children
      if (
        this._options.maxDepth !== undefined &&
        depth >= this._options.maxDepth
      ) {
        continue;
      }

      // Everything from here on can fail because the entry stopped existing
      // between `readdir` naming it and this loop reaching it — the `stat`,
      // the `readFile`, or the `readdir` inside a recursive descent. One
      // vanished child used to abort the entire scan, and with it the watcher
      // that depends on it: a folder under active churn could stop syncing
      // altogether. Skip the child, keep the scan.
      try {
        const childStats = await stat(childPath);
        /* v8 ignore else -- @preserve */
        if (entry.isDirectory()) {
          // Recursively scan directory
          const childTree = await this._scanDirectory(
            childPath,
            childRelPath,
            depth + 1,
            trees,
          );
          childTrees.push(childTree);

          // Hash directory tree node in place (JSON hash, NOT stored in Bs)
          hip(childTree);
          const childHashStr = childTree._hash as string;

          // Add child tree to map
          trees.set(childHashStr, childTree);
          childRefs.push(childHashStr);
        } else if (entry.isFile()) {
          /* v8 ignore else -- @preserve */
          const mtimeMs = childStats.mtime.getTime();

          // Scan cache: if this file's mtime AND size are unchanged since the last
          // scan, reuse its cached blobId instead of re-reading + re-hashing the
          // content. (mtime+size is the rsync-style heuristic; a same-size edit
          // within the same mtime tick is not detected — acceptable in practice.)
          const cached = this._scanCachePath
            ? this._blobCache.get(childRelPath)
            : undefined;

          let blobId: string;
          if (
            cached &&
            cached.mtime === mtimeMs &&
            cached.size === childStats.size
          ) {
            blobId = cached.blobId;
          } else {
            // Store ONLY file content in blob storage (NOT tree node)
            let fileContent: Buffer;
            try {
              fileContent = await readFile(childPath);
            } catch (error) {
              // A file deleted between stat and read is the same race as one
              // deleted before the stat — rethrow it unwrapped so the per-entry
              // handler can recognise and skip it, rather than burying the code
              // in a message string and killing the whole scan.
              if (FsScanner._isVanished(error)) throw error;
              throw new Error(
                `Failed to read file "${childRelPath}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            let blobProps;
            try {
              blobProps = await this._bs.setBlob(fileContent);
            } catch (error) {
              throw new Error(
                `Failed to store blob for file "${childRelPath}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            if (!blobProps || !blobProps.blobId) {
              throw new Error(
                `Blob storage returned invalid blobId for file "${childRelPath}"`,
              );
            }
            blobId = blobProps.blobId;
          }

          if (this._scanCachePath) {
            this._nextBlobCache.set(childRelPath, {
              mtime: mtimeMs,
              size: childStats.size,
              blobId,
            });
          }

          const fileMeta: FsNodeMeta = {
            name: entry.name,
            type: 'file',
            relativePath: childRelPath,
            size: childStats.size,
            // mtime is kept for files (restore preserves it, so it round-trips to
            // the same ref on every client) but NOT for directories (a folder's
            // mtime is per-machine and does not round-trip). The absolute `path`
            // is excluded everywhere — it is folder-specific.
            mtime: mtimeMs,
            blobId, // Link to content in Bs
          };

          const fileTree: Tree = {
            id: entry.name,
            isParent: false,
            meta: fileMeta,
            children: null,
          };

          childTrees.push(fileTree);

          // Hash file tree node in place (JSON hash, NOT stored in Bs)
          hip(fileTree);
          const fileTreeHashStr = fileTree._hash as string;

          // Add file tree to map
          trees.set(fileTreeHashStr, fileTree);
          childRefs.push(fileTreeHashStr);
        }
      } catch (error) {
        if (!FsScanner._isVanished(error)) throw error;
        this._vanishedDuringScan++;
        continue;
      }
    }

    // Create directory tree node. The root's name is normalised to '.' (the
    // mount-point folder name is environment-specific and would otherwise make
    // the root hash folder-dependent, breaking shared cross-client refs).
    const dirName =
      relativePath === '.'
        ? '.'
        : /* v8 ignore next -- @preserve */
          relativePath.split('/').pop() || '';

    const dirMeta: FsNodeMeta = {
      name: dirName,
      type: 'directory',
      relativePath,
    };

    const dirTree: Tree = {
      id: dirName,
      isParent: childRefs.length > 0,
      meta: dirMeta,
      children: childRefs.length > 0 ? childRefs : null,
    };

    return dirTree;
  }

  /**
   * Load the persisted scan cache from {@link FsScanOptions.scanCachePath} once.
   * A missing or corrupt cache file is tolerated (the scan just starts cold).
   */
  private async _loadPersistedCache(): Promise<void> {
    if (this._cacheLoaded) return;
    this._cacheLoaded = true;
    /* v8 ignore next -- @preserve: only called when scanCachePath is set */
    if (!this._scanCachePath) return;
    try {
      const raw = await readFile(this._scanCachePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        entries?: [string, { mtime: number; size: number; blobId: string }][];
      };
      if (Array.isArray(parsed.entries)) {
        this._blobCache = new Map(parsed.entries);
      }
    } catch {
      // No cache yet, or unreadable/corrupt → start from an empty cache.
    }
  }

  /**
   * Write the current scan cache to {@link FsScanOptions.scanCachePath} atomically
   * (temp + rename). Best-effort: a failed cache write never fails the scan.
   */
  private async _persistCache(): Promise<void> {
    /* v8 ignore next -- @preserve: only called when scanCachePath is set */
    if (!this._scanCachePath) return;
    const body = JSON.stringify({
      version: 1,
      entries: [...this._blobCache.entries()],
    });
    const tmp = `${this._scanCachePath}.${Date.now().toString(36)}.tmp`;
    /* v8 ignore start -- @preserve: cache persistence is best-effort; a write
       failure (e.g. read-only dir) must never fail the scan itself. */
    try {
      await mkdir(dirname(this._scanCachePath), { recursive: true });
      await writeFile(tmp, body);
      await rename(tmp, this._scanCachePath);
    } catch {
      // ignore — the next scan simply re-reads and re-writes the cache.
    }
    /* v8 ignore stop */
  }

  /**
   * Whether a watcher event's path should be ignored.
   *
   * `fs.watch` in recursive mode reports a path RELATIVE TO THE ROOT
   * (`sub/dir/.fsagent-tmp-abc`), while the ignore patterns are basenames.
   * {@link _shouldIgnore} tests `startsWith`, so a nested match never fired:
   * every atomic write the agent itself makes during a restore came back as a
   * change event, each event triggered a scan, and the debounce that batches a
   * push was reset before it could fire.
   *
   * Measured on the customer's folder: after a 3 642-file restore the watcher
   * reported the SAME newly added file nine times and the agent never emitted a
   * ref for it — `[fs] added: …/probe-….txt` nine times, no `sync:out`. The
   * file did not fail to arrive; it was never sent.
   *
   * Every segment is tested, because the pattern may match a directory as
   * easily as a file.
   * @param relativePath - Path as the watcher reports it.
   * @returns True when any segment matches an ignore pattern.
   */
  private _shouldIgnorePath(relativePath: string): boolean {
    for (const segment of relativePath.split(/[\\/]/)) {
      if (segment && this._shouldIgnore(segment)) return true;
    }
    return false;
  }

  private _shouldIgnore(name: string): boolean {
    /* v8 ignore next -- @preserve */
    if (!this._options.ignore) {
      return false;
    }
    for (const pattern of this._options.ignore) {
      if (name === pattern || name.startsWith(pattern)) {
        return true;
      }
    }
    return false;
  }

  async watch(): Promise<void> {
    if (this._watcher) {
      throw new Error('Already watching. Call stopWatch() first.');
    }
    /* v8 ignore next -- @preserve */
    if (!this._tree) {
      await this.scan();
    }
    /* v8 ignore start -- @preserve native watcher wiring is not unit-testable */
    const onEvent = async (eventType: string, filename: string | null) => {
      if (!filename) return;
      if (this._shouldIgnorePath(filename)) {
        return;
      }
      await this._handleFileChange(eventType, filename);
    };
    // Native fs.watch on Windows surfaces EPERM/ENOBUFS via 'error' when its
    // internal change buffer overflows under a burst (renaming a whole folder,
    // antivirus rescan). The handle is dead at that point — close and reinstall
    // a fresh watcher; events lost in the gap are recovered by the safety scan.
    //
    // Windows-only: on Linux inotify this error path can fire spuriously under a
    // write burst and reinstall the watcher, opening a brief gap that drops a
    // genuine change. The periodic safety rescan below covers all platforms.
    const onError = (err: unknown): void => {
      console.warn(
        `[fs-scanner] watcher error: ${FsScanner._errMessage(err)} — reinstalling`,
      );
      try {
        this._watcher?.close();
      } catch {
        // already closed
      }
      this._watcher = null;
      setTimeout(() => {
        if (this._stopRequested) return;
        try {
          this._watcher = watch(this._rootPath, { recursive: true }, onEvent);
          if (FsScanner._isWindows) this._watcher.on('error', onError);
        } catch (e) {
          console.warn(
            `[fs-scanner] watcher reinstall failed: ${FsScanner._errMessage(e)}`,
          );
        }
      }, 500);
    };
    this._stopRequested = false;
    this._watcher = watch(this._rootPath, { recursive: true }, onEvent);
    if (FsScanner._isWindows) this._watcher.on('error', onError);
    /* v8 ignore stop -- @preserve */

    // Periodic safety net: native fs.watch drops events under burst load
    // (especially Windows ReadDirectoryChangesW). A periodic full rescan +
    // notify catches drift the watcher missed.
    /* v8 ignore next -- @preserve stopWatch clears the timer with the watcher, so it is always null here */
    if (!this._safetyTimer) {
      this._safetyTimer = setInterval(() => {
        /* v8 ignore next -- @preserve timer firing is exercised via _runSafetyRescan */
        void this._runSafetyRescan();
      }, SAFETY_RESCAN_INTERVAL_MS);
      this._safetyTimer.unref?.();
    }
  }

  /**
   * One safety-rescan pass: rescans the tree and, if its content differs from
   * the previous scan (the native watcher dropped an event), emits a sync
   * notification so syncToDb reconciles the drift. Paused/stopped scanners and
   * scan failures are no-ops.
   */
  private async _runSafetyRescan(): Promise<void> {
    // Gated on the pause looking STUCK, not on the pause itself. A stuck pause
    // is what this exists to recover from — but scanning during a legitimate
    // restore pause mutates `_tree` underneath the restore, which broke delete
    // propagation intermittently until the threshold was applied here too.
    if (this._stopRequested) return;
    if (this._paused && !this._pauseLooksStuck({ type: 'safety-rescan', path: '.' })) {
      return;
    }
    /* v8 ignore next -- @preserve _tree is set before the timer ever fires */
    const prevKey = this._tree ? this._safetyContentKey(this._tree) : null;
    try {
      // Through the coalescer too: a rescan landing in the middle of a burst
      // would otherwise add a full extra pass to a folder already scanning.
      await this._scanAfterNow();
    } catch (err) {
      console.warn(
        `[fs-scanner] safety rescan failed: ${FsScanner._errMessage(err)}`,
      );
      return;
    }
    /* v8 ignore next -- @preserve defensive: stop racing the scan */
    if (this._stopRequested) return;
    /* v8 ignore next -- @preserve scan() always sets _tree on success */
    const nextKey = this._tree ? this._safetyContentKey(this._tree) : null;
    if (prevKey !== nextKey) {
      console.warn(
        `[fs-scanner] safety rescan detected drift on ${this._rootPath} — notifying`,
      );
      await this._notifyChange({ type: 'safety-rescan', path: '.' });
    }
  }

  /**
   * Path+blobId content fingerprint used by the safety rescan to detect drift
   * the native watcher missed (mtime-independent, same idea as the agent's
   * content key but local to the scanner).
   * @param tree - The tree to fingerprint
   * @returns A stable content key
   */
  private _safetyContentKey(tree: FsTree): string {
    const parts: string[] = [];
    for (const [, node] of tree.trees) {
      const meta = node.meta as FsNodeMeta | null;
      /* v8 ignore next -- @preserve scanned nodes always carry meta */
      if (!meta) continue;
      if (meta.type === 'file') {
        /* v8 ignore next -- @preserve scanned files always carry a blobId */
        parts.push(`${meta.relativePath}:${meta.blobId ?? ''}`);
      } else if (meta.type === 'directory' && meta.relativePath !== '.') {
        parts.push(`d:${meta.relativePath}`);
      }
    }
    parts.sort();
    return parts.join('\n');
  }

  /**
   * Extracts a readable message from a thrown value.
   * @param err - The caught value
   * @returns A message string
   */
  private static _errMessage(err: unknown): string {
    /* v8 ignore next -- @preserve non-Error throws are defensive */
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Whether a caught value is a "no longer there" filesystem error.
   *
   * A scan walks a directory that is still being written to. `readdir` returns
   * a name, and by the time the entry is `stat`ed, read, or descended into it
   * can be gone — a save-and-rename editor, a build tool, a peer applying a
   * deletion. That is ordinary, not exceptional.
   * @param err - The caught value.
   * @returns `true` for ENOENT / ENOTDIR.
   */
  private static _isVanished(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }

  /** Whether the host is Windows — gates Windows-specific watcher hardening. */
  private static get _isWindows(): boolean {
    return process.platform === 'win32';
  }

  private async _handleFileChange(
    _eventType: string,
    filename: string,
  ): Promise<void> {
    // Skip processing if paused — but record that we missed a change
    if (this._paused) {
      this._missedChangesDuringPause = true;
      return;
    }

    const relativePath = filename.replace(/\\/g, '/');
    const fullPath = join(this._rootPath, filename);

    // Determine whether the file still exists. On Windows a just-written or
    // renamed file briefly reports ENOENT/EBUSY (antivirus, indexer,
    // save-and-rename editors), so a single stat() failure is not proof of
    // deletion — retry a few times. On Linux/macOS a single stat is accurate
    // (and the retry would needlessly delay delete handling).
    let exists = false;
    /* v8 ignore next -- @preserve Windows-only branch; CI runs on Linux */
    if (FsScanner._isWindows) {
      /* v8 ignore start -- @preserve Windows-only; CI runs on Linux */
      for (let i = 0; i < 4; i++) {
        try {
          await stat(fullPath);
          exists = true;
          break;
        } catch {
          if (i < 3) await new Promise((r) => setTimeout(r, 80 + i * 80));
        }
      }
      /* v8 ignore stop -- @preserve */
    } else {
      try {
        await stat(fullPath);
        exists = true;
      } catch {
        // File is gone.
      }
    }

    try {
      if (exists) {
        // File added or modified — rescan to update the tree, then notify.
        const existingTree = this._findTreeByPath(relativePath);
        await this._scanAfterNow();
        await this._notifyChange({
          type: existingTree ? 'modified' : 'added',
          path: relativePath,
        });
        return;
      }

      // Gone after retries. Only stop watching if the root itself disappeared;
      // otherwise emit a delete for this path.
      let rootExists = false;
      try {
        await stat(this._rootPath);
        rootExists = true;
      } catch {
        this.stopWatch();
      }
      if (rootExists) {
        await this._scanAfterNow();
        await this._notifyChange({ type: 'deleted', path: relativePath });
      }
    } catch {
      // Transient scan/notify failure (locked file, etc.) — skip this event;
      // the watcher stays alive and the next change triggers a fresh scan.
    }
  }

  /**
   * A scan that is guaranteed to have STARTED after this call, sharing one
   * pass with everyone else who asked while it was running.
   *
   * `scan()` is a whole-tree operation: it walks every directory, stats every
   * file and writes a blob for anything new. Calling it once per watcher event
   * therefore costs O(files²) on a burst — and fs.watch does not await its
   * callback, so those scans all run AT ONCE. Copying 1 200 tiny files into a
   * watched folder took 1 200 concurrent full scans: the CPU sat 82% idle
   * waiting on the filesystem, RSS climbed from 263 MB to 785 MB, and after two
   * minutes the peer had received nothing. On the customer's 3 702-file folder
   * the same burst wedged the client outright.
   *
   * Started-after is the part that cannot be traded away. Joining a scan that
   * began BEFORE the event would let a push carry a tree that predates the file
   * that triggered it — which is precisely the partial trees the lab saw
   * advertised: 64 nodes, then 103, then 204, each a stale snapshot of a folder
   * that already held twelve hundred files. So a caller either starts a scan
   * now, or waits for the one that begins when the current pass ends. A burst
   * of any size collapses to at most two scans, and no change is missed.
   */
  private _scanAfterNow(): Promise<FsTree> {
    if (!this._activeScan) {
      const started = (async (): Promise<FsTree> => {
        try {
          return await this.scan();
        } finally {
          this._activeScan = null;
        }
      })();
      this._activeScan = started;
      return started;
    }
    if (this._pendingScan) return this._pendingScan;
    const queued = (async (): Promise<FsTree> => {
      // A failed pass is not this caller's problem: what it asked for is a scan
      // that starts afterwards, and that is what it still gets.
      try {
        await this._activeScan;
      } catch {
        /* the follow-up pass is the answer either way */
      }
      this._pendingScan = null;
      return this._scanAfterNow();
    })();
    this._pendingScan = queued;
    return queued;
  }

  private _findTreeByPath(relativePath: string): Tree | undefined {
    if (!this._tree) return undefined;

    for (const tree of this._tree.trees.values()) {
      const meta = tree.meta as FsNodeMeta | null;
      if (meta && meta.relativePath === relativePath) {
        return tree;
      }
    }
    return undefined;
  }

  /**
   * Whether this notification should escape the pause.
   *
   * Only the safety rescan may, and only once the pause has outlasted any
   * plausible restore. Letting it through a SHORT pause reintroduces exactly
   * the echo the pause prevents — a rescan firing mid-restore notifies, the
   * agent stores a tree built from half-restored files, and delete propagation
   * breaks (caught by the client-server suite, not by unit tests).
   * @param change - The pending notification.
   * @returns `true` when the pause has lasted long enough to look stuck.
   */
  private _pauseLooksStuck(change: FsChange): boolean {
    if (change.type !== 'safety-rescan') return false;
    if (this._pausedAt === null) return false;
    return Date.now() - this._pausedAt >= STUCK_PAUSE_MS;
  }

  private async _notifyChange(change: FsChange): Promise<void> {
    // Pausing suppresses notifications so an external restore does not loop
    // back as a local change — EXCEPT the periodic safety rescan.
    //
    // `pauseWatch()` is called on socket disconnect and `resumeWatch()` only on
    // reconnect. A disconnect whose reconnect never fires leaves the scanner
    // paused forever, and every subsequent write is dropped here: the node
    // syncs its initial state and then goes silent for good. That was live for
    // weeks. The rescan is the one notification that must survive a pause,
    // because it is what notices the writes the pause swallowed.
    if (this._paused && !this._pauseLooksStuck(change)) {
      return;
    }

    for (const callback of this._changeCallbacks) {
      await callback(change);
    }
  }

  onChange(callback: FsChangeCallback): void {
    this._changeCallbacks.push(callback);
  }

  offChange(callback: FsChangeCallback): void {
    this._changeCallbacks = this._changeCallbacks.filter(
      (cb) => cb !== callback,
    );
  }

  stopWatch(): void {
    this._stopRequested = true;
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    if (this._safetyTimer) {
      clearInterval(this._safetyTimer);
      this._safetyTimer = null;
    }
    /* v8 ignore next -- @preserve */
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  /**
   * Temporarily pause file change notifications, so an external restore does
   * not loop back as a local change.
   *
   * `autoResumeMs` bounds the pause. A pause taken on socket disconnect is
   * released by the matching reconnect — and when that reconnect never fires,
   * an unbounded pause silences the node permanently. A bounded one degrades
   * to a little duplicate work instead, which is the right way round: the
   * loop-suppression this exists for is an optimisation, staying alive is not.
   * @param autoResumeMs - Release the pause after this many milliseconds.
   *   Omit to pause until an explicit `resumeWatch()`.
   */
  pauseWatch(autoResumeMs?: number): void {
    if (!this._paused) this._pausedAt = Date.now();
    this._paused = true;
    this._missedChangesDuringPause = false;
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    if (autoResumeMs !== undefined) {
      this._autoResumeTimer = setTimeout(() => {
        this._autoResumeTimer = null;
        if (this._paused) {
          console.warn(
            `[fs-scanner] pause exceeded ${autoResumeMs}ms without a ` +
              `resume — releasing it so ${this._rootPath} keeps syncing`,
          );
          this.resumeWatch();
        }
      }, autoResumeMs);
      this._autoResumeTimer.unref?.();
    }
  }

  /**
   * Resume file change notifications.
   * If any filesystem events were missed during the pause, triggers
   * an asynchronous rescan so that syncToDb can detect and push the changes.
   */
  resumeWatch(): void {
    if (this._autoResumeTimer) {
      clearTimeout(this._autoResumeTimer);
      this._autoResumeTimer = null;
    }
    const missedChanges = this._missedChangesDuringPause;
    this._paused = false;
    this._pausedAt = null;
    this._missedChangesDuringPause = false;
    if (missedChanges) {
      void this._rescanAfterPause();
    }
  }

  /**
   * Re-scan the filesystem and fire onChange callbacks to catch modifications
   * that were missed while watching was paused.
   */
  private async _rescanAfterPause(): Promise<void> {
    try {
      await this.scan();
      /* v8 ignore if -- @preserve */
      if (this._paused) {
        return;
      }
      await this._notifyChange({ type: 'modified', path: '.' });
    } catch {
      /* v8 ignore start -- @preserve */
      // Ignore — the next filesystem event will trigger a fresh scan.
    }
    /* v8 ignore stop -- @preserve */
  }

  getTreeByHash(treeHash: TreeRef): Tree | undefined {
    return this._tree?.trees.get(treeHash);
  }

  getTreeByPath(relativePath: string): Tree | undefined {
    return this._findTreeByPath(relativePath);
  }

  getAllTrees(): Tree[] {
    if (!this._tree) {
      return [];
    }
    return Array.from(this._tree.trees.values());
  }

  getChildren(treeHash: TreeRef): Tree[] {
    const tree = this.getTreeByHash(treeHash);
    if (!tree || !tree.children) {
      return [];
    }

    return tree.children
      .map((childHash: TreeRef) => this.getTreeByHash(childHash))
      .filter((t: Tree | undefined): t is Tree => t !== undefined);
  }

  getRootTree(): Tree | undefined {
    /* v8 ignore next -- @preserve */
    if (!this._tree) return undefined;
    return this._tree.trees.get(this._tree.rootHash);
  }

  static example(): FsScanner {
    return new FsScanner(process.cwd(), {
      ignore: ['node_modules', '.git', 'dist', 'coverage'],
    });
  }
}
