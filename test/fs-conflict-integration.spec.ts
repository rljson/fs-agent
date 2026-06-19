// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync, readFileSync } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Conflict } from '@rljson/db';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import { FsConflictResolver } from '../src/fs-conflict-resolver.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

/** Lets a microtask-deferred `.catch()`/`.then()` settle. */
const flush = () => new Promise((r) => setTimeout(r, 20));

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
    const tipB = await storeRevision([tipO]);

    // Branch C deletes b.txt, forking from A.
    await putFiles({ 'a.txt': 'a0' });
    const tipC = await storeRevision([tipO]);

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
    void tipB;
  });

  it('resolves through the observer registered by syncFromDb, then tears down', async () => {
    const route = Route.fromFlat(`/${TREE}`);
    const socket = new SocketMock();
    const connector = new Connector(db, route, socket);

    // Ancestor + one branch (no fork yet).
    await putFiles({ 'doc.txt': 'v0' });
    const tipO = await storeRevision();
    await putFiles({ 'doc.txt': 'vB' });
    await storeRevision([tipO]); // tipB

    // Register the client conflict observer, THEN insert the forking tip — the
    // insert fires the observer, which resolves the fork end-to-end.
    const teardown = await agent.syncFromDb(db, connector, TREE);
    await putFiles({ 'doc.txt': 'vC' });
    await storeRevision([tipO]); // tipC → fork → observer → resolve

    await flush();
    expect(await db.detectDagBranch(TREE)).toBeNull(); // collapsed to one tip

    // Teardown unregisters the observer (idempotent, no throw).
    teardown();
  });

  it('records a sync error when conflict resolution rejects (fire-and-forget)', async () => {
    const failing = {
      resolve: () => Promise.reject(new Error('boom')),
    } as unknown as FsConflictResolver;
    (
      agent as unknown as {
        _onConflict: (r: FsConflictResolver, c: Conflict) => void;
      }
    )._onConflict(failing, { table: TREE } as Conflict);

    await flush();
    const log = readFileSync(join(testDir, SYNC_ERROR_FILE), 'utf8');
    expect(log).toContain('syncFromDb/resolveConflict');
  });

  it('stays quiet when conflict resolution succeeds', async () => {
    const ok = {
      resolve: () => Promise.resolve('ref'),
    } as unknown as FsConflictResolver;
    (
      agent as unknown as {
        _onConflict: (r: FsConflictResolver, c: Conflict) => void;
      }
    )._onConflict(ok, { table: TREE } as Conflict);

    await flush();
    expect(existsSync(join(testDir, SYNC_ERROR_FILE))).toBe(false);
  });
});
