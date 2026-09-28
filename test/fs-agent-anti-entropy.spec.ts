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

// The anti-entropy's wiring inside the agent, driven by hand: a hub
// announcement is a `bootstrap` event on the connector's socket, so a test can
// play the hub without one. The end-to-end behaviour is in
// `client-server/heals-after-forced-divergence.spec.ts`.
describe('FsAgent — anti-entropy wiring', () => {
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
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
      antiEntropy: { graceMs: 1, maxBackoffMs: 1 },
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

  it('ignores an announcement that names no ref', async () => {
    const { agent, announce } = await start();
    announce({ o: 'hub' });
    announce({ o: 'hub', r: 42 });
    expect(agent.antiEntropyStatus?.hubRef).toBeNull();
  });

  // The signal a CARAT One Client runs on: its heartbeat is off.
  it('hears the state beacon, which the connector ignores', async () => {
    const { agent, beacon } = await start();
    beacon({ o: 'hub', r: 'hub-state', p: ['x'] });
    expect(agent.antiEntropyStatus?.hubRef).toBe('hub-state');
  });

  // A stopped sync reports nothing (review, ONE-446): a status left behind
  // would keep describing a divergence nobody is watching.
  it('stops listening, and stops reporting, when sync stops', async () => {
    const { agent, beacon } = await start();
    beacon({ o: 'hub', r: 'before-stop' });
    expect(agent.antiEntropyStatus?.hubRef).toBe('before-stop');
    for (const stop of stops) stop();
    stops = [];
    expect(agent.antiEntropyStatus).toBeNull();
    beacon({ o: 'hub', r: 'after-stop' });
    expect(agent.antiEntropyStatus).toBeNull();
  });

  it('keeps a newer sync’s status when an older one stops', async () => {
    const { agent, db, connector } = await start();
    const olderStop = stops.pop() as () => void;
    // A second receive side on the same agent replaces the first…
    stops.push(await agent.syncFromDb(db, connector, 'fsTree'));
    const current = agent.antiEntropyStatus;
    // …and stopping the OLD one must not wipe the new one's reading.
    olderStop();
    expect(agent.antiEntropyStatus).toEqual(current);
  });

  it('records a re-push that fails, rather than throwing it away', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { agent, connector, announce } = await start();
    vi.spyOn(connector, 'send').mockImplementation(() => {
      throw new Error('socket gone');
    });

    // The hub holds an earlier push of OURS: it missed the latest one.
    const hub = { o: connector.origin, r: 'an-earlier-state-of-ours' };
    announce(hub);
    await sleep(5);
    announce(hub);

    expect(agent.antiEntropyStatus?.lastRepair?.action).toBe('push');
    // _withRetry tries three times, 100 ms apart.
    await sleep(600);
    const log = await readFile(join(dir, SYNC_ERROR_FILE), 'utf8');
    expect(log).toContain('antiEntropy/push');
    expect(log).toContain('socket gone');
  });

  it('falls back to an additive apply when the first merge made no progress', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { agent, announce } = await start();

    // A state nobody here can relate to, and one this node cannot fetch: the
    // repair fails every time, so it is attempted again and again.
    // Carrying the hub's announce id and state count, as a real heartbeat
    // does: without them the connector reads every repeat as news and keeps
    // the agent busy applying it, which is not the case being tested.
    const hub = {
      o: 'someone-else',
      r: 'unrelated',
      p: ['elsewhere'],
      c: '__server__:hub',
      seq: 1,
    };
    for (let i = 0; i < 40 && (agent.antiEntropyStatus?.repairs ?? 0) < 2; i++) {
      announce(hub);
      await sleep(25);
    }

    const repairs = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('anti-entropy:'));
    expect(repairs[0]).toContain('merge (attempt 1)');
    expect(repairs[1]).toContain('merge (attempt 2)');
  });
});
