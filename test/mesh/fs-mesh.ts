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
// refs: every uncut node holds the same files WITH THE SAME CONTENT, and no
// node's file set has moved for `stableMs`. The stability half is the point.
// The afternoon livelock would have passed any single-sample ref check — both
// nodes reported a healthy `push` at every instant — and fails this one,
// because the folder never stops moving.
//
// **CONTENT, and for a long time this said so without doing it.** It compared
// file NAMES, so a fleet where every node held a different version of the same
// document reported itself converged. That is why nothing caught the fleet
// freeze, where receivers sat six versions behind reporting health
// (`fs-mesh-invariants.spec.ts`), and it is why the catch-up test asserted the
// document's version separately and then failed on it once in a full run while
// passing 8 of 8 alone — the assertion was sampled a moment after a
// convergence that had never looked at it.
//
// Content is read only once the file lists already AGREE, so a churning fleet
// still costs one `readdir` per node per poll.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route, type SyncConfig } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'fs/promises';
import { dirname, join, relative, sep } from 'path';

import {
  AGENT_STATE_FILE,
  ATOMIC_TMP_PREFIX,
  CONFLICT_LOG_FILE,
  FsAgent,
  RECOVERED_DIR,
  SYNC_ERROR_FILE,
} from '../../src/fs-agent.ts';

import type { AntiEntropyOptions } from '../../src/fs-anti-entropy.ts';
import type { FsConflictReport } from '../../src/fs-conflict-resolver.ts';

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
// What the agent keeps in the folder and never syncs. A test comparing folders
// has to see the same thing a peer does, or its own bookkeeping reads as a
// divergence — which `RECOVERED_DIR` produced the moment it existed: a joiner
// correctly kept a file outside the synced tree and `converged()` called the
// fleet divided over it.
const BOOKKEEPING = [
  SYNC_ERROR_FILE,
  ATOMIC_TMP_PREFIX,
  AGENT_STATE_FILE,
  CONFLICT_LOG_FILE,
  RECOVERED_DIR,
];

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
  /**
   * Everything this node has been observed holding, in order.
   *
   * Empty unless the mesh was built with `recordHistory`. Sampled from disk
   * rather than hooked into the agent, so it sees what a user would see.
   */
  readonly timeline: FsTimeline;
  readonly isCut: boolean;

  /**
   * Partitions this node: nothing leaves or reaches its socket, row and blob
   * reads included. See the header for why it is total and not selective.
   */
  cut(): void;
  /**
   * Stops this node's own messages reaching anyone, while it keeps receiving.
   *
   * What a one-way firewall rule or a broken outbound route produces. The node
   * looks healthy to itself and its work reaches nobody.
   */
  mute(): void;
  /**
   * Stops anything reaching this node, while its own messages still go out.
   *
   * The mirror image, and the nastier one: the node announces states nobody
   * answers and never hears that the fleet has moved on.
   */
  deafen(): void;
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
  /**
   * Waits until this node's file set is exactly `paths`.
   *
   * **Use this instead of a sleep to set a scenario up.** A fixed wait encodes
   * an assumption about how fast the machine is, and under full-suite load
   * that assumption fails: A3 passed 8 of 8 alone and failed in the suite,
   * because a three-second partition was not long enough for a node to finish
   * noticing its own deletion before it was healed. The test then measures the
   * setup rather than the behaviour.
   * @param paths - The expected file set, sorted.
   * @param timeoutMs - How long to allow. Default 20 000.
   * @returns What the node held when it gave up, so a failure reads.
   */
  settlesOn(paths: string[], timeoutMs?: number): Promise<string[]>;

  /**
   * Stops this node's agent, as a process exit does.
   *
   * NOT a cut. A cut breaks the network and leaves the agent watching; this
   * stops the agent and leaves the folder reachable, so a test can change it
   * behind the agent's back — which is what a crash, an upgrade, or a user
   * editing while the client is closed actually produces.
   */
  down(): void;

  /**
   * Starts a NEW agent on the same folder, database and blob store.
   *
   * The chain survives, exactly as it does on disk, so the restarted agent has
   * to reconcile its own history against whatever the folder now holds.
   */
  up(): Promise<void>;
}

// .............................................................................
/**
 * What a node held at one moment: relative path → content.
 *
 * Content, not a hash: these folders are small and a failing invariant is
 * something somebody has to read.
 */
export type FsSnapshot = Readonly<Record<string, string>>;

