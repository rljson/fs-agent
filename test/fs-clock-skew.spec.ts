// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// F7 / S3 / M6 — a wrong clock must not make a file invisible.
//
// *"Solange die Reihenfolge an der Uhr hängt, entscheidet eine falsch gehende
// Uhr darüber, wessen Arbeit zählt."* And the reason that is not hypothetical
// here: the host application lets a machine take its time from the BIOS clock
// alone.
//
// This is also a regression guard for a defect introduced by the settle rule
// that keeps a half-copied file off the wire. Both halves of that rule compare
// a file's mtime against a moment of this machine's own clock, and both read a
// FUTURE timestamp as "touched just now" — `mtime > scanStartedAt` is
// permanently true and `now - mtime` is negative. Measured: a file dated one
// day ahead never appeared in the tree at all. Not once; never.
//
// A future timestamp is ordinary. An archive carries whatever it likes, a file
// copied from a machine running fast arrives dated ahead, and a BIOS clock can
// be years out. None of those is a file being written.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { mkdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';

describe('F7 — a file is visible whatever its timestamp says', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-skew-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * An agent that is WATCHING, because that is when the settle rule applies —
   * a one-shot scan never defers anything.
   * @returns The agent.
   */
  const watching = async (): Promise<FsAgent> => {
    const agent = new FsAgent(dir, new BsMem());
    agents.push(agent);
    await (
      agent as unknown as { _ensureWatching(): Promise<void> }
    )._ensureWatching();
    return agent;
  };

  /** The file paths a scan found, root excluded. */
  const pathsOf = async (agent: FsAgent): Promise<string[]> =>
    [...(await agent.extract()).trees.values()]
      .map((n) => (n.meta as { relativePath?: string })?.relativePath)
      .filter((p): p is string => !!p && p !== '.')
      .sort();

  const stamps: ReadonlyArray<readonly [string, number]> = [
    ['one day in the future', 86_400_000],
    ['a year in the future', 365 * 86_400_000],
    ['one second in the future', 1_000],
    ['long in the past', -10 * 365 * 86_400_000],
  ];

  for (const [what, offset] of stamps) {
    // .........................................................................
    it(`publishes a file dated ${what}`, async () => {
      const agent = await watching();
      await writeFile(join(dir, 'stamped.txt'), 'content');
      const when = new Date(Date.now() + offset);
      await utimes(join(dir, 'stamped.txt'), when, when);
      // Past any settle window several times over.
      await sleep(1_200);

      expect(
        await pathsOf(agent),
        `a file dated ${what} is invisible to the tree`,
      ).toEqual(['stamped.txt']);
    }, 60_000);
  }

  // ...........................................................................
  it('still holds back a file that is genuinely being written', async () => {
    // The counterpart. A guard that lets everything through is not a guard,
    // and the clock fix must not undo the half-copied-file protection.
    const agent = await watching();
    const bs = (agent as unknown as { _bs: BsMem })._bs;
    const sizes: number[] = [];
    const realSetBlob = bs.setBlob.bind(bs);
    bs.setBlob = async (content) => {
      const props = await realSetBlob(content);
      sizes.push(props.size);
      return props;
    };

    const slice = Buffer.alloc(256 * 1024, 0x41);
    const total = slice.length * 96;
    const { open } = await import('fs/promises');
    const handle = await open(join(dir, 'copying.bin'), 'w');
    try {
      for (let i = 0; i < 96; i++) {
        await handle.write(slice);
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await sleep(1_200);

    expect(
      sizes.filter((s) => s > 0 && s < total),
      'a partial copy was hashed; the clock fix undid the settle rule',
    ).toEqual([]);
  }, 60_000);

  // ...........................................................................
  it('publishes a file whose timestamp jumps backwards after a scan', async () => {
    // A machine whose clock is corrected while running, or an archive
    // extracted over an existing file. The file has already been seen once,
    // so this is the modify path rather than the first-sight one.
    const agent = await watching();
    await writeFile(join(dir, 'moving.txt'), 'first');
    await sleep(600);
    expect(await pathsOf(agent)).toEqual(['moving.txt']);

    await writeFile(join(dir, 'moving.txt'), 'second-and-longer');
    const past = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, 'moving.txt'), past, past);
    await sleep(900);

    const node = [...(await agent.extract()).trees.values()].find(
      (n) => (n.meta as { relativePath?: string })?.relativePath ===
        'moving.txt',
    );
    expect(
      (node?.meta as { size?: number })?.size,
      'the new content was never picked up because its timestamp went back',
    ).toBe('second-and-longer'.length);
  }, 60_000);
});
