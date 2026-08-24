// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { AGENT_STATE_FILE, FsAgent } from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

// A node that is offline while a file is created used to DELETE that file from
// every other node when it returned. Not a failure to catch up — the file
// arrived everywhere and was then pruned by the one that missed it.
//
// Measured on four machines before this was fixed: a file reached all three
// connected nodes and was gone from all three two seconds later, as the fourth
// reconnected and its stale tree was applied as authoritative.
describe('FsAgent — a peer that reconnects with a stale tree', () => {
  const sourceDir = join(process.cwd(), 'test-temp-stale-source');
  const targetDir = join(process.cwd(), 'test-temp-stale-target');

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

  /** A db with the tree table ready. */
  const makeDb = async () => {
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
      simulateIncoming: (
        ref: string,
        predecessorRefs?: string[],
        extra?: Record<string, unknown>,
      ) =>
        socket.emit(connector.events.ref, {
          o: 'remote-peer',
          r: ref,
          p: predecessorRefs,
          ...extra,
        }),
    });
  };

  // Rule (a): a sender that cannot say what it descends from has not shown it
  // knows the current state, so it may add but must not delete.
  it('applies a ref with NO ancestry additively, never pruning', async () => {
    const db = await makeDb();
    const bs = new BsMem();

    // The target holds a file the incoming tree does not know about.
    await writeFile(join(targetDir, 'keep.txt'), 'keep');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');

    // A stale peer's tree: shared.txt only.
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');
    const staleRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );

    // resolveConflicts on: it is the only mode in which a sender transmits
    // ancestry at all, so it is the only mode in which its ABSENCE means
    // anything. See the gate in processRef.
    const agent = new FsAgent(targetDir, bs, {
      resolveConflicts: true,
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    connector.simulateIncoming(staleRef); // no predecessors
    await new Promise((r) => setTimeout(r, 400));

    // The file the stale peer never saw is still here.
    expect(existsSync(join(targetDir, 'keep.txt'))).toBe(true);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('declares no ancestry')),
    ).toBe(true);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

  it('still prunes when the sender DOES declare ancestry', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');

    const adapter = new FsDbAdapter(db, 'fsTree');
    // The predecessor: the state the target is actually in.
    const parentRef = await adapter.storeFsTree(
      await new FsAgent(targetDir, bs).extract(),
    );
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');
    const newerRef = await adapter.storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
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

    // A deletion that declares where it came from is still honoured — the
    // guard must not turn cleanTarget off in general.
    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);
    expect(await readFile(join(targetDir, 'shared.txt'), 'utf-8')).toBe('shared');

    stop();
    agent.scanner.stopWatch();
  });

  // The gate that keeps rule (a) from breaking everything else. With conflict
  // resolution off no ref carries ancestry at all, so treating its absence as
  // suspicious would stop every deletion propagating — it did, across eight
  // tests, before this gate existed.
  it('leaves pruning alone where ancestry is never transmitted', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');
    const ref = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );

    // resolveConflicts defaults to false — the mode most deployments run.
    const agent = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    connector.simulateIncoming(ref); // no predecessors, as always in this mode
    await new Promise((r) => setTimeout(r, 400));

    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);

    stop();
    agent.scanner.stopWatch();
  });

  // Starting order must be the caller's choice, not something a crash decides
  // for them. syncToDb called watch() unconditionally, so syncFromDb-then-
  // syncToDb threw "Already watching" — pushing every caller into push-first,
  // which is the order that lets a reconnecting client overwrite the network.
  it('allows syncFromDb to be started before syncToDb', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const agent = new FsAgent(targetDir, bs, { timeouts: { debounceMs: 1 } });
    const connector = makeConnector(db);

    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    // The order that used to throw.
    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    expect(agent.scanner.isWatching).toBe(true);

    stopFrom();
    stopTo();
    agent.scanner.stopWatch();
  });

  it('still allows the other order', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const agent = new FsAgent(targetDir, bs, { timeouts: { debounceMs: 1 } });
    const connector = makeConnector(db);

    const stopTo = await agent.syncToDb(db, connector, 'fsTree');
    const stopFrom = await agent.syncFromDb(db, connector, 'fsTree');
    expect(agent.scanner.isWatching).toBe(true);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
  });

  // The guard that needs no ancestry: the sender has already said something
  // later than this. A node returning from a disconnect emits exactly that —
  // the state it held before it left. Applying its FILES is harmless, they
  // are real, just old. Applying its ABSENCES is the data loss.
  describe('an advertisement that is not the newest from its sender', () => {
    /** A connector that reports sender sequences, as a real one does. */
    const makeSeqConnector = (db: Db) => {
      const socket = new SocketMock();
      const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket, {
        causalOrdering: true,
        includeClientIdentity: true,
      });
      return Object.assign(connector, {
        advertise: (ref: string, seq: number) =>
          socket.emit(connector.events.ref, {
            o: 'remote-peer',
            r: ref,
            c: 'peer-a',
            seq,
          }),
      });
    };

    // Ignored outright, not applied additively. The earlier version of this
    // guard applied a stale advertisement's files on the reasoning that they
    // are "real, just old" — which is wrong when the stale state predates a
    // deletion: its files include the one just deleted, so the deletion is
    // undone BY ADDITION. Measured: with the additive version, a periodic
    // re-advertisement made a delete-propagation recipe fail two runs in four.
    it('is ignored outright — it neither adds nor deletes', async () => {
      const db = await makeDb();
      const bs = new BsMem();

      // The sender's older state contains a file its newer state does not:
      // exactly the shape of a re-advertised pre-deletion tree.
      await writeFile(join(sourceDir, 'deleted-later.txt'), 'doomed');
      const adapter = new FsDbAdapter(db, 'fsTree');
      const oldRef = await adapter.storeFsTree(
        await new FsAgent(sourceDir, bs).extract(),
      );
      await rm(join(sourceDir, 'deleted-later.txt'));
      await writeFile(join(sourceDir, 'survivor.txt'), 'survivor');
      const newRef = await adapter.storeFsTree(
        await new FsAgent(sourceDir, bs).extract(),
      );

      const agent = new FsAgent(targetDir, bs, {
        timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
      });
      const connector = makeSeqConnector(db);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stop = await agent.syncFromDb(db, connector, 'fsTree', {
        cleanTarget: true,
      });

      connector.advertise(newRef, 5);
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(join(targetDir, 'survivor.txt'))).toBe(true);

      // The straggler: the sender's PRE-deletion state.
      connector.advertise(oldRef, 3);
      await new Promise((r) => setTimeout(r, 400));

      // The deleted file must NOT come back…
      expect(existsSync(join(targetDir, 'deleted-later.txt'))).toBe(false);
      // …and nothing current may be removed either.
      expect(existsSync(join(targetDir, 'survivor.txt'))).toBe(true);
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('is not the newest its sender has advertised'),
        ),
      ).toBe(true);

      stop();
      agent.scanner.stopWatch();
      warnSpy.mockRestore();
    });

    it('still prunes for the newest advertisement', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'gone.txt'), 'gone');
      await writeFile(join(targetDir, 'shared.txt'), 'shared');
      await writeFile(join(sourceDir, 'shared.txt'), 'shared');
      const ref = await new FsDbAdapter(db, 'fsTree').storeFsTree(
        await new FsAgent(sourceDir, bs).extract(),
      );

      const agent = new FsAgent(targetDir, bs, {
        timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
      });
      const connector = makeSeqConnector(db);
      const stop = await agent.syncFromDb(db, connector, 'fsTree', {
        cleanTarget: true,
      });

      connector.advertise(ref, 1);
      await new Promise((r) => setTimeout(r, 400));

      // A current advertisement deletes exactly as before — the guard must
      // not turn cleanTarget off in general.
      expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);

      stop();
      agent.scanner.stopWatch();
    });
  });

  // Rule (b): the fix at the source. A restart must still be able to say what
  // it descends from, or every push it makes is one peers cannot check.
  it('records the ref it is at, and declares it after a restart', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');

    const first = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1 },
    });
    const c1 = makeConnector(db);
    const stop1 = await first.syncToDb(db, c1, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));
    stop1();
    first.scanner.stopWatch();

    expect(existsSync(join(targetDir, AGENT_STATE_FILE))).toBe(true);

    // A brand-new agent over the same folder — the restart.
    const restarted = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1 },
    });
    const c2 = makeConnector(db);
    const sent: Array<string[] | undefined> = [];
    const realSend = c2.send.bind(c2);
    c2.send = (ref: string) => {
      sent.push(c2.predecessors);
      return realSend(ref);
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stop2 = await restarted.syncToDb(db, c2, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));

    expect(
      logSpy.mock.calls.some((c) =>
        String(c[0]).includes('resuming from recorded ref'),
      ),
    ).toBe(true);

    stop2();
    restarted.scanner.stopWatch();
    logSpy.mockRestore();
  });

  // Every unusable shape answers the same way: this process cannot vouch for
  // what it descends from. A state file is a convenience, never a dependency.
  for (const [label, contents] of [
    ['unparseable', 'not json at all'],
    ['valid JSON but not an object', 'null'],
    ['an object without the field', '{}'],
    ['an empty ref', '{"currentRef":""}'],
    ['a ref of the wrong type', '{"currentRef":42}'],
  ] as const) {
    it(`treats ${label} as "no ancestry"`, async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'a.txt'), 'a');
      await writeFile(join(targetDir, AGENT_STATE_FILE), contents);

      const agent = new FsAgent(targetDir, bs, { timeouts: { debounceMs: 1 } });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stop = await agent.syncToDb(db, makeConnector(db), 'fsTree');
      await new Promise((r) => setTimeout(r, 200));

      // Degrades quietly rather than throwing.
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes('resuming from recorded ref'),
        ),
      ).toBe(false);

      stop();
      agent.scanner.stopWatch();
      logSpy.mockRestore();
    });
  }

  it('never syncs its own state file', async () => {
    const bs = new BsMem();
    await writeFile(join(targetDir, 'a.txt'), 'a');
    await writeFile(
      join(targetDir, AGENT_STATE_FILE),
      JSON.stringify({ currentRef: 'abc' }),
    );

    const tree = await new FsAgent(targetDir, bs).extract();
    const paths = Array.from(tree.trees.values())
      .map((t) => (t.meta as { relativePath?: string } | null)?.relativePath)
      .filter(Boolean);

    expect(paths).toContain('a.txt');
    expect(paths).not.toContain(AGENT_STATE_FILE);
  });
});
