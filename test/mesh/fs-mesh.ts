// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A multi-node mesh for the filesystem sync.
//
// WHY THIS EXISTS
// Two data-loss failures were measured on the live fleet on 2026-09-30, in
// opposite directions, and neither was catchable by the suite as it stood:
//
//   - a folder copied onto a node was repeatedly pulled away against its own
//     contents (an addition discarded), and
//   - the fix for that livelocked, flipping a folder between two states
//     roughly twenty times in ninety seconds before landing on the state the
//     user had deleted (a deletion undone).
//
// Both need one precondition to reproduce: A NODE HOLDING WORK THE HUB HAS NOT
// SEEN. No test in this repo created one. The decision spec constructs views by
// hand and, outside a single case, never sets `lastPushedRef` — so every test
// described a node with no local work to lose. The multi-node tests never cut a
// node off while it wrote.
//
// WHAT THIS DOES
// Builds n nodes that are a faithful model of the production topology rather
// than a mock of it:
//
//   - a real `Server` with the STATE BEACON, a real `Client` per node over a
//     real socket pair, a real `Connector` carrying the SyncConfig a CARAT One
//     Client ships (`causalOrdering` + `includeClientIdentity`), and
//     `resolveConflicts: true` — the production value, without which the
//     ancestry DAG, the inline merge and the prune rule are all switched off;
//   - a real `FsAgent` per node over a real temp folder with a real watcher,
//     running the live `syncToDb` + `syncFromDb({ cleanTarget: true })` loops;
//   - its own `Bs` per node, so a blob has to travel to reach a peer. A shared
//     `BsMem` makes every blob trivially available everywhere and hides
//     exactly the half of a rejoin that can fail.
//
// THE PARTITION
// {@link FsMeshNode.cut} drops EVERYTHING on this node's socket in both
// directions — refs, the bootstrap, the state beacon, and row and blob reads
// alike — and {@link FsMeshNode.heal} restores it.
//
// The first version of this harness cut only the announcement channel and left
// row reads resolving, on the reasoning that a node which cannot hear or tell
// anyone its state is already partitioned for sync purposes. That is wrong,
// and measurably so: T1, T2 AND T4 all passed against code the field had just
// lost data with. A node that can still read its peers' revision rows can
// always find the common ancestor, and a three-way merge against a common
// ancestor CAN tell "deleted on their branch" from "never had it on their
// branch". The information the plan says is missing was being handed back by
// the transport.
//
// Cutting everything reproduced T4 in seven seconds, on its author's own
// folder — the shape of the afternoon failure, and of mongo's "deleted
// customer came back". So the total cut is the faithful one and the gentle one
// was the mock. The single-message loss is modelled separately and
// deliberately in `client-server/heals-after-forced-divergence.spec.ts`.
//
// THE ASSERTION
// {@link FsMesh.converged} asserts on FOLDER CONTENTS AND STABILITY, never on
// refs: every uncut node holds the same file set, and no node's file set has
// moved for `stableMs`. The stability half is the point. The afternoon livelock
// would have passed any single-sample ref check — both nodes reported a healthy
// `push` at every instant — and fails this one, because the folder never stops
// moving.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route, type SyncConfig } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { dirname, join, relative, sep } from 'path';

import {
  AGENT_STATE_FILE,
  ATOMIC_TMP_PREFIX,
  FsAgent,
  SYNC_ERROR_FILE,
} from '../../src/fs-agent.ts';

import type { AntiEntropyOptions } from '../../src/fs-anti-entropy.ts';

// .............................................................................
/** The sync configuration a CARAT One Client ships (`sl-node.ts`). */
export const MESH_SYNC: SyncConfig = {
  causalOrdering: true,
  includeClientIdentity: true,
};

/**
 * How often the hub announces what it holds.
 *
 * Short, because the anti-entropy's grace period is measured against it and a
 * test that waits out a production beacon takes minutes.
 */
export const MESH_BEACON_MS = 150;

/** The anti-entropy tuning every mesh node runs with. */
export const MESH_ANTI_ENTROPY: AntiEntropyOptions = {
  graceMs: 500,
  maxBackoffMs: 2_000,
};

/** Files the agent keeps beside the content, which are nobody else's business. */
const BOOKKEEPING = [SYNC_ERROR_FILE, ATOMIC_TMP_PREFIX, AGENT_STATE_FILE];

const isBookkeeping = (name: string): boolean =>
  BOOKKEEPING.some((prefix) => name === prefix || name.startsWith(prefix));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// .............................................................................
/** One participant in the mesh. */
export interface FsMeshNode {
  /** `A`, `B`, `C`, … — what failures are reported against. */
  readonly name: string;
  /** This node's synced folder. */
  readonly folder: string;
  readonly agent: FsAgent;
  readonly db: Db;
  readonly connector: Connector;

  /** Whether this node is currently partitioned. */
  readonly isCut: boolean;

