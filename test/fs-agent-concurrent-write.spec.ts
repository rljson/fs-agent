// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// TWO WRITES OF ONE PATH MUST NOT BLEND.
//
// `_atomicWriteFile` used to write straight to the target on everything but
// win32, keeping an in-place write because a rename replaces the inode and
// `fs.watch` can lose the watch. The price was byte-level corruption.
//
// `writeFile` is `open('w')` — which TRUNCATES — followed by a write. Two
// concurrent calls therefore interleave as:
//
//   open+truncate (A)   open+truncate (B)   write "s20" (A)   write "s0" (B)
//
// and the file is left holding `"s00"`: the second writer's two bytes over the
// first writer's three. Neither version. **A file nobody wrote.**
//
// Measured straight against the OS, 2 000 pairs with contents of different
// lengths: `"s00"` 1 520 times, `"s20"` 476, `"s0"` 4. The blend is the COMMON
// case. It reached us as the fuzz test's *nothing holds content nobody ever
// wrote* invariant failing with exactly `"s00"` on `sub/four.txt`, after the
// run had written `s0`, `s14` and `s20` to it — and a blend is worse than
// either version losing, because the scanner hashes it and announces it to the
// whole network as a legitimate state.
//
// The fix is the one `_atomicWriteStream` already had: stage in a sibling temp
// and rename, on every platform. Each writer gets its own staging file, so the
// outcome is whichever rename lands last — a complete version either way.
// .............................................................................

import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATOMIC_TMP_PREFIX,
  atomicWriteFile,
  atomicWriteStream,
} from '../src/fs-atomic-write.ts';

/**
 * `ATOMIC_TMP_PREFIX` is imported from the module that DEFINES it, not from
 * `index.ts`. The first version of this file took it from the barrel, where it
 * was not exported — so it was `undefined`, `startsWith(undefined)` matched
 * nothing, and the "no staging file survived" assertion passed without
 * checking anything. A test that cannot fail is not a test.
 */
const atomicWrite = atomicWriteFile;

/** A one-chunk stream, for the stream writer's half of the contract. */
const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-agent-atomic-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ...........................................................................
  it('leaves one COMPLETE version when two writes race on one path', async () => {
    // 200 rounds, because the old behaviour lost this three times in four and
    // a single round would therefore prove nothing either way.
    const file = join(dir, 'doc.txt');
    const blends: string[] = [];

    for (let round = 0; round < 200; round++) {
      await writeFile(file, 'init');
      // Different LENGTHS is the whole point: equal-length contents overwrite
      // each other completely and cannot blend.
      await Promise.all([atomicWrite(file, 's20'), atomicWrite(file, 's0')]);
      const got = await readFile(file, 'utf8');
      if (got !== 's20' && got !== 's0') blends.push(got);
    }

    expect(
      blends,
      `the file held content nobody wrote: ${JSON.stringify(
        [...new Set(blends)],
      )}`,
    ).toEqual([]);
  }, 60_000);

  // ...........................................................................
  it('writes the content, and leaves no staging file behind', async () => {
    const file = join(dir, 'sub-free.txt');
    await atomicWrite(file, 'the bytes');
    expect(await readFile(file, 'utf8')).toBe('the bytes');

    const left = (await readdir(dir)).filter((n) =>
      n.startsWith(ATOMIC_TMP_PREFIX),
    );
    expect(left, 'a staging file survived the write').toEqual([]);
  });

  // ...........................................................................
  it('replaces existing content rather than overwriting part of it', async () => {
    // The single-writer case the blend made look fine: a SHORTER version
    // replacing a longer one must not leave the old tail.
    const file = join(dir, 'shrinks.txt');
    await atomicWrite(file, 'a long first version');
    await atomicWrite(file, 'short');
    expect(await readFile(file, 'utf8')).toBe('short');
  });

  // ...........................................................................
  it('writes Buffers as well as strings', async () => {
    const file = join(dir, 'bytes.bin');
    await atomicWrite(file, Buffer.from([0x00, 0xff, 0x00]));
    const got = await readFile(file);
    expect([...got]).toEqual([0x00, 0xff, 0x00]);
  });

  // ...........................................................................
  it('fails loudly when the directory does not exist, and stages nothing', async () => {
    // The staging file lives beside the target, so an impossible directory
    // fails at the staging write — before anything is renamed into place, and
    // with no half-written file anywhere.
    const missing = join(dir, 'no-such-dir', 'x.txt');
    await expect(atomicWrite(missing, 'x')).rejects.toThrow();
    expect(await readdir(dir), 'something was left behind').toEqual([]);
  });
});

// ...........................................................................
describe('atomicWriteStream', () => {
  // The same contract, for the writer the blob adapter and the restore path
  // use. `blobToFile` streamed straight into the target until this existed,
  // which is where the fuzz run's `"s25"` came from.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-agent-atomic-stream-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves one COMPLETE version when two streams race on one path', async () => {
    const file = join(dir, 'doc.txt');
    const blends: string[] = [];

    for (let round = 0; round < 200; round++) {
      await writeFile(file, 'init');
      await Promise.all([
        atomicWriteStream(file, streamOf('s15')),
        atomicWriteStream(file, streamOf('s2')),
      ]);
      const got = await readFile(file, 'utf8');
      if (got !== 's15' && got !== 's2') blends.push(got);
    }

    expect(
      blends,
      `the file held content nobody wrote: ${JSON.stringify(
        [...new Set(blends)],
      )}`,
    ).toEqual([]);
  }, 60_000);

  it('writes the bytes and leaves no staging file behind', async () => {
    const file = join(dir, 'streamed.txt');
    await atomicWriteStream(file, streamOf('the bytes'));
    expect(await readFile(file, 'utf8')).toBe('the bytes');
    expect(
      (await readdir(dir)).filter((n) => n.startsWith(ATOMIC_TMP_PREFIX)),
      'a staging file survived the write',
    ).toEqual([]);
  });

  it('never leaves a partial file at the target when the stream fails', async () => {
    // The reason the staging file matters most: a failed restore must leave
    // the previous version intact, not a truncated document.
    const file = join(dir, 'fails.txt');
    await writeFile(file, 'the previous version');
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      },
      pull(controller) {
        controller.error(new Error('the blob went away'));
      },
    });

    await expect(atomicWriteStream(file, broken)).rejects.toThrow(
      'the blob went away',
    );
    expect(await readFile(file, 'utf8')).toBe('the previous version');
    expect(
      (await readdir(dir)).filter((n) => n.startsWith(ATOMIC_TMP_PREFIX)),
      'the partial staging file was left behind',
    ).toEqual([]);
  });

  it('hands a read failure to the caller\'s tagger when one is given', async () => {
    // The restore path has to tell "the blob could not be read" from "the file
    // could not be written": one costs a retry, the other a user-visible
    // error. That distinction is the tagger's whole job.
    const file = join(dir, 'tagged.txt');
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('source gone'));
      },
    });

    const tagged = atomicWriteStream(file, broken, (error) =>
      Object.assign(error as Error, { __blobRead: true }),
    );
    await expect(tagged).rejects.toMatchObject({ __blobRead: true });
  });
});
