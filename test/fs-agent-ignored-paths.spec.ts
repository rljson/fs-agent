// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// What a node ignores, it neither writes, nor deletes, nor makes room over.
//
// The mesh scenarios in `fs-mesh-ignore-lists.spec.ts` show the fleet staying
// whole when lists differ or change. These are the single-node rules under
// them, each of which a mesh reaches only by luck of timing.
// .............................................................................

import type { Tree } from '@rljson/rljson';
import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { fileNode } from '../src/fs-carry.ts';
import {
  AGENT_STATE_FILE,
  FsAgent,
  SYNC_ERROR_FILE,
  UnwritablePathError,
} from '../src/fs-agent.ts';
import type { FsTree } from '../src/fs-scanner.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

/** The agent's insides these rules live in. */
interface Insides {
  _ownHead?: string;
  _ownContent: ReadonlyMap<string, string>;
  _carried: ReadonlyMap<string, Tree>;
  _uncovered: Set<string>;
  _ignoreOnRecord: readonly string[];
  _chain: { collectRemovals: (...a: unknown[]) => Promise<unknown> };
  _persistedIgnore(): string[] | undefined;
  _setOwn(
    head: string,
    content: ReadonlyMap<string, string>,
    carried: ReadonlyMap<string, Tree>,
  ): void;
  _treeOf(head: string): Promise<{ tree: FsTree } | undefined>;
  _uncover(head: string, headTree: FsTree, folderTree: FsTree): Promise<boolean>;
  _takeUncovered(): Promise<void>;
  _mergeCarried(
    merged: ReadonlyMap<string, string>,
    theirs: ReadonlyMap<string, string>,
    theirCarried: ReadonlyMap<string, Tree>,
  ): Promise<Map<string, Tree>>;
}
const insides = (agent: FsAgent) => agent as unknown as Insides;

