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

    agent = new FsAgent(testDir, undefined, { resolveConflicts: true });
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
    const resolver = new FsConflictResolver(
      (agent as unknown as {
        _buildConflictResolverDeps: (db: Db, t: string) => never;
      })._buildConflictResolverDeps(db, TREE),
    );
    const mergeRef = await resolver.resolve(conflict!);
    expect(mergeRef).toBeTruthy();

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
    const resolver = new FsConflictResolver(
      (agent as unknown as {
        _buildConflictResolverDeps: (db: Db, t: string) => never;
      })._buildConflictResolverDeps(db, TREE),
    );
    await resolver.resolve(conflict!);

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
});
