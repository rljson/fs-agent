// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_STATE_FILE,
  FsAgent,
  TOMBSTONE_LOG_MAX,
} from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

// .............................................................................
// The tombstone log: what this node deleted, remembered past the push.
//
// `_pendingDeletes` has always existed and has always been consumed in
// `_restoreTree` as "never re-create a file deleted here and not yet
// announced". Its lifetime was ONE announcement — `_rememberAnnounced` cleared
// it — and that is one push too early. "Once peers have been told, a file's
// absence is theirs to know about" is true only of a peer that HEARD. A
// partitioned node's deletion reached nobody; on rejoin the fleet's tree still
// contains the file, the apply puts it back on the node that deleted it, and
// the local scan then finds it present so the deletion is never announced at
// all. Measured as `test/mesh/fs-mesh.spec.ts` T4.
//
// **This is half a fix and must not ship alone.** Measured across four runs of
// T4: it stops a node resurrecting its own deletion, and it does NOT make the
// deletion reach every peer — one of three was left holding the file and never
// converged. Making the delete WIN on a peer that never heard it is the other
// half, and it needs the edit chain (`src/fs-edit-chain.ts`) to carry it.
// .............................................................................
describe('FsAgent — the tombstone log', () => {
  // A FOLDER PER TEST, not one shared between them.
  //
  // With a shared folder, `afterEach`'s `rm -rf` runs while the previous
  // test's watcher is still live: the agent sees a deletion for every file it
  // held, tombstones them all, and writes that log into the folder the next
  // test has just recreated. Every later test then reads the one before it.
  //
  // It is a teardown artifact rather than a defect — production does not
  // delete the folder it is syncing — but it is a fair warning about a real
  // hazard: deleting a large folder produces one tombstone per file, and
  // nothing here bounds that yet. See the mass-delete note at the end.
  let dir = '';
  let nth = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let stops: Array<() => void> = [];
  let agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-tombstone-log-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
    stops = [];
    agents = [];
  });

  afterEach(async () => {
    for (const stop of stops) stop();
    for (const agent of agents) agent.scanner.stopWatch();
    vi.restoreAllMocks();
    // Let the watcher's last events drain before the folder goes, so a
    // teardown cannot be mistaken for a deletion worth remembering.
    await sleep(50);
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const makeDb = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    return db;
  };

  /** A started agent over `dir`, syncing to `db`. */
  const start = async (db: Db): Promise<FsAgent> => {
    const agent = new FsAgent(dir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 20 },
    });
    agents.push(agent);
    const connector = new Connector(
      db,
      Route.fromFlat('/fsTree'),
      new SocketMock(),
    );
    stops.push(await agent.syncToDb(db, connector, 'fsTree'));
    return agent;
  };

  /** What `.fsagent-state.json` currently records. */
  const state = (): { currentRef?: string; tombstones?: string[] } => {
    const file = join(dir, AGENT_STATE_FILE);
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf-8'));
  };

  // ...........................................................................
  it('records a local deletion, and keeps it past the announcement', async () => {
    const db = await makeDb();
    await writeFile(join(dir, 'doomed.txt'), 'doomed');
    await writeFile(join(dir, 'keeper.txt'), 'keeper');
    await start(db);
    await sleep(300);

    await unlink(join(dir, 'doomed.txt'));
    await sleep(500);

    // Past the push that announced the deletion — which is exactly where the
    // old code forgot it.
    expect(state().tombstones).toEqual(['doomed.txt']);
    expect(state().currentRef).toBeTruthy();
  }, 30_000);

  // ...........................................................................
  it('keeps the ref when a deletion is recorded, and the other way round', async () => {
    // One file holds both, and each is written on its own trigger — a deletion
    // the moment the watcher reports it, a ref when the folder settles. A
    // write of either that blanked the other would trade one defect for
    // another.
    const db = await makeDb();
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'b.txt'), 'b');
    await start(db);
    await sleep(300);
    const before = state().currentRef;
    expect(before).toBeTruthy();

    await unlink(join(dir, 'a.txt'));
    await sleep(500);

    expect(state().tombstones).toEqual(['a.txt']);
    // The ref moved (the folder changed) but was never blanked.
    expect(state().currentRef).toBeTruthy();
  }, 30_000);

  // ...........................................................................
  it('loads what a previous run deleted', async () => {
    const db = await makeDb();
    await writeFile(join(dir, 'gone.txt'), 'gone');
    await start(db);
    await sleep(300);
    await unlink(join(dir, 'gone.txt'));
    await sleep(500);
    expect(state().tombstones).toEqual(['gone.txt']);

    // A brand-new agent over the same folder: the restart. A process that came
    // back having forgotten its deletions is how the first peer that never
    // heard about one undoes it.
    const restarted = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(restarted);
    expect(restarted['_pendingDeletes'].has(join(dir, 'gone.txt'))).toBe(true);
  }, 30_000);

  // ...........................................................................
  it('forgets a path the user creates again', async () => {
    // Otherwise a path deleted once could never be written again on this node:
    // the guard in `_restoreTree` would refuse every later copy of it, for
    // good.
    const db = await makeDb();
    await writeFile(join(dir, 'again.txt'), 'first');
    await start(db);
    await sleep(300);

    await unlink(join(dir, 'again.txt'));
    await sleep(500);
    expect(state().tombstones).toEqual(['again.txt']);

    await writeFile(join(dir, 'again.txt'), 'second');
    await sleep(500);
    expect(state().tombstones).toEqual([]);
  }, 30_000);

  // ...........................................................................
  it('records a deletion inside a subfolder by its relative path', async () => {
    // Stored relative and `/`-separated, so a log written on Windows is
    // readable on a Mac — the folder moves between machines, and so does this.
    const db = await makeDb();
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'deep.txt'), 'deep');
    await writeFile(join(dir, 'keep.txt'), 'keep');
    await start(db);
    await sleep(300);

    await unlink(join(dir, 'nested', 'deep.txt'));
    await sleep(500);

    expect(state().tombstones).toEqual(['nested/deep.txt']);

    const restarted = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(restarted);
    expect(
      restarted['_pendingDeletes'].has(join(dir, 'nested', 'deep.txt')),
    ).toBe(true);
  }, 30_000);

  // ...........................................................................
  // Every unusable shape answers the same way: nothing is tombstoned. A log is
  // a guard, never a dependency — an agent that refused to start because it
  // could not read one would be worse than one that guards nothing.
  for (const [label, contents] of [
    ['unparseable', 'not json at all'],
    ['valid JSON but not an object', 'null'],
    ['an object without the field', '{"currentRef":"abc"}'],
    ['a field of the wrong type', '{"tombstones":"nope"}'],
    ['entries of the wrong type', '{"tombstones":[42,null]}'],
    ['an empty entry', '{"tombstones":[""]}'],
  ] as const) {
    it(`treats ${label} as "nothing tombstoned"`, async () => {
      await writeFile(join(dir, AGENT_STATE_FILE), contents);
      const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
      agents.push(agent);
      expect(agent['_pendingDeletes'].size).toBe(0);
    });
  }

  // ...........................................................................
  it('degrades quietly when the log cannot be written', async () => {
    // A directory where the state file belongs: an unwritable path, which is
    // what a permissions problem or a stray folder looks like from here. The
    // guard is then lost across a restart — but the sync keeps running, which
    // is the right trade. An agent that refused to start because it could not
    // write a guard would be worse than one that guards nothing.
    const db = await makeDb();
    await mkdir(join(dir, AGENT_STATE_FILE), { recursive: true });
    await writeFile(join(dir, 'x.txt'), 'x');
    await writeFile(join(dir, 'y.txt'), 'y');
    const agent = await start(db);
    await sleep(300);

    await unlink(join(dir, 'x.txt'));
    await sleep(500);

    // Still running, still tracking in memory.
    expect(agent['_pendingDeletes'].has(join(dir, 'x.txt'))).toBe(true);
  }, 30_000);

  // ...........................................................................
  describe('the log is bounded', () => {
    it('evicts the oldest deletions past the cap, loudly', async () => {
      // The log is the one structure in this agent that grows without bound,
      // and it is rewritten SYNCHRONOUSLY on every deletion — so the cost of
      // deleting the next file grows with every file already deleted.
      //
      // Evicting a tombstone can RESURRECT a file, which is the whole point of
      // keeping it, so the eviction is oldest-first and it says so. A sighting
      // in the field means the log needs a real garbage-collection rule — one
      // that knows when every peer has seen a deletion — not a bigger number.
      const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
      agents.push(agent);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log = agent['_pendingDeletes'] as Set<string>;
      for (let i = 0; i < TOMBSTONE_LOG_MAX + 3; i++) {
        log.add(join(dir, `f${i}.txt`));
      }
      agent['_persistTombstones']();

      expect(log.size).toBe(TOMBSTONE_LOG_MAX);
      // Oldest gone, newest kept.
      expect(log.has(join(dir, 'f0.txt'))).toBe(false);
      expect(log.has(join(dir, 'f2.txt'))).toBe(false);
      expect(
        log.has(join(dir, `f${TOMBSTONE_LOG_MAX + 2}.txt`)),
      ).toBe(true);
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes('tombstone log full'),
        ),
      ).toBe(true);
    }, 30_000);

    it('caps a log it reads back, not only one it writes', async () => {
      // A file written by a build without the cap, or with a larger one, must
      // not reintroduce a size this process has decided not to carry — and the
      // NEWEST entries are the ones worth keeping.
      const tombstones = Array.from(
        { length: TOMBSTONE_LOG_MAX + 5 },
        (_, i) => `f${i}.txt`,
      );
      await writeFile(
        join(dir, AGENT_STATE_FILE),
        JSON.stringify({ currentRef: 'abc', tombstones }),
      );

      const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
      agents.push(agent);
      const log = agent['_pendingDeletes'] as Set<string>;

      expect(log.size).toBe(TOMBSTONE_LOG_MAX);
      expect(log.has(join(dir, 'f0.txt'))).toBe(false);
      expect(
        log.has(join(dir, `f${TOMBSTONE_LOG_MAX + 4}.txt`)),
      ).toBe(true);
    }, 30_000);
  });
});