  /**
   * Partitions this node: nothing leaves or reaches its socket, row and blob
   * reads included. See the header for why it is total and not selective.
   */
  cut(): void;
  /** Lets it talk again. */
  heal(): void;

  /**
   * Writes a file, creating parent directories as needed.
   * @param path - Relative to this node's folder, `/`-separated.
   * @param content - What to write.
   */
  write(path: string, content: string): Promise<void>;
  /**
   * Deletes a file.
   * @param path - Relative to this node's folder, `/`-separated.
   */
  del(path: string): Promise<void>;
  /**
   * Reads a file.
   * @param path - Relative to this node's folder, `/`-separated.
   * @returns Its content, or `undefined` when the node does not hold it.
   */
  read(path: string): Promise<string | undefined>;
  /**
   * Every file this node holds, excluding the agent's own bookkeeping.
   * @returns Sorted, `/`-separated paths relative to this node's folder.
   */
  files(): Promise<string[]>;
}

// .............................................................................
/** What {@link FsMesh.converged} concluded. */
export interface ConvergenceResult {
  /** Whether every uncut node agreed and stayed still. */
  converged: boolean;
  /** Each node's final file set, keyed by name. */
  snapshot: Record<string, string[]>;
  /**
   * How many times a node's file set changed while waiting for stability.
   *
   * A mesh that agrees at once reports 0. A LIVELOCK reports a number that
   * keeps climbing — which is the signal the afternoon failure produced and no
   * ref check could see.
   */
  churn: number;
  /** How long the wait took, ms. */
  elapsedMs: number;
}

// .............................................................................
/** An n-node filesystem-sync mesh. */
export interface FsMesh {
  readonly nodes: FsMeshNode[];
  readonly server: Server;
  readonly treeKey: string;
  readonly route: Route;

  /**
   * One node by name.
   * @param name - `A`, `B`, …
   * @returns That node.
   */
  node(name: string): FsMeshNode;

  /**
   * Every node's file set right now.
   * @returns Sorted paths keyed by node name.
   */
  snapshot(): Promise<Record<string, string[]>>;

  /**
   * Waits until every uncut node holds the same file set and no node's file
   * set has moved for `stableMs`.
   * @param opts - `stableMs` (default 1 500) is how long nothing may move;
   *   `timeoutMs` (default 20 000) is the whole budget.
   * @returns What it concluded — never throws, so a caller can assert on the
   *   snapshot and read the disagreement rather than a timeout message.
   */
  converged(opts?: {
    stableMs?: number;
    timeoutMs?: number;
  }): Promise<ConvergenceResult>;

  /** Shuts every node and the hub down and removes the folders. */
  stop(): Promise<void>;
}

// .............................................................................
/**
 * Builds and starts an n-node mesh.
 * @param opts - `root` is where the folders go (removed by `stop`); `names`
 *   defaults to `['A', 'B']`; `antiEntropy` overrides
 *   {@link MESH_ANTI_ENTROPY}; `seed` runs before sync starts, so a node can
 *   begin holding content nobody has announced.
 * @returns The started mesh.
 */
