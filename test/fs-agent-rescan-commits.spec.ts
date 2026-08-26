// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// Reported from a live pair, on a real 3 702-file folder:
//
//   "fs.watch delivers only coarse [fs] modified: . events (folder level),
//    never per-file [fs] added — so new files are not detected. The safety
//    rescan DOES fire, and logs [fs] safety-rescan: ., but the newly found
//    files never reach the peer."
//
// The rescan is the designed answer to exactly that: Windows'
// ReadDirectoryChangesW coalesces or overflows on a large recursive tree, and
// the periodic full rescan is what catches what the watcher dropped. If a
// rescan finds new files and they are not announced, the fallback is decorative
// and a big folder cannot sync live at all.
describe('FsAgent — a change found only by the safety rescan', () => {
  const dir = join(process.cwd(), 'test-temp-rescan-commit');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // Sized like the folder the field report is about. The small-folder case
    // works; the report is that the large one does not, so the fixture has to
    // be large or it tests the wrong thing.
    const seedCount = Number(process.env.RESCAN_SEED_FILES ?? 20);
    await mkdir(join(dir, 'nested'), { recursive: true });
    for (let i = 0; i < seedCount; i++) {
      await writeFile(join(dir, 'nested', `seed-${i}.txt`), `seed-${i}`);
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Agent + connector wired together, with every outgoing ref recorded. */
  const wire = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };
    const agent = new FsAgent(dir, new BsMem(), {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    return { db, connector, agent, sent, socket };
  };

  /** Makes the watcher blind, as a coalesced or overflowed buffer does. */
  const blindTheWatcher = (agent: FsAgent): void => {
    agent.scanner.pauseWatch();
    (agent.scanner as unknown as { _pausedAt: number })._pausedAt =
      Date.now() - 10 * 60 * 1000;
  };

  // The field case, and the one the small-folder tests miss.
  //
  // A rescan that lands while a remote apply is running is DISCARDED, not
  // deferred. On a small folder an apply is instant, so a rescan almost never
  // lands inside one. On a big folder an apply takes seconds — and the rescan
  // runs every five — so nearly every rescan is thrown away and a file the
  // watcher missed is never announced at all.
  //
  // The reported symptom exactly: "the safety rescan fires and logs, but the
  // newly found files never reach the peer". That log line comes from the
  // host's own change handler, which runs BEFORE this guard, so seeing it
  // proves the scanner noticed — not that the agent acted.
  it('is not thrown away when a remote apply happens to be running', async () => {
    const { db, connector, agent, sent, socket } = await wire();
    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 1_500));
    sent.length = 0;

    blindTheWatcher(agent);
    await writeFile(join(dir, 'during-an-apply.txt'), 'appeared quietly');

    // A remote apply is in flight, as one usually is on a busy folder.
    (agent as unknown as { _remoteApplyInFlight: boolean })._remoteApplyInFlight =
      true;
    await (
      agent.scanner as unknown as { _runSafetyRescan(): Promise<void> }
    )._runSafetyRescan();
    await new Promise((r) => setTimeout(r, 400));

    // Correct: nothing goes out mid-apply, or it would re-assert stale state.
    expect(sent).toEqual([]);

    // A real apply now runs and finishes — which on a busy folder is simply
    // the next thing that happens. Whatever the earlier one made us postpone
    // must not have been lost with it.
    (agent as unknown as { _remoteApplyInFlight: boolean })._remoteApplyInFlight =
      false;
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: false,
    });
    const peerRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(dir, new BsMem()).extract(),
    );
    socket.emit(connector.events.ref, { o: 'remote-peer', r: peerRef });
    await new Promise((r) => setTimeout(r, 3_000));

    expect(sent.length).toBeGreaterThan(0);
    stopFrom();

    stop();
    agent.scanner.stopWatch();
  });

  it('is stored and announced, not just detected', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));

    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };

    const agent = new FsAgent(dir, new BsMem(), {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 1_500));
    sent.length = 0;

    // A file the watcher never reported — which is what a coalesced or
    // overflowed ReadDirectoryChangesW buffer looks like from the agent's side.
    //
    // Simulated by pausing the watcher so no per-file event can fire, and then
    // ageing the pause past the stuck threshold. That is deliberate: the rescan
    // is documented as the ONE notification that must survive a pause, exactly
    // so a dropped-event situation can still recover.
    agent.scanner.pauseWatch();
    (agent.scanner as unknown as { _pausedAt: number })._pausedAt =
      Date.now() - 10 * 60 * 1000;
    await writeFile(join(dir, 'missed-by-watcher.txt'), 'appeared quietly');

    // The rescan is the fallback that is supposed to notice.
    await (
      agent.scanner as unknown as { _runSafetyRescan(): Promise<void> }
    )._runSafetyRescan();
    await new Promise((r) => setTimeout(r, 2_500));

    // Detecting it is not enough — it has to reach a peer.
    expect(sent.length).toBeGreaterThan(0);

    stop();
    agent.scanner.stopWatch();
  });
});
