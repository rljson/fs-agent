// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// LEVEL 2 — the model must be able to EXPRESS it (§7.4).
//
// These do not fail because a rule is wrong. They fail because there is
// nothing to call. That makes them the cheapest tests in the plan and the
// clearest definition of "the chain and the tombstones are done" — and, after
// T4 turned out to be a coin flip, the only place a red for the delete defect
// can be held DETERMINISTICALLY. Level 3 has a race to lose; this level does
// not.
//
// `GUARD` — passes today and must never stop passing.
// `it.fails` — red today, deterministically, naming what turns it green.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { mkdir, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { FsEditChain } from '../src/fs-edit-chain.ts';

const TREE = 'fileTree';

describe('level 2 — surfaces', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];
  const stops: Array<() => void> = [];

  const makeDb = async (io?: IoMem): Promise<Db> => {
    const store = io ?? new IoMem();
    if (!io) {
      await store.init();
      await store.isReady();
    }
    const db = new Db(store);
    if (!(await db.core.hasTable(TREE))) {
      await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    }
    return db;
  };

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-level2-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    // Let the watcher drain before the folder goes, so a teardown is not
    // mistaken for a deletion worth remembering.
    await new Promise((r) => setTimeout(r, 50));
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  // ...........................................................................
  // S1 — a deletion is representable and survives a restart.
  //
  // GREEN as of WP2a. It was the plan's first red at this level ("today there
  // is no tombstone at all, so this does not compile"), and the mechanism
  // turned out to exist under another name: `_pendingDeletes`, whose lifetime
  // was one announcement. Persisting it is what makes this pass.
  // ...........................................................................
  it('S1 GUARD: a deletion is recorded and survives a restart', async () => {
    const db = await makeDb();
    await writeFile(join(dir, 'doomed.txt'), 'doomed');
    await writeFile(join(dir, 'keeper.txt'), 'keeper');

    const agent = new FsAgent(dir, new BsMem(), {
      timeouts: { debounceMs: 20 },
    });
    agents.push(agent);

    // Through `syncToDb`, not `storeInDb`. A tombstone may only be recorded
    // for a path in `_announcedFiles` — a file peers could know about — and
    // that set is populated by the sync paths, not by a bare store. A file
    // deleted before anyone was told needs no tombstone anyway, because no
    // peer can push it back.
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
    );
    stops.push(await agent.syncToDb(db, connector, TREE));
    await new Promise((r) => setTimeout(r, 300));

    await unlink(join(dir, 'doomed.txt'));
    await new Promise((r) => setTimeout(r, 500));
    agent.scanner.stopWatch();

    // The restart: a brand-new agent over the same folder.
    const restarted = new FsAgent(dir, new BsMem());
    agents.push(restarted);
    expect(restarted['_pendingDeletes'].has(join(dir, 'doomed.txt'))).toBe(
      true,
    );
    expect(restarted['_pendingDeletes'].has(join(dir, 'keeper.txt'))).toBe(
      false,
    );
  }, 30_000);

  // ...........................................................................
  // S2 — a repeated content state is a DISTINCT event.
  //
  // The cheapest possible test of the root cause: no agents, no network, no
  // folders. A folder goes to a state, away from it, and back to byte-identical
  // content. The two arrivals must be two history entries with different
  // identities and different predecessors.
  //
  // GREEN as of WP1a. Before the chain, the content hash WAS the identity, so
  // the return was indistinguishable from the original and from an echo.
  // ...........................................................................
  it('S2 GUARD: returning to a content state is a new entry, not the old one', async () => {
    const db = await makeDb();
    const chain = new FsEditChain(db, TREE);
    await chain.init();

    const there = await chain.append({ treeRef: 'C1', changed: ['a.txt'] });
    const away = await chain.append({ treeRef: 'C0', removed: ['a.txt'] });
    const back = await chain.append({ treeRef: 'C1', changed: ['a.txt'] });

    // Same content, by construction.
    expect(back.treeRef).toBe(there.treeRef);
    // Different event.
    expect(back.head).not.toBe(there.head);
    // And it knows where it came FROM, which is what the ref alone can never
    // say: we arrived at C1 the second time by way of C0.
    expect(there.previous).toEqual([]);
    expect(back.previous).toEqual([away.head]);
  }, 30_000);

  // ...........................................................................
  // S3 — the chain is readable.
  //
  // GREEN as of WP1a for a node's own entries. §7.6.5 asks for one more thing
  // before the level-4 `chain-is-complete` recipe can be written: the same
  // read exposed on the node API. That is not this level's job.
  // ...........................................................................
  it('S3 GUARD: each entry’s ref, predecessors and locality are readable', async () => {
    const db = await makeDb();
    const chain = new FsEditChain(db, TREE);
    await chain.init();
    const first = await chain.append({ treeRef: 'C1' });
    const second = await chain.append({ treeRef: 'C2', changed: ['b.txt'] });

    const read = await chain.entry(second.head);
    expect(read?.head).toBe(second.head);
    expect(read?.previous).toEqual([first.head]);
    expect(read?.treeRef).toBe('C2');
    expect(read?.changed).toEqual(['b.txt']);

    // "Whether the body is held locally" — a ref this node cannot resolve
    // answers `undefined` rather than throwing, because a peer's entry we have
    // not pulled is the ordinary case.
    expect(await chain.entry('a-ref-only-a-peer-holds')).toBeUndefined();
  }, 30_000);

  // ...........................................................................
  // S4 — a delete WINS over a re-announcement of the deleted state.
  //
  // **RED, deterministically, and this is the one that matters.**
  //
  // The tombstone-level unit of §1.2, and the home the delete defect needed
  // after T4 turned out to be a coin flip at level 3 (~40% of runs converge).
  // There is no race here: a peer's tree is applied directly, and either the
  // file comes back or it does not.
  //
  // Two halves, and WP2a delivered only the first:
  //
  //   1. a peer's re-announcement must not resurrect the file HERE — green,
  //      that is `_restoreTree`'s guard, now that the log outlives the push;
  //   2. the delete must WIN on the peer, so the fleet converges rather than
  //      splitting — RED. Nothing carries "this was deleted" to anyone. The
  //      node holds its own deletion and its peers keep the file, for good.
  //
  // The assertion below is the second half: after applying a peer's tree that
  // still contains the deleted file, this node must have something to SAY
  // about it — a record a peer can read and act on. Today there is no such
  // surface at all, in any form.
  //
  // → WP2b (a delete becomes an edit the chain carries).
  // ...........................................................................
  it.fails('S4: a delete is expressible as something a peer can act on', async () => {
    const db = await makeDb();
    const chain = new FsEditChain(db, TREE);
    await chain.init();

    // The deletion, recorded in the chain as WP1a already allows.
    const entry = await chain.append({
      treeRef: 'C0',
      removed: ['doomed.txt'],
    });
    expect(entry.removed).toEqual(['doomed.txt']);

    // And now the half that does not exist: a peer holding the file must be
    // able to ask "has this path been deleted?" and be told yes. There is no
    // such question to ask — the chain records the removal, and nothing
    // consumes it, announces it, or lets a peer resolve a path against it.
    const asPeer = chain as unknown as {
      isTombstoned?: (path: string) => Promise<boolean>;
    };
    expect(typeof asPeer.isTombstoned).toBe('function');
    expect(await asPeer.isTombstoned!('doomed.txt')).toBe(true);
  }, 30_000);

  // ...........................................................................
  // S5 — the agent WRITES the chain as it pushes.
  //
  // WP1a built `FsEditChain` and nothing called it. This is the assertion that
  // the agent actually keeps a history of its own folder: after a push, there
  // is an entry whose `treeRef` is the state that was pushed, whose `previous`
  // is the entry before it, and whose `removed` names what the push deleted.
  //
  // `removed` is the half that matters for WP2b. A tree records what a folder
  // holds; only this records what it deliberately stopped holding, and it has
  // to be written by the thing that knows — the push — rather than inferred
  // later by a peer that never saw the file.
  //
  // → WP1b.
  // ...........................................................................
  it('S5: a push appends a chain entry naming what it removed', async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const db = await makeDb(io);

    await writeFile(join(dir, 'doomed.txt'), 'doomed');
    await writeFile(join(dir, 'keeper.txt'), 'keeper');

    const agent = new FsAgent(dir, new BsMem(), {
      timeouts: { debounceMs: 20 },
    });
    agents.push(agent);
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
    );
    stops.push(await agent.syncToDb(db, connector, TREE));
    await new Promise((r) => setTimeout(r, 300));

    // The folder's first state is an entry.
    const chain = new FsEditChain(db, TREE);
    await chain.init();
    const first = chain.head;
    expect(first, 'the initial push left no chain entry').toBeTruthy();
    const firstEntry = await chain.entry(first as string);
    expect(firstEntry?.treeRef).toBe(agent['_currentRef']);

    await unlink(join(dir, 'doomed.txt'));
    await new Promise((r) => setTimeout(r, 500));

    // And the deletion is an entry of its own, naming the path.
    const after = new FsEditChain(db, TREE);
    await after.init();
    const entry = await after.entry(after.head as string);
    expect(entry?.removed).toEqual(['doomed.txt']);
    expect(entry?.previous).toEqual([first]);
    expect(entry?.treeRef).toBe(agent['_currentRef']);
  }, 30_000);
});