/**
 * A node's state over time, sampled.
 *
 * WHY THE PATH MATTERS AND NOT ONLY THE DESTINATION. `converged()` asks what
 * every node holds at the end, and a fleet can reach the right answer by a
 * route no user would forgive — a document going back to last week's version
 * for ten seconds, a deleted file reappearing and being deleted again. Both
 * converge. Both are the bug reports this project actually gets.
 *
 * `@rljson/mongo-agent`'s mesh has asserted this for a while (its
 * `expectNoRegression` walks a per-node history for version regressions and
 * post-delete resurrections) and this harness had no equivalent at all.
 */
export interface FsTimeline {
  /** Samples in order, oldest first. */
  readonly samples: ReadonlyArray<{ atMs: number; files: FsSnapshot }>;
}

/**
 * Why a convergence wait ended, as a failure message.
 *
 * The snapshot alone is misleading now that content counts: every node holding
 * `doc.txt` looks like agreement, and the thing worth reading is WHICH paths
 * differ. A message that names `doc.txt` is the difference between a bug
 * report and an investigation.
 * @param result - What the wait concluded.
 * @returns A one-line explanation for an assertion message.
 */
export const whyNot = (result: ConvergenceResult): string =>
  result.differingPaths.length > 0
    ? `same files, DIFFERENT CONTENT on ${result.differingPaths.join(', ')} ` +
      `— ${JSON.stringify(result.snapshot)}`
    : JSON.stringify(result.snapshot);

/** What {@link FsMesh.converged} concluded. */
export interface ConvergenceResult {
  /** Whether every uncut node agreed and stayed still. */
  converged: boolean;
  /** Each node's final file set, keyed by name. */
  snapshot: Record<string, string[]>;
  /**
   * Paths the uncut nodes hold with DIFFERING content, when that is why they
   * did not converge.
   *
   * Empty when the file lists themselves disagree — then the snapshot already
   * says it — and empty on success. A failure message that names `doc.txt` is
   * the difference between a bug report and an investigation.
   */
  differingPaths: string[];
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
   * Adds a node to the running network, optionally with a folder of its own.
   *
   * A client arriving at a network that already has a history, which is what
   * every real deployment does after the first machine. `seed` writes the
   * folder BEFORE the agent starts — the faithful order, because a backup
   * restore or a copied-in folder happened before the client was launched.
   * @param name - The new node's name.
   * @param seed - Writes its folder before its agent starts.
   */
  join(
    name: string,
    seed?: (folder: string) => Promise<void>,
  ): Promise<FsMeshNode>;

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
  /**
   * Every conflict any node in this mesh reported, in the order reported.
   *
   * Live array, appended to as the mesh runs.
   */
  readonly conflicts: readonly FsConflictReport[];
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
  /**
   * Answer a divergence with an ADDITIVE bucket-sync round instead of
   * replacing a folder. `FsAgentOptions.bucketSync` on every node.
   */
  bucketSync?: boolean;

