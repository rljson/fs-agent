// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// Deleting a file propagated only when the DELETER had created it. A client
// that had merely received the file could delete it, and the file stayed
// forever on the peer.
//
// A tree ref is a content hash, so a folder returning to an earlier state
// re-derives that state's exact ref — and deleting a file returns the folder to
// precisely the state it was in before that file existed.
//
// The receive path already knew this: adopting a state retires the one it
// leaves (`_adoptAppliedRef`), so a later return to the left state is
// deliverable. The SEND path did not. An agent that moved off a state by its
// own edit left that state's ref marked "already received" for good, and the
// peer's advertisement of it was dropped by the connector before any listener
// saw it.
describe('FsAgent — leaving a state by its own edit retires that state', () => {
  const dir = join(process.cwd(), 'test-temp-send-retire');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hands the previous ref back to the connector on every push', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));

    await writeFile(join(dir, 'seed.txt'), 'seed');

    // The ref of the state the folder is about to leave. A tree ref is a pure
    // content hash, so deriving it here yields the same string the agent does.
    const bs = new BsMem();
    const seedRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(dir, bs).extract(),
    );

    const agent = new FsAgent(dir, bs, {
      timeouts: { debounceMs: 20, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), new SocketMock());
    const retired = vi.spyOn(connector, 'invalidateReceived');

    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 300));

    retired.mockClear();

    // A local edit moves the folder off it.
    await writeFile(join(dir, 'added.txt'), 'added');
    await new Promise((r) => setTimeout(r, 600));

    // Deleting `added.txt` on a PEER returns that peer's folder to `seedRef`
    // and it advertises exactly that ref. Unless it has been retired here,
    // the connector drops it as already-received and the deletion never
    // arrives.
    expect(retired).toHaveBeenCalledWith(seedRef);

    stop();
    agent.scanner.stopWatch();
  });
});
