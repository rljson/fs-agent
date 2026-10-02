// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// V2 / D3 — a file still being written must not be distributed.
//
// From the register: *"Ein Kopieren dauert Sekunden — und in diesen Sekunden
// wird die halbe Datei verteilt."* And measured: *"Eine große Datei wird 0,3
// Sekunden nach dem ersten Byte gelesen und als vollständiger Stand an alle
// verteilt. Dort gilt sie als gültig."*
//
// THE LOWEST LEVEL THIS CAN BE ASKED AT. Not "did a peer ever hold a truncated
// file", which is a race a test can only lose: a poll either catches the window
// or it does not. The question with a definite answer is whether this agent
// ever HASHED a partial file — because a blob is what gets announced, so a
// partial blob is the whole defect, and a scan that never made one cannot have
// distributed one.
//
// So every `setBlob` is recorded, and the assertion is on the sizes: for a file
// written in slices, the only blob that may exist for it is the complete one.
// No peers, no network, no timing luck.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { open, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';

const TREE = 'fsTree';

/** One slice of the file, and how long to wait before the next. */
const SLICE_BYTES = 256 * 1024;
const SLICES = 96;
const SLICE_PAUSE_MS = 0;
const TOTAL_BYTES = SLICE_BYTES * SLICES;

describe('V2/D3 — a file being written is not distributed half-done', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-slowcopy-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * An agent watching the folder, with every stored blob's size recorded.
   * @returns The agent and the list of blob sizes it has written.
   */
  const start = async (): Promise<{ sizes: number[] }> => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const bs = new BsMem();
    const sizes: number[] = [];
    const realSetBlob = bs.setBlob.bind(bs);
    bs.setBlob = async (content) => {
      const props = await realSetBlob(content);
      sizes.push(props.size);
      return props;
    };
    const connector = new Connector(db, Route.fromFlat(`/${TREE}`), new SocketMock(), {
      causalOrdering: true,
      includeClientIdentity: true,
    });
    const agent = new FsAgent(dir, bs, {
      // A short debounce, so the agent is as eager as it can be — which is the
      // condition the defect needs. Slowing it down would hide the fault
      // rather than test it.
      timeouts: { debounceMs: 1 },
    });
    agents.push(agent);
    stops.push(await agent.syncToDb(db, connector, TREE));
    return { sizes };
  };

  /**
   * Writes a file the way a copy does: open, append, append, …, close.
   * @param path - Where to write.
   */
  const slowCopy = async (path: string): Promise<void> => {
    const slice = Buffer.alloc(SLICE_BYTES, 0x41);
    const handle = await open(path, 'w');
    try {
      for (let i = 0; i < SLICES; i++) {
        await handle.write(slice);
        await handle.sync();
        // No artificial pause: a copy writes as fast as the disk allows, and
        // that is the case this has to catch. A test that paused between
        // slices was measuring a stalled network copy — a different and
        // strictly harder problem, where a long enough stall is
        // indistinguishable from a finished file.
        if (SLICE_PAUSE_MS > 0) await sleep(SLICE_PAUSE_MS);
      }
    } finally {
      await handle.close();
    }
  };

  // ...........................................................................
  it('never hashes a partial copy', async () => {
    const { sizes } = await start();
    await sleep(200);

    await slowCopy(join(dir, 'big.bin'));
    // Long enough for the debounce and a safety rescan to have had their say.
    await sleep(1_500);

    const partial = sizes.filter((s) => s > 0 && s < TOTAL_BYTES);
    expect(
      partial,
      `hashed ${partial.length} partial version(s) of a file still being ` +
        `written — sizes ${JSON.stringify(partial)} against a final ` +
        `${TOTAL_BYTES}. Every one of these is a state that gets announced ` +
        `to the fleet as complete.`,
    ).toEqual([]);
    // And the finished file IS hashed, or the test would pass by doing nothing.
    expect(sizes, 'the completed file was never hashed').toContain(TOTAL_BYTES);
  }, 60_000);
  // ...........................................................................
  it('keeps the last known content while a file is overwritten', async () => {
    // The branch that makes the deferral safe, and the one that would be a
    // disaster to get wrong.
    //
    // A file still being written must not simply be LEFT OUT of the tree: a
    // path missing from a tree peers already hold reads as a DELETION, so a
    // user saving over a document would have it deleted on every machine. The
    // previous scan's node is reused instead — the change has not happened yet
    // as far as the network is concerned.
    const { sizes } = await start();
    await writeFile(join(dir, 'doc.txt'), 'ORIGINAL');
    await sleep(800); // settled, scanned, announced
    expect(sizes.length, 'the original was never hashed').toBeGreaterThan(0);

    // Now overwrite it and look at the tree WHILE the write is fresh.
    await writeFile(join(dir, 'doc.txt'), 'REPLACED-BUT-STILL-SETTLING');
    const tree = await agents[0].extract();
    const paths = [...tree.trees.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => p !== undefined && p !== '.');

    expect(
      paths,
      'the path vanished from the tree — peers would read that as a deletion',
    ).toContain('doc.txt');

    // And once it settles, the new content does go out.
    await sleep(800);
    const after = await agents[0].extract();
    const node = [...after.trees.values()].find(
      (n) => (n.meta as { relativePath?: string })?.relativePath === 'doc.txt',
    );
    expect((node?.meta as { size?: number })?.size).toBe(
      'REPLACED-BUT-STILL-SETTLING'.length,
    );
    expect(await readFile(join(dir, 'doc.txt'), 'utf-8')).toBe(
      'REPLACED-BUT-STILL-SETTLING',
    );
  }, 60_000);

  // ...........................................................................
  it('one unsettled file does not stop the rest of the folder', async () => {
    // Why a deferral does NOT mark the whole scan partial, the way a vanished
    // entry does. Something appended to continuously — a log inside the synced
    // folder — would otherwise freeze every other file's sync for as long as it
    // kept being written. It stops updating itself; it does not stop the
    // folder.
    await start();
    await writeFile(join(dir, 'settled.txt'), 'settled');
    await sleep(800);

    // A file kept permanently in motion.
    const churn = await open(join(dir, 'busy.log'), 'w');
    let stop = false;
    const churning = (async () => {
      while (!stop) {
        await churn.write('line\n');
        await sleep(40);
      }
    })();

    // Meanwhile a quiet file appears and must still reach the tree.
    await writeFile(join(dir, 'quiet.txt'), 'quiet');
    await sleep(1_200);

    const tree = await agents[0].extract();
    const paths = [...tree.trees.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => p !== undefined && p !== '.')
      .sort();

    stop = true;
    await churning;
    await churn.close();

    expect(
      paths,
      'a file in motion froze the rest of the folder',
    ).toContain('quiet.txt');
    expect(paths).toContain('settled.txt');
  }, 60_000);
});
