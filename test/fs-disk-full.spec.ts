// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// L2 / D4 — a full disk must abort cleanly and say so.
//
// *"Jede alte Version jeder Datei bleibt auf jedem Rechner für immer liegen.
// Was bei voller Platte passiert, wurde nie getestet."* The register's own
// reduction: *"disk-full — Fill the disk: clean abort with a message instead of
// a silent standstill."*
//
// The write path is mocked rather than a real volume filled: `ENOSPC` is what
// the kernel reports and what the agent has to recognise, and staging a genuine
// full disk in a unit suite buys nothing except a machine that cannot run the
// rest of it.
//
// What "clean" has to mean, concretely:
//  - a typed failure, so a caller can tell it from a bug;
//  - the path in the message, so somebody knows what stopped;
//  - a line in the sync error log, because a console scrolls away;
//  - and it ABORTS rather than skipping the file, unlike a lock or an
//    impossible name — on a full disk the next file fails too, and skipping
//    each in turn loses a different one on every attempt while reporting
//    progress.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const full = new Set<string>();

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const enospc = (): NodeJS.ErrnoException => {
    const err = new Error('ENOSPC: no space left on device') as
      NodeJS.ErrnoException;
    err.code = 'ENOSPC';
    return err;
  };
  return {
    ...actual,
    // At the OPEN, which is where a full volume refuses a new file. The
    // restore writes through a temp file, so the name it opens is the temp
    // one — the folder is what is full, not a particular path.
    open: (path: unknown, flags?: unknown, ...rest: never[]) => {
      const write = flags === undefined || String(flags).includes('w');
      if (write && [...full].some((f) => String(path).startsWith(f))) {
        return Promise.reject(enospc());
      }
      return (actual.open as (...a: never[]) => Promise<unknown>)(
        path as never,
        flags as never,
        ...rest,
      );
    },
  };
});

const { DiskFullError, FsAgent, RestoreIncompleteError, SYNC_ERROR_FILE } =
  await import('../src/fs-agent.ts');

describe('L2/D4 — a full disk', () => {
  let dir = '';
  let nth = 0;
  const agents: Array<InstanceType<typeof FsAgent>> = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-diskfull-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(dir, 'source'), { recursive: true });
    await mkdir(join(dir, 'target'), { recursive: true });
    full.clear();
  });

  afterEach(async () => {
    full.clear();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * A tree of three files, and a receiver whose volume is about to fill.
   * @returns The tree and the receiving agent.
   */
  const setup = async () => {
    const source = join(dir, 'source');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(source, name), name.repeat(100));
    }
    const bs = new BsMem();
    const sender = new FsAgent(source, bs);
    agents.push(sender);
    const tree = await sender.extract();
    const target = join(dir, 'target');
    const receiver = new FsAgent(target, bs);
    agents.push(receiver);
    return { tree, receiver, target };
  };

  // ...........................................................................
  it('aborts with a typed error naming what could not be written', async () => {
    const { tree, receiver, target } = await setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    full.add(target);

    const thrown = await receiver
      .restore(tree, target, { cleanTarget: true })
      .catch((e: unknown) => e);
    const said = err.mock.calls.map((c) => String(c[0])).join('\n');
    err.mockRestore();

    expect(thrown).toBeInstanceOf(RestoreIncompleteError);
    expect(thrown).toBeInstanceOf(DiskFullError);
    expect((thrown as InstanceType<typeof DiskFullError>).path).toMatch(
      /\.txt$/,
    );
    // Loud, because the alternative is a folder that quietly stops updating.
    expect(said).toContain('NO SPACE LEFT');
    expect(said).toContain(target);
  }, 60_000);

  // ...........................................................................
  it('records it where a support request can find it', async () => {
    // A console line is gone when the terminal scrolls, and this is exactly
    // the fault somebody reports a week later.
    const { tree, receiver, target } = await setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    full.add(target);

    await receiver.restore(tree, target, { cleanTarget: true }).catch(() => {});
    err.mockRestore();

    const log = join(target, SYNC_ERROR_FILE);
    expect(existsSync(log), 'nothing was written to the sync error log').toBe(
      true,
    );
    expect(readFileSync(log, 'utf-8')).toContain('ENOSPC');
  }, 60_000);

  // ...........................................................................
  it('succeeds once space is available again', async () => {
    // The counterpart: a full disk must not leave the agent in a state it
    // cannot come back from. Nothing was recorded as applied, so the ordinary
    // retry does the whole tree.
    const { tree, receiver, target } = await setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    full.add(target);
    await receiver.restore(tree, target, { cleanTarget: true }).catch(() => {});
    err.mockRestore();

    full.clear();
    await receiver.restore(tree, target, { cleanTarget: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      expect(existsSync(join(target, name)), `${name} is missing`).toBe(true);
    }
  }, 60_000);
});
