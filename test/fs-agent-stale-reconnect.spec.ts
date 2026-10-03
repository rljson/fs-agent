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

import {
  AGENT_STATE_FILE,
  CHAIN_HEAD_PREFIX,
  FsAgent,
} from '../src/fs-agent.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';
import { announceAsPeer } from './chain-announce.ts';

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
    //
    // No log to assert any more, and that is the point: this used to be a
    // RULE that decided, loudly, whether a push was allowed to prune. Nothing
    // prunes on absence now, so the guarantee holds structurally and there is
    // nothing to announce.
    expect(existsSync(join(targetDir, 'keep.txt'))).toBe(true);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

  // The same rule, on the configuration a CARAT One Client actually runs.
  //
  // **The lab incident of 2026-09-19.** Nine files were written into the synced
  // folder on one machine while it was — unknowingly — attached to a server
  // that had lost the hub election. Thirty-seven minutes later those files were
  // deleted from the machine that wrote them, by a peer pushing the older,
  // empty state of the folder without declaring what it descended from.
  //
  // The rule above would have refused that prune. It did not run, because it
  // was gated on `resolveConflicts`, which a One Client deliberately leaves off
  // — an earlier attempt to turn the whole merge on dropped the four-node lab
  // to 4 of 11. But the client DOES set `causalOrdering`, so ancestry is on the
  // wire and its absence means exactly what the rule says it means.
  it('never prunes on a no-ancestry push from a causally-ordered peer', async () => {
    const db = await makeDb();
    const bs = new BsMem();

    // What the machine wrote while it was cut off.
    await writeFile(join(targetDir, 'Preisliste.txt'), 'seed');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');

    // What the rest of the branch still held: the folder without those files.
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');
    const staleRef = await new FsDbAdapter(db, 'fsTree').storeFsTree(
      await new FsAgent(sourceDir, bs).extract(),
    );

    // A One Client's fs-client, exactly: conflict resolution OFF, causal
    // ordering ON.
    const agent = new FsAgent(targetDir, bs, {
      resolveConflicts: false,
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket, {
      causalOrdering: true,
      includeClientIdentity: true,
    });
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    // No predecessors — the shape a hub relays after its cache was wiped, and
    // the shape any sender has before it knows a ref of its own.
    socket.emit(connector.events.ref, { o: 'remote-peer', r: staleRef });
    await new Promise((r) => setTimeout(r, 400));

    expect(existsSync(join(targetDir, 'Preisliste.txt'))).toBe(true);

    stop();
    agent.scanner.stopWatch();
  });

  // A REAL DELETION STILL REACHES THIS NODE — and there is now exactly one way
  // it can, so three tests collapse into two.
  //
  // They used to differ only in what the ADVERTISEMENT declared: predecessors
  // present, predecessors absent, a transport that carries none at all. Each
  // one asked whether an absence was trustworthy enough to delete on. A
  // deletion is stated in the chain now, by the node that performed it, so the
  // declaration decides nothing and the mechanism is the same in every mode.
  // What is still worth testing twice is the TRANSPORT, because the old rule
  // turned itself off where ancestry was not carried.
  it('applies a deletion the sender STATES', async () => {
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');

    const agent = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(sourceDir, bs).extract(),
      removed: ['gone.txt'],
    });
    connector.simulateIncoming(peer.announcement);
    await new Promise((r) => setTimeout(r, 600));

    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);
    expect(await readFile(join(targetDir, 'shared.txt'), 'utf-8')).toBe(
      'shared',
    );

    stop();
    agent.scanner.stopWatch();
  });

  // The gate that keeps rule (a) from breaking everything else. With conflict
  // resolution off no ref carries ancestry at all, so treating its absence as
  // suspicious would stop every deletion propagating — it did, across eight
  // tests, before this gate existed.
  it('applies a stated deletion on a transport that carries no ancestry', async () => {
    // The mode most deployments run: `resolveConflicts` off, no
    // `causalOrdering`, so no advertisement ever declares a predecessor. The
    // OLD rule had to switch itself off here or it refused every deletion —
    // measured across eight tests. The chain needs no such exception: the
    // entry travels in the database, not in the advertisement.
    const db = await makeDb();
    const bs = new BsMem();
    await writeFile(join(targetDir, 'gone.txt'), 'gone');
    await writeFile(join(targetDir, 'shared.txt'), 'shared');
    await writeFile(join(sourceDir, 'shared.txt'), 'shared');

    const agent = new FsAgent(targetDir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });
    const connector = makeConnector(db);
    const stop = await agent.syncFromDb(db, connector, 'fsTree', {
      cleanTarget: true,
    });

    const peer = await announceAsPeer(db, 'fsTree', {
      tree: await new FsAgent(sourceDir, bs).extract(),
      removed: ['gone.txt'],
    });
    connector.simulateIncoming(peer.announcement);
    await new Promise((r) => setTimeout(r, 600));

    expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);

    stop();
    agent.scanner.stopWatch();
  });

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
        advertise: (ref: string, seq: number, predecessors?: string[]) =>
          socket.emit(connector.events.ref, {
            o: 'remote-peer',
            r: ref,
            c: 'peer-a',
            seq,
            p: predecessors,
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

    it('applies a stated deletion that arrives as the newest', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'gone.txt'), 'gone');
      await writeFile(join(targetDir, 'shared.txt'), 'shared');
      await writeFile(join(sourceDir, 'shared.txt'), 'shared');

      const agent = new FsAgent(targetDir, bs, {
        timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
      });
      const connector = makeSeqConnector(db);
      // Both directions, as every real client runs: the node has a state of
      // its own, and therefore a lineage the deletion is ordered against.
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      const stop = await agent.syncFromDb(db, connector, 'fsTree', {
        cleanTarget: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const peer = await announceAsPeer(db, 'fsTree', {
        tree: await new FsAgent(sourceDir, bs).extract(),
        removed: ['gone.txt'],
      });
      connector.advertise(peer.announcement, 1, []);
      await new Promise((r) => setTimeout(r, 600));

      // The pair to `is ignored outright` above: a deletion arriving as the
      // sender's newest word is applied, one arriving behind it is not.
      expect(existsSync(join(targetDir, 'gone.txt'))).toBe(false);

      stopTo();
      stop();
      agent.scanner.stopWatch();
    });

    // THE "TWO NAMES FOR ONE STATE" TEST IS GONE, and so is its premise.
    //
    // It asserted that a prune was honoured when the sender declared the ref
    // the TREE ARRIVED UNDER rather than this node's own name for the same
    // state — because *"mtimes do not always survive a restore byte for byte,
    // and on Windows they regularly do not"*, so a receiver's re-scan of
    // applied content produced a different ref. Measured at the time: with
    // `_currentRef` alone, three lab runs in four converged perfectly on
    // 1 201 files and none of them could delete one.
    //
    // Since mtime left the content identity there is ONE name. That is what
    // makes a receiver able to adopt the sender's chain entry at all, and it
    // is why the rule this test covered no longer exists.

    // Refusing to PRUNE from an old tree is not enough: applying one
    // additively is what puts a deleted file back. A peer that has not yet
    // seen a deletion pushes a tree that still contains the file, and the
    // additive apply restores it.
    //
    // Measured on the customer's folder — 3642 files, 404 MB — where a file
    // deleted from it was back moments later, on one run in two.
    it('ignores a sender that descends from a state this node has left', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'shared.txt'), 'shared');

      const agent = new FsAgent(targetDir, bs, {
        timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
      });
      const connector = makeSeqConnector(db);
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      const stop = await agent.syncFromDb(db, connector, 'fsTree', {
        cleanTarget: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      // The state the node is about to leave, by the name the CHAIN knows it
      // by. Not `_currentRef`: a content hash cannot say whether this node was
      // ever in that state, only that some folder somewhere held those bytes.
      const inner = agent as unknown as {
        _chainHead?: { head: string; treeRef: string };
      };
      const leftHead = inner._chainHead?.head as string;
      expect(leftHead, 'the node recorded no entry for its own state').toBe(
        inner._chainHead?.head,
      );

      // The node moves on: it deletes the file and is now somewhere new.
      await rm(join(targetDir, 'shared.txt'), { force: true });
      await new Promise((r) => setTimeout(r, 600));
      expect(inner._chainHead?.head).not.toBe(leftHead);

      // A PEER THAT NEVER SAW THE DELETION RE-ANNOUNCES THE SHARED ENTRY.
      // That is the whole announcement: a receiver adopts the sender's entry
      // rather than authoring one, so the state both nodes were in has ONE
      // name, and a peer still in it says exactly that name. No synthetic
      // tree, no hand-declared ancestry — the earlier version of this test
      // stored a tree with no entry behind it and put the ancestry in the
      // advertisement, which no build has done since the chain landed.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      connector.advertise(`${CHAIN_HEAD_PREFIX}${leftHead}`, 1, []);
      await new Promise((r) => setTimeout(r, 600));

      // The deletion stands. Ignored outright, not applied additively.
      expect(existsSync(join(targetDir, 'shared.txt'))).toBe(false);
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('already left')),
      ).toBe(true);

      stopTo();
      stop();
      agent.scanner.stopWatch();
      warnSpy.mockRestore();
    });

    // The other half of the same rule, and the whole point of it: a sender
    // that cannot show it has seen this node's state may ADD but not DELETE.
    // A node catching up declares its own previous state, never this one's, so
    // it can never cause a prune however late its tree arrives.
    it('does not prune for a sender that never saw this state', async () => {
      const db = await makeDb();
      const bs = new BsMem();
      await writeFile(join(targetDir, 'gone.txt'), 'gone');
      await writeFile(join(targetDir, 'shared.txt'), 'shared');

      const agent = new FsAgent(targetDir, bs, {
        timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
      });
      const connector = makeSeqConnector(db);
      const stopTo = await agent.syncToDb(db, connector, 'fsTree');
      const stop = await agent.syncFromDb(db, connector, 'fsTree', {
        cleanTarget: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      await writeFile(join(sourceDir, 'shared.txt'), 'shared');
      const ref = await new FsDbAdapter(db, 'fsTree').storeFsTree(
        await new FsAgent(sourceDir, bs).extract(),
      );
      // Declares a state this node has never been in.
      connector.advertise(ref, 1, ['some-other-state-entirely']);
      await new Promise((r) => setTimeout(r, 400));

      expect(existsSync(join(targetDir, 'gone.txt'))).toBe(true);
      expect(existsSync(join(targetDir, 'shared.txt'))).toBe(true);

      stopTo();
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
