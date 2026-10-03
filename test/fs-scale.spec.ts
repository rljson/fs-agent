// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// V2/D8 and E2/T1 — the two measurements that need time, not a lab.
//
// D8: *"Jede Änderung rechnet den ganzen Ordner durch, alle 5 Sekunden noch
// einmal. Erster Start am echten Katalog rund 48 Minuten."*
// T1: *"Nichts lief je länger als eine Testsuite von 45 Minuten. Lecks,
// unbegrenztes Wachstum und Abdriften sind Mehrstundenphänomene."*
//
// Both are reachable here. Neither needs four machines — they need a clock and
// patience, and a laptop has both. What they are NOT is a pass/fail: the
// register is explicit — *"Das Ergebnis ist die Kurve, nicht ein Häkchen"* — so
// these print numbers and assert only the bounds that would mean something is
// structurally wrong.
//
// SIZED BY ENVIRONMENT, because the suite has to stay runnable. The defaults
// are small enough to sit in an ordinary run; the register's own scale is one
// variable away:
//
//   FS_SCALE_FILES=100000 FS_SOAK_MS=14400000 pnpm test fs-scale
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

const FILES = Number(process.env['FS_SCALE_FILES'] ?? 4_000);
const SOAK_MS = Number(process.env['FS_SOAK_MS'] ?? 20_000);
const SAMPLE_MS = 2_000;
const TREE = 'fsTree';

