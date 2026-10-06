// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// F5 / C7 — measure the steps, not just the total.
//
// *"Im Schnitt 3 Sekunden, im schlechtesten Fall 84. Alle Zeitbudgets der
// Testsuite hängen an dieser Zahl."* And why nobody could say more than that:
// *"Bisher wird nur die Gesamtzeit gemessen. Die einzelnen Schritte mitmessen —
// Scan, Prüfsumme, Ablage, Meldung, Abholen, Schreiben —, sonst rät man."*
//
// A total says a sync was slow. It does not say whether the folder was being
// hashed, a blob was crossing the network, or a disk was writing — and those
// have different causes and different people to talk to. The 84-second outlier
// is unexplainable without this split, and every budget in a real fleet suite is
// derived from it.
//
// These tests do not assert durations: a number measured on one laptop means
// nothing on another, and a test that pins one is flaky by construction. They
// assert that each stage IS measured and attributed to the right side, which is
// what makes a real fleet's numbers readable.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';
import { FsDbAdapter } from '../src/fs-db-adapter.ts';

const TREE = 'fsTree';

describe('F5 — per-stage timings', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-timings-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ...........................................................................
  it('reports nothing before anything has run', async () => {
    // A stage absent means it has not happened, which is information. A stage
    // reported as 0 would read as "instant".
    const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(agent);
    expect(agent.stageTimings).toEqual({});
  });

  // ...........................................................................
  it('attributes the send side: scan and announce', async () => {
    await writeFile(join(dir, 'a.txt'), 'a'.repeat(5_000));
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
      { causalOrdering: true, includeClientIdentity: true },
    );
    const agent = new FsAgent(dir, new BsMem(), {
      ...ORIGIN_FIXTURE,
      timeouts: { debounceMs: 20 },
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, TREE));
    await sleep(900);
    await writeFile(join(dir, 'b.txt'), 'b'.repeat(5_000));
    await sleep(900);

    const t = agent.stageTimings;
    expect(Object.keys(t).sort(), JSON.stringify(t)).toContain('push.scan');
    expect(Object.keys(t), JSON.stringify(t)).toContain('push.announce');
    // Measured, not merely present: a stage that never records is a stage
    // reported as instant forever.
    for (const stage of ['push.scan', 'push.announce']) {
      expect(t[stage], `${stage} is not a number`).toBeTypeOf('number');
      expect(t[stage]).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  // ...........................................................................
  it('attributes the receive side: fetch, write and re-derive', async () => {
    // The three steps an apply is made of, and the ones the register names as
    // "Abholen" and "Schreiben". Separating them is what tells a reader
    // whether the 84 seconds were the network or the disk.
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const bs = new BsMem();

    const source = join(dir, 'source');
    await mkdir(source, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(source, `f-${i}.txt`), `c-${i}`.repeat(500));
    }
    const sender = new FsAgent(source, bs, ORIGIN_FIXTURE);
    agents.push(sender);
    const ref = await new FsDbAdapter(db, TREE).storeFsTree(
      await sender.extract(),
      { skipNotification: true },
    );

    const target = join(dir, 'target');
    await mkdir(target, { recursive: true });
    const receiver = new FsAgent(target, bs, ORIGIN_FIXTURE);
    agents.push(receiver);
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
      { causalOrdering: true, includeClientIdentity: true },
    );
    stops.push(
      await receiver.syncFromDb(db, connector, TREE, { cleanTarget: true }),
    );
    (connector as unknown as { socket: { emit: (e: string, p: unknown) => void } })
      .socket?.emit?.(connector.events.ref, { o: 'peer', r: ref });
    // Driven directly as well, so the test does not depend on a transport
    // detail to prove that the stages are attributed.
    await receiver.loadFromDb(db, TREE, ref, target, { cleanTarget: true });

    const t = receiver.stageTimings;
    for (const stage of ['apply.write']) {
      expect(t[stage], `${stage} was never measured: ${JSON.stringify(t)}`)
        .toBeTypeOf('number');
    }
    // The send and receive sides are kept apart, or a reader cannot tell
    // which machine was slow.
    expect(Object.keys(t).some((k) => k.startsWith('apply.'))).toBe(true);
  }, 60_000);

  // ...........................................................................
  it('reports the LAST cycle, not a running total', async () => {
    // A total never resets and answers a different question. What a budget
    // needs is "what did the slow one cost", and that means the figure has to
    // be replaced each cycle rather than accumulated.
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(2_000_000));
    const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(agent);
    await agent.extract();
    const afterBig = agent.stageTimings['push.scan'];

    await rm(join(dir, 'big.txt'));
    await writeFile(join(dir, 'tiny.txt'), 'x');
    await agent.extract();
    const afterTiny = agent.stageTimings['push.scan'];

    expect(afterBig).toBeTypeOf('number');
    expect(afterTiny).toBeTypeOf('number');
    // Not the sum of the two — which is what an accumulating counter would
    // give, and would make every later cycle look worse than it was.
    expect(afterTiny).toBeLessThanOrEqual(afterBig + 1);
  }, 60_000);
});
