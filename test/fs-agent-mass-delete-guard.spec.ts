// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import {
  FsAgent,
  MASS_DELETE_MIN_FILES,
  MassDeleteRefusedError,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// The dangerous direction of sync is a POPULATED node receiving a tree that
// lacks its files. A peer that comes up empty — a fresh clone, a folder not yet
// mounted, a bootstrap that raced its own first scan — advertises an empty
// tree, and every other node faithfully deletes everything it has.
describe('FsAgent — the mass-delete guard', () => {
  const sourceDir = join(process.cwd(), 'test-temp-guard-source');
  const targetDir = join(process.cwd(), 'test-temp-guard-target');

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

  /** Fills a folder with `n` numbered files. */
  const fill = async (dir: string, n: number, prefix = 'f') => {
    for (let i = 0; i < n; i++) {
      await writeFile(join(dir, `${prefix}${i}.txt`), `content-${i}`);
    }
  };

  /** The tree of `sourceDir` as it currently stands. */
  const sourceTree = (bs: BsMem) => new FsAgent(sourceDir, bs).extract();

  /** Files currently in the target. */
  const targetFiles = async () =>
    (await readdir(targetDir)).filter((f) => f !== SYNC_ERROR_FILE);

  const POPULATED = MASS_DELETE_MIN_FILES + 20;

  it('refuses an empty incoming tree against a populated folder', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs); // source is empty
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs).restore(tree, targetDir, {
        cleanTarget: true,
      }),
    ).rejects.toBeInstanceOf(MassDeleteRefusedError);

    // Nothing deleted — that is the entire point.
    expect(await targetFiles()).toHaveLength(POPULATED);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).includes('MASS DELETE REFUSED'),
      ),
    ).toBe(true);
    errSpy.mockRestore();
  });

  it('records the refusal where an operator will find it', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new FsAgent(targetDir, bs)
      .restore(tree, targetDir, { cleanTarget: true })
      .catch(() => undefined);

    expect(existsSync(join(targetDir, SYNC_ERROR_FILE))).toBe(true);
    errSpy.mockRestore();
  });

  it('reports what it refused, so the numbers can be judged', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = (await new FsAgent(targetDir, bs)
      .restore(tree, targetDir, { cleanTarget: true })
      .catch((e: unknown) => e)) as MassDeleteRefusedError;

    expect(err.wouldPrune).toBe(POPULATED);
    expect(err.totalFiles).toBe(POPULATED);
    expect(err.incomingFiles).toBe(0);
    expect(err.message).toContain('NO files at all');
    errSpy.mockRestore();
  });

  // The guard has to stay out of the way of ordinary work, or it gets disabled.
  it('allows an ordinary deletion of a few files', async () => {
    const bs = new BsMem();
    await fill(sourceDir, POPULATED);
    await fill(targetDir, POPULATED);
    // Source drops three of them.
    for (const i of [0, 1, 2]) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(POPULATED - 3);
  });

  it('allows a large deletion that is still a minority of the folder', async () => {
    const bs = new BsMem();
    const total = 500;
    await fill(sourceDir, total);
    await fill(targetDir, total);
    // 120 files: over the count floor, but under the ratio.
    for (let i = 0; i < 120; i++) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(total - 120);
  });

  it('refuses a majority deletion even when the tree is not empty', async () => {
    const bs = new BsMem();
    const total = 400;
    await fill(sourceDir, total);
    await fill(targetDir, total);
    for (let i = 0; i < 300; i++) await rm(join(sourceDir, `f${i}.txt`));
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs).restore(tree, targetDir, {
        cleanTarget: true,
      }),
    ).rejects.toBeInstanceOf(MassDeleteRefusedError);
    expect(await targetFiles()).toHaveLength(total);
    errSpy.mockRestore();
  });

  // Emptying a small folder is an ordinary edit. A guard that blocked it would
  // fire constantly on small trees and be turned off.
  it('allows a small folder to be emptied', async () => {
    const bs = new BsMem();
    await fill(targetDir, 5);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(0);
  });

  // The correction the lab forced, and the reason this is not symmetric with
  // the locked-file case. The peer that sent the sparse tree is the one
  // MISSING data; this node holds the fuller copy. If it goes quiet after
  // refusing, the sparse peer has nothing to catch up from — and with every
  // populated node refusing its pushes, the network livelocks. Measured on
  // four machines, where two nodes sat at 5 and 15 of 121 files.
  it('keeps advertising its own state after refusing, so the sparse peer can catch up', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    const treeKey = 'fsTree';
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

    const bs = new BsMem();
    await fill(targetDir, POPULATED);

    // A peer advertises an almost-empty tree.
    await fill(sourceDir, 2, 'sparse');
    const sparseRef = await new FsDbAdapter(db, treeKey).storeFsTree(
      await sourceTree(bs),
    );

    const route = Route.fromFlat(`/${treeKey}+`);
    const socket = new SocketMock();
    const connector = new Connector(db, route, socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };
    const agent = new FsAgent(targetDir, bs, {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stopTo = await agent.syncToDb(db, connector, treeKey);
    const stopFrom = await agent.syncFromDb(db, connector, treeKey, {
      cleanTarget: true,
    });

    // Count only what goes out AFTER the refusal — syncToDb's initial store
    // has already sent one ref.
    sent.length = 0;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: sparseRef });
    await new Promise((r) => setTimeout(r, 500));

    // Refused: nothing DELETED. The two incoming files were still added —
    // the restore is additive and only the prune is refused, which is the
    // right split: new data is never the dangerous part.
    const after = await targetFiles();
    expect(after.filter((f) => f.startsWith('f'))).toHaveLength(POPULATED);
    expect(after.filter((f) => f.startsWith('sparse'))).toHaveLength(2);

    // …and crucially the node still SAYS something. After a refusal the
    // watcher resumes, sees the two files the restore did add, and broadcasts
    // the folder as it now stands — 120 files plus those two.
    //
    // The suppression that is right for a locked file silences exactly this,
    // and here that is the livelock: the only node with the full copy goes
    // quiet, and the sparse peer has nothing to catch up from.
    expect(sent.length).toBeGreaterThan(0);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
    errSpy.mockRestore();
  });

  // The test above passes for an incidental reason: the sparse tree carried two
  // files, the restore added them, the watcher woke on the change and broadcast
  // the folder. Nothing was DELIBERATE about the answer.
  //
  // An EMPTY incoming tree adds nothing. The folder does not change, the
  // watcher has nothing to report, and the node with the full copy says
  // nothing at all — which is the deadlock a joining machine actually hits.
  // Measured on two clients: an empty joiner sat at 0 of 3642 files for 60 s.
  it('answers an empty tree with its own state, though nothing changed', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    const treeKey = 'fsTree';
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

    const bs = new BsMem();
    await fill(targetDir, POPULATED);

    // sourceDir is left empty — the joiner holds nothing.
    const emptyRef = await new FsDbAdapter(db, treeKey).storeFsTree(
      await sourceTree(bs),
    );

    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${treeKey}+`), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };

    const agent = new FsAgent(targetDir, bs, {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // syncToDb gives the agent a current ref — the state it will answer with.
    const stopTo = await agent.syncToDb(db, connector, treeKey);
    const stopFrom = await agent.syncFromDb(db, connector, treeKey, {
      cleanTarget: true,
    });

    sent.length = 0;
    socket.emit(connector.events.ref, { o: 'remote-peer', r: emptyRef });
    await new Promise((r) => setTimeout(r, 500));

    // Nothing was deleted…
    expect(
      (await targetFiles()).filter((f) => f.startsWith('f')),
    ).toHaveLength(POPULATED);
    // …and the folder is byte-for-byte what it was, so only a deliberate
    // answer can have put anything on the wire.
    expect(sent.length).toBeGreaterThan(0);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes('re-announcing'),
      ),
    ).toBe(true);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // Two nodes can refuse each other, each holding files the other lacks. An
  // unthrottled answer to every refusal is a loop.
  it('answers at most once per cooldown', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    const treeKey = 'fsTree';
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const adapter = new FsDbAdapter(db, treeKey);
    const emptyRef = await adapter.storeFsTree(await sourceTree(bs));
    await fill(sourceDir, 1, 'other');
    const otherSparseRef = await adapter.storeFsTree(await sourceTree(bs));

    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${treeKey}+`), socket);
    const agent = new FsAgent(targetDir, bs, {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stopTo = await agent.syncToDb(db, connector, treeKey);
    const stopFrom = await agent.syncFromDb(db, connector, treeKey, {
      cleanTarget: true,
    });

    warnSpy.mockClear();
    socket.emit(connector.events.ref, { o: 'remote-peer', r: emptyRef });
    await new Promise((r) => setTimeout(r, 300));
    socket.emit(connector.events.ref, { o: 'other-peer', r: otherSparseRef });
    await new Promise((r) => setTimeout(r, 300));

    const answers = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('re-announcing'),
    );
    expect(answers).toHaveLength(1);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // Nothing to answer WITH: an agent that has never pushed has no current ref,
  // and inventing one would be asserting a state it has not established.
  it('says nothing when it has no state of its own to offer', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    const treeKey = 'fsTree';
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const emptyRef = await new FsDbAdapter(db, treeKey).storeFsTree(
      await sourceTree(bs),
    );

    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat(`/${treeKey}+`), socket);
    const agent = new FsAgent(targetDir, bs, {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // syncFromDb only — never pushed, so no current ref.
    const stopFrom = await agent.syncFromDb(db, connector, treeKey, {
      cleanTarget: true,
    });
    warnSpy.mockClear();
    socket.emit(connector.events.ref, { o: 'remote-peer', r: emptyRef });
    await new Promise((r) => setTimeout(r, 300));

    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('re-announcing')),
    ).toBe(false);
    expect(
      (await targetFiles()).filter((f) => f.startsWith('f')),
    ).toHaveLength(POPULATED);

    stopFrom();
    agent.scanner.stopWatch();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does not interfere when cleanTarget is off', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir);

    expect(await targetFiles()).toHaveLength(POPULATED);
  });

  // A fresh client with an empty folder must still be able to receive: there is
  // nothing to lose, so the guard has no business firing.
  it('lets a fresh empty client receive a large tree', async () => {
    const bs = new BsMem();
    await fill(sourceDir, POPULATED);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(POPULATED);
  });
});
