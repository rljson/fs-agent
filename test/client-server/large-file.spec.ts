// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg, Route, type SyncConfig } from '@rljson/rljson';
import { Client, Server, SocketIoBridge } from '@rljson/server';

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Server as SocketIoServer } from 'socket.io';
import {
  io as socketIoClient,
  type Socket as ClientSocket,
} from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from '../origin-fixture.ts';

// =============================================================================
// A file larger than one Socket.IO message, over real Socket.IO.
//
// The hub accepts messages up to 50 MB, as in production. Every step moves a
// 60 MB file: added, changed in the middle, edited on both sides while apart,
// deleted. Each node has a blob store of its own, so every byte crosses the
// sockets.
// =============================================================================

const TREE = 'sharedTree';
const SYNC: SyncConfig = { causalOrdering: true, includeClientIdentity: true };
const SOCKET_CAP = 50 * 1024 * 1024;
const LARGE = 60 * 1024 * 1024;

interface Node {
  name: string;
  folder: string;
  socket: ClientSocket;
  client: Client;
  db: Db;
  connector: Connector;
  agent: FsAgent;
  stops: Array<() => void>;
}

// .............................................................................
/**
 * Bytes that do not repeat and do not compress, the same for the same seed.
 * @param size - Number of bytes.
 * @param seed - Start of the sequence.
 * @returns The bytes.
 */
const noise = (size: number, seed: number): Buffer => {
  const words = new Uint32Array(Math.ceil(size / 4));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x >>> 0;
  }
  return Buffer.from(words.buffer, 0, size);
};

const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** The synced files of a folder, without the agent's own state. */
const filesIn = async (folder: string): Promise<string[]> =>
  (await readdir(folder)).filter((name) => !name.startsWith('.fsagent'));

const shaOfFile = async (path: string): Promise<string | undefined> =>
  readFile(path).then(sha, () => undefined);

/**
 * Polls until `fn()` is truthy; fails with `what` and both folders when it
 * never is.
 */
