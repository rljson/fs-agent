// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// Refs do not arrive in the order they were sent, and on a large folder there
// are many of them. Measured on four machines: seeding 1 200 files produced
// trees of 989, then 1 099, then 911 nodes IN THAT ARRIVAL ORDER. The 911 was
// ten seconds stale when it landed, every node applied it — pruning 77 files
// each, well under the mass-delete guard's floor — and then re-advertised that
// older state as its own, because a rescan of a restored folder reproduces the
// ref it restored from. Three of four nodes converged on a tree missing 35
// files, including the node that had created them.
//
// The guard cannot catch this. It refuses catastrophes, and every step here is
// small. Only causality can.
describe('FsAgent — an ancestor is not news', () => {
  const sourceDir = join(process.cwd(), 'test-temp-ancestor-source');
  const targetDir = join(process.cwd(), 'test-temp-ancestor-target');

  beforeEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const makeDb = async (): Promise<Db> => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    return db;
  };

  const makeConnector = (db: Db) => {
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    return Object.assign(connector, {
      simulateIncoming: (ref: string, predecessorRefs?: string[]) =>
        socket.emit(connector.events.ref, {
          o: 'remote-peer',
          r: ref,
          p: predecessorRefs,
        }),
    });
  };

  // The default deployment. `resolveConflicts` is OFF here deliberately: that
  // is the configuration the customer runs, and the configuration in which
  // this protection did not exist.
  it('ignores a stale ref that arrives after its own descendant', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    const adapter = new FsDbAdapter(db, 'fsTree');

    // The older state: two files.
    await writeFile(join(sourceDir, 'one.txt'), '1');
    await writeFile(join(sourceDir, 'two.txt'), '2');
    const olderRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );
    const olderTimeIds = await db.getTimeIdsForRef('fsTree', olderRef);

    // Its descendant: a third file added.
    await writeFile(join(sourceDir, 'three.txt'), '3');
    const newerRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
      { previous: [olderTimeIds[olderTimeIds.length - 1]] },
    );

    const agent = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    // In order first, so the target reaches the newer state.
    connector.simulateIncoming(newerRef, [olderRef]);
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(join(targetDir, 'three.txt'))).toBe(true);

    // Then the straggler: the state this one descends from, arriving late.
    connector.simulateIncoming(olderRef, []);
    await new Promise((r) => setTimeout(r, 400));

    // Nothing is pruned. Applying the ancestor would have deleted three.txt —
    // one file here, seventy-seven per node in the lab.
    expect(existsSync(join(targetDir, 'three.txt'))).toBe(true);
    expect(existsSync(join(targetDir, 'one.txt'))).toBe(true);
    expect(existsSync(join(targetDir, 'two.txt'))).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes('is an ancestor of the state'),
      ),
    ).toBe(true);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

  // The other direction has to keep working, or the cure is worse: a genuine
  // deletion that descends from what this node holds must still prune.
  it('still applies a ref that descends from the current state', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    const adapter = new FsDbAdapter(db, 'fsTree');

    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'stays.txt'), 'stays');
    const parentRef = await adapter.storeFsTree(
      await new FsAgent(targetDir, bs).extract(),
    );
    const parentTimeIds = await db.getTimeIdsForRef('fsTree', parentRef);

    await writeFile(join(sourceDir, 'stays.txt'), 'stays');
    const newerRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
      { previous: [parentTimeIds[parentTimeIds.length - 1]] },
    );

    const agent = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    connector.simulateIncoming(newerRef, [parentRef]);
    await new Promise((r) => setTimeout(r, 400));

    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);
    expect(existsSync(join(targetDir, 'stays.txt'))).toBe(true);

    stop();
    agent.scanner.stopWatch();
  });
});
