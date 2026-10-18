// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// "Diverged" must mean the CONTENT differs, not that the names do.
//
// A field measurement recorded what the opposite costs. After a forced 40 s
// partition both machines held identical content (38 files, identical hashes)
// and one reported `diverged: true` for over EIGHT MINUTES across six merge
// repairs. Nothing was lost, and the divergence signal — which the UI's
// "weicht ab" is built on — was permanently untrustworthy.
//
// In 0.2.0 a head names a tree, and two heads can name the same content: a
// peer's edit that ends where this folder already is. That is one state under
// two names, and it must settle without anybody reporting a divergence. A head
// whose content really differs must be reported until the fleet agrees.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { announceAsPeer } from './chain-announce.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const TREE = 'fsTree';

describe('a divergence is a difference in CONTENT', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-divergence-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * An agent syncing the temp folder, plus a way to play the hub's beacon.
   * @returns The agent, the db, and a `beacon` that says a head.
   */
  const start = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${TREE}`), socket, {
      causalOrdering: true,
      includeClientIdentity: true,
    });
    const agent = new FsAgent(dir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, TREE));
    stops.push(await agent.syncFromDb(db, connector, TREE));
    return {
      agent,
      db,
      beacon: (head: string) =>
        socket.emit(stateBeaconEvent(connector.route.flat), { r: head }),
    };
  };

  // ...........................................................................
  it('does not report a divergence for identical content under a different head', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    const own = agent.ownHead as string;
    const tree = await agent.extract();

    // A peer's edit that ends exactly where this folder already is.
    const peer = await announceAsPeer(db, TREE, {
      tree,
      changed: ['a.txt'],
      previous: [own],
    });
    expect(peer.head, 'the two heads must differ, or this proves nothing')
      .not.toBe(own);

    beacon(peer.head);
    await sleep(200);

    const status = agent.antiEntropyStatus!;
    expect(status.diverged).toBe(false);
    expect(status.localRef).toBe(peer.head);
  });

  // ...........................................................................
  it('still reports a divergence when the content really differs', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    const { agent, db, beacon } = await start();
    const own = agent.ownHead as string;

    // Both sides moved on from the same state, differently.
    await writeFile(join(dir, 'mine.txt'), 'mine');
    for (let i = 0; i < 100 && agent.ownHead === own; i++) await sleep(20);
    expect(agent.ownHead, 'this side never authored its edit').not.toBe(own);
    const peerDir = `${dir}-peer`;
    await mkdir(peerDir, { recursive: true });
    await writeFile(join(peerDir, 'a.txt'), 'a');
    await writeFile(join(peerDir, 'theirs.txt'), 'theirs');
    const peerAgent = new FsAgent(peerDir, agent.bs, ORIGIN_FIXTURE);
    const peer = await announceAsPeer(db, TREE, {
      tree: await peerAgent.extract(),
      changed: ['theirs.txt'],
      previous: [own],
    });
    await rm(peerDir, { recursive: true, force: true });

    beacon(peer.head);
    await sleep(300);

    // Merged — both files are here — and still different from what the hub
    // says until the hub hears the merge.
    const status = agent.antiEntropyStatus!;
    expect(status.diverged).toBe(true);
    expect(status.lastRepair?.action).toBe('merge');
    expect(status.hubRef).toBe(peer.head);
  });
});
