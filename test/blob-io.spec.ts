// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';

import { mkdir, open, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STREAM_ABOVE_BYTES, storeFileAsBlob } from '../src/blob-io.ts';

import type { Bs } from '@rljson/bs';

/**
 * The threshold decides which of two correct paths a file takes, so the tests
 * have to see which one ran — not only that the bytes arrived. A store that
 * records the SHAPE of what it was handed is the only way to tell a streamed
 * file from a buffered one after the fact.
 */
const recordingBs = (): { bs: Bs; shapes: string[] } => {
  const inner = new BsMem();
  const shapes: string[] = [];
  const bs = Object.create(inner) as Bs;
  bs.setBlob = (content) => {
    shapes.push(content instanceof ReadableStream ? 'stream' : 'buffer');
    return inner.setBlob(content);
  };
  return { bs, shapes };
};

describe('storeFileAsBlob', () => {
  const testDir = join(process.cwd(), 'test-temp-blob-io');

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Writes `size` bytes with a per-position pattern and returns them. */
  const fixture = async (name: string, size: number): Promise<Buffer> => {
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i++) content[i] = i % 251;
    await writeFile(join(testDir, name), content);
    return content;
  };

  const store = async (
    bs: Bs,
    name: string,
    size: number,
  ): Promise<string> => {
    const handle = await open(join(testDir, name), 'r');
    try {
      return (await storeFileAsBlob(bs, handle, size)).blobId;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  it('reads a small file whole, because a stream would bound nothing extra', async () => {
    // Below one chunk the whole-file read costs no more memory than a stream
    // would, and the scanner runs this once per file over trees of hundreds of
    // thousands of files. The cheap path is also the bounded one here.
    const { bs, shapes } = recordingBs();
    await fixture('small.bin', 1024);
    await store(bs, 'small.bin', 1024);
    expect(shapes).toEqual(['buffer']);
  });

  it('streams a file above the threshold', async () => {
    const { bs, shapes } = recordingBs();
    const size = STREAM_ABOVE_BYTES + 1;
    await fixture('big.bin', size);
    await store(bs, 'big.bin', size);
    expect(shapes).toEqual(['stream']);
  });

  it('reads a file exactly AT the threshold whole', async () => {
    // The boundary is inclusive on the cheap side: at exactly one chunk there is
    // nothing to gain, and an off-by-one here would silently move every 4 MB
    // file onto the slower path.
    const { bs, shapes } = recordingBs();
    await fixture('edge.bin', STREAM_ABOVE_BYTES);
    await store(bs, 'edge.bin', STREAM_ABOVE_BYTES);
    expect(shapes).toEqual(['buffer']);
  });

  it('stores the SAME blobId whichever path a file takes', async () => {
    // The threshold must be a performance decision and nothing else. If the two
    // paths disagreed on the id, a file crossing the threshold — by one byte, by
    // one edit — would stop deduplicating against its own earlier copy and every
    // reference to it would miss.
    const size = STREAM_ABOVE_BYTES + 4096;
    const content = await fixture('both.bin', size);
    const { bs } = recordingBs();

    const streamed = await store(bs, 'both.bin', size);
    // Same file, described as small, so the buffer path takes it.
    const buffered = await store(bs, 'both.bin', 1);

    expect(streamed).toBe(buffered);
    const { content: back } = await bs.getBlob(streamed);
    expect(back.equals(content)).toBe(true);
  });

  it('stores an empty file', async () => {
    const { bs } = recordingBs();
    await fixture('empty.bin', 0);
    const blobId = await store(bs, 'empty.bin', 0);
    const { content } = await bs.getBlob(blobId);
    expect(content).toHaveLength(0);
  });
});
