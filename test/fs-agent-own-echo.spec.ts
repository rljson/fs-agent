// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

// A client destroyed its OWN edit by applying its OWN last advertisement back
// over it.
//
// Traced in a two-client run while the server repeated a new connection\'s
// bootstrap:
//
//   RESTORE root=a ref=joLcfgkh lastSent=joLcfgkh newest=true
//   syncToDb tick key=<v1> lastSent=<v1>  →  DROP: content-key dedup
//
// three times in one attempt. The client restored the state it had itself just
// broadcast, which undid the edit it had not yet sent, and then declined to
// send anything because the folder was back at the content it had already
// sent. The edit reached no peer and was gone locally too.
//
// In 0.2.0 it cannot happen by construction: a node authors its own work
// before it judges anything that arrived, so its own echoed head finds the
// node AHEAD of it, and the answer is to announce, never to restore.
describe('FsAgent — its own advertisement echoed back', () => {
  const dir = join(process.cwd(), 'test-temp-own-echo');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 300 && !(await check()); i++) await sleep(10);
    expect(await check(), `timed out waiting: ${what}`).toBe(true);
  };

  const makeDb = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    return db;
  };

  it('is ignored, so a newer local edit survives', async () => {
    const db = await makeDb();
    const bs = new BsMem();

    await writeFile(join(dir, 'shared.txt'), 'v1');

    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 20 },
    });
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);

    // Records and announces the folder as it stands.
    const stopToDb = await agent.syncToDb(db, connector, 'fsTree');
    await until(() => agent.ownHead !== undefined, 'the first head');
    const ownHead = agent.ownHead as string;

    // Stop pushing. The edit below then stays un-sent, which is the situation
    // the trace captured: the echo lands while the agent's newest state is
    // still only on disk, so its last announcement is the one being echoed.
    stopToDb();
    const stop = await agent.syncFromDb(db, connector, 'fsTree');

    // The user edits the file. This is the state that must survive.
    await writeFile(join(dir, 'shared.txt'), 'v2');

    // Seen by the scanner before the echo arrives — still un-sent, as in the
    // trace. Otherwise a watcher pass that caught the write half-done holds it
    // back past the echo, and with the push stopped nothing would record it.
    const { blobId: v2 } = await bs.setBlob('v2');
    await until(async () => {
      await agent.scanner.scanFresh();
      return agent.scanner.knownFile('shared.txt')?.blobId === v2;
    }, 'the scanner to read the edit');

    // The server echoes the agent's own head back — server as origin, so the
    // connector's self-filter does not fire.
    socket.emit(connector.events.ref, {
      o: '__server__',
      r: ownHead,
      c: '__server__',
      seq: 99,
    });
    await until(() => agent.ownHead !== ownHead, 'the edit to be authored');

    // The edit is still there, and it is in the chain: the folder's own work
    // is authored before anything that arrived is judged.
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('v2');
    expect(agent.ownHead).not.toBe(ownHead);

    stop();
    agent.scanner.stopWatch();
  });

});