describe('scale and endurance', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];
  // Scan caches live OUTSIDE the scanned folder — a cache file inside it is
  // part of the next scan — so the teardown has to name them. Left behind,
  // they turned up as untracked files in the repo.
  const caches: string[] = [];

  /**
   * A scan-cache path beside the scanned folder, registered for cleanup.
   * @param name - Distinguishes one test's cache from another's.
   * @returns The absolute path to hand to `scanCachePath`.
   */
  const cachePath = (name: string): string => {
    const path = join(process.cwd(), `test-temp-scale-${name}-${nth}.json`);
    caches.push(path);
    return path;
  };

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-scale-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
    for (const cache of caches.splice(0)) {
      await rm(cache, { force: true, maxRetries: 5 });
    }
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ...........................................................................
  // D8 — what a scan costs the second time.
  //
  // The register's fix ("nur den geänderten Pfad bis zur Wurzel neu rechnen")
  // is not built, so a second scan still WALKS the whole folder. What it must
  // not do is READ and HASH every file again, because that is the 48 minutes —
  // and that is what the scan cache is for. So the measurement is blob reads,
  // and the walk time is printed rather than asserted.
  // ...........................................................................
  it(`D8: a second scan re-reads nothing (${FILES} files)`, async () => {
    const nested = join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    for (let i = 0; i < FILES; i++) {
      // Spread over two levels, so the walk is not one flat readdir.
      const where = i % 2 === 0 ? dir : nested;
      await writeFile(join(where, `f-${i}.txt`), `content-${i}`);
    }

    const bs = new BsMem();
    let reads = 0;
    const realSetBlob = bs.setBlob.bind(bs);
    bs.setBlob = async (content) => {
      reads++;
      return realSetBlob(content);
    };
    // A cache path, because that is what a One Client should be configured
    // with — and without it the reuse is unavailable, which is worth knowing
    // as its own fact (see the GUARD below).
    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      scanCachePath: cachePath('cache'),
    });
    agents.push(agent);

    const t0 = Date.now();
    await agent.extract();
    const firstMs = Date.now() - t0;
    const afterFirst = reads;

    const t1 = Date.now();
    await agent.extract();
    const secondMs = Date.now() - t1;
    const reReads = reads - afterFirst;

    // The curve, not a tick.
    console.log(
      `[D8] ${FILES} files: first scan ${firstMs} ms (${afterFirst} reads), ` +
        `second scan ${secondMs} ms (${reReads} reads), ` +
        `${Math.round(firstMs / FILES * 1000)} µs/file first`,
    );

    expect(afterFirst, 'the first scan did not read the files').toBe(FILES);
    expect(
      reReads,
      're-read files whose size and timestamp had not changed; this is the ' +
        '48-minute scan happening again',
    ).toBe(0);
    // Generous, and still enough to catch a second scan that re-does the work:
    // reading and hashing dominates, so dropping it has to show.
    expect(secondMs).toBeLessThan(firstMs);
  }, 600_000);

  // ...........................................................................
  it('D8 GUARD: one changed file is the only thing re-read', async () => {
    // The claim the cache is actually for. If a single edit re-read the
    // folder, the five-second safety rescan would do it too, which is the
    // shape of the original report.
    for (let i = 0; i < Math.min(FILES, 500); i++) {
      await writeFile(join(dir, `g-${i}.txt`), `c-${i}`);
    }
    const bs = new BsMem();
    let reads = 0;
    const realSetBlob = bs.setBlob.bind(bs);
    bs.setBlob = async (content) => {
      reads++;
      return realSetBlob(content);
    };
    const agent = new FsAgent(dir, bs, {
      ...ORIGIN_FIXTURE,
      scanCachePath: cachePath('guard'),
    });
    agents.push(agent);
    await agent.extract();
    const base = reads;

    await writeFile(join(dir, 'g-7.txt'), 'CHANGED');
    await agent.extract();

    expect(reads - base, 'more than the changed file was re-read').toBe(1);
  }, 600_000);

  // ...........................................................................
  // T1 — endurance. Memory, handles and the agent's own bounded structures,
  // sampled while the folder churns.
  //
  // Short by default. `FS_SOAK_MS=14400000` is the four hours the register
  // asks for, and nothing about the test changes to run it.
  // ...........................................................................
  it(`T1: nothing grows without bound under churn (${SOAK_MS} ms)`, async () => {
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
    stops.push(await agent.syncFromDb(db, connector, TREE));

    type Sample = {
      atMs: number;
      heapMb: number;
      tombstones: number;
      announced: number;
    };
    const samples: Sample[] = [];
    const inner = (a: FsAgent, k: string): number => {
      const v = (a as unknown as Record<string, unknown>)[k];
      if (v instanceof Set || v instanceof Map) return v.size;
      if (Array.isArray(v)) return v.length;
      /* v8 ignore next -- @preserve every key below exists */
      return 0;
    };

    const started = Date.now();
    let round = 0;
    while (Date.now() - started < SOAK_MS) {
      // Churn: write a few, delete a few. Deletions are what grows a
      // tombstone log, which is the structure the register names.
      for (let i = 0; i < 20; i++) {
        await writeFile(join(dir, `soak-${round}-${i}.txt`), `r${round}`);
      }
      // Long enough that the files are ANNOUNCED before being deleted, which
      // is what puts entries in the tombstone log — the structure the register
      // names as growing without bound. Churning faster than an announcement
      // exercises nothing: a file no peer was told about needs no tombstone.
      await sleep(500);
      for (let i = 0; i < 20; i++) {
        await rm(join(dir, `soak-${round}-${i}.txt`), { force: true });
      }
      await sleep(500);
      round++;

      if (samples.length === 0 || Date.now() - started >
          samples[samples.length - 1].atMs + SAMPLE_MS) {
        global.gc?.();
        samples.push({
          atMs: Date.now() - started,
          heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          tombstones: inner(agent, '_pendingDeletes'),
          announced: inner(agent, '_announcedFiles'),
        });
      }
    }

    console.log(
      `[T1] ${round} churn rounds over ${Date.now() - started} ms\n` +
        samples
          .map(
            (s) =>
              `  ${String(s.atMs).padStart(7)} ms  heap ${s.heapMb} MB  ` +
              `tombstones ${s.tombstones}  ` +
              `announced ${s.announced}`,
          )
          .join('\n'),
    );

    expect(samples.length, 'no samples were taken').toBeGreaterThan(1);
    // The churn has to have actually reached the announce path, or the caps
    // below are being asserted against structures nothing filled.
    expect(
      Math.max(...samples.map((s) => s.tombstones)),
      'no deletion was ever announced, so nothing exercised the tombstone log',
    ).toBeGreaterThan(0);
    const last = samples[samples.length - 1];
    // The caps this agent documents, asserted rather than trusted. These are
    // the "zwei unbegrenzte Listen" the register asks to be bounded — on the
    // file side they are.
    // `_announcedHeads` is NOT asserted here. This run is single-node, so it
    // receives no announcements and the map stays empty — a cap asserted
    // against a structure nothing filled, which is the very mistake the
    // `tombstones > 0` check above exists to prevent. Its own bound is
    // measured in `fs-agent-announced-heads.spec.ts`.
    expect(last.tombstones).toBeLessThanOrEqual(10_000);
    // And the folder is empty at the end, so nothing accumulated on disk
    // either.
    expect((await agent.extract()).trees.size).toBeLessThan(10);
  }, 7_200_000);
});
