// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readFile, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

// What the hub says, received by hand: its head arrives on the bootstrap or
// on the state beacon, so a test can play the hub without one. The end-to-end
// behaviour is in `client-server/heals-after-forced-divergence.spec.ts`.
describe('FsAgent — receiving what the hub says', () => {
  const dir = join(process.cwd(), 'test-temp-anti-entropy-wiring');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let stops: Array<() => void> = [];
  let agents: FsAgent[] = [];

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
    stops = [];
    agents = [];
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    for (const agent of agents) agent.scanner.stopWatch();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const start = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree'), socket);
    await writeFile(join(dir, 'a.txt'), 'a');
    const agent = new FsAgent(dir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, 'fsTree'));
    stops.push(await agent.syncFromDb(db, connector, 'fsTree'));
    const announce = (payload: unknown) =>
      socket.emit(connector.events.bootstrap, payload);
    const beacon = (payload: unknown) =>
      socket.emit(stateBeaconEvent(connector.route.flat), payload);
    return { agent, db, connector, socket, announce, beacon };
  };

  it('reports nothing before it has started', () => {
    expect(new FsAgent(dir).antiEntropyStatus).toBeNull();
  });

  it('ignores an announcement that names no head', async () => {
    const { agent, announce } = await start();
    announce({ o: 'hub' });
    announce({ o: 'hub', r: 42 });
    announce({ o: 'hub', r: '' });
    await sleep(50);
    expect(agent.antiEntropyStatus).toBeNull();
  });

  // The signal a host client runs on: its heartbeat is off.
  it('hears the state beacon, and reports agreement with its own head', async () => {
    const { agent, beacon } = await start();
    beacon({ o: 'hub', r: agent.ownHead });
    await sleep(50);
    expect(agent.antiEntropyStatus).toMatchObject({
      diverged: false,
      hubRef: agent.ownHead,
      localRef: agent.ownHead,
    });
  });

  // A head nobody can read is not evidence of anything. Nothing is changed,
  // and it is said once per pair of heads, not once per beacon.
  it('reports a head whose history cannot be read as blocked, once', async () => {
    const { agent, beacon } = await start();
    beacon({ o: 'hub', r: 'aHeadNobodyHolds' });
    await sleep(100);
    beacon({ o: 'hub', r: 'aHeadNobodyHolds' });
    await sleep(100);

    expect(agent.antiEntropyStatus).toMatchObject({
      diverged: true,
      hubRef: 'aHeadNobodyHolds',
      lastRepair: { action: 'blocked', attempt: 2 },
    });
    const blocked = agent.signals.filter((s) => s.kind === 'repair/blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].action).toBe('review');
  });

  // A status left behind would keep describing a divergence nobody watches.
  it('stops listening, and stops reporting, when sync stops', async () => {
    const { agent, beacon } = await start();
    beacon({ o: 'hub', r: agent.ownHead });
    await sleep(50);
    expect(agent.antiEntropyStatus).not.toBeNull();
    for (const stop of stops) stop();
    stops = [];
    expect(agent.antiEntropyStatus).toBeNull();
    beacon({ o: 'hub', r: agent.ownHead });
    await sleep(50);
    expect(agent.antiEntropyStatus).toBeNull();
  });

  it('keeps a newer receive side’s status when an older one stops', async () => {
    const { agent, db } = await start();
    const older = stops.pop() as () => void;
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree'), socket);
    stops.push(await agent.syncFromDb(db, connector, 'fsTree'));
    socket.emit(stateBeaconEvent(connector.route.flat), { r: agent.ownHead });
    await sleep(50);
    const current = agent.antiEntropyStatus;
    expect(current).not.toBeNull();

    older();
    expect(agent.antiEntropyStatus).toEqual(current);
  });

  it('records an announcement that fails, rather than throwing it away', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { agent, connector, beacon } = await start();
    const first = agent.ownHead as string;
    await writeFile(join(dir, 'b.txt'), 'b');
    for (let i = 0; i < 100 && agent.ownHead === first; i++) await sleep(20);
    expect(agent.ownHead).not.toBe(first);
    vi.spyOn(connector, 'send').mockImplementation(() => {
      throw new Error('socket gone');
    });

    // The hub holds an earlier head of OURS: it missed the latest one.
    beacon({ o: 'hub', r: first });
    await sleep(100);

    expect(agent.antiEntropyStatus?.lastRepair?.action).toBe('push');
    const log = await readFile(join(dir, SYNC_ERROR_FILE), 'utf8');
    expect(log).toContain('announce');
    expect(log).toContain('socket gone');
  });
});
