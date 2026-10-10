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

import { } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync, readFileSync, } from 'fs';
import { link, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, } from 'vitest';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reaches a private member, as the tombstone-log tests do. */
const priv = <T>(agent: FsAgent, name: string): T =>
  (agent as unknown as Record<string, T>)[name];

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
  // suite happens to produce — an announcement with no sender metadata, a ref heard while a join is still
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
