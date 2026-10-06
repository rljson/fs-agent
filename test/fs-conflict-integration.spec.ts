// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route, type SyncConfig } from '@rljson/rljson';

import { existsSync, readFileSync } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { FsConflictResolver } from '../src/fs-conflict-resolver.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

/**
 * End-to-end conflict resolution against a real Db + real filesystem. Exercises
 * the FsAgent wiring (`_buildConflictResolverDeps`) and a fork-collapsing merge
 * revision. Requires `@rljson/db >= 0.0.21` (the `previous` insert override).
 */
describe('FsAgent conflict resolution (integration)', () => {
  const TREE = 'sharedTree';
  const testDir = join(process.cwd(), 'test-temp-conflict');

  let io: IoMem;
  let db: Db;
  let agent: FsAgent;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });

    io = new IoMem();
    await io.init();
    db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));

    agent = new FsAgent(testDir, undefined, {
    ...ORIGIN_FIXTURE,
    resolveConflicts: true,
  });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Write a flat set of files, replacing the working dir contents. */
  const putFiles = async (files: Record<string, string>) => {
    for (const name of await readdir(testDir)) {
      await rm(join(testDir, name), { recursive: true, force: true });
    }
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(testDir, name), content);
    }
  };

  /** Scan the working dir and store it; return the new revision's timeId. */
  const storeRevision = async (previous?: string[]): Promise<string> => {
    const tree = await agent.extract();
    const ref = await new FsDbAdapter(db, TREE).storeFsTree(tree, {
      skipNotification: true,
      previous,
    });
    const timeIds = await db.getTimeIdsForRef(TREE, ref);
    return timeIds[timeIds.length - 1];
  };

  it('collapses an offline-edit fork into a single merge revision, losing nothing', async () => {
    // Ancestor A.
    await putFiles({ 'doc.txt': 'v0', 'keep.txt': 'k0' });
    const tipO = await storeRevision();

    // Branch B (offline edit): change doc.txt, add onlyB.txt — descends from A.
    await putFiles({ 'doc.txt': 'vB', 'keep.txt': 'k0', 'onlyB.txt': 'b0' });
    const tipB = await storeRevision([tipO]);

    // Branch C (incoming): change doc.txt differently, add onlyC.txt, forking
    // from the same ancestor A (force previous = [tipO]).
    await putFiles({ 'doc.txt': 'vC', 'keep.txt': 'k0', 'onlyC.txt': 'c0' });
    const tipC = await storeRevision([tipO]);

    // The fork is detected.
    const conflict = await db.detectDagBranch(TREE);
    expect(conflict?.type).toBe('dagBranch');
    expect([...(conflict?.branches ?? [])].sort()).toEqual([tipB, tipC].sort());

    // Resolve via the agent's own wiring.
    //
    // `announce` is REQUIRED, and this test is why it is not optional. The
    // merge store suppresses `Connector`'s db observer, so if nothing
    // announces afterwards the merge revision never leaves the node at all.
    // An optional parameter would make that the silent default for any future
    // caller who forgets it — which is the defect this argument exists to fix.
    // See `_buildConflictResolverDeps`.
    const announced: string[] = [];
    const resolver = new FsConflictResolver(
      (
        agent as unknown as {
          _buildConflictResolverDeps: (
            db: Db,
            t: string,
            announce: (ref: string) => Promise<void>,
          ) => never;
        }
      )._buildConflictResolverDeps(db, TREE, async (ref) => {
        announced.push(ref);
      }),
    );
    const mergeRef = await resolver.resolve(conflict!);
    expect(mergeRef).toBeTruthy();

    // The merge went out, and it went out NAMING THE STATE IT PRODUCED.
    expect(announced, 'the merge revision was never announced').toEqual([
      mergeRef,
    ]);

    // Fork collapsed → single tip.
    expect(await db.detectDagBranch(TREE)).toBeNull();

    // Merge revision references BOTH tips.
    const mergeTimeIds = await db.getTimeIdsForRef(TREE, mergeRef!);
    const mergeRow = await db.getInsertHistoryRowByTimeId(
      TREE,
      mergeTimeIds[mergeTimeIds.length - 1],
    );
    expect([...(mergeRow.previous ?? [])].sort()).toEqual([tipB, tipC].sort());

    // Nothing lost on disk: both adds present, keep.txt intact, and exactly one
    // conflict copy holding the losing doc version.
    const names = await readdir(testDir);
    expect(names).toContain('onlyB.txt');
    expect(names).toContain('onlyC.txt');
    expect(names).toContain('keep.txt');
    const copies = names.filter((n) => n.includes('conflicted copy'));
    expect(copies).toHaveLength(1);

    // doc.txt holds one version, the conflict copy holds the other — both of
    // {vB, vC} survive somewhere.
    const docValue = readFileSync(join(testDir, 'doc.txt'), 'utf8');
    const copyValue = readFileSync(join(testDir, copies[0]), 'utf8');
    expect([docValue, copyValue].sort()).toEqual(['vB', 'vC']);
  });

  it('removes files dropped by the merge (both branches delete different files)', async () => {
    await putFiles({ 'a.txt': 'a0', 'b.txt': 'b0' });
    const tipO = await storeRevision();

    // Branch B deletes a.txt (descends from A).
    await putFiles({ 'b.txt': 'b0' });
    await storeRevision([tipO]);

    // Branch C deletes b.txt, forking from A.
    await putFiles({ 'a.txt': 'a0' });
    await storeRevision([tipO]);

    const conflict = await db.detectDagBranch(TREE);
    const announced: string[] = [];
    const resolver = new FsConflictResolver(
      (
        agent as unknown as {
          _buildConflictResolverDeps: (
            db: Db,
            t: string,
            announce: (ref: string) => Promise<void>,
          ) => never;
        }
      )._buildConflictResolverDeps(db, TREE, async (ref) => {
        announced.push(ref);
      }),
    );
    await resolver.resolve(conflict!);
    // A merge that only DELETES is still a state, and still has to be said.
    expect(announced, 'the merge revision was never announced').toHaveLength(1);

    expect(await db.detectDagBranch(TREE)).toBeNull();
    // Each branch's deletion wins for its own file → both removed, no copies.
    expect(existsSync(join(testDir, 'a.txt'))).toBe(false);
    expect(existsSync(join(testDir, 'b.txt'))).toBe(false);
  });

  it('_ancestryPrevious yields undefined when a parent ref is not stored locally', async () => {
    // A predecessor ref that has no local InsertHistory row (causal gap) maps to
    // no timeId, so the new revision gets no `previous` (becomes a root).
    const prev = await (
      agent as unknown as {
        _ancestryPrevious: (
          db: Db,
          t: string,
          refs: string[] | undefined,
        ) => Promise<string[] | undefined>;
      }
    )._ancestryPrevious(db, TREE, ['ref-not-in-this-db']);
    expect(prev).toBeUndefined();
  });

  it('_ancestryRelation classifies behind / ahead / diverged (incl. a diamond)', async () => {
    const adapter = new FsDbAdapter(db, TREE);
    const store = async (
      files: Record<string, string>,
      previous?: string[],
    ): Promise<string> => {
      await putFiles(files);
      return adapter.storeFsTree(await agent.extract(), {
        skipNotification: true,
        previous,
      });
    };
    const tid = async (ref: string) =>
      (await db.getTimeIdsForRef(TREE, ref))[0];

    const baseRef = await store({ 'f.txt': 'base' });
    const aRef = await store({ 'f.txt': 'A' }, [await tid(baseRef)]);
    const cRef = await store({ 'f.txt': 'C' }, [await tid(baseRef)]);
    // Diamond: D descends from both A and C (which both descend from base).
    const dRef = await store({ 'f.txt': 'D' }, [
      await tid(aRef),
      await tid(cRef),
    ]);

    const rel = (cur: string, inc: string, pred: string[]) =>
      (
        agent as unknown as {
          _ancestryRelation: (
            db: Db,
            t: string,
            cur: string,
            inc: string,
            pred: string[],
          ) => Promise<'behind' | 'ahead' | 'diverged'>;
        }
      )._ancestryRelation(db, TREE, cur, inc, pred);

    // A descends from our head (base) → fast-forward.
    expect(await rel(baseRef, aRef, [baseRef])).toBe('behind');
    // base is our ancestor; the diamond walk from D revisits base → ahead.
    expect(await rel(dRef, baseRef, [])).toBe('ahead');
    // A and C are siblings → diverged.
    expect(await rel(aRef, cRef, [baseRef])).toBe('diverged');
  });

  it('ignores an incoming ancestor (relation ahead) without clobbering local state', async () => {
    const SYNC: SyncConfig = {
      causalOrdering: true,
      includeClientIdentity: true,
    };
    const adapter = new FsDbAdapter(db, TREE);
    const store = async (
      files: Record<string, string>,
      previous?: string[],
    ): Promise<string> => {
      await putFiles(files);
      return adapter.storeFsTree(await agent.extract(), {
        skipNotification: true,
        previous,
      });
    };
    const tid = async (ref: string) =>
      (await db.getTimeIdsForRef(TREE, ref))[0];

    // base → A → D ; our head is D, disk holds D's content.
    const baseRef = await store({ 'f.txt': 'base' });
    const aRef = await store({ 'f.txt': 'AAA' }, [await tid(baseRef)]);
    const dRef = await store({ 'f.txt': 'DDD' }, [await tid(aRef)]);
    (agent as unknown as { _currentRef: string })._currentRef = dRef;

    const socket = new SocketMock();
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      socket,
      SYNC,
    );
    const teardown = await agent.syncFromDb(db, connector, TREE, {
      cleanTarget: true,
    });

    // Inject A — an ancestor of our head D, carrying its predecessor ref. It
    // must be ignored (relation 'ahead'), leaving D's content on disk intact.
    socket.emit(connector.events.ref, {
      o: 'remote-origin',
      r: aRef,
      c: 'peer',
      seq: 1,
      p: [baseRef],
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(await readFile(join(testDir, 'f.txt'), 'utf8')).toBe('DDD');
    teardown();
  });
  // ...........................................................................
  it('merges a fork nothing can name, on a folder never scanned', async () => {
    // TWO SHAPES NO SCENARIO IN THE SUITE PRODUCES, and both are ordinary.
    //
    // 1. A FORK THE CHAIN CANNOT NAME. The merge adopts the incoming side's
    //    head so the merge revision descends from BOTH branches — without
    //    that, the peer whose branch was merged classifies the result as a
    //    fork against its own head and resolves it again, for ever. But a
    //    peer on the old wire format announces a plain tree ref and records
    //    no head, so there is nothing to adopt. The merge must still happen,
    //    and must simply not claim a parent it cannot name.
    //
    // 2. A FOLDER NEVER SCANNED. `beforeMerge` is read from the scan, and a
    //    conflict can land before the first one completes — a restart into an
    //    already-diverged network. The empty tree is what makes
    //    `_recordReceived` treat everything as delivered rather than crash.
    await putFiles({ 'doc.txt': 'v0' });
    const tipO = await storeRevision();

    await putFiles({ 'doc.txt': 'vB', 'onlyB.txt': 'b0' });
    const tipB = await storeRevision([tipO]);
    const ourRef = (await db.getRefOfTimeId(TREE, tipB)) as string;

    await putFiles({ 'doc.txt': 'vC', 'onlyC.txt': 'c0' });
    const tipC = await storeRevision([tipO]);
    const theirRef = (await db.getRefOfTimeId(TREE, tipC)) as string;
    const theirTree = await agent.extract();

    // A FRESH AGENT, because `_scanner.tree` has only a getter and the only
    // honest way to have never scanned is to never have scanned. This is the
    // restart-into-a-diverged-network shape: the folder is on disk, the
    // history is in the db, and this process has not looked at either yet.
    const fresh = new FsAgent(testDir, undefined, {
      ...ORIGIN_FIXTURE,
      resolveConflicts: true,
    });
    // It is at B, and has no chain at all — so nothing names C.
    (fresh as unknown as { _currentRef: unknown })._currentRef = ourRef;
    (fresh as unknown as { _chain: unknown })._chain = undefined;
    (fresh as unknown as { _chainHead: unknown })._chainHead = undefined;
    expect(
      (fresh as unknown as { _scanner: { tree?: unknown } })._scanner.tree,
      'the fresh agent had already scanned, so the shape under test is gone',
    ).toBeFalsy();

    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
    );
    const announced: string[] = [];
    (connector as unknown as { send: (r: string) => void }).send = (
      r: string,
    ) => {
      announced.push(r);
    };

    const merging = (
      fresh as unknown as {
        _resolveConflictInline: (
          db: Db,
          treeKey: string,
          incomingRef: string,
          incomingTree: unknown,
          predecessorRefs: string[],
          connector: Connector,
        ) => Promise<void>;
      }
    )._resolveConflictInline(
      db,
      TREE,
      theirRef,
      theirTree,
      [ourRef],
      connector,
    );

    // AND IT FAILS LOUDLY, which is the third thing worth pinning here. This
    // agent has no blob store reaching the peer that authored C, so the merge
    // cannot materialise it. The alternative — writing what it could fetch and
    // calling the merge done — would publish a revision claiming content it
    // does not hold, and every peer would then fetch THAT.
    await expect(merging).rejects.toThrow(/could not fetch/);

    // Nothing was claimed on the way. The adoption is what makes a merge
    // descend from both branches, and a branch nothing names cannot be
    // adopted — so the field stays empty rather than holding a guess.
    expect(
      (fresh as unknown as { _adoptedChainHead?: string })._adoptedChainHead,
      'a parent was claimed that nothing names',
    ).toBeUndefined();
    // And no half-merged state was announced.
    expect(announced, 'a merge that failed was announced anyway').toEqual([]);
    fresh.dispose();
  }, 30_000);
});
