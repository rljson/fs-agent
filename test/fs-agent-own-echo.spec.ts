// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

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
// Neither existing defence sees it. The origin filter compares the payload\'s
// origin to this connector\'s, and a bootstrap carries the SERVER as origin.
// The staleness check asks whether this is the newest thing its sender has
// said — and the sender it sees is the server, whose count did advance.
describe('FsAgent — its own advertisement echoed back', () => {
  const dir = join(process.cwd(), 'test-temp-own-echo');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

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

    // The ref the agent will broadcast. A tree ref is a pure content hash and
    // excludes mtime, so recomputing it here yields the same string the agent
    // derives from the same bytes.
    const ownRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(dir, bs).extract(),
    );

    const agent = new FsAgent(dir, bs, {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);

    // Broadcasts the folder as it stands — and, as `_sendRef` always does,
    // retires that ref from both dedup sets, which is what leaves the agent
    // reachable by its own advertisement.
    const stopToDb = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 300));

    // Stop pushing. The edit below then stays un-sent, which is the situation
    // the trace captured: the echo lands while the agent's newest state is
    // still only on disk, so its last advertisement is the one being echoed.
    stopToDb();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    // The user edits the file. This is the state that must survive.
    await writeFile(join(dir, 'shared.txt'), 'v2');

    // The server echoes the agent's own ref back on the bootstrap channel —
    // server as origin, so the connector's self-filter does not fire, and a
    // sequence the server has advanced, so the staleness check reads it as
    // news.
    socket.emit(connector.events.ref, {
      o: '__server__',
      r: ownRef,
      c: '__server__',
      seq: 99,
    });
    await new Promise((r) => setTimeout(r, 600));

    // The edit is still there — the echo did not roll the folder back.
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('v2');
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes('own last advertisement echoed back'),
      ),
    ).toBe(true);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

});