const until = async (
  what: string,
  fn: () => Promise<boolean>,
  timeout = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out after ${timeout} ms: ${what}; ${await folders()}`);
};

let folders: () => Promise<string> = async () => '';

describe('a file above the socket cap, over real Socket.IO', () => {
  const root = join(process.cwd(), 'test-temp-large-file');
  const route = Route.fromFlat(`/${TREE}`);
  let http: HttpServer;
  let socketIo: SocketIoServer;
  let server: Server;
  let port: number;
  /** Bytes the hub's sockets carried, both directions. */
  let wireBytes = 0;
  let a: Node;
  let b: Node;

  const startSync = async (n: Node) => {
    n.stops.push(await n.agent.syncToDb(n.db, n.connector, TREE));
    n.stops.push(
      await n.agent.syncFromDb(n.db, n.connector, TREE, { cleanTarget: true }),
    );
  };

  const stopSync = (n: Node) => {
    for (const stop of n.stops) stop();
    n.stops = [];
  };

  const mkNode = async (name: string): Promise<Node> => {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    const localIo = new IoMem();
    await localIo.init();
    await localIo.isReady();
    await new Db(localIo).core.createTableWithInsertHistory(
      createTreesTableCfg(TREE),
    );
    const socket = socketIoClient(`http://localhost:${port}`, {
      forceNew: true,
    });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    const client = new Client(new SocketIoBridge(socket), localIo, new BsMem());
    await client.init();
    const db = new Db(client.io!);
    const connector = new Connector(
      db,
      route,
      new SocketIoBridge(socket),
      SYNC,
    );
    const agent = new FsAgent(folder, client.bs!, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 100, restore: 120_000 },
    });
    return { name, folder, socket, client, db, connector, agent, stops: [] };
  };

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });

    http = createServer();
    socketIo = new SocketIoServer(http, { maxHttpBufferSize: SOCKET_CAP });
    wireBytes = 0;
    const count = (packet: { data?: unknown }) => {
      const { data } = packet;
      wireBytes +=
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : ((data as { byteLength?: number } | undefined)?.byteLength ?? 0);
    };
    socketIo.engine.on(
      'connection',
      (raw: { on: (event: string, listener: typeof count) => void }) => {
        raw.on('packet', count);
        raw.on('packetCreate', count);
      },
    );
    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(
      createTreesTableCfg(TREE),
    );
    server = new Server(route, serverIo, new BsMem(), {
      syncConfig: SYNC,
      stamp: { domain: 'test', hub: 'hub' },
    });
    await server.init();
    socketIo.on('connection', (socket) => {
      void server.addSocket(new SocketIoBridge(socket));
    });
    await new Promise<void>((resolve) => http.listen(() => resolve()));
    port = (http.address() as AddressInfo).port;

    a = await mkNode('A');
    b = await mkNode('B');
    folders = async () =>
      JSON.stringify({
        A: await filesIn(a.folder),
        B: await filesIn(b.folder),
      });
    await startSync(a);
    await startSync(b);
    await new Promise((r) => setTimeout(r, 400));
  });

  afterEach(async () => {
    for (const n of [a, b]) {
      stopSync(n);
      await n.client.tearDown();
      n.socket.disconnect();
    }
    await server.tearDown();
    await new Promise<void>((resolve) => socketIo.close(() => resolve()));
    http.close();
    await rm(root, { recursive: true, force: true });
  });

  it('is added, changed and deleted on the other node', async () => {
    const v1 = noise(LARGE, 1);
    await writeFile(join(a.folder, 'big.bin'), v1);
    await until(
      'B holds version 1',
      async () => (await shaOfFile(join(b.folder, 'big.bin'))) === sha(v1),
    );

    // The whole file crossed twice: author to hub, hub to B.
    expect(wireBytes).toBeGreaterThan(2 * LARGE);

    // One kilobyte in the middle changes: only the blocks around it cross,
    // a few megabytes rather than the file.
    wireBytes = 0;
    const v2 = Buffer.from(v1);
    noise(1024, 2).copy(v2, LARGE / 2);
    await writeFile(join(a.folder, 'big.bin'), v2);
    await until(
      'B holds version 2',
      async () => (await shaOfFile(join(b.folder, 'big.bin'))) === sha(v2),
    );
    expect(wireBytes).toBeLessThan(LARGE / 6);

    // Deleted, together with an ordinary file in the same step, and nothing
    // is left behind on B.
    await writeFile(join(a.folder, 'small.txt'), 'small');
    await until(
      'B holds small.txt',
      async () =>
        (await readFile(join(b.folder, 'small.txt'), 'utf8').catch(
          () => '',
        )) === 'small',
    );
    await rm(join(a.folder, 'big.bin'));
    await rm(join(a.folder, 'small.txt'));
    await until(
      'B holds nothing',
      async () => (await filesIn(b.folder)).length === 0,
    );
  }, 240_000);

  it('keeps both versions when both nodes changed it while apart', async () => {
    const base = noise(LARGE, 3);
    await writeFile(join(a.folder, 'big.bin'), base);
    await until(
      'B holds the base',
      async () => (await shaOfFile(join(b.folder, 'big.bin'))) === sha(base),
    );

    stopSync(a);
    stopSync(b);
    const fromA = Buffer.from(base);
    noise(1024, 4).copy(fromA, 1024);
    const fromB = Buffer.from(base);
    noise(1024, 5).copy(fromB, LARGE - 4096);
    await writeFile(join(a.folder, 'big.bin'), fromA);
    await writeFile(join(b.folder, 'big.bin'), fromB);

    await startSync(a);
    await startSync(b);

    // Both versions on both nodes: one at big.bin, the other as a
    // conflicted copy.
    const both = async (n: Node): Promise<boolean> => {
      const shas = await Promise.all(
        (await filesIn(n.folder)).map((name) =>
          shaOfFile(join(n.folder, name)),
        ),
      );
      return shas.includes(sha(fromA)) && shas.includes(sha(fromB));
    };
    await until('A holds both versions', () => both(a), 120_000);
    await until('B holds both versions', () => both(b), 120_000);
    expect(a.agent.ownHead).toBe(b.agent.ownHead);
  }, 300_000);
});
