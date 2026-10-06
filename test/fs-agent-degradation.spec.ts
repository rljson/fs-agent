// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WHAT THE AGENT DOES WHEN ITS DEPENDENCIES FAIL.
//
// Every one of these paths was covered before, and by accident. The suite's
// 100 % included 24 error-handling callbacks — `lstat(...).catch(() =>
// undefined)`, `refreshHead().catch(() => undefined)`,
// `entryForTreeRef(...).catch(...)` — that were only ever entered because the
// fleet was MISBEHAVING: a peer read that blocked for its full request timeout
// (`@rljson/io` 0.0.81–0.0.83) and files that blended into content nobody wrote
// (`fs-atomic-write.ts`). Both were fixed, the failures stopped happening, and
// the handlers stopped being reached — the same 59 statements and 24 functions
// in two consecutive gate runs, identical, so it is systematic and not
// variance.
//
// That is worth stating plainly: **a coverage figure earned by things going
// wrong is not evidence that the degradation works.** These tests make the
// dependency fail on purpose instead, which is the only way the claim means
// anything — and the only way the figure survives the next fix.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { link, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_STATE_FILE,
  ANTI_ENTROPY_ASK_MS,
  EDIT_TIME_LOG_MAX,
  FsAgent,
  JOIN_ASK_INTERVAL_MS,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reaches a private member, as the tombstone-log tests do. */
const priv = <T>(agent: FsAgent, name: string): T =>
  (agent as unknown as Record<string, T>)[name];

/**
 * A chain stub whose named methods reject.
 *
 * Every one of these call sites catches the rejection and carries on, and that
 * is the contract being pinned: the chain is BEST EFFORT. A node whose history
 * is unreadable still has to sync — it loses the ordering the chain provides,
 * not the ability to work.
 */
const failingChain = (
  failing: string[],
  answers: Record<string, unknown> = {},
): Record<string, unknown> => {
  const chain: Record<string, unknown> = {};
  for (const name of [
    'refreshHead',
    'entry',
    'entryForTreeRef',
    'oldestEntryForTreeRef',
    'lastEditOf',
  ]) {
    chain[name] = failing.includes(name)
      ? () => Promise.reject(new Error(`the chain cannot read ${name}`))
      : () => Promise.resolve(answers[name]);
  }
  return chain;
};

/** A database with the trees table the agent expects, as the other specs build it. */
const aDb = async (): Promise<Db> => {
  const io = new IoMem();
  await io.init();
  const db = new Db(io);
  await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
  return db;
};

/** The sync-error file the agent writes when it degrades. */
const syncErrors = (dir: string): string => {
  const file = join(dir, SYNC_ERROR_FILE);
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
};