  /**
   * `FsAgentOptions.joinWaitMs` on every node.
   *
   * Set it for a scenario where a node arrives at a network that already has a
   * history, and its own folder has to be judged against that history rather
   * than announced over it.
   */
  joinWaitMs?: number;
  /**
   * Sample every node's folder on an interval and keep the series, so a test
   * can assert over the ROUTE a fleet took and not only its destination. See
   * {@link FsTimeline}.
   */
  recordHistory?: boolean;
  /** How often to sample when `recordHistory` is on. Default 60 ms. */
  historyMs?: number;
}): Promise<FsMesh> => {
  const treeKey = opts.treeKey ?? 'sharedTree';
  const names = opts.names ?? ['A', 'B'];
  const conflicts: FsConflictReport[] = [];
  /** Per node, the series its timeline exposes. Filled by the poller below. */
  const series = new Map<string, Array<{ atMs: number; files: FsSnapshot }>>();
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

  // A NODE, BUILT ON DEMAND.
  //
  // Extracted from the start-up loop so a node can also arrive LATER, at a
  // network that is already running and already has a history. That is the
  // whole J section of `doc/scenario-matrix.md` — a client joining with files
  // of its own, some of them new work and some of them a stale copy — and it
  // could not be expressed at all while every node had to exist before the
  // first byte was written.
  const addNode = async (name: string): Promise<FsMeshNode> => {
    const folder = folders[name];
    const localIo = new IoMem();
    await localIo.init();
    await localIo.isReady();
    await new Db(localIo).core.createTableWithInsertHistory(treeCfg);

    const [serverSocket, clientSocket] = createSocketPair();

    // The partition. `both` is the faithful default — see the header — but a
    // one-way cut has to be possible too, because it is what a firewall, a
    // NAT and an asymmetric route actually produce. A node that can SEND but
    // not RECEIVE believes it is online and keeps announcing into a void; a
    // node that can RECEIVE but not SEND looks healthy to itself while its
    // own work reaches nobody. Both are indistinguishable from health locally,
    // which is why they are worth testing and a symmetric cut cannot.
    let cut = false;
    let muteOutbound = false;
    let deafInbound = false;
    const gag = (
      socket: { emit: (e: string, ...a: unknown[]) => boolean },
      blocked: () => boolean,
    ) => {
      const pass = socket.emit.bind(socket);
      socket.emit = ((event: string, ...args: unknown[]) =>
        blocked() ? true : pass(event, ...args)) as typeof socket.emit;
    };
    // The CLIENT socket's emit is this node talking; the SERVER socket's emit
    // is the hub talking to it.
    gag(clientSocket, () => cut || muteOutbound);
    gag(serverSocket, () => cut || deafInbound);

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
    const agentOptions = {
      // Which node said it. Four agents in one process used to produce three
      // identical `applied 3 peer deletions: …` lines with nothing saying who,
      // and a convergence investigation stopped dead there.
      logName: name,
      // Production sets this, and it is load-bearing: with it off the ancestry
      // DAG, the inline three-way merge and half the prune rule never run, so
      // a mesh without it tests a code path no client ships.
      resolveConflicts: true,
      // Collected so a test can assert the agent SAID a conflict happened,
      // not just that a renamed file turned up. Resolving one used to be
      // silent, and silence is the defect.
      onConflict: (reports) => {
        conflicts.push(...reports);
      },
      antiEntropy: opts.antiEntropy ?? MESH_ANTI_ENTROPY,
      timeouts: { debounceMs: 100, processRefRetryDelayMs: 300 },
      announceTreeRef: opts.oldWireFormat?.includes(name) ?? false,
      // Undefined, not `false`. Passing `false` here overrode the agent's own
      // default and silently measured the OLD model: T4 ran at 3 of 8 while
      // the identical scenario passed 8 of 8 elsewhere, for no reason but
      // this line.
      bucketSync: opts.bucketSync,
      // ZERO unless a test asks. A mesh is built from scratch, so every node
      // in it IS the origin of its own history and has nothing to join — the
      // wait could only expire. The scenario that needs it is a node arriving
      // at a network that already HAS a history, which is `mesh.join`.
      joinWaitMs: opts.joinWaitMs ?? 0,
    };

    // A NODE THAT CAN BE STOPPED AND STARTED AGAIN.
    //
    // A cut models a broken network; this models a stopped PROCESS, and the
    // two are not interchangeable. While an agent is down its folder can still
    // change — the user saves, a backup tool restores, someone deletes a
    // directory — and when it comes back its own history disagrees with its
    // own folder. That is what every crash and every "edited while the agent
    // was down" produces, and nothing in this suite could express it.
    //
    // The restart is faithful in the way that matters: a NEW `FsAgent` on the
    // same folder, with the same database and blob store. So the chain
    // survives exactly as it does on disk, and the new agent has to work out
    // what the folder did behind its back.
    let liveAgent = new FsAgent(folder, client.bs, agentOptions);
    let liveStops: Array<() => void> = [];
    const start = async () => {
      liveStops = [
        await liveAgent.syncToDb(db, connector, treeKey),
        await liveAgent.syncFromDb(db, connector, treeKey, {
          cleanTarget: true,
        }),
      ];
    };
    await start();
    // Registered as a closure, so teardown stops whichever agent is live.
    stops.push(() => {
      for (const stop of liveStops) stop();
      liveAgent.scanner.stopWatch();
    });

    const abs = (path: string) => join(folder, ...path.split('/'));

    const samples: Array<{ atMs: number; files: FsSnapshot }> = [];
    series.set(name, samples);
    nodes.push({
      name,
      folder,
      timeline: { samples },
      get agent() {
        return liveAgent;
      },
      db,
      connector,
      down: () => {
        for (const stop of liveStops) stop();
        liveStops = [];
        liveAgent.scanner.stopWatch();
      },
      up: async () => {
        liveAgent = new FsAgent(folder, client.bs, agentOptions);
        await start();
      },
      get isCut() {
        return cut;
      },
      cut: () => {
        cut = true;
      },
      mute: () => {
        muteOutbound = true;
      },
      deafen: () => {
        deafInbound = true;
      },
      heal: () => {
        cut = false;
        muteOutbound = false;
        deafInbound = false;
      },
      write: async (path, content) => {
        // ATOMICALLY, as every real application saves.
        //
        // `writeFile` truncates and then writes, so for an instant the file is
        // ZERO BYTES — and anything watching can observe that. The timeline
        // sampler did, and the route invariant correctly called it a step
        // backwards:
        //
        //   ["v0","v1","v2","v3","","v4","v5","v6","v7","v8"]
        //
        // The fleet was right and the harness was wrong: no editor leaves a
        // file empty between saves, the agent's own writes go through
        // temp-and-rename for exactly this reason, and `fs-editor-patterns`
        // tests that an atomic save converges. A harness that produces a state
        // no application produces manufactures failures.
        //
        // The temp name carries `ATOMIC_TMP_PREFIX`, which the scanner ignores,
        // so the intermediate file is invisible to sync as well as to the
        // sampler.
        const file = abs(path);
        await mkdir(dirname(file), { recursive: true });
        const tmp = join(
          dirname(file),
          `${ATOMIC_TMP_PREFIX}${Math.random().toString(36).slice(2)}`,
        );
        await writeFile(tmp, content);
        await rename(tmp, file);
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
      settlesOn: async (paths, timeoutMs = 20_000) => {
        const want = JSON.stringify(paths);
        const deadline = Date.now() + timeoutMs;
        let seen = await listFiles(folder);
        while (JSON.stringify(seen) !== want && Date.now() < deadline) {
          await sleep(100);
          seen = await listFiles(folder);
        }
        return seen;
      },
    });
    return nodes[nodes.length - 1];
  };

  for (const name of names) {
    await addNode(name);
  }

  /**
   * Adds a node to a network that is ALREADY RUNNING.
   *
   * The J section of `doc/scenario-matrix.md`: a client arrives with a folder
   * of its own and no history, and what happens to its files has to be decided
   * against the chain. `seed` writes that folder BEFORE the agent starts, which
   * is the only faithful order — a backup restore, or a user who copied a
   * folder in, happened before the client was launched.
   * @param name - The new node's name.
   * @param seed - Writes its folder before its agent starts.
   * @returns The node, already syncing.
   */
  const joinNode = async (
    name: string,
    seed?: (folder: string) => Promise<void>,
  ): Promise<FsMeshNode> => {
    folders[name] = join(opts.root, name);
    await mkdir(folders[name], { recursive: true });
    if (seed) await seed(folders[name]);
    return addNode(name);
  };

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

  /**
   * Which paths the uncut nodes hold with differing content.
   *
   * Read from DISK, like everything else here, and only called once the file
   * lists agree — so the cost lands on a fleet that is nearly there, never on
   * one still churning.
   * @returns The differing paths, sorted. Empty means the folders are equal.
   */
  const contentDisagreement = async (): Promise<string[]> => {
    const live = nodes.filter((n) => !n.isCut);
    if (live.length < 2) return [];
    const [first, ...rest] = live;
    const differing = new Set<string>();
    for (const path of await first.files()) {
      const mine = await first.read(path);
      for (const other of rest) {
        if ((await other.read(path)) !== mine) differing.add(path);
      }
    }
    return [...differing].sort();
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
    let differingPaths: string[] = [];

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
      const namesAgree =
        live.length > 0 &&
        live.every((set) => JSON.stringify(set) === JSON.stringify(live[0]));

      // THE SAME FILES IS NOT THE SAME FOLDER. `doc.txt` is present on every
      // node whatever version it holds, which is exactly how a fleet six
      // versions behind reported itself healthy.
      differingPaths = namesAgree ? await contentDisagreement() : [];
      const agree = namesAgree && differingPaths.length === 0;

      if (agree) {
        agreedSince ??= Date.now();
        if (Date.now() - agreedSince >= stableMs) {
          return {
            converged: true,
            snapshot: current,
            differingPaths: [],
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
          differingPaths,
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

  // Sampling, when asked for.
  //
  // Polled from DISK rather than hooked into the agent, deliberately: a hook
  // would report what the agent believes, and the invariants are about what a
  // user would find in the folder. A duplicate consecutive sample is dropped,
  // so a quiet fleet costs a readdir and nothing else.
  let historyTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.recordHistory) {
    const sample = async () => {
      for (const n of nodes) {
        const files: Record<string, string> = {};
        for (const path of await n.files()) {
          files[path] = (await n.read(path)) ?? '<unreadable>';
        }
        const got = series.get(n.name) as Array<{
          atMs: number;
          files: FsSnapshot;
        }>;
        const last = got[got.length - 1];
        if (last && JSON.stringify(last.files) === JSON.stringify(files)) {
          continue;
        }
        got.push({ atMs: Date.now(), files });
      }
    };
    await sample();
    historyTimer = setInterval(() => void sample(), opts.historyMs ?? 60);
    historyTimer.unref?.();
  }

  const stopAll = async () => {
    if (historyTimer) clearInterval(historyTimer);
    historyTimer = null;
    await stop();
  };

  return {
    nodes,
    server,
    treeKey,
    route,
    node,
    join: joinNode,
    snapshot,
    converged,
    stop: stopAll,
    conflicts,
  };
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