export const buildFsMesh = async (opts: {
  root: string;
  names?: string[];
  treeKey?: string;
  antiEntropy?: AntiEntropyOptions;
  seed?: (folders: Record<string, string>) => Promise<void>;
  /**
   * Node names that speak the OLD wire format — a plain tree ref rather than
   * a `~H~` chain head. A mixed-version fleet, by construction.
   */
  oldWireFormat?: readonly string[];
}): Promise<FsMesh> => {
  const treeKey = opts.treeKey ?? 'sharedTree';
  const names = opts.names ?? ['A', 'B'];
  const route = Route.fromFlat(`/${treeKey}`);
  const treeCfg = createTreesTableCfg(treeKey);

  await rm(opts.root, { recursive: true, force: true, maxRetries: 5 });

  // ------ the hub ------
  const serverIo = new IoMem();
  await serverIo.init();
  await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
  const server = new Server(route, serverIo, new BsMem(), {
    syncConfig: MESH_SYNC,
    stateBeaconMs: MESH_BEACON_MS,
  });
  await server.init();

  // ------ the folders, before any node is listening ------
  const folders: Record<string, string> = {};
  for (const name of names) {
    folders[name] = join(opts.root, name);
    await mkdir(folders[name], { recursive: true });
  }
  if (opts.seed) await opts.seed(folders);

  // ------ the nodes ------
  const nodes: FsMeshNode[] = [];
  const stops: Array<() => void> = [];
  const clients: Client[] = [];

  for (const name of names) {
    const folder = folders[name];
    const localIo = new IoMem();
    await localIo.init();
    await localIo.isReady();
    await new Db(localIo).core.createTableWithInsertHistory(treeCfg);

    const [serverSocket, clientSocket] = createSocketPair();

    // The partition: every event, both directions. See the header.
    let cut = false;
    const gag = (socket: { emit: (e: string, ...a: unknown[]) => boolean }) => {
      const pass = socket.emit.bind(socket);
      socket.emit = ((event: string, ...args: unknown[]) =>
        cut ? true : pass(event, ...args)) as typeof socket.emit;
    };
    gag(clientSocket);
    gag(serverSocket);

    serverSocket.connect();
    await server.addSocket(serverSocket);
    const client = new Client(clientSocket, localIo, new BsMem());
    await client.init();
    clients.push(client);
    const db = new Db(client.io!);
    const connector = new Connector(db, route, clientSocket, MESH_SYNC);

    // `client.bs`, NOT a bare `BsMem`.
    //
    // The client's blob store is the node's own store WITH a path to its
    // peers. Handed a bare one, an agent can store its own blobs and never
    // fetch anybody else's, so every restore fails on its first file and
    // nothing propagates at all — which is what the first run of this harness
    // did, in both directions, and it looks exactly like a sync defect.
    //
    // It is still a per-node store: a blob has to travel to reach a peer. A
    // SHARED `BsMem` would make every blob available everywhere for free and
    // hide the half of a rejoin that can actually fail.
    const agent = new FsAgent(folder, client.bs, {
      // Production sets this, and it is load-bearing: with it off the ancestry
      // DAG, the inline three-way merge and half the prune rule never run, so
      // a mesh without it tests a code path no client ships.
      resolveConflicts: true,
      antiEntropy: opts.antiEntropy ?? MESH_ANTI_ENTROPY,
      timeouts: { debounceMs: 100, processRefRetryDelayMs: 300 },
      announceTreeRef: opts.oldWireFormat?.includes(name) ?? false,
    });

    stops.push(await agent.syncToDb(db, connector, treeKey));
    stops.push(
      await agent.syncFromDb(db, connector, treeKey, { cleanTarget: true }),
    );

    const abs = (path: string) => join(folder, ...path.split('/'));

    nodes.push({
      name,
      folder,
      agent,
      db,
      connector,
      get isCut() {
        return cut;
      },
      cut: () => {
        cut = true;
      },
      heal: () => {
        cut = false;
      },
      write: async (path, content) => {
        const file = abs(path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      },
      del: async (path) => {
        await unlink(abs(path));
      },
      read: async (path) => {
        try {
          return await readFile(abs(path), 'utf8');
        } catch {
          return undefined;
        }
      },
      files: () => listFiles(folder),
    });
  }

  const node = (name: string) => {
    const found = nodes.find((n) => n.name === name);
    /* v8 ignore next -- @preserve a test asking for a node it did not build */
    if (!found) throw new Error(`fs-mesh: no node named ${name}`);
    return found;
  };

  const snapshot = async (): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const n of nodes) out[n.name] = await n.files();
    return out;
  };

  const converged = async (o?: {
    stableMs?: number;
    timeoutMs?: number;
  }): Promise<ConvergenceResult> => {
    const stableMs = o?.stableMs ?? 1_500;
    const timeoutMs = o?.timeoutMs ?? 20_000;
    const started = Date.now();
    const deadline = started + timeoutMs;

    let churn = 0;
    let previous = await snapshot();
    let agreedSince: number | null = null;

    for (;;) {
      await sleep(100);
      const current = await snapshot();

      // Did anything move? Counted across ALL nodes, cut ones included: a cut
      // node whose folder is being rewritten is still a folder being rewritten.
      if (JSON.stringify(current) !== JSON.stringify(previous)) {
        churn++;
        agreedSince = null;
      }
      previous = current;

      // Do the nodes that can talk hold the same thing?
      const live = nodes.filter((n) => !n.isCut).map((n) => current[n.name]);
      const agree =
        live.length > 0 &&
        live.every((set) => JSON.stringify(set) === JSON.stringify(live[0]));

      if (agree) {
        agreedSince ??= Date.now();
        if (Date.now() - agreedSince >= stableMs) {
          return {
            converged: true,
            snapshot: current,
            churn,
            elapsedMs: Date.now() - started,
          };
        }
      } else {
        agreedSince = null;
      }

      if (Date.now() >= deadline) {
        return {
          converged: false,
          snapshot: current,
          churn,
          elapsedMs: Date.now() - started,
        };
      }
    }
  };

  const stop = async () => {
    for (const s of stops) s();
    for (const n of nodes) n.agent.scanner.stopWatch();
    for (const c of clients) await c.tearDown();
    await server.tearDown();
    await rm(opts.root, { recursive: true, force: true, maxRetries: 10 });
  };

  return { nodes, server, treeKey, route, node, snapshot, converged, stop };
};

// .............................................................................
/**
 * Every file under `root`, excluding the agent's own bookkeeping.
 * @param root - Folder to walk.
 * @returns Sorted, `/`-separated paths relative to `root`.
 */
const listFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      /* v8 ignore next -- @preserve a folder removed mid-walk */
      return;
    }
    for (const entry of entries) {
      if (isBookkeeping(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  await walk(root);
  return out.sort();
};
