// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { createTreesTableCfg } from '@rljson/rljson';

import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';

import type { Bs } from '@rljson/bs';

/**
 * A restore fetches a blob as a STREAM now, so the bytes arrive during the write
 * rather than before it. That moves two things that used to be settled: where a
 * transfer failure surfaces, and what a large file costs.
 */
describe('FsAgent — restore streams the blob', () => {
  const testDir = join(process.cwd(), 'test-temp-fs-blob-stream');

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** A db with a trees table, ready to store into. */
  const freshDb = async (treeKey: string): Promise<Db> => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));
    return db;
  };

  it('restores a file larger than one socket message could carry', async () => {
    // The ceiling this lifts: a blob over the transport's 50 MB
    // `maxHttpBufferSize` could not be fetched at all, because the whole file
    // was one message. One 63 MB file left three of four lab nodes permanently
    // holding a file the fourth had deleted, and the largest observed document
    // was 45.9 MB against the same cap.
    //
    // The fixture is 6 MB rather than 63: what is under test is that the
    // transfer is chunked at all, and the chunk is 4 MB, so crossing it twice
    // proves the same thing as crossing it sixteen times.
    const treeKey = 'fsTree';
    const db = await freshDb(treeKey);

    const sourceDir = join(testDir, 'src');
    await mkdir(sourceDir, { recursive: true });
    const size = 6 * 1024 * 1024;
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i++) content[i] = i % 251;
    await writeFile(join(sourceDir, 'large.bin'), content);

    const bs = new BsMem();
    const rootRef = await new FsAgent(sourceDir, bs).storeInDb(db, treeKey);

    const targetDir = join(testDir, 'dst');
    await mkdir(targetDir, { recursive: true });
    await new FsAgent(targetDir, bs).loadFromDb(db, treeKey, rootRef);

    const back = await readFile(join(targetDir, 'large.bin'));
    expect(back).toHaveLength(size);
    expect(back.equals(content)).toBe(true);
  });

  it('treats a transfer that breaks off mid-file as an unfetchable blob', async () => {
    // Attribution, and it matters to a person. A locked file is a the host application document
    // somebody still has open and the answer is "retry in a minute"; an
    // unreachable peer is an infrastructure answer. Before streaming, a fetch
    // failure could only happen before the write, so the two never mixed. Now a
    // peer going away mid-file surfaces inside the write — and must still be
    // reported as the blob problem it is.
    const treeKey = 'fsTree';
    const db = await freshDb(treeKey);

    const sourceDir = join(testDir, 'src2');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'breaks.txt'), 'x'.repeat(4096));
    await writeFile(join(sourceDir, 'survives.txt'), 'intact');

    const bs = new BsMem();
    const rootRef = await new FsAgent(sourceDir, bs).storeInDb(db, treeKey);

    // Serves one chunk, then fails — the shape of a peer that disconnects
    // part-way through, rather than one that was never reachable.
    const flaky = Object.create(bs) as Bs;
    flaky.getBlobStream = async (id: string) => {
      const { content } = await bs.getBlob(id);
      if (content.length < 4096) return bs.getBlobStream(id);
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(content.subarray(0, 512)));
            return;
          }
          controller.error(new Error('peer went away mid-transfer'));
        },
      });
    };

    const targetDir = join(testDir, 'dst2');
    await mkdir(targetDir, { recursive: true });
    const target = new FsAgent(targetDir, flaky);

    await expect(target.loadFromDb(db, treeKey, rootRef)).rejects.toThrow(
      /could not fetch 1 blob: breaks\.txt/,
    );

    // The rest of the tree landed, which is the rule a broken transfer must not
    // break: one file's bytes are worth exactly one missing file.
    expect(await readFile(join(targetDir, 'survives.txt'), 'utf8')).toBe(
      'intact',
    );
    // And no half-written file was left where a complete one belongs.
    const partial = join(targetDir, 'breaks.txt');
    if (existsSync(partial)) {
      expect((await readFile(partial)).length).not.toBe(4096);
    }
  });

  it('names every unfetchable blob, and counts them in the plural', async () => {
    // The message goes into a field report, and "could not fetch 1 blob" when
    // two are missing sends whoever reads it looking for one cause. Both files
    // have to be listed, and the noun has to agree.
    const treeKey = 'fsTree';
    const db = await freshDb(treeKey);

    const sourceDir = join(testDir, 'src3');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'gone-a.txt'), 'a');
    await writeFile(join(sourceDir, 'gone-b.txt'), 'b');
    await writeFile(join(sourceDir, 'here.txt'), 'here');

    const bs = new BsMem();
    const rootRef = await new FsAgent(sourceDir, bs).storeInDb(db, treeKey);

    const holed = Object.create(bs) as Bs;
    holed.getBlobStream = async (id: string) => {
      const { content } = await bs.getBlob(id);
      if (content.length === 1) throw new Error('no peer holds this blob');
      return bs.getBlobStream(id);
    };

    const targetDir = join(testDir, 'dst3');
    await mkdir(targetDir, { recursive: true });
    await expect(
      new FsAgent(targetDir, holed).loadFromDb(db, treeKey, rootRef),
    ).rejects.toThrow(/could not fetch 2 blobs: gone-a\.txt, gone-b\.txt/);

    expect(await readFile(join(targetDir, 'here.txt'), 'utf8')).toBe('here');
  });
});