describe('FsAgent — paths a node ignores', () => {
  const sourceDir = join(process.cwd(), 'test-temp-ignored-source');
  const targetDir = join(process.cwd(), 'test-temp-ignored-target');
  const elsewhere = join(process.cwd(), 'test-temp-ignored-elsewhere');
  const stops: Array<() => void> = [];
  /** The node's store, which a restart finds again, as on disk. */
  let db: Db | undefined;

  beforeEach(async () => {
    db = undefined;
    for (const d of [sourceDir, targetDir, elsewhere]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const d of [sourceDir, targetDir, elsewhere]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  /** A tree of `sourceDir`, its blobs in `bs`. */
  const sourceTree = async (bs: BsMem, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(sourceDir, ...path.split('/'));
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
    }
    return new FsAgent(sourceDir, bs, ORIGIN_FIXTURE).extract();
  };

  /** An agent on `targetDir`, started with this list on the node's store. */
  const syncing = async (ignore: string[]) => {
    if (!db) {
      const io = new IoMem();
      await io.init();
      db = new Db(io);
      await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    }
    const connector = new Connector(
      db,
      Route.fromFlat('/fsTree+'),
      new SocketMock(),
    );
    const agent = new FsAgent(targetDir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      ignore,
      timeouts: { debounceMs: 1 },
    });
    stops.push(await agent.syncToDb(db, connector, 'fsTree'));
    stops.push(() => agent.scanner.stopWatch());
    return agent;
  };

  // ...........................................................................
  describe('a restore', () => {
    it('writes nothing this node ignores into its own folder', async () => {
      const bs = new BsMem();
      const tree = await sourceTree(bs, {
        'a.txt': 'a',
        'x.bak': 'x',
        'build/out.js': 'o',
      });
      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        ignore: ['*.bak', 'build/'],
      });

      await agent.restore(tree);
      expect(existsSync(join(targetDir, 'a.txt'))).toBe(true);
      expect(existsSync(join(targetDir, 'x.bak'))).toBe(false);
      expect(existsSync(join(targetDir, 'build'))).toBe(false);

      // Anywhere else the tree is just a tree.
      await agent.restore(tree, elsewhere);
      expect(existsSync(join(elsewhere, 'x.bak'))).toBe(true);
      expect(existsSync(join(elsewhere, 'build', 'out.js'))).toBe(true);
    });

    it('does not remove a directory it ignores to make room for a file', async () => {
      const bs = new BsMem();
      const tree = await sourceTree(bs, { 'a.txt': 'a', cache: 'a file' });
      await mkdir(join(targetDir, 'cache'));
      await writeFile(join(targetDir, 'cache', 'keep.bin'), 'mine');
      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        ignore: ['cache/'],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(agent.restore(tree)).rejects.toThrow(UnwritablePathError);
      expect(await readFile(join(targetDir, 'cache', 'keep.bin'), 'utf-8')).toBe(
        'mine',
      );
      expect(existsSync(join(targetDir, 'a.txt'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('does not remove a file it ignores to make room for a directory', async () => {
      const bs = new BsMem();
      const tree = await sourceTree(bs, { 'cache/a.txt': 'a' });
      await writeFile(join(targetDir, 'cache'), 'mine');
      // The file is ignored, a directory of that name is not.
      const agent = new FsAgent(targetDir, bs, {
        ...ORIGIN_FIXTURE,
        ignore: ['cache', '!cache/'],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(agent.restore(tree)).rejects.toThrow(UnwritablePathError);
      expect(await readFile(join(targetDir, 'cache'), 'utf-8')).toBe('mine');
      vi.restoreAllMocks();
    });
  });

  // ...........................................................................
  describe('a merge', () => {
    it('carries each side\'s version, and a copy kept at a path it ignores', async () => {
      const agent = await syncing(['*.bak']);
      const mine = fileNode('x.bak', 'mine', 4);
      const yours = fileNode('y.bak', 'yours', 5);
      insides(agent)._ownContent = new Map([
        ['x.bak', 'mine'],
        ['a.txt', 'a'],
      ]);
      insides(agent)._carried = new Map([['x.bak', mine]]);
      await writeFile(join(targetDir, 'x (conflicted copy 1).bak'), 'theirs!');

      const carried = await insides(agent)._mergeCarried(
        new Map([
          ['x.bak', 'mine'],
          ['y.bak', 'yours'],
          ['a.txt', 'a'],
          // Both kept: one written, one that could not be.
          ['x (conflicted copy 1).bak', 'theirs'],
          ['x (conflicted copy 2).bak', 'lost'],
        ]),
        new Map([
          ['x.bak', 'theirs'],
          ['y.bak', 'yours'],
          ['a.txt', 'a'],
        ]),
        new Map([
          ['x.bak', fileNode('x.bak', 'theirs', 6)],
          ['y.bak', yours],
        ]),
      );
      expect([...carried.keys()].sort()).toEqual([
        'x (conflicted copy 1).bak',
        'x.bak',
        'y.bak',
      ]);
      expect(carried.get('x.bak')).toBe(mine);
      expect(carried.get('y.bak')).toBe(yours);
      expect(carried.get('x (conflicted copy 1).bak')?._hash).toBe(
        fileNode('x (conflicted copy 1).bak', 'theirs', 7)._hash,
      );
    });
  });

  // ...........................................................................
  describe('the guard against a folder that went missing', () => {
    it('counts only what the folder holds, not what it carries', async () => {
      // Every file this node sees is gone, unseen — an unmounted drive. The
      // fifty it carries are not in the folder; counted, they made the folder
      // look nearly full, and the twenty deletions went out.
      for (let n = 0; n < 20; n++) {
        await writeFile(join(targetDir, `doc-${n}.txt`), `doc ${n}`);
      }
      for (let n = 0; n < 50; n++) {
        await writeFile(join(targetDir, `old-${n}.bak`), `old ${n}`);
      }
      const first = await syncing([]);
      const head = first.ownHead as string;
      for (const stop of stops.splice(0)) stop();
      for (let n = 0; n < 20; n++) await rm(join(targetDir, `doc-${n}.txt`));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const again = await syncing(['*.bak']);
      expect(again.ownHead).toBe(head);
      expect(again.signals.some((s) => s.kind === 'deletion/refused')).toBe(
        true,
      );
      vi.restoreAllMocks();
    });
  });

  // ...........................................................................
  describe('the ignore list a restart compares against', () => {
    it('is read from the state file only when it is a list of patterns', async () => {
      const agent = new FsAgent(targetDir, new BsMem(), ORIGIN_FIXTURE);
      const state = join(targetDir, AGENT_STATE_FILE);
      const read = () => insides(agent)._persistedIgnore();

      expect(read()).toBeUndefined();
      await writeFile(state, JSON.stringify({ ownHead: 'h' }));
      expect(read()).toBeUndefined();
      await writeFile(state, JSON.stringify({ ownHead: 'h', ignore: '*.bak' }));
      expect(read()).toBeUndefined();
      await writeFile(state, JSON.stringify({ ownHead: 'h', ignore: ['*.bak', 1] }));
      expect(read()).toBeUndefined();
      await writeFile(state, JSON.stringify({ ownHead: 'h', ignore: ['*.bak'] }));
      expect(read()).toEqual(['*.bak']);
    });

    it('is the new one at once when a restart has nothing to compare against', async () => {
      // A state file written before the list was recorded.
      await writeFile(join(targetDir, 'a.txt'), 'a');
      await writeFile(join(targetDir, 'x.bak'), 'x');
      const first = await syncing([]);
      const head = first.ownHead as string;
      for (const stop of stops.splice(0)) stop();
      const state = join(targetDir, AGENT_STATE_FILE);
      const older = JSON.parse(readFileSync(state, 'utf-8'));
      delete older.ignore;
      await writeFile(state, JSON.stringify(older));

      const again = await syncing(['*.bak']);
      expect(again.ownHead).toBe(head);
      expect(JSON.parse(readFileSync(state, 'utf-8')).ignore).toEqual(
        again.scanner.ignore,
      );
      // What it ignores now, it carries: nothing was authored as deleted.
      expect(insides(again)._carried.has('x.bak')).toBe(true);
    });
  });

  // ...........................................................................
  describe('the paths a node sees again', () => {
    it('are not waited for once the network removed them', async () => {
      await writeFile(join(targetDir, 'a.txt'), 'a');
      const agent = await syncing([]);
      const i = insides(agent);
      i._uncovered.add('gone.bak');
      i._ignoreOnRecord = ['*.bak'];

      i._setOwn(agent.ownHead as string, i._ownContent, i._carried);
      expect(i._uncovered.size).toBe(0);
      expect(i._ignoreOnRecord).toEqual(agent.scanner.ignore);
    });

    it('wait for the next head when the own head cannot be read', async () => {
      await writeFile(join(targetDir, 'a.txt'), 'a');
      const agent = await syncing([]);
      const i = insides(agent);
      i._uncovered.add('y.bak');
      vi.spyOn(i, '_treeOf').mockResolvedValue(undefined);

      await i._takeUncovered();
      expect([...i._uncovered]).toEqual(['y.bak']);
      expect(readFileSync(join(targetDir, SYNC_ERROR_FILE), 'utf-8')).toContain(
        'the own head cannot be read',
      );
    });

    it('are let go one by one, as each is in the folder', async () => {
      await writeFile(join(targetDir, 'a.txt'), 'a');
      const agent = await syncing([]);
      const i = insides(agent);
      i._ignoreOnRecord = ['*.bak'];
      i._uncovered.add('a.txt');
      i._uncovered.add('y.bak');
      vi.spyOn(i, '_treeOf').mockResolvedValue(undefined);

      // `a.txt` is there — somebody's, whatever its version; `y.bak` is not.
      await i._takeUncovered();
      expect([...i._uncovered]).toEqual(['y.bak']);
      expect(i._ignoreOnRecord).toEqual(['*.bak']);

      // Once the last is there, the folder is in step with the new list.
      await writeFile(join(targetDir, 'y.bak'), 'y');
      await i._takeUncovered();
      expect(i._uncovered.size).toBe(0);
      expect(i._ignoreOnRecord).toEqual(agent.scanner.ignore);
    });

    it('do not bring back what the network deleted meanwhile', async () => {
      // Deleted on the network while this node ignored it; its own copy is
      // kept out of the folder rather than announced again.
      await writeFile(join(targetDir, 'a.txt'), 'a');
      await writeFile(join(targetDir, 'x.bak'), 'x');
      const first = await syncing([]);
      await rm(join(targetDir, 'x.bak'));
      await first.scanner.scanFresh();
      for (let n = 0; n < 100 && insides(first)._ownContent.has('x.bak'); n++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(insides(first)._ownContent.has('x.bak')).toBe(false);
      for (const stop of stops.splice(0)) stop();

      const ignoring = await syncing(['*.bak']);
      await writeFile(join(targetDir, 'x.bak'), 'mine');
      const head = ignoring.ownHead;
      for (const stop of stops.splice(0)) stop();

      const seeing = await syncing([]);
      expect(seeing.ownHead).toBe(head);
      expect(existsSync(join(targetDir, 'x.bak'))).toBe(false);
      const kept = join(targetDir, '.fsagent-recovered', 'x (recovered).bak');
      expect(await readFile(kept, 'utf-8')).toBe('mine');
      expect(seeing.signals.map((s) => s.kind)).toContain('join/recovered');
    });

    it('are joined without the history when the history cannot be read', async () => {
      await writeFile(join(targetDir, 'a.txt'), 'a');
      const agent = await syncing([]);
      const i = insides(agent);
      const head = agent.ownHead as string;
      const headTree = (await i._treeOf(head))?.tree as FsTree;
      i._ignoreOnRecord = ['*.txt'];
      vi.spyOn(i._chain, 'collectRemovals').mockRejectedValue(
        new Error('unreadable'),
      );

      // The folder already holds what the head holds: nothing to move.
      expect(
        await i._uncover(head, headTree, await agent.scanner.scanFresh()),
      ).toBe(false);
      expect(i._uncovered.size).toBe(0);
      expect(i._ignoreOnRecord).toEqual(agent.scanner.ignore);
    });
  });
});
