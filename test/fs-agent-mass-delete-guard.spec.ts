// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db, stateBeaconEvent } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import {
  FsAgent,
  MASS_DELETE_MIN_FILES,
  MassDeleteRefusedError,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import { SIGNAL_LOG_FILE } from '../src/fs-signals.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// The dangerous direction of sync is a POPULATED node receiving a tree that
// lacks its files. A peer that comes up empty — a fresh clone, a folder not yet
// mounted, a bootstrap that raced its own first scan — advertises an empty
// tree, and every other node faithfully deletes everything it has.
describe('FsAgent — the mass-delete guard', () => {
  // A FOLDER PER TEST, not one folder reused.
  //
  // Several tests here start a live agent against the shared folder, and a
  // `stop()` does not cancel work already in flight: an apply scheduled a
  // moment earlier still runs, scans, and writes. With one folder for the
  // whole file that lands in the NEXT test's folder — measured as 121 files
  // where 120 were written (a stray `.fsagent-state.json`) and as 117 of 120
  // restored, because a leftover agent pruned what the test had just put
  // there. Both read as defects in the code under test and were neither.
  let nth = 0;
  let sourceDir = '';
  let targetDir = '';

  beforeEach(async () => {
    nth++;
    sourceDir = join(process.cwd(), `test-temp-guard-source-${nth}`);
    targetDir = join(process.cwd(), `test-temp-guard-target-${nth}`);
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
  const sourceTree = (bs: BsMem) => new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract();

  /** Files currently in the target. */
  // The agent's own bookkeeping is not content, so it is not counted. Every
  // file it keeps in the folder it watches has to be listed here — a refusal
  // now writes a signal as well as a log line, and counting that made the
  // folder look one file larger than the guard had left it.
  const AGENT_OWN = [SYNC_ERROR_FILE, SIGNAL_LOG_FILE];
  const targetFiles = async () =>
    (await readdir(targetDir)).filter((f) => !AGENT_OWN.includes(f));

  const POPULATED = MASS_DELETE_MIN_FILES + 20;

  it('refuses an empty incoming tree against a populated folder', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs); // source is empty
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
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

    const agent = new FsAgent(targetDir, bs, ORIGIN_FIXTURE);
    await agent
      .restore(tree, targetDir, { cleanTarget: true })
      .catch(() => undefined);

    // A refusal is a signal a person has to act on, persisted for a host that
    // starts later — not an error.
    expect(agent.signalsNeedingAction.map((s) => s.kind)).toEqual([
      'deletion/refused',
    ]);
    expect(existsSync(join(targetDir, SIGNAL_LOG_FILE))).toBe(true);
    errSpy.mockRestore();
  });

  it('reports what it refused, so the numbers can be judged', async () => {
    const bs = new BsMem();
    await fill(targetDir, POPULATED);
    const tree = await sourceTree(bs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = (await new FsAgent(targetDir, bs, ORIGIN_FIXTURE)
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

    await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
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

    await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
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
      new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
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

    await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(0);
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
      ...ORIGIN_FIXTURE,
      timeouts: {
        debounceMs: 1,
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

    await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir);

    expect(await targetFiles()).toHaveLength(POPULATED);
  });

  // A fresh client with an empty folder must still be able to receive: there is
  // nothing to lose, so the guard has no business firing.
  it('lets a fresh empty client receive a large tree', async () => {
    const bs = new BsMem();
    await fill(sourceDir, POPULATED);
    const tree = await sourceTree(bs);

    await new FsAgent(targetDir, bs, ORIGIN_FIXTURE).restore(tree, targetDir, {
      cleanTarget: true,
    });

    expect(await targetFiles()).toHaveLength(POPULATED);
  });
  // ...........................................................................
  it('does not record a folder that emptied without the watcher seeing it go', async () => {
    // The sender's half of the guard. A folder that empties while not one
    // deletion was seen — a drive that went away, a restore that wiped it —
    // is not somebody deleting files, and recording it would delete them on
    // every node. The watcher is stopped here, so the test means the same
    // thing on every platform: macOS reports a recursive delete as one event
    // for the folder, Linux as one per file.
    await fill(targetDir, 12);
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree'), socket);
    const agent = new FsAgent(targetDir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 1 },
    });
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    try {
      const own = agent.ownHead as string;
      agent.scanner.stopWatch();
      for (const file of await targetFiles()) await rm(join(targetDir, file));

      // A receive records the folder's own work before anything else.
      socket.emit(stateBeaconEvent(connector.route.flat), { r: own });
      for (let i = 0; i < 300 && agent.signalsNeedingAction.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const [refusal] = agent.signalsNeedingAction;
      expect(refusal?.kind).toBe('deletion/refused');
      expect(refusal?.detail).toContain('12 of 12 files disappeared');
      expect(refusal?.detail).toContain('The watcher did not see them go');
      expect(refusal?.paths).toHaveLength(12);
      expect(agent.ownHead, 'the disappearance was recorded').toBe(own);
    } finally {
      stopTo();
      stopFrom();
    }
  });

  // ...........................................................................
  it('reports each refusal where a client can read it', async () => {
    // THE REFUSAL IS A DEFERRED DECISION, AND SOMEBODY HAS TO BE ASKED.
    //
    // The guard is right to refuse — a wiped peer telling the fleet to wipe is
    // what it exists for — and it is wrong for a user who deleted 10 000 files
    // on purpose. Nothing in this package can tell those apart, so the
    // deletion simply never happens, on every node, and no message will fix
    // that.
    //
    // Until a client asks the user, the least it can do is SAY SO: a log line
    // is not readable by a UI on another machine, and "why did my deletion not
    // arrive" is exactly the question that UI has to answer. A refusal is a
    // `required` signal. See `README.public.md`, "Known constraints".
    const dir = await mkdtemp(join(tmpdir(), 'fs-agent-refusals-'));
    const agent = new FsAgent(dir);
    try {
      expect(
        agent.signalsNeedingAction,
        'a fresh agent has refused nothing',
      ).toEqual([]);

      (
        agent as unknown as {
          _refuseDeletion: (
            route: string,
            wouldRemove: number,
            held: number,
            paths: readonly string[],
          ) => void;
        }
      )._refuseDeletion('removals', 150, 160, ['a.txt', 'b.txt']);

      const [refusal] = agent.signalsNeedingAction;
      expect(refusal.kind).toBe('deletion/refused');
      expect(refusal.action).toBe('required');
      expect(
        refusal.paths,
        'a client has no paths to put in front of the user',
      ).toEqual(['a.txt', 'b.txt']);
      expect(refusal.detail).toContain('150 of 160');
      expect(agent.signalTotals['deletion/refused']).toBe(1);
    } finally {
      agent.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