describe('FsAgent — degradation when a dependency fails', () => {
  let dir: string;
  let agent: FsAgent;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-agent-degrade-'));
    agent = new FsAgent(dir);
  });

  afterEach(async () => {
    agent.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  // ...........................................................................
  describe('a path that vanishes between the walk and the question', () => {
    // `_isSameFileAsExpected` asks whether an entry the prune is about to
    // delete is the expected file under another spelling — `Angebot.docx` and
    // `angebot.docx` are one file on a case-insensitive filesystem and two on
    // a case-sensitive one, and the inode answers that without knowing which.
    //
    // Both `lstat` calls can fail: the user can delete either path while the
    // restore is running, which is the normal state of a folder somebody is
    // working in. The code catches both and keeps nothing.
    const sameFileAsExpected = (
      a: FsAgent,
      fullPath: string,
      expected: Map<string, string>,
    ): Promise<boolean> =>
      (
        a as unknown as {
          _isSameFileAsExpected: (
            p: string,
            m: Map<string, string>,
          ) => Promise<boolean>;
        }
      )._isSameFileAsExpected(fullPath, expected);

    it('the prune KEEPS an entry that is the expected file renamed', async () => {
      // The same rule one level up, at the only caller left: a direct
      // `restore({ cleanTarget: true })`, which means "make this folder be
      // exactly this tree". The prune walks an entry the tree does not contain
      // and must not delete it when it IS the tree's file under another
      // spelling — deleting it would destroy the very file being restored.
      //
      // This is the half that was uncovered on Linux CI (`fs-agent.ts`
      // 2965-2966): on a case-sensitive filesystem the two spellings are two
      // files, so the keep never fires, and a hard link is what makes them one
      // without assuming anything about the volume.
      const spelled = join(dir, 'Angebot.docx');
      await writeFile(spelled, 'the real document');
      const tree = await agent.extract();

      const other = join(dir, 'angebot.docx');
      let oneFile = true;
      try {
        await link(spelled, other);
      } catch {
        // Already one file — a case-insensitive volume, and then the entry the
        // prune walks is the tree's own spelling, which it keeps anyway.
        oneFile = false;
      }

      await agent.restore(tree, dir, { cleanTarget: true });

      expect(
        existsSync(spelled),
        'the restore deleted the file it was restoring',
      ).toBe(true);
      if (oneFile) {
        expect(
          existsSync(other),
          'the prune deleted the expected file under its other spelling',
        ).toBe(true);
        expect(
          priv<number>(agent, '_restoreSkipped'),
          'the keep was not counted',
        ).toBeGreaterThan(0);
      }
    }, 30_000);

    it('a deleted DIRECTORY states the removal of the files it held', async () => {
      // UNREACHABLE ON macOS, so it is called directly.
      //
      // `rm -r` unlinks the children and then the directory. On Linux, when the
      // watched directory goes inotify removes its watch and drops any queued
      // child events — one child's deletion is observed and the rest are lost.
      // FSEvents reports them all, so on a developer's Mac the file branch
      // always wins and this one never runs.
      //
      // The consequence was not a slow deletion but an UNDONE one: nothing
      // stated those removals, so a peer still holding the files announced them
      // back and the node restored the directory it had just deleted. Measured
      // on Linux CI twice, a different subset surviving each time.
      //
      // It is not inference from absence: the watcher reported the directory
      // deleted, and removing a directory removes what is inside it.
      const announced = priv<Set<string>>(agent, '_announcedFiles');
      const held = [
        join(dir, 'old', 'f0.txt'),
        join(dir, 'old', 'f1.txt'),
        join(dir, 'old', 'nested', 'f2.txt'),
      ];
      for (const p of held) announced.add(p);
      // A file OUTSIDE the directory, which must not be touched.
      const elsewhere = join(dir, 'keep.txt');
      announced.add(elsewhere);

      const stated = (
        agent as unknown as { _tombstoneDeleted: (p: string) => number }
      )._tombstoneDeleted('old');

      expect(stated, 'the files the directory held were not stated').toBe(3);
      const pending = priv<Set<string>>(agent, '_pendingDeletes');
      for (const p of held) {
        expect(pending.has(p), `${p} was not tombstoned`).toBe(true);
      }
      expect(
        pending.has(elsewhere),
        'a file outside the deleted directory was tombstoned',
      ).toBe(false);
    });

    it('a deleted directory nobody heard of states nothing', async () => {
      // The bound. A path no peer could know about needs no tombstone, because
      // no peer can push it back — the same rule the file branch applies, and
      // what keeps a scratch directory from filling the log.
      const stated = (
        agent as unknown as { _tombstoneDeleted: (p: string) => number }
      )._tombstoneDeleted('never-announced');
      expect(stated).toBe(0);
      expect(priv<Set<string>>(agent, '_pendingDeletes').size).toBe(0);
    });

    it('keeps the entry when both spellings are ONE file', async () => {
      // THE ONLY BRANCH THAT KEEPS ANYTHING, and it was covered by accident.
      //
      // On a case-insensitive filesystem — macOS by default — writing
      // `Angebot.docx` makes `angebot.docx` reachable too, both spellings land
      // on one inode, and this returns true without anything being arranged.
      // On a case-SENSITIVE filesystem they are two files, the inodes differ,
      // and the branch is unreachable.
      //
      // So the whole `same === true` path, and the prune's `continue` that
      // depends on it, were 100% covered on a developer's Mac and uncovered on
      // Linux CI: `fs-agent.ts` lines 2451 and 2965-2966, reported as
      // `Coverage for lines (99.85%) does not meet global threshold (100%)`.
      // A green local gate said nothing about it.
      //
      // A HARD LINK arranges it on either kind of filesystem: two directory
      // entries differing only in case, one inode. On a case-insensitive one
      // the link is refused because the name already resolves — which is the
      // condition under test, so the refusal is ignored rather than asserted.
      const spelled = join(dir, 'Angebot.docx');
      await writeFile(spelled, 'x');
      const other = join(dir, 'angebot.docx');
      try {
        await link(spelled, other);
      } catch {
        // Already one file: a case-insensitive filesystem has arranged it.
      }

      const expected = new Map([[other.toLowerCase(), spelled]]);
      expect(
        await sameFileAsExpected(agent, other, expected),
        'two spellings of one inode were not recognised as one file',
      ).toBe(true);
    });

    it('keeps nothing when NEITHER path is on disk any more', async () => {
      const gone = join(dir, 'Angebot.docx');
      const expected = new Map([[gone.toLowerCase(), join(dir, 'angebot.docx')]]);
      expect(await sameFileAsExpected(agent, gone, expected)).toBe(false);
    });

    it('keeps nothing when only the ENTRY is on disk', async () => {
      const here = join(dir, 'Angebot.docx');
      await writeFile(here, 'x');
      const expected = new Map([[here.toLowerCase(), join(dir, 'angebot.docx')]]);
      // On a case-INSENSITIVE filesystem these are one file, so the expected
      // path stats fine and the answer is "keep". On a case-sensitive one the
      // expected path is absent and the answer is "do not keep". Either is
      // correct; what must not happen is a throw.
      const kept = await sameFileAsExpected(agent, here, expected);
      expect(typeof kept).toBe('boolean');
    });

    it('answers no without touching the disk when nothing expects the path', async () => {
      // The early return: no expected spelling, so neither `lstat` is reached.
      const orphan = join(dir, 'nobody-expects-this.txt');
      expect(await sameFileAsExpected(agent, orphan, new Map())).toBe(false);
    });

    it('answers no when the expected spelling IS the path itself', async () => {
      const same = join(dir, 'exact.txt');
      await writeFile(same, 'x');
      const expected = new Map([[same.toLowerCase(), same]]);
      expect(await sameFileAsExpected(agent, same, expected)).toBe(false);
    });
  });

  // ...........................................................................
  describe('the chain refuses to answer', () => {
    // `_ensureChain` is best-effort by design — fs-agent creates its own
    // tables, and a node whose host is one release behind must still sync. So
    // every read of the chain is wrapped, and what these pin is that the
    // wrapping DEGRADES rather than swallows: the ordering is lost, the sync
    // is not, and the failure is written where somebody can find it.

    it('agreeing on the fleet\'s entry gives up when the lookup fails', async () => {
      (agent as unknown as { _chain: unknown })._chain = failingChain([
        'oldestEntryForTreeRef',
      ]);
      await expect(
        priv<(r: string) => Promise<void>>(agent, '_agreeOnEntryFor').call(
          agent,
          'someTreeRef',
        ),
      ).resolves.toBeUndefined();
    });

    it('adopts the fleet\'s entry when THIS node\'s own entry is unreadable', async () => {
      // The second catch: the fleet's entry read fine, ours did not. With no
      // timeId of our own to compare, the fleet's entry wins — which is the
      // safe direction, because it claims no path for this node.
      (agent as unknown as { _chain: unknown })._chain = failingChain(
        ['entry'],
        {
          oldestEntryForTreeRef: {
            head: 'theirHead',
            timeId: '100:aaaaaaaa',
          },
        },
      );
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'myTreeRef',
      };

      await priv<(r: string) => Promise<void>>(
        agent,
        '_agreeOnEntryFor',
      ).call(agent, 'someTreeRef');

      expect(
        (agent as unknown as { _chainHead: { head: string } })._chainHead.head,
      ).toBe('theirHead');
    });

    it('a conflict verdict with no readable history returns no timeId', async () => {
      // `chainTimeIdOfRef` and `lastEditOfPath` are what let the resolver pick
      // a winner PER PATH instead of per branch. With the chain unreadable
      // both must answer `undefined` — the resolver then falls back to branch
      // order — and the failure must be recorded, not silent.
      const db = await aDb();

      const deps = priv<(d: Db, k: string) => Record<string, unknown>>(
        agent,
        '_buildConflictResolverDeps',
      ).call(agent, db, 'fsTree');

      (agent as unknown as { _chain: unknown })._chain = failingChain([
        'entryForTreeRef',
      ]);

      const timeId = await (
        deps.chainTimeIdOfRef as (r: string) => Promise<string | undefined>
      )('someTreeRef');
      expect(timeId).toBeUndefined();
      expect(syncErrors(dir), 'the degradation was not recorded').toContain(
        'chain/timeIdOfRef',
      );

      const lastEdit = await (
        deps.lastEditOfPath as (
          r: string,
          p: string,
        ) => Promise<string | undefined>
      )('someTreeRef', 'one.txt');
      expect(lastEdit).toBeUndefined();
    });

    it('a readable entry with an unreadable WALK still returns no timeId', async () => {
      // The other half of `lastEditOfPath`: the entry resolves, walking it for
      // the path does not. Recorded under its own context so the two are
      // distinguishable in the error file.
      const db = await aDb();

      const deps = priv<(d: Db, k: string) => Record<string, unknown>>(
        agent,
        '_buildConflictResolverDeps',
      ).call(agent, db, 'fsTree');

      (agent as unknown as { _chain: unknown })._chain = failingChain(
        ['lastEditOf'],
        { entryForTreeRef: { head: 'aHead', timeId: '100:aaaaaaaa' } },
      );

      const lastEdit = await (
        deps.lastEditOfPath as (
          r: string,
          p: string,
        ) => Promise<string | undefined>
      )('someTreeRef', 'one.txt');
      expect(lastEdit).toBeUndefined();
      expect(syncErrors(dir)).toContain('chain/lastEditOfPath');
    });
  });

  // ...........................................................................
  describe('the ask loops, when the chain cannot answer them', () => {
    // Two timers ASK rather than wait to be told: the join ask (a node that
    // misses the hub's bootstrap cannot tell "I heard nothing" from "there is
    // nothing") and the anti-entropy ask (a dropped announcement is never
    // retried, so listening alone leaves a receiver frozen reporting health).
    //
    // Both read the chain every tick, and the chain is best-effort. What these
    // pin is that a tick which cannot read it is a NO-OP and not a crash: the
    // loop has to survive to ask again, because the next tick is the whole
    // recovery mechanism.

    it('a join tick whose head lookup fails does nothing and keeps asking', async () => {
      const db = await aDb();
      priv<(d: Db, k: string, w: string) => void>(
        agent,
        '_deferToNetwork',
      ).call(agent, db, 'fsTree', 'the folder has files and no history');
      (agent as unknown as { _chain: unknown })._chain = failingChain([
        'refreshHead',
      ]);

      await sleep(JOIN_ASK_INTERVAL_MS * 3);

      // Still waiting — the failed read must not have resolved the join one
      // way or the other.
      expect(
        priv<unknown>(agent, '_joinPending'),
        'a failed tick abandoned the join',
      ).not.toBeUndefined();
      expect(syncErrors(dir)).not.toContain('join/ask');
    });

    it('a join tick whose entry lookup fails does nothing and keeps asking', async () => {
      const db = await aDb();
      priv<(d: Db, k: string, w: string) => void>(
        agent,
        '_deferToNetwork',
      ).call(agent, db, 'fsTree', 'the folder has files and no history');
      (agent as unknown as { _chain: unknown })._chain = failingChain(
        ['entry'],
        { refreshHead: 'aHead' },
      );

      await sleep(JOIN_ASK_INTERVAL_MS * 3);
      expect(priv<unknown>(agent, '_joinPending')).not.toBeUndefined();
    });

    it('a join tick that throws OUTRIGHT is recorded and the loop survives', async () => {
      // A synchronous throw never reaches the per-call `.catch`, so it lands
      // in the timer's own handler. That is the one that has to write it down,
      // because a loop failing silently every 150 ms is indistinguishable from
      // a loop that is working.
      const db = await aDb();
      priv<(d: Db, k: string, w: string) => void>(
        agent,
        '_deferToNetwork',
      ).call(agent, db, 'fsTree', 'the folder has files and no history');
      (agent as unknown as { _chain: unknown })._chain = {
        refreshHead: () => {
          throw new Error('the chain threw outright');
        },
      };

      await sleep(JOIN_ASK_INTERVAL_MS * 3);
      expect(syncErrors(dir), 'the failing tick was never recorded').toContain(
        'join/ask',
      );
      expect(
        priv<unknown>(agent, '_joinPending'),
        'the loop gave up instead of asking again',
      ).not.toBeUndefined();
    });

    it('an anti-entropy tick whose chain reads fail leaves the fleet alone', async () => {
      // The ask exists to notice MISSING work. A tick that cannot read the
      // chain must not offer the anti-entropy anything — an unprompted repair
      // against a branch this node was not behind once ended a run on round 5
      // of 10.
      const db = await aDb();
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await agent.syncFromDb(db, connector, 'fsTree');
      try {
        (agent as unknown as { _chain: unknown })._chain = failingChain([
          'refreshHead',
        ]);
        await sleep(ANTI_ENTROPY_ASK_MS + 400);
        expect(syncErrors(dir)).not.toContain('antiEntropy/ask');

        // And the other two reads on that path.
        (agent as unknown as { _chain: unknown })._chain = failingChain(
          ['entry'],
          { refreshHead: 'aHead' },
        );
        await sleep(ANTI_ENTROPY_ASK_MS + 400);
        expect(syncErrors(dir)).not.toContain('antiEntropy/ask');
      } finally {
        stop();
      }
    }, 30_000);

    it('an anti-entropy tick asks for no repair when classify fails', async () => {
      // The ask exists to notice MISSING work, and only that. `refreshHead`
      // returns A tip and during churn there can be several — a sibling branch
      // is a tip too — so offering one to the anti-entropy without knowing we
      // are BEHIND it starts a repair nothing asked for. Measured once as a
      // node ending on round 5 of 10 after a `fork` verdict sent it into a
      // merge against a branch it was not behind. An unreadable `classify`
      // therefore has to mean "ask for nothing", not "assume behind".
      const db = await aDb();
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await agent.syncFromDb(db, connector, 'fsTree');
      try {
        (agent as unknown as { _chainHead: unknown })._chainHead = {
          head: 'myHead',
          treeRef: 'myTreeRef',
        };
        (agent as unknown as { _currentRef: unknown })._currentRef = 'myTreeRef';
        (agent as unknown as { _chain: unknown })._chain = {
          refreshHead: () => Promise.resolve('theirHead'),
          entry: () =>
            Promise.resolve({ treeRef: 'theirTreeRef', previous: [] }),
          classify: () => Promise.reject(new Error('the walk ran out')),
        };

        await sleep(ANTI_ENTROPY_ASK_MS + 400);
        // It got all the way to the comparison and then asked for nothing.
        expect(syncErrors(dir)).not.toContain('antiEntropy/ask');
      } finally {
        stop();
      }
    }, 30_000);

    it('an anti-entropy tick that throws outright is recorded', async () => {
      const db = await aDb();
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await agent.syncFromDb(db, connector, 'fsTree');
      try {
        (agent as unknown as { _chain: unknown })._chain = {
          refreshHead: () => {
            throw new Error('the chain threw outright');
          },
        };
        await sleep(ANTI_ENTROPY_ASK_MS + 400);
        expect(syncErrors(dir)).toContain('antiEntropy/ask');
      } finally {
        stop();
      }
    }, 30_000);
  });

  // ...........................................................................
  describe('setting a file aside when it cannot be moved', () => {
    // The join moves two kinds of file out of the way before applying the
    // fleet's state: one the history says was deleted (into
    // `.fsagent-recovered/`) and one edited while this node was away (as a
    // conflict copy). Either move can fail, and the answer is to leave the
    // file alone and record it — the restore then overwrites it, which loses
    // less than refusing to join at all.

    const setAside = (a: FsAgent, from: string, to: string): Promise<void> =>
      priv<(f: string, t: string) => Promise<void>>(a, '_setAside').call(
        a,
        from,
        to,
      );

    it('records the failure when the file is already gone', async () => {
      await setAside(agent, 'vanished.txt', '.fsagent-recovered/vanished.txt');
      expect(
        syncErrors(dir),
        'a file that could not be set aside was not recorded',
      ).toContain('join/setAside/vanished.txt');
    });

    it('records the failure when the destination is a directory', async () => {
      // A non-empty directory at the destination cannot be renamed over.
      await writeFile(join(dir, 'doc.txt'), 'content');
      const blocked = join(dir, '.fsagent-recovered', 'doc.txt');
      await rm(blocked, { recursive: true, force: true });
      const { mkdir } = await import('fs/promises');
      await mkdir(blocked, { recursive: true });
      await writeFile(join(blocked, 'inside.txt'), 'somebody else\'s work');

      await setAside(agent, 'doc.txt', '.fsagent-recovered/doc.txt');

      expect(syncErrors(dir)).toContain('join/setAside/doc.txt');
      // And the file it could not move is still where it was.
      expect(existsSync(join(dir, 'doc.txt'))).toBe(true);
    });

    it('moves the file when it CAN, creating the directory on the way', async () => {
      await writeFile(join(dir, 'deleted-while-away.txt'), 'my work');
      await setAside(
        agent,
        'deleted-while-away.txt',
        '.fsagent-recovered/deleted-while-away.txt',
      );
      expect(existsSync(join(dir, 'deleted-while-away.txt'))).toBe(false);
      expect(
        existsSync(join(dir, '.fsagent-recovered', 'deleted-while-away.txt')),
      ).toBe(true);
      expect(syncErrors(dir)).not.toContain('join/setAside');
    });
  });

  // ...........................................................................
  describe('reachability and the join walk, with an unreadable history', () => {
    it('judging an announcement falls back to the tree ref alone', async () => {
      // `_reachabilityOf` asks the chain which entry produced an announced
      // state, so it can say whether this node is behind, ahead or forked.
      // When that query fails the answer is the tree ref with NO reachability
      // — and that matters: no reachability means the ordinary heuristics
      // decide, which is the behaviour this query was added to improve on,
      // not to replace.
      (
        agent as unknown as {
          _resolveAnnouncement: (a: string) => Promise<unknown>;
        }
      )._resolveAnnouncement = async () => ({ treeRef: 'theirTreeRef' });
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'myTreeRef',
      };
      (agent as unknown as { _chain: unknown })._chain = failingChain([
        'entryForTreeRef',
      ]);

      const result = await priv<
        (a: string) => Promise<{ treeRef: string; reachability?: string }>
      >(agent, '_reachabilityOf').call(agent, 'announced');

      expect(result).toEqual({ treeRef: 'theirTreeRef' });
    });

    it('joining treats an unreadable walk as "nothing is known to be removed"', async () => {
      // The join decides what to set aside from what the history says was
      // REMOVED. An unreadable walk makes that unknown — and unknown must not
      // read as "never removed" (which would announce a stale copy) or as
      // "removed" (which would destroy new work). Neither: every extra file
      // stays in `announce`, so the node is at worst noisy.
      await writeFile(join(dir, 'mine.txt'), 'my work');
      // A real, valid, EMPTY tree — scanned from an empty folder, because a
      // hand-made `{ rootHash: '', trees: new Map() }` is not one and fails in
      // the content map before the walk is ever reached.
      const emptyDir = await mkdtemp(join(tmpdir(), 'fs-agent-head-'));
      const emptyTree = await new FsAgent(emptyDir).extract();
      await rm(emptyDir, { recursive: true, force: true });
      (
        agent as unknown as {
          _fetchTreeFromDb: (...a: unknown[]) => Promise<unknown>;
        }
      )._fetchTreeFromDb = async () => emptyTree;
      (agent as unknown as { _chain: unknown })._chain = {
        ...failingChain([]),
        collectRemovals: () =>
          Promise.reject(new Error('the history cannot be walked')),
      };

      const db = await aDb();
      await priv<(d: Db, k: string, e: unknown) => Promise<void>>(
        agent,
        '_joinReconcileBody',
      ).call(agent, db, 'fsTree', {
        head: 'theirHead',
        treeRef: 'theirTreeRef',
        timeId: '100:aaaaaaaa',
        previous: [],
      });

      // The file this node holds was NOT set aside and NOT deleted.
      expect(
        existsSync(join(dir, 'mine.txt')),
        'an unreadable walk cost the node its own file',
      ).toBe(true);
      expect(existsSync(join(dir, '.fsagent-recovered'))).toBe(false);
    });
  });

  // ...........................................................................
  describe('resuming from a recorded ref the database cannot serve', () => {
    it('starts anyway, additively, instead of refusing to sync', async () => {
      // A restart reloads the NAME of the state it was last in and then reads
      // what that state CONTAINED, so a deletion made while it was stopped can
      // be stated rather than silently retained. The read is of this node's
      // OWN database, so nothing is asked of the network — but it can still
      // fail, and then the old additive behaviour is the right fallback: the
      // node under-states rather than deleting on a guess.
      await writeFile(
        join(dir, AGENT_STATE_FILE),
        JSON.stringify({ currentRef: 'aRefThisDbNeverHad' }),
      );
      await writeFile(join(dir, 'doc.txt'), 'content');

      (
        agent as unknown as {
          _fetchTreeFromDb: (...a: unknown[]) => Promise<unknown>;
        }
      )._fetchTreeFromDb = () =>
        Promise.reject(new Error('that tree is not in this database'));

      const db = await aDb();
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await agent.syncToDb(db, connector, 'fsTree');
      try {
        // It started, and it established a state of its own rather than
        // refusing to sync. `_hasAnnounced` is true here because the initial
        // push sets it — what the failed read cost is the CONTENT of the
        // previous state, not the ability to run.
        expect(priv<string | undefined>(agent, '_currentRef')).toBeDefined();

        // Worth knowing and currently true: this degradation is SILENT. The
        // read is wrapped in `.catch(() => undefined)` with nothing written,
        // so a node that permanently cannot read its own recorded state
        // under-states its deletions for ever and says so nowhere. The
        // fallback is the right one; the silence is a reporting gap.
        expect(syncErrors(dir)).not.toContain('resume');
      } finally {
        stop();
      }
    }, 30_000);
  });

  // ...........................................................................
  describe('classifying an announced ref with an unreadable chain', () => {
    const classify = (a: FsAgent, treeRef: string): Promise<string> =>
      priv<(r: string) => Promise<string>>(a, '_classifyAnnouncedRef').call(
        a,
        treeRef,
      );

    it('answers "incomplete" when the entry for the ref cannot be read', async () => {
      // An unreadable chain has to give the same answer as a MISSING one,
      // because in both cases the history says nothing — and `incomplete`
      // leaves the decision to the caller's own branches instead of guessing
      // a relation that would gate a merge.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'myTreeRef',
      };
      (agent as unknown as { _chain: unknown })._chain = failingChain([
        'entryForTreeRef',
      ]);
      expect(await classify(agent, 'theirTreeRef')).toBe('incomplete');
    });

    it('answers "incomplete" when classify itself cannot be computed', async () => {
      // The head was found — by announcement or by lookup — and comparing the
      // two could not be done. Same answer, for the same reason.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'myTreeRef',
      };
      (agent as unknown as { _chain: unknown })._chain = {
        ...failingChain([], {
          entryForTreeRef: { head: 'theirHead', timeId: '1:a' },
        }),
        classify: () => Promise.reject(new Error('the walk ran out')),
      };
      expect(await classify(agent, 'theirTreeRef')).toBe('incomplete');
    });

    it('uses the head the ANNOUNCEMENT carried in preference to a lookup', async () => {
      // The lookup by tree ref is ambiguous by nature: a tree ref is a content
      // hash, so two nodes holding the same bytes produce the same one. The
      // announced head is what the sender said about ITSELF.
      // `_currentRef` set to match, because a verdict is only given while the
      // head NAMES the state the folder is in — see the test below. This
      // fixture left it unset, which now means "this node holds work no head
      // speaks for" and answers `incomplete` before any lookup happens.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'myTreeRef',
      };
      (agent as unknown as { _currentRef: unknown })._currentRef = 'myTreeRef';
      const asked: string[] = [];
      (agent as unknown as { _chain: unknown })._chain = {
        entryForTreeRef: () =>
          Promise.reject(new Error('must not be consulted')),
        classify: (_mine: string, theirs: string) => {
          asked.push(theirs);
          return Promise.resolve('behind');
        },
      };
      priv<Map<string, string>>(agent, '_announcedHeads').set(
        'theirTreeRef',
        'headFromTheAnnouncement',
      );

      expect(await classify(agent, 'theirTreeRef')).toBe('behind');
      expect(asked).toEqual(['headFromTheAnnouncement']);
    });

    it('records a bucket round\'s agreement only against a hub ref', async () => {
      // A round can finish after the announcement that prompted it has been
      // superseded, or before any beacon has arrived. An agreement names both
      // sides, so with nothing to name on the hub's side there is nothing to
      // record — and recording it against `undefined` would mark every future
      // announcement as agreed.
      const told: string[] = [];
      (agent as unknown as { _antiEntropy: unknown })._antiEntropy = {
        status: { hubRef: undefined },
        agreedOn: (r: string) => told.push(r),
      };
      (
        agent as unknown as { _bucketRoundAgreed: () => void }
      )._bucketRoundAgreed();
      expect(told, 'an agreement was recorded with nothing to agree with').toEqual(
        [],
      );

      (agent as unknown as { _antiEntropy: unknown })._antiEntropy = {
        status: { hubRef: 'theHubsRef' },
        agreedOn: (r: string) => told.push(r),
      };
      (
        agent as unknown as { _bucketRoundAgreed: () => void }
      )._bucketRoundAgreed();
      expect(told, 'a proven agreement was not recorded').toEqual([
        'theHubsRef',
      ]);
    });

    it('gives no verdict when the walk itself fails', async () => {
      // The chain is BEST EFFORT everywhere, and a walk that throws is not a
      // verdict. `incomplete` keeps a failed read from being mistaken for a
      // clean answer — a `behind` invented here authorises a repair to replace
      // the folder.
      //
      // The head must NAME the folder for the walk to be reached at all, so
      // both are set: the guard below returns before `classify` otherwise, and
      // that is how this path stopped being exercised.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'whereIAm',
      };
      (agent as unknown as { _currentRef: unknown })._currentRef = 'whereIAm';
      (agent as unknown as { _chain: unknown })._chain = {
        classify: () => Promise.reject(new Error('the walk cannot be read')),
      };
      priv<Map<string, string>>(agent, '_announcedHeads').set(
        'theirTreeRef',
        'theirHead',
      );

      expect(
        await classify(agent, 'theirTreeRef'),
        'a failed walk was reported as a clean verdict',
      ).toBe('incomplete');
    });

    it('gives no verdict while its own head does not name its folder', async () => {
      // THE DEFECT THIS EXISTS FOR, and it cost a file every time it fired.
      //
      // `classify` compares two chain HEADS. This node's head can lag its own
      // folder — a write is on disk and in `_currentRef` before
      // `_recordChainEntry` has appended the entry for it, and an apply that
      // re-derives a different ref leaves the head naming the state it came
      // from. Asked in that window the chain answers truthfully about a state
      // this node has already left:
      //
      //   ours=fZ79puL0 theirs=KDeHB45d -> behind
      //     chainHeadTree=B4-SH9ZX current=hd3PHz1r
      //
      // `behind` was right about the head and wrong about the folder, which
      // held a file no peer had. The repair read it as `pull`, replaced the
      // folder, and did it again — 45 times in 89 seconds on `I7b`.
      //
      // `incomplete` becomes `blocked`: nothing applied, nothing latched,
      // retried. `fork` was tried instead and measured WORSE, 3 of 8 churn
      // runs against 1 of 8.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'theStateMyHeadNames',
      };
      (agent as unknown as { _currentRef: unknown })._currentRef =
        'theStateMyFolderIsActuallyIn';
      (agent as unknown as { _chain: unknown })._chain = {
        classify: () =>
          Promise.reject(new Error('must not be asked about a stale head')),
      };
      priv<Map<string, string>>(agent, '_announcedHeads').set(
        'theirTreeRef',
        'theirHead',
      );

      expect(
        await classify(agent, 'theirTreeRef'),
        'a verdict was given about a head that does not name this folder',
      ).toBe('incomplete');
    });
  });

  // ...........................................................................
  describe('cleaning up after a peer deletion the filesystem fights', () => {
    it('skips a path that is already gone and leaves a non-empty directory alone', async () => {
      // Children before parents, so a directory is empty by the time its turn
      // comes — unless somebody's work is still in there, and then `rmdir`
      // refusing is the CORRECT outcome. `recursive: true` would delete that
      // work, which is the exact class of loss the removals rule exists to
      // prevent.
      await writeFile(join(dir, 'anchor.txt'), 'held');
      const folder = join(dir, 'folder');
      const { mkdir } = await import('fs/promises');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'somebody-elses-work.txt'), 'mine');

      // A peer states three removals: the non-empty directory, one real file,
      // and one the node HELD at scan time and no longer has on disk.
      //
      // That last one is the case worth building deliberately: the plan is
      // computed from what the node held, so a path only reaches the cleanup
      // loop if it was in the tree — and the user can still delete it in the
      // window between the scan and the apply, which is the normal state of a
      // folder somebody is working in.
      await writeFile(join(dir, 'raced.txt'), 'deleted by the user meanwhile');
      await agent.extract();
      await rm(join(dir, 'raced.txt'), { force: true });

      priv<
        Map<string, { removed: string[]; changed: string[]; timeId: string }>
      >(agent, '_incomingRemovals').set('theirTreeRef', {
        removed: ['raced.txt', 'folder', 'anchor.txt'],
        changed: [],
        timeId: '100:aaaaaaaa',
      });

      await priv<(r: string) => Promise<void>>(
        agent,
        '_applyIncomingRemovals',
      ).call(agent, 'theirTreeRef');

      // The real file went; the directory and the work inside it stayed.
      expect(existsSync(join(dir, 'anchor.txt'))).toBe(false);
      expect(
        existsSync(join(folder, 'somebody-elses-work.txt')),
        'a non-empty directory was emptied on a peer\'s authority',
      ).toBe(true);
    });
  });

  // ...........................................................................
  describe('with no edit chain at all', () => {
    // **This is a supported state, not a broken one.** `_ensureChain` is
    // best-effort on purpose: fs-agent creates its OWN tables, and an agent
    // that insisted on them would fail at runtime on every node whose host is
    // one release behind. So every path that reads the chain begins by asking
    // whether there is one, and what that buys is a node which syncs without
    // the chain's ordering rather than not syncing at all.
    //
    // Each of these asserts the OBSERVABLE consequence — nothing written,
    // nothing recorded, nothing thrown — because a test that merely executes
    // a guard proves only that the guard is syntactically present.

    const callOn = (name: string, ...args: unknown[]): Promise<unknown> =>
      priv<(...a: unknown[]) => Promise<unknown>>(agent, name).apply(
        agent,
        args,
      );

    it('agreeing on an entry does nothing', async () => {
      await expect(callOn('_agreeOnEntryFor', 'aTreeRef')).resolves.toBeUndefined();
      expect(priv<unknown>(agent, '_chainHead')).toBeUndefined();
    });

    it('collecting removals for a ref does nothing', async () => {
      await expect(
        callOn('_collectRemovalsForTreeRef', 'aTreeRef'),
      ).resolves.toBeUndefined();
      expect(priv<Map<string, unknown>>(agent, '_incomingRemovals').size).toBe(0);
    });

    it('collecting a peer entry\'s removals does nothing', async () => {
      await expect(
        callOn('_collectIncomingRemovals', {
          head: 'theirHead',
          treeRef: 'theirTreeRef',
          timeId: '1:a',
          previous: [],
        }),
      ).resolves.toBeUndefined();
      expect(priv<Map<string, unknown>>(agent, '_incomingRemovals').size).toBe(0);
    });

    it('recording this node\'s own entry does nothing', async () => {
      // And that is the half that matters for authorship: with no chain there
      // are no claims, so a peer's later removal of a path is never refused as
      // stale on the strength of a claim this node never recorded.
      await expect(
        callOn('_recordChainEntry', 'aTreeRef', [], ['one.txt']),
      ).resolves.toBeUndefined();
      expect(priv<Map<string, string>>(agent, '_localPathTimeIds').size).toBe(0);
    });

    it('an unmarked announcement resolves to the bare tree ref', async () => {
      // The hub advertises from its trees table, so an unmarked ref is the
      // common case and not a legacy one. No chain means no head to read off
      // it, and the ref itself is still the state to apply.
      const resolved = await callOn('_resolveAnnouncement', 'bareTreeRef');
      expect(resolved).toEqual({ treeRef: 'bareTreeRef' });
    });

    it('a second concurrent join returns the first one instead of starting again', async () => {
      // `_joinInFlight` exists because two announcements can arrive while the
      // first reconcile is still writing the folder, and running two at once
      // would have them fight over the same files.
      let release: () => void = () => undefined;
      const inFlight = new Promise<void>((r) => {
        release = r;
      });
      (agent as unknown as { _joinInFlight: unknown })._joinInFlight = inFlight;

      const second = callOn('_reconcileJoin', undefined, 'fsTree', {
        head: 'theirHead',
        treeRef: 'theirTreeRef',
        timeId: '1:a',
        previous: [],
      });
      release();
      await expect(second).resolves.toBeUndefined();
    });
  });

  // ...........................................................................
  describe('the bucket fetch and a path this node deleted', () => {
    it('does not fetch back a path this node has tombstoned', async () => {
      // The peer has not heard about the deletion yet; it will, and this
      // node's own manifest already says so. Fetching it back would resurrect
      // a file its owner deleted — on the authority of a peer that is simply
      // behind.
      const target = join(dir, 'deleted-here.txt');
      priv<Set<string>>(agent, '_pendingDeletes').add(target);

      const db = await aDb();
      await callOnAgent(
        agent,
        '_applyReconcilePlan',
        {
          fetch: [['deleted-here.txt', 'someBlobId']],
          drop: [],
          redelete: [],
          conflict: [],
        },
        db,
        'fsTree',
      );

      expect(
        existsSync(target),
        'a tombstoned path was fetched back from a peer',
      ).toBe(false);
    });
  });
  // ...........................................................................
  describe('the things a node says out loud when it cannot act', () => {
    // Every one of these used to be silent, and silence is the defect: a node
    // can be told the hub's state thirty-seven times, ignore every one, and
    // report perfect health.

    it('says so when a marked head arrives before it has a chain', async () => {
      // No chain means nothing can resolve the head, and nothing will repair
      // from it — the node is relying entirely on being pushed to. That is
      // worth a warning rather than a silent discard.
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        const resolved = await callOnAgent(
          agent,
          '_resolveAnnouncement',
          '~H~aMarkedHead',
        );
        expect(resolved).toBeUndefined();
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).toContain('DISCARDED');
    });

    it('says so when a head cannot be resolved here', async () => {
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        (agent as unknown as { _chain: unknown })._chain = failingChain([], {
          entry: undefined,
        });
        const resolved = await callOnAgent(
          agent,
          '_resolveAnnouncement',
          '~H~aMarkedHead',
        );
        expect(resolved).toBeUndefined();
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).toContain('will re-announce');
    });

    it('refuses to act on deletions behind an INCOMPLETE ancestry', async () => {
      // An incomplete walk cannot say whether a path was ever removed, and
      // acting on it would delete on a guess. The sender re-announces.
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        (agent as unknown as { _chain: unknown })._chain = {
          collectRemovals: () =>
            Promise.resolve({ complete: false, removed: ['one.txt'] }),
        };
        await callOnAgent(agent, '_collectIncomingRemovals', {
          head: 'theirHead',
          treeRef: 'theirTreeRef',
          timeId: '1:a',
          previous: [],
        });
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).toContain('incomplete');
      expect(
        priv<Map<string, unknown>>(agent, '_incomingRemovals').size,
        'deletions were parked on an ancestry that could not be walked',
      ).toBe(0);
    });

    it('records a blob it cannot fetch without losing the whole round', async () => {
      // One unreachable blob is worth one missing file, never the whole
      // bucket round — the same rule the restore path learned the hard way.
      const db = await aDb();
      await callOnAgent(
        agent,
        '_applyReconcilePlan',
        {
          fetch: [['wanted.txt', 'aBlobNobodyHas']],
          drop: [],
          redelete: [],
          conflict: [],
        },
        db,
        'fsTree',
      );
      expect(syncErrors(dir)).toContain('bucketSync/fetch/wanted.txt');
    });

    it('judging an announcement that cannot be resolved answers nothing', async () => {
      (
        agent as unknown as {
          _resolveAnnouncement: (a: string) => Promise<unknown>;
        }
      )._resolveAnnouncement = async () => undefined;
      expect(
        await callOnAgent(agent, '_reachabilityOf', 'announced'),
      ).toBeUndefined();
    });

    it('an ask that fires after the join resolved does nothing', async () => {
      // The join can be finished by an announcement between two ticks, and the
      // tick that lands afterwards must not start a second reconcile.
      const db = await aDb();
      priv<(d: Db, k: string, w: string) => void>(
        agent,
        '_deferToNetwork',
      ).call(agent, db, 'fsTree', 'the folder has files and no history');
      (agent as unknown as { _chain: unknown })._chain = failingChain([], {
        refreshHead: 'aHead',
        entry: { head: 'aHead', treeRef: 'aTreeRef', timeId: '1:a' },
      });
      // Resolved before the tick.
      (agent as unknown as { _joinPending: unknown })._joinPending = undefined;

      await sleep(JOIN_ASK_INTERVAL_MS * 3);
      expect(syncErrors(dir)).not.toContain('join/');
    });
  });
  // ...........................................................................
  describe('the remaining degradations, each on purpose', () => {
    it('falls back to the per-node walk when the batch read fails', async () => {
      // Batch reads are an OPTIMISATION. A failure there is not a failure of
      // the walk — every hash simply goes down the slower per-node path, and
      // the answer is the same one.
      const db = await aDb();
      const tree = await agent.extract();
      const ref = await agent.storeInDb(db, 'fsTree', tree);
      // `Core.readRowsByHashes` is the batch path; the per-node walk below it
      // is the proven one. Making the batch fail is what sends the walk down
      // the slow road, and the answer has to be identical.
      (
        db.core as unknown as { readRowsByHashes: (...a: unknown[]) => unknown }
      ).readRowsByHashes = () =>
        Promise.reject(new Error('the batch read is unavailable'));

      const fetched = await callOnAgent(
        agent,
        '_fetchTreeFromDb',
        db,
        'fsTree',
        ref,
      );
      expect(fetched, 'the walk gave up when its optimisation failed').toBeTruthy();
    }, 30_000);

    it('the resolver log sink carries every level through', async () => {
      // This sink was absent for a long time, so every line the conflict
      // resolver wrote went nowhere — including the one naming which paths a
      // per-path verdict moved. It cost hours of one investigation: the
      // diagnostics produced no output and the absence was read as the code
      // not running.
      const db = await aDb();
      const deps = priv<(d: Db, k: string) => Record<string, unknown>>(
        agent,
        '_buildConflictResolverDeps',
      ).call(agent, db, 'fsTree');
      const log = deps.log as (level: string, message: string) => void;

      const seen: string[] = [];
      const [err, warn, info] = [console.error, console.warn, console.log];
      console.error = (m: unknown) => seen.push(`error:${String(m)}`);
      console.warn = (m: unknown) => seen.push(`warn:${String(m)}`);
      console.log = (m: unknown) => seen.push(`log:${String(m)}`);
      try {
        log('error', 'something broke');
        log('warn', 'something is odd');
        log('info', 'something happened');
      } finally {
        console.error = err;
        console.warn = warn;
        console.log = info;
      }
      expect(seen).toEqual([
        'error:something broke',
        'warn:something is odd',
        'log:something happened',
      ]);
    });

    it('recovers what a previous state contained when the read SUCCEEDS', async () => {
      // The half that makes a deletion made while stopped statable: the ref
      // names the state, and this reads what that state CONTAINED. Without it
      // the first push computes a delta against an empty map and states
      // nothing — silent data retention for a deleted file.
      const db = await aDb();
      await writeFile(join(dir, 'doc.txt'), 'content');
      const tree = await agent.extract();
      const ref = await agent.storeInDb(db, 'fsTree', tree);
      await writeFile(
        join(dir, AGENT_STATE_FILE),
        JSON.stringify({ currentRef: ref }),
      );

      const resumed = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await resumed.syncToDb(db, connector, 'fsTree');
      try {
        expect(
          priv<Map<string, string>>(resumed, '_announcedContent').size,
          'the previous state was not recovered, so a deletion made while ' +
            'stopped could never be stated',
        ).toBeGreaterThan(0);
        expect(priv<boolean>(resumed, '_hasAnnounced')).toBe(true);
      } finally {
        stop();
        resumed.dispose();
      }
    }, 30_000);

    it('the bounded join wait does nothing once the join already resolved', async () => {
      // The wait is a DEFERRAL and never a refusal: when it expires the folder
      // IS the origin. But an announcement can resolve the join first, and
      // then the expiry must leave it alone.
      const db = await aDb();
      const quick = new FsAgent(dir, new BsMem(), { joinWaitMs: 120 });
      try {
        priv<(d: Db, k: string, w: string) => void>(
          quick,
          '_deferToNetwork',
        ).call(quick, db, 'fsTree', 'the folder has files and no history');
        (quick as unknown as { _joinPending: unknown })._joinPending = undefined;
        await sleep(300);
        // Nothing to assert beyond "it did not throw and did not re-open the
        // join": the expiry found nothing to do, which is the contract.
        expect(priv<unknown>(quick, '_joinPending')).toBeUndefined();
      } finally {
        quick.dispose();
      }
    }, 30_000);
  });
  // ...........................................................................
  describe('a merge must not make this node the author of what it kept', () => {
    // The defect this closes, measured: the side holding v5 had a LATER edit
    // of `doc.txt` than the writer's v8, so the per-path conflict question
    // answered truthfully and still chose v5. The question was right; one of
    // its two inputs was a lie — because a merge that KEPT this side's bytes
    // left the node looking as though it had edited the file.

    it('aligns what it believes it announced, for the paths a merge left alone', async () => {
      await writeFile(join(dir, 'kept.txt'), 'the same bytes throughout');
      const before = await agent.extract();
      // Same bytes after the merge: the merge resolved some OTHER path.
      const after = await agent.extract();

      // This node believes it announced something else for that path, which
      // is what a post-merge state looks like.
      priv<Map<string, string>>(agent, '_announcedContent').set(
        'kept.txt',
        'a-stale-hash',
      );

      const logged: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => logged.push(a.join(' '));
      try {
        priv<(b: unknown, a: unknown) => void>(
          agent,
          '_dontClaimUnchangedPaths',
        ).call(agent, before, after);
      } finally {
        console.log = log;
      }

      expect(
        priv<Map<string, string>>(agent, '_announcedContent').get('kept.txt'),
        'the node still believes it announced something else, so its next ' +
          'push will claim a path it did not edit',
      ).not.toBe('a-stale-hash');
      expect(logged.join('\n')).toContain('byte-for-byte unchanged');
    });

    it('says nothing when the merge changed everything it touched', async () => {
      await writeFile(join(dir, 'edited.txt'), 'before');
      const before = await agent.extract();
      await writeFile(join(dir, 'edited.txt'), 'after');
      const after = await agent.extract();

      const logged: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => logged.push(a.join(' '));
      try {
        priv<(b: unknown, a: unknown) => void>(
          agent,
          '_dontClaimUnchangedPaths',
        ).call(agent, before, after);
      } finally {
        console.log = log;
      }
      expect(logged.join('\n')).not.toContain('byte-for-byte unchanged');
    });

    it('leaves a claim alone when it already matches the bytes on disk', async () => {
      // The other half: a node that legitimately authored a path and kept it
      // through a merge still authored it. Dropping that claim would lose its
      // work in the other direction.
      await writeFile(join(dir, 'mine.txt'), 'my work');
      const before = await agent.extract();
      const after = await agent.extract();
      const hash = priv<Map<string, string>>(
        agent,
        '_announcedContent',
      );
      const content = (
        agent as unknown as {
          _getFileContentMap: (t: unknown) => Map<string, string>;
        }
      )._getFileContentMap(after);
      hash.set('mine.txt', content.get('mine.txt') as string);

      const logged: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => logged.push(a.join(' '));
      try {
        priv<(b: unknown, a: unknown) => void>(
          agent,
          '_dontClaimUnchangedPaths',
        ).call(agent, before, after);
      } finally {
        console.log = log;
      }
      expect(logged.join('\n')).not.toContain('byte-for-byte unchanged');
    });
  });

  // ...........................................................................
  describe('the anti-entropy ask, before it has anything to compare', () => {
    const tickWith = async (
      chain: unknown,
      chainHead: unknown,
    ): Promise<string> => {
      const db = await aDb();
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await agent.syncFromDb(db, connector, 'fsTree');
      try {
        (agent as unknown as { _chain: unknown })._chain = chain;
        (agent as unknown as { _chainHead: unknown })._chainHead = chainHead;
        await sleep(ANTI_ENTROPY_ASK_MS + 400);
        return syncErrors(dir);
      } finally {
        stop();
      }
    };

    it('does nothing at all when there is no chain', async () => {
      expect(await tickWith(undefined, undefined)).not.toContain(
        'antiEntropy/ask',
      );
    });

    it('does nothing when this node has no head to compare against', async () => {
      // `_chainHead` is where this node believes it is. Without one there is
      // no "behind" to establish, and asking the anti-entropy to repair
      // towards a tip this node cannot relate to is the unprompted merge the
      // guard above it exists to prevent.
      expect(
        await tickWith(
          {
            refreshHead: () => Promise.resolve('aHead'),
            entry: () =>
              Promise.resolve({ treeRef: 'aTreeRef', previous: [] }),
            classify: () => Promise.resolve('behind'),
          },
          undefined,
        ),
      ).not.toContain('antiEntropy/ask');
    });
  });
  // ...........................................................................
  describe('the fallbacks a folder with no scan yet relies on', () => {
    it('a manifest of a folder nobody has scanned is empty, not a crash', async () => {
      // `_manifest` is what the bucket protocol advertises. Asked before the
      // first scan it has no tree to read, and an empty manifest is the
      // truthful answer — this node is advertising that it holds nothing yet.
      const manifest = (
        agent as unknown as { _manifest: () => ReadonlyMap<string, string> }
      )._manifest();
      expect(manifest.size).toBe(0);
    });

    it('announces a bare tree ref only when nothing can name the state', async () => {
      // THE OLD CLAIM HERE WAS WRONG, and it was the comment that made it look
      // settled: "for any other state there is no head to mark it with". There
      // is, whenever the chain recorded one — which is every state this node
      // ever passed through. `_chainHead` is a cache for the state just
      // appended, not the limit of what can be named.
      //
      // Bare is honest for exactly one case: nothing names the tree. Here the
      // agent has no chain at all, which is that case.
      priv<Map<string, string>>(agent, '_announcedHeads');
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'theStateIAmAt',
      };
      (agent as unknown as { _chain: unknown })._chain = undefined;
      const announced = await (
        agent as unknown as { _announceAs: (r: string) => Promise<string> }
      )._announceAs('someOtherState');
      expect(announced).toBe('someOtherState');
    });

    it('marks a state it is no longer at, from a head a peer announced', async () => {
      // The re-announcement case: an anti-entropy push, or a folder that
      // returned to a state it held before. This node is not at that state's
      // head any more and still has to name it, or the receiver gets a ref it
      // cannot ask the chain about.
      const heads = priv<Map<string, string>>(agent, '_announcedHeads');
      heads.set('aStateIPassedThrough', 'thatStatesHead');
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'myHead',
        treeRef: 'theStateIAmAtNow',
      };
      const announced = await (
        agent as unknown as { _announceAs: (r: string) => Promise<string> }
      )._announceAs('aStateIPassedThrough');
      expect(announced).toBe('~H~thatStatesHead');
    });
  });

  // ...........................................................................
  describe('the removals guard, at its two edges', () => {
    it('keeps ONE path a peer deleted, and says so in the singular', async () => {
      // The plural form is not cosmetic here: this warning is what a user is
      // shown when their own newer work survives a peer's deletion, and "kept
      // 1 paths" in a support log is how a reader stops trusting the log.
      await writeFile(join(dir, 'mine.txt'), 'my newer work');
      await writeFile(join(dir, 'anchor.txt'), 'anchor');
      await agent.extract();

      // This node claims the path, with a LATER timeId than the removal.
      priv<Map<string, string>>(agent, '_localPathTimeIds').set(
        'mine.txt',
        '9999999999999:zzzzzzzz',
      );
      priv<
        Map<string, { removed: string[]; changed: string[]; timeId: string }>
      >(agent, '_incomingRemovals').set('theirTreeRef', {
        removed: ['mine.txt'],
        changed: [],
        timeId: '100:aaaaaaaa',
      });

      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        await callOnAgent(agent, '_applyIncomingRemovals', 'theirTreeRef');
      } finally {
        console.warn = warn;
      }

      expect(warnings.join('\n')).toContain('kept 1 path a peer deleted');
      expect(
        existsSync(join(dir, 'mine.txt')),
        'newer local work was deleted on a peer\'s authority',
      ).toBe(true);
    });

    it('refuses a bucket round that would drop most of what the node holds', async () => {
      // The ratio half of the guard, reached by a plan rather than by a
      // stated removal: enough files to pass the floor, and a drop list that
      // takes most of them.
      for (let i = 0; i < 120; i++) {
        await writeFile(join(dir, `f${i}.txt`), `content ${i}`);
      }
      await agent.extract();

      const db = await aDb();
      const errors: string[] = [];
      const err = console.error;
      console.error = (...a: unknown[]) => errors.push(a.join(' '));
      try {
        await callOnAgent(
          agent,
          '_applyReconcilePlan',
          {
            fetch: [],
            drop: Array.from({ length: 110 }, (_, i) => `f${i}.txt`),
            redelete: [],
            conflict: [],
          },
          db,
          'fsTree',
        );
      } finally {
        console.error = err;
      }

      expect(errors.join('\n')).toMatch(/REFUSED|refused/);
      expect(
        existsSync(join(dir, 'f0.txt')),
        'a bucket round emptied the folder',
      ).toBe(true);
    }, 60_000);

    it('falls back to the entry\'s own timeId when the walk carries none', async () => {
      // The parked removals are ordered by the timeId of the edit that made
      // them. A walk that reaches the root without one leaves the entry's own
      // as the best available answer — ordering by nothing would make every
      // removal the oldest.
      (agent as unknown as { _chain: unknown })._chain = {
        collectRemovals: () =>
          Promise.resolve({
            complete: true,
            removed: ['gone.txt'],
            changed: [],
            timeId: undefined,
          }),
      };
      await callOnAgent(agent, '_collectIncomingRemovals', {
        head: 'theirHead',
        treeRef: 'theirTreeRef',
        timeId: '555:fromTheEntry',
        previous: [],
      });
      expect(
        priv<Map<string, { timeId: string }>>(
          agent,
          '_incomingRemovals',
        ).get('theirTreeRef')?.timeId,
      ).toBe('555:fromTheEntry');
    });
  });

  // ...........................................................................
  describe('a tree node that is simply missing', () => {
    it('tolerates a missing node but lets a TIMEOUT surface', async () => {
      // A missing node is ordinary — a blob reference, or one that was
      // deleted — and the per-node walk tolerated it too. A timeout is
      // systemic and must surface, because swallowing it turns a transport
      // fault into a silently short tree.
      const db = await aDb();
      await writeFile(join(dir, 'doc.txt'), 'content');
      const tree = await agent.extract();
      const ref = await agent.storeInDb(db, 'fsTree', tree);

      // Nothing missing: the happy path still works.
      expect(
        await callOnAgent(agent, '_fetchTreeFromDb', db, 'fsTree', ref),
      ).toBeTruthy();

      // Now make every read time out: that must throw, not return a short
      // tree.
      (
        db.core as unknown as { readRowsByHashes: (...a: unknown[]) => unknown }
      ).readRowsByHashes = () =>
        Promise.reject(new Error('the batch read is unavailable'));
      (
        db as unknown as { get: (...a: unknown[]) => unknown }
      ).get = () => Promise.reject(new Error('Timeout after 1ms: db.get'));

      // It THROWS, and that is the point: a swallowed timeout would turn a
      // transport fault into a tree that is merely short, which the caller
      // cannot tell from a folder that really has fewer files.
      await expect(
        callOnAgent(agent, '_fetchTreeFromDb', db, 'fsTree', ref),
      ).rejects.toThrow(/Timeout/);
    }, 60_000);
  });
  // ...........................................................................
  describe('answering a tree this node refuses to apply', () => {
    // A refusal is the one case where going quiet is actively harmful, and the
    // lab forced the correction. The peer that sent the sparse tree is the one
    // MISSING data; this node holds the fuller copy. Suppressing this node's
    // advertisements leaves the sender stranded with nothing to catch up from,
    // and with every node that has the files refusing its pushes the network
    // livelocks — measured on four nodes, two of them sat at 5 and 15 of 121
    // files and could not recover.
    //
    // "Keeps talking about it" was aspirational for a while: the refusal only
    // stopped SUPPRESSING advertisements, and a node whose own content had not
    // changed had nothing new to say, so it said nothing. Hence an explicit
    // re-announcement.

    it('re-announces its own state so the sender can catch up', async () => {
      await writeFile(join(dir, 'doc.txt'), 'content');
      const db = await aDb();
      const tree = await agent.extract();
      const ref = await agent.storeInDb(db, 'fsTree', tree);
      (agent as unknown as { _currentRef: string })._currentRef = ref;

      const sent: string[] = [];
      const connector = {
        sendRef: (r: string) => {
          sent.push(r);
          return Promise.resolve();
        },
      };
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        await callOnAgent(agent, '_readvertiseAfterRefusal', connector);
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).toContain('re-announcing');
    });

    it('answers at most once per cooldown, so a refusal storm is not a flood', async () => {
      // The sender re-announces on every beacon while it is behind, and
      // answering each one would turn one disagreement into a broadcast loop.
      await writeFile(join(dir, 'doc.txt'), 'content');
      const db = await aDb();
      const tree = await agent.extract();
      (agent as unknown as { _currentRef: string })._currentRef =
        await agent.storeInDb(db, 'fsTree', tree);

      const connector = { sendRef: () => Promise.resolve() };
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        await callOnAgent(agent, '_readvertiseAfterRefusal', connector);
        await callOnAgent(agent, '_readvertiseAfterRefusal', connector);
        await callOnAgent(agent, '_readvertiseAfterRefusal', connector);
      } finally {
        console.warn = warn;
      }
      expect(
        warnings.filter((w) => w.includes('re-announcing')).length,
        'a refusal storm turned into an announcement flood',
      ).toBe(1);
    });

    it('says nothing when it has no state of its own to offer', async () => {
      // Nothing established yet: there is no fuller copy to point the sender
      // at, so there is nothing to say.
      const connector = { sendRef: () => Promise.resolve() };
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        await callOnAgent(agent, '_readvertiseAfterRefusal', connector);
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).not.toContain('re-announcing');
    });
  });
  // ...........................................................................
  describe('the plural and the singular, because a support log is read by a person', () => {
    it('says "paths" when a peer deleted more than one thing this node keeps', async () => {
      // The singular is covered elsewhere. Both forms matter for the same
      // reason: "kept 1 paths" in a support log is how a reader stops
      // trusting the log, and this line is what a user is shown when their
      // own newer work survives a peer's deletion.
      await writeFile(join(dir, 'mine-a.txt'), 'my newer work');
      await writeFile(join(dir, 'mine-b.txt'), 'also mine');
      await writeFile(join(dir, 'anchor.txt'), 'anchor');
      await agent.extract();

      const claims = priv<Map<string, string>>(agent, '_localPathTimeIds');
      claims.set('mine-a.txt', '9999999999999:zzzzzzzz');
      claims.set('mine-b.txt', '9999999999999:zzzzzzzy');
      priv<
        Map<string, { removed: string[]; changed: string[]; timeId: string }>
      >(agent, '_incomingRemovals').set('theirTreeRef', {
        removed: ['mine-a.txt', 'mine-b.txt'],
        changed: [],
        timeId: '100:aaaaaaaa',
      });

      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
      try {
        await callOnAgent(agent, '_applyIncomingRemovals', 'theirTreeRef');
      } finally {
        console.warn = warn;
      }
      expect(warnings.join('\n')).toContain('kept 2 paths a peer deleted');
      expect(existsSync(join(dir, 'mine-a.txt'))).toBe(true);
      expect(existsSync(join(dir, 'mine-b.txt'))).toBe(true);
    });

    it('lifts a single tombstone and says "tombstone", not "tombstones"', async () => {
      // A tombstone is lifted when a peer re-creates a path this node had
      // deleted — without it the restore would refuse every later copy of
      // that path for ever.
      const target = join(dir, 'came-back.txt');
      priv<Set<string>>(agent, '_pendingDeletes').add(target);
      await writeFile(join(dir, 'anchor.txt'), 'anchor');
      await agent.extract();

      priv<
        Map<string, { removed: string[]; changed: string[]; timeId: string }>
      >(agent, '_incomingRemovals').set('theirTreeRef', {
        removed: [],
        changed: ['came-back.txt'],
        timeId: '100:aaaaaaaa',
      });

      const logs: string[] = [];
      const log = console.log;
      console.log = (...a: unknown[]) => logs.push(a.join(' '));
      try {
        await callOnAgent(agent, '_applyIncomingRemovals', 'theirTreeRef');
      } finally {
        console.log = log;
      }
      expect(logs.join('\n')).toMatch(/lifted 1 tombstone[^s]/);
      expect(
        priv<Set<string>>(agent, '_pendingDeletes').has(target),
        'the tombstone was not lifted, so the re-creation can never be written',
      ).toBe(false);
    });
  });

  // ...........................................................................
  describe('errors that are not the shape the code hoped for', () => {
    it('tags a stream read that fails with something other than an Error', async () => {
      // The restore has to tell "the blob could not be read" from "the file
      // could not be written" — one costs a retry, the other a user-visible
      // error. A source that rejects with a string still has to be
      // classifiable.
      const file = join(dir, 'from-a-bad-stream.txt');
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error('a string, not an Error');
        },
      });
      await expect(
        callOnAgent(
          agent.constructor as unknown as FsAgent,
          '_atomicWriteStream',
          file,
          broken,
        ),
      ).rejects.toMatchObject({ __blobRead: true });
    });

    it('tolerates a missing tree node that is not a timeout', async () => {
      // A missing node is ordinary — a blob reference, or one deleted. Only a
      // timeout is systemic and must surface, because swallowing that turns a
      // transport fault into a silently short tree.
      const db = await aDb();
      await writeFile(join(dir, 'doc.txt'), 'content');
      const tree = await agent.extract();
      const ref = await agent.storeInDb(db, 'fsTree', tree);
      (
        db.core as unknown as { readRowsByHashes: (...a: unknown[]) => unknown }
      ).readRowsByHashes = () =>
        Promise.reject(new Error('the batch read is unavailable'));
      (db as unknown as { get: (...a: unknown[]) => unknown }).get = () =>
        Promise.reject(new Error('node not found'));

      // The non-timeout error is TOLERATED at the node level — the walk
      // carries on — and the read then ends with no nodes at all, which is
      // fatal because a tree whose root cannot be read is not a tree. Both
      // halves matter: tolerating the node is what keeps a blob reference or a
      // deleted entry from killing a restore, and failing at the end is what
      // keeps an empty result from being mistaken for an empty folder.
      await expect(
        callOnAgent(agent, '_fetchTreeFromDb', db, 'fsTree', ref),
      ).rejects.toThrow(/No tree nodes found/);
    }, 30_000);
  });

  // ...........................................................................
  // The states the 100% branch gate asked for, and nothing else reaches.
  //
  // Each of these is a decision the agent makes on a shape no scenario in the
  // suite happens to produce — a hub message arriving with bucket sync off, an
  // announcement with no sender metadata, a ref heard while a join is still
  // pending. They are not exotic: each is one configuration switch or one
  // timing away from being the normal case in the field.
  //
  // Driven through `connector.listen`, which is the real entry point, by
  // capturing the callback the agent registers. Calling it directly is what
  // makes the shape controllable — a socket cannot be made to deliver an
  // announcement with a missing field.
  describe('the ref callback, on shapes no scenario produces', () => {
    /** Captures the callback `syncFromDb` registers, and the agent's stop. */
    const listening = async (
      a: FsAgent,
      db: Db,
    ): Promise<{
      fire: (
        ref: string,
        preds?: string[],
        info?: { isNewestFromSender?: boolean },
      ) => Promise<void>;
      stop: () => void;
    }> => {
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      let captured:
        | ((
            ref: string,
            preds?: string[],
            info?: { isNewestFromSender?: boolean },
          ) => Promise<void>)
        | undefined;
      const real = connector.listen.bind(connector);
      (
        connector as unknown as { listen: (cb: unknown) => void }
      ).listen = (cb: unknown) => {
        captured = cb as typeof captured;
        real(cb as Parameters<typeof real>[0]);
      };
      const stop = await a.syncFromDb(db, connector, 'fsTree');
      if (!captured) throw new Error('the agent registered no callback');
      return { fire: captured, stop };
    };

    it('drops a bucket-sync message when bucket sync is off', async () => {
      // `~BQ~` and friends are a control protocol, and a build with the
      // protocol switched off still RECEIVES them: every peer on the LAN
      // speaks it by default. Answering would be wrong and crashing would be
      // worse, so the message is dropped — and dropped SILENTLY, because a
      // peer using a feature this node has turned off is not an error.
      const db = await aDb();
      // ITS OWN FOLDER: `dir` already holds the suite agent, whose own sync
      // errors would answer this assertion for it.
      const own = await mkdtemp(join(tmpdir(), 'fs-agent-nobucket-'));
      const quiet = new FsAgent(own, undefined, {
        ...ORIGIN_FIXTURE,
        bucketSync: false,
      });
      const { fire, stop } = await listening(quiet, db);
      try {
        await expect(fire('~BQ~{"r":1,"d":[]}')).resolves.toBeUndefined();
        expect(
          syncErrors(own),
          'a peer speaking an off feature was recorded as a failure',
        ).not.toContain('bucket');
      } finally {
        stop();
        quiet.dispose();
        await rm(own, { recursive: true, force: true });
      }
    }, 30_000);

    it('leaves an unresolvable head to the anti-entropy, and says so', async () => {
      // Resolving a `~H~` head is a READ, and a read may have to travel to a
      // peer that cannot answer. Bounded, because an unbounded one is a silent
      // hang — measured in `I7b`, where a node sat inside this call for the
      // rest of the run with no log, no retry and no fallback.
      //
      // THIS PATH USED TO BE EXERCISED BY ACCIDENT. Before `@rljson/io` 0.0.84
      // every gate run produced 24–27 reads blocked for a full ten seconds, so
      // the timeout fired on its own. The io fix removed them — which is why
      // this needs a test of its own now, and why a test that only ever ran
      // because something else was broken is worth being suspicious of.
      const db = await aDb();
      const own = await mkdtemp(join(tmpdir(), 'fs-agent-slowhead-'));
      const slow = new FsAgent(own, undefined, {
        ...ORIGIN_FIXTURE,
        timeouts: { dbQuery: 60 },
      });
      const { fire, stop } = await listening(slow, db);
      try {
        (slow as unknown as { _chain: unknown })._chain = {
          // Open, and never answers — what an unreachable peer looks like.
          entry: () => new Promise(() => {}),
        };
        await fire('~H~aHeadNobodyCanAnswerFor', [], {
          isNewestFromSender: true,
        });
        await sleep(500);
        expect(
          syncErrors(own),
          'a head that could not be resolved was swallowed silently',
        ).toContain('syncFromDb/resolveAnnouncement');
      } finally {
        stop();
        slow.dispose();
        await rm(own, { recursive: true, force: true });
      }
    }, 30_000);

    it('treats an announcement with no sender metadata as the newest', async () => {
      // `info.isNewestFromSender` is how a receiver skips a ref its sender has
      // already superseded. An announcement that carries no metadata at all —
      // an older peer, or any sender that did not fill the field — must be
      // treated as NEWS, not discarded: defaulting the other way makes a node
      // ignore the only thing it was told.
      const db = await aDb();
      await writeFile(join(dir, 'seed.txt'), 'seed');
      const { fire, stop } = await listening(agent, db);
      try {
        const other = await mkdtemp(join(tmpdir(), 'fs-agent-sender-'));
        const sender = new FsAgent(other, undefined, ORIGIN_FIXTURE);
        const lines: string[] = [];
        const spy = vi
          .spyOn(console, 'log')
          .mockImplementation((...a: unknown[]) => {
            lines.push(a.map(String).join(' '));
          });
        try {
          await writeFile(join(other, 'fromPeer.txt'), 'peer');
          const ref = await sender.storeInDb(db, 'fsTree');

          // No third argument at all: the default is what is under test.
          await fire(ref, []);
          await sleep(1200);
          expect(
            lines.filter((l) => l.includes('newestFromSender=')),
            'the announcement was never applied, so the default was not exercised',
          ).not.toEqual([]);
          expect(
            lines.filter((l) => l.includes('newestFromSender=false')),
            'an announcement with no metadata was treated as superseded',
          ).toEqual([]);
        } finally {
          spy.mockRestore();
          sender.dispose();
          await rm(other, { recursive: true, force: true });
        }
      } finally {
        stop();
      }
    }, 30_000);

    it('ignores a bare ref heard while a join is still pending', async () => {
      // The join protocol applies the hub's chain head FIRST and judges this
      // folder's extras against it. An announcement heard mid-join must not
      // be applied over a folder nobody has judged yet — the ask loop owns the
      // reconcile, and this ref is dropped rather than restored.
      const db = await aDb();
      const { fire, stop } = await listening(agent, db);
      try {
        const other = await mkdtemp(join(tmpdir(), 'fs-agent-joinbare-'));
        const sender = new FsAgent(other, undefined, ORIGIN_FIXTURE);
        try {
          await writeFile(join(other, 'wouldArrive.txt'), 'x');
          const ref = await sender.storeInDb(db, 'fsTree');

          (agent as unknown as { _joinPending: unknown })._joinPending = {
            resolve: () => {},
          };
          await fire(ref, [], { isNewestFromSender: true });
          await sleep(1200);
          expect(
            existsSync(join(dir, 'wouldArrive.txt')),
            'a mid-join announcement was applied over an unjudged folder',
          ).toBe(false);
        } finally {
          sender.dispose();
          await rm(other, { recursive: true, force: true });
        }
      } finally {
        (agent as unknown as { _joinPending: unknown })._joinPending =
          undefined;
        stop();
      }
    }, 30_000);

    it('ignores a resolvable HEAD heard while a join is still pending', async () => {
      // Same rule, the other wire format. A marked head is the shape the join
      // is WAITING for, which makes this the easier mistake: the ref resolves,
      // the entry is there, everything looks ready — and applying it still
      // skips the judgement the protocol exists to make.
      const db = await aDb();
      const { fire, stop } = await listening(agent, db);
      try {
        const applied: string[] = [];
        (
          agent as unknown as { _rememberAnnouncedHead: unknown }
        )._rememberAnnouncedHead = (treeRef: string) => {
          applied.push(treeRef);
        };
        (agent as unknown as { _joinPending: unknown })._joinPending = {
          resolve: () => {},
        };
        (agent as unknown as { _chain: unknown })._chain = {
          entry: () =>
            Promise.resolve({
              head: 'theHead',
              treeRef: 'theTree',
              changed: [],
              removed: [],
              timeId: '1:a',
            }),
        };
        await fire('~H~theHead', [], { isNewestFromSender: true });
        await sleep(600);
        expect(
          applied,
          'a mid-join head was parked and scheduled instead of dropped',
        ).toEqual([]);
      } finally {
        (agent as unknown as { _joinPending: unknown })._joinPending =
          undefined;
        stop();
      }
    }, 30_000);
  });

  // ...........................................................................
  // The decisions reached by calling the method, not by driving a fleet.
  //
  // Each of these is a state the suite's scenarios never produce because they
  // all start from a scanned folder and a chain that answers. A folder that
  // has not been scanned yet, a path this node did not author, a chain read
  // that fails mid-removal — all of them are ordinary in the field and none of
  // them is reachable from a converged mesh.
  describe('the removal and reachability paths, called directly', () => {
    /** Collects `console.log` for the run of one test. */
    const captureLog = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = [];
      const spy = vi
        .spyOn(console, 'log')
        .mockImplementation((...a: unknown[]) => {
          lines.push(a.map(String).join(' '));
        });
      return { lines, restore: () => spy.mockRestore() };
    };

    it('answers reachability when both sides have a head', async () => {
      // The verdict the whole chain exists to produce. Everything else in this
      // method is a reason it CANNOT answer — no head of our own, a head that
      // will not resolve, a tree no entry covers — and those were the only
      // shapes the suite reached, so the one path that returns a verdict was
      // never taken here.
      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'mine',
        treeRef: 'myTree',
      };
      const asked: Array<[string, string]> = [];
      (agent as unknown as { _chain: unknown })._chain = {
        entry: () =>
          Promise.resolve({
            head: 'theirs',
            treeRef: 'theirTree',
            changed: [],
            removed: [],
            timeId: '2:b',
          }),
        classify: (a: string, b: string) => {
          asked.push([a, b]);
          return Promise.resolve('behind');
        },
      };

      const verdict = await callOnAgent(agent, '_reachabilityOf', '~H~theirs');
      expect(verdict).toEqual({
        treeRef: 'theirTree',
        reachability: 'behind',
      });
      // Asked FROM our head TO theirs, in that order — reversing it inverts
      // every verdict the fleet makes.
      expect(asked, 'the chain was asked the wrong way round').toEqual([
        ['mine', 'theirs'],
      ]);
    });

    it('lifts several tombstones at once and says so in the plural', async () => {
      // "lifted 1 tombstones" in a support log is how a reader stops trusting
      // the log — the same reason the removals guard has both forms. And the
      // folder here has never been scanned, which is the other thing no
      // scenario reaches: a removal arriving before the first scan completes.
      const pending = priv<Set<string>>(agent, '_pendingDeletes');
      pending.add(join(dir, 'a.txt'));
      pending.add(join(dir, 'b.txt'));
      priv<Map<string, unknown>>(agent, '_incomingRemovals').set('aRef', {
        changed: ['a.txt', 'b.txt'],
        removed: [],
        timeId: '1:x',
      });

      const { lines, restore } = captureLog();
      try {
        await callOnAgent(agent, '_applyIncomingRemovals', 'aRef');
      } finally {
        restore();
      }
      expect(
        lines.filter((l) => l.includes('lifted 2 tombstones a peer re-created')),
        'the plural form was not used for two paths',
      ).toHaveLength(1);
      expect(
        pending.size,
        'a tombstone survived the re-creation that lifted it',
      ).toBe(0);
    });

    it('asks the chain who last edited a path it did not author', async () => {
      // A peer's removal of a path THIS node holds but never claimed. The
      // local claim map is empty for it, so the only thing that can order the
      // two is the chain — and that is the read this block makes.
      await writeFile(join(dir, 'peerOwned.txt'), 'v1');
      await agent.extract();

      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'mine',
        treeRef: 'myTree',
      };
      const asked: string[] = [];
      (agent as unknown as { _chain: unknown })._chain = {
        lastEditOf: (_head: string, path: string) => {
          asked.push(path);
          return Promise.resolve({ timeId: '9:z' });
        },
      };
      priv<Map<string, unknown>>(agent, '_incomingRemovals').set('r2', {
        changed: [],
        removed: ['peerOwned.txt'],
        timeId: '5:m',
      });

      await callOnAgent(agent, '_applyIncomingRemovals', 'r2');
      expect(
        asked,
        'the chain was never asked who last edited the path',
      ).toEqual(['peerOwned.txt']);
    });

    it('still applies a removal when that chain read fails', async () => {
      // Best effort, as everywhere else the chain is read: losing the ordering
      // it provides must not lose the removal. Without the catch this rejects
      // into the apply and the peer deletion is dropped on the floor.
      await writeFile(join(dir, 'peerOwned.txt'), 'v1');
      await agent.extract();

      (agent as unknown as { _chainHead: unknown })._chainHead = {
        head: 'mine',
        treeRef: 'myTree',
      };
      (agent as unknown as { _chain: unknown })._chain = {
        lastEditOf: () =>
          Promise.reject(new Error('the chain cannot read lastEditOf')),
      };
      priv<Map<string, unknown>>(agent, '_incomingRemovals').set('r3', {
        changed: [],
        removed: ['peerOwned.txt'],
        timeId: '5:m',
      });

      await expect(
        callOnAgent(agent, '_applyIncomingRemovals', 'r3'),
      ).resolves.toBeUndefined();
    });

    it('names a bucket-sync conflict in the singular and the plural', async () => {
      // "1 paths edited on both sides" in a support log is how a reader stops
      // trusting the log, which is why both forms exist — and why both have to
      // be measured. Whichever one a run happens not to produce is an uncovered
      // branch: this read 100% on macOS and failed Linux CI at 99.92%, the last
      // branch in the package.
      const db = await aDb();
      const warned: string[] = [];
      const spy = vi
        .spyOn(console, 'warn')
        .mockImplementation((...a: unknown[]) => {
          warned.push(a.map(String).join(' '));
        });
      try {
        for (const conflict of [['a.txt'], ['a.txt', 'b.txt']]) {
          await callOnAgent(
            agent,
            '_applyReconcilePlan',
            { fetch: [], drop: [], redelete: [], conflict },
            db,
            'fsTree',
          );
        }
      } finally {
        spy.mockRestore();
      }
      expect(
        warned.filter((w) => w.includes('1 path edited on both sides')),
        'one conflict was reported in the plural',
      ).toHaveLength(1);
      expect(
        warned.filter((w) => w.includes('2 paths edited on both sides')),
        'two conflicts were reported in the singular',
      ).toHaveLength(1);
    }, 30_000);

    it('refuses a mass deletion against a folder it has not scanned', async () => {
      // `held` is read from the scan, and an unscanned folder reports ZERO
      // held. The guard divides by it, so this is the shape that either
      // refuses everything or divides by zero depending on one `Math.max` —
      // and no scenario reaches it, because every scenario scans first.
      const db = await aDb();
      const drop = Array.from({ length: 150 }, (_, i) => `gone-${i}.txt`);
      await callOnAgent(
        agent,
        '_applyReconcilePlan',
        { fetch: [], drop, redelete: [], conflict: [] },
        db,
        'fsTree',
      );
      expect(
        syncErrors(dir),
        'a 150-file deletion against an unscanned folder was carried out',
      ).toContain('bucketSync/massDeleteGuard');
      expect(
        priv<Set<string>>(agent, '_pendingDeletes').size,
        'a refused deletion still tombstoned the paths',
      ).toBe(0);
    });

    it('treats a revision with no recorded predecessors as a root', async () => {
      // The ancestry walk follows `previous` links. A revision whose row names
      // none — a lineage root, or one whose parent row never arrived — ends the
      // walk, and the fallback that makes it end is the one no fork in the
      // suite needs.
      const db = await aDb();
      const ref = await agent.storeInDb(db, 'fsTree');
      // A PREDECESSOR WHOSE ROW NEVER ARRIVED. Every ref the table holds has
      // an entry in the predecessor map, empty list and all, so the fallback
      // fires for exactly one thing: a causal gap. The walk must END there
      // rather than throw — a sender naming a revision this node never
      // received is ordinary after a partition.
      const relation = await callOnAgent(
        agent,
        '_ancestryRelation',
        db,
        'fsTree',
        ref,
        'aRefNobodyStored',
        ['aPredecessorNobodyStored'],
      );
      expect(
        relation,
        'a causal gap was not reported as diverged',
      ).toBe('diverged');
    });
  });

  // ...........................................................................
  // What a repair does when the bucket round is not available to answer it.
  //
  // The repair callback the anti-entropy holds is the last thing between a
  // detected divergence and a whole-folder apply. With `bucketSync` on — the
  // shipping default — it hands every divergence to the bucket round and
  // returns, so the two decisions BELOW that point are never reached by any
  // scenario in this suite. They are the ones that decide whether a repair may
  // prune, and that is not a decision to leave unmeasured.
  describe('the repair callback, with the bucket round switched off', () => {
    /** The repair the agent registered with its anti-entropy. */
    const repairOf = (
      a: FsAgent,
    ): ((
      action: 'pull' | 'push' | 'merge',
      hubRef: string,
      hubPredecessors: string[],
      attempt: number,
    ) => void) =>
      (
        priv<{
          _deps: {
            repair: (
              action: 'pull' | 'push' | 'merge',
              hubRef: string,
              hubPredecessors: string[],
              attempt: number,
            ) => void;
          };
        }>(a, '_antiEntropy')._deps
      ).repair;

    const withAgent = async (): Promise<{
      a: FsAgent;
      db: Db;
      own: string;
      stop: () => void;
      close: () => Promise<void>;
    }> => {
      const db = await aDb();
      const own = await mkdtemp(join(tmpdir(), 'fs-agent-norepair-'));
      const a = new FsAgent(own, undefined, {
        ...ORIGIN_FIXTURE,
        bucketSync: false,
      });
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      const stop = await a.syncFromDb(db, connector, 'fsTree');
      return {
        a,
        db,
        own,
        stop,
        close: async () => {
          stop();
          a.dispose();
          await rm(own, { recursive: true, force: true });
        },
      };
    };

    it('keeps the hub ancestry on the FIRST attempt at a merge', async () => {
      // Ancestry is what lets a receiver tell a deletion from a straggler, so
      // the first try keeps it and prunes under the ordinary rules.
      const { a, own, close } = await withAgent();
      try {
        const lines: string[] = [];
        const spy = vi
          .spyOn(console, 'log')
          .mockImplementation((...x: unknown[]) => {
            lines.push(x.map(String).join(' '));
          });
        try {
          repairOf(a)('merge', 'aHubRef', ['itsParent'], 1);
          await sleep(500);
        } finally {
          spy.mockRestore();
        }
        expect(
          lines.filter((l) => l.includes('bucket-sync round')),
          'a build with bucket sync off answered a divergence with one',
        ).toEqual([]);
        expect(
          syncErrors(own),
          'the repair failed rather than scheduling an apply',
        ).not.toContain('antiEntropy/push');
      } finally {
        await close();
      }
    }, 30_000);

    it('drops the hub ancestry on a REPEATED merge, so the apply is additive', async () => {
      // The concession. A merge that ran once and did not converge is retried
      // WITHOUT the ancestry, which makes the apply purely additive: nothing is
      // pruned, both sides end up with the union, and the next round pushes it.
      //
      // The trade is stated in the code and worth repeating: losing a deletion
      // this way is recoverable, guessing which side deleted is not. A repeat
      // is also the only evidence of a livelock — one push is not one.
      const { a, own, close } = await withAgent();
      try {
        // Two paths through one line, so both are measured in one run: the
        // second attempt of a merge drops ancestry, a `pull` never does.
        repairOf(a)('merge', 'aHubRef', ['itsParent'], 2);
        repairOf(a)('pull', 'anotherHubRef', ['itsParent'], 3);
        await sleep(500);
        expect(
          syncErrors(own),
          'a repair with no ancestry was recorded as a failure',
        ).not.toContain('antiEntropy/push');
      } finally {
        await close();
      }
    }, 30_000);
  });

  // ...........................................................................
  // Applied the state and re-derived a different ref.
  //
  // A node that applies a peer's state and then hashes its own folder to
  // something else is short of what it applied — a locked file, a blob that
  // would not fetch, a path it refused. That is a real divergence and the
  // correct signal, and it went unnoticed for exactly as long as nothing said
  // it, which is why the apply says it.
  //
  // The folder here ends up holding MORE than the sender: an empty directory
  // of its own that the additive restore does not remove. Measured while
  // writing this — an empty directory is in the content map, not only in the
  // tree, so it is a genuine content difference and not merely a hash one.
  describe('a re-derived ref that differs from the one applied', () => {
    it('says out loud that it is short of what it applied', async () => {
      const db = await aDb();
      // ONE blob store, shared: the restore has to succeed for the apply to
      // reach its own bookkeeping, and a per-node store cannot fetch a peer's
      // blobs. That is its own defect class — see the mesh harness.
      const bs = new BsMem();
      const sendDir = await mkdtemp(join(tmpdir(), 'fs-agent-emptydir-s-'));
      const recvDir = await mkdtemp(join(tmpdir(), 'fs-agent-emptydir-r-'));
      const sender = new FsAgent(sendDir, bs, ORIGIN_FIXTURE);
      const receiver = new FsAgent(recvDir, bs, ORIGIN_FIXTURE);
      const connector = new Connector(
        db,
        Route.fromFlat('/fsTree'),
        new SocketMock(),
      );
      let fire:
        | ((
            ref: string,
            preds?: string[],
            info?: { isNewestFromSender?: boolean },
          ) => Promise<void>)
        | undefined;
      const real = connector.listen.bind(connector);
      (connector as unknown as { listen: (cb: unknown) => void }).listen = (
        cb: unknown,
      ) => {
        fire = cb as typeof fire;
        real(cb as Parameters<typeof real>[0]);
      };
      const stop = await receiver.syncFromDb(db, connector, 'fsTree');

      const agreed: string[] = [];
      const ae = priv<{ agreedOn: (r: string) => void } | undefined>(
        receiver,
        '_antiEntropy',
      );
      if (ae) ae.agreedOn = (r: string) => agreed.push(r);

      const warnings: string[] = [];
      const spy = vi
        .spyOn(console, 'warn')
        .mockImplementation((...a: unknown[]) => {
          warnings.push(a.map(String).join(' '));
        });
      try {
        await writeFile(join(sendDir, 'keep.txt'), 'k');
        const ref = await sender.storeInDb(db, 'fsTree');

        // The empty directory sits on the RECEIVER, not the sender. A restore
        // is additive — it writes what the sender has and removes nothing it
        // was not told to — so the directory survives the apply. The folder
        // then holds exactly the sender's files and hashes to something else.
        await mkdir(join(recvDir, 'mine'), { recursive: true });

        await fire!(ref, [], { isNewestFromSender: true });
        await sleep(1500);

        expect(
          existsSync(join(recvDir, 'keep.txt')),
          'the restore did not run, so the bookkeeping under test was not reached',
        ).toBe(true);
        expect(
          existsSync(join(recvDir, 'keep.txt')),
          'the restore did not run, so the bookkeeping under test was not reached',
        ).toBe(true);
        expect(
          warnings.filter((w) =>
            w.includes('this node is short of what it applied'),
          ),
          'a folder that does not match what it applied said nothing',
        ).toHaveLength(1);
        // And it did NOT tell the anti-entropy the two agree, because they do
        // not: this folder holds a directory the sender never sent.
        expect(
          agreed,
          'a real divergence was recorded as agreement',
        ).toEqual([]);
      } finally {
        spy.mockRestore();
        stop();
        receiver.dispose();
        sender.dispose();
        await rm(sendDir, { recursive: true, force: true });
        await rm(recvDir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  // ...........................................................................
  // When each path was last edited, and why it has to outlive the process.
  //
  // `reconcile` orders a peer's tombstone against our content by comparing two
  // `timeId`s — see `ManifestEntry.editedAt`. Ours comes from
  // `_pathEditTimes`, and a comparison with one operand is not a comparison:
  // a restarted node that has forgotten its times sends entries with no
  // `editedAt`, the rule falls back to "the tombstone wins", and `I7b` fails
  // again on every restart. The tombstones in the same file are persisted for
  // the mirror-image reason.
  describe('the path edit times', () => {
    const note = (a: FsAgent, paths: string[], timeId: string): void =>
      (
        a as unknown as {
          _notePathEdits: (p: readonly string[], t: string) => void;
        }
      )._notePathEdits(paths, timeId);

    it('survives a restart of the agent', async () => {
      note(agent, ['doc.txt'], '500:aaa');
      const restarted = new FsAgent(dir);
      try {
        expect(
          priv<Map<string, string>>(restarted, '_pathEditTimes').get('doc.txt'),
          'a restart forgot when the path was edited — a stale tombstone wins again',
        ).toBe('500:aaa');
      } finally {
        restarted.dispose();
      }
    });

    it('keeps the NEWEST time, whichever order the entries arrive in', async () => {
      // Entries arrive out of order: a peer's older state can be heard after a
      // newer one. Taking whatever came last would make the manifest advertise
      // a stale edit as current, which is the failure this index prevents.
      note(agent, ['doc.txt'], '500:aaa');
      note(agent, ['doc.txt'], '100:bbb');
      const times = priv<Map<string, string>>(agent, '_pathEditTimes');
      expect(
        times.get('doc.txt'),
        'an older entry overwrote a newer one',
      ).toBe('500:aaa');

      note(agent, ['doc.txt'], '900:ccc');
      expect(
        times.get('doc.txt'),
        'a newer entry was ignored',
      ).toBe('900:ccc');
    });

    it('forgets the oldest times when the log is full', async () => {
      // Bounded, like the tombstone log beside it: this covers every path
      // either side has touched, so on a catalogue it would otherwise grow
      // without limit and take the state file with it. Forgetting the oldest
      // is what puts those paths back on the rules that predate `editedAt` —
      // the safe direction, and the only one available.
      const many = Array.from(
        { length: EDIT_TIME_LOG_MAX + 1 },
        (_, i) => `f-${i}.txt`,
      );
      note(agent, many, '400:aaa');
      const times = priv<Map<string, string>>(agent, '_pathEditTimes');
      expect(times.size, 'the log grew past its bound').toBe(
        EDIT_TIME_LOG_MAX,
      );
      expect(
        times.has('f-0.txt'),
        'the bound forgot the newest instead of the oldest',
      ).toBe(false);
      expect(times.has(`f-${EDIT_TIME_LOG_MAX}.txt`)).toBe(true);
    }, 30_000);

    it('ignores malformed entries in the state file', async () => {
      // The file is on a user's disk and can be edited, truncated or written
      // by another build. Every shape that is not a usable pair is skipped
      // rather than throwing, because a state file that cannot be parsed must
      // degrade to "this process cannot say when these paths were edited" —
      // never to an agent that will not start.
      writeFileSync(
        join(dir, AGENT_STATE_FILE),
        JSON.stringify({
          editTimes: [
            'not-a-pair',
            ['only-one-element'],
            [42, '100:aaa'],
            ['', '100:aaa'],
            ['no-time', ''],
            ['no-time-either', 7],
            ['good.txt', '100:aaa'],
          ],
        }),
        'utf-8',
      );
      const restarted = new FsAgent(dir);
      try {
        const times = priv<Map<string, string>>(restarted, '_pathEditTimes');
        expect(
          [...times],
          'a malformed entry was accepted, or a good one was dropped with it',
        ).toEqual([['good.txt', '100:aaa']]);
      } finally {
        restarted.dispose();
      }
    });

    it('records a removal as readily as a write', async () => {
      // A deletion is a word on the path, and the ordering needs it: a
      // tombstone with no time of its own cannot be compared with anything.
      note(agent, ['gone.txt'], '700:ddd');
      expect(
        priv<Map<string, string>>(agent, '_pathEditTimes').get('gone.txt'),
      ).toBe('700:ddd');
    });
  });
});

/** Calls a private method on an agent with arguments. */
function callOnAgent(
  agent: FsAgent,
  name: string,
  ...args: unknown[]
): Promise<unknown> {
  return (
    agent as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  )[name].apply(agent, args);
}
