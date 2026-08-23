// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

// CARAT holds .dbf and .PRJZ open for as long as a user has the document. One
// of those aborted the entire restore, so a single open document stopped every
// OTHER file in the tree from arriving — one user's lock became everyone's
// stalled sync.
//
// The write path is mocked because a genuinely locked file is a Windows
// behaviour and CI runs on Linux, where an exclusive lock of that kind cannot
// be staged. `vi.mock` is hoisted per file, so this lives apart from the other
// agent specs, which must keep writing to real disk.
const lockedPaths = new Set<string>();
let writeErrorCode = 'EPERM';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: (path: unknown, ...rest: never[]) => {
      const target = String(path);
      if ([...lockedPaths].some((p) => target.endsWith(p))) {
        const err = new Error(`${writeErrorCode}: locked`) as NodeJS.ErrnoException;
        err.code = writeErrorCode;
        return Promise.reject(err);
      }
      return (actual.writeFile as (...a: never[]) => Promise<void>)(
        path as never,
        ...rest,
      );
    },
  };
});

const { FsAgent, PartialRestoreError } = await import('../src/fs-agent.ts');

/**
 * A Connector on a mock socket, plus a way to inject a ref as though a peer
 * had advertised it, and a record of everything this node sent out.
 */
const createProbeConnector = (db: Db, treeKey: string) => {
  const route = Route.fromFlat(`/${treeKey}+`);
  const socket = new SocketMock();
  const connector = new Connector(db, route, socket);
  const sent: string[] = [];
  const realSend = connector.send.bind(connector);
  connector.send = (ref: string) => {
    sent.push(ref);
    return realSend(ref);
  };
  return Object.assign(connector, {
    sent,
    simulateIncoming: (ref: string) =>
      socket.emit(connector.events.ref, { o: 'remote-test-origin', r: ref }),
  });
};

describe('FsAgent — a file held open by another process', () => {
  const sourceDir = join(process.cwd(), 'test-temp-locked-source');
  const targetDir = join(process.cwd(), 'test-temp-locked-target');

  beforeEach(async () => {
    lockedPaths.clear();
    writeErrorCode = 'EPERM';
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
      await mkdir(d, { recursive: true });
    }
  });

  afterEach(async () => {
    lockedPaths.clear();
    for (const d of [sourceDir, targetDir]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  /** Seeds the source folder and returns its tree. */
  const seed = async (bs: BsMem, files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(sourceDir, name), content);
    }
    return new FsAgent(sourceDir, bs).extract();
  };

  it('still delivers every other file in the same restore', async () => {
    const bs = new BsMem();
    const tree = await seed(bs, {
      'open.dbf': 'locked content',
      'a.txt': 'alpha',
      'b.txt': 'beta',
    });
    lockedPaths.add('open.dbf');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      new FsAgent(targetDir, bs).restore(tree, targetDir),
    ).rejects.toBeInstanceOf(PartialRestoreError);

    // The whole point: one locked document must not hold up the rest.
    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('alpha');
    expect(await readFile(join(targetDir, 'b.txt'), 'utf-8')).toBe('beta');
    warnSpy.mockRestore();
  });

  it('names the locked file, in the log and on the error', async () => {
    const bs = new BsMem();
    const tree = await seed(bs, { 'open.dbf': 'x', 'a.txt': 'alpha' });
    lockedPaths.add('open.dbf');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await new FsAgent(targetDir, bs)
      .restore(tree, targetDir)
      .catch((e: unknown) => e);

    expect((err as InstanceType<typeof PartialRestoreError>).lockedPaths).toEqual([
      'open.dbf',
    ]);
    expect(
      warnSpy.mock.calls.some(
        (c) => String(c[0]).includes('open.dbf') && String(c[0]).includes('held open'),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it('reports every locked file, not just the first', async () => {
    const bs = new BsMem();
    const tree = await seed(bs, {
      'one.dbf': 'x',
      'two.PRJZ': 'y',
      'a.txt': 'alpha',
    });
    lockedPaths.add('one.dbf');
    lockedPaths.add('two.PRJZ');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await new FsAgent(targetDir, bs)
      .restore(tree, targetDir)
      .catch((e: unknown) => e);

    expect(
      (err as InstanceType<typeof PartialRestoreError>).lockedPaths.sort(),
    ).toEqual(['one.dbf', 'two.PRJZ']);
    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('alpha');
    warnSpy.mockRestore();
  });

  for (const code of ['EBUSY', 'EACCES']) {
    it(`treats ${code} as locked too`, async () => {
      const bs = new BsMem();
      writeErrorCode = code;
      const tree = await seed(bs, { 'open.dbf': 'x', 'a.txt': 'alpha' });
      lockedPaths.add('open.dbf');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        new FsAgent(targetDir, bs).restore(tree, targetDir),
      ).rejects.toBeInstanceOf(PartialRestoreError);
      expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('alpha');
      warnSpy.mockRestore();
    });
  }

  // The counterpart. Tolerance is for "busy", not for "broken" — a failing
  // disk must still stop the restore rather than be reported as a lock and
  // quietly retried forever.
  it('still aborts on a write failure that is not a lock', async () => {
    const bs = new BsMem();
    writeErrorCode = 'EIO';
    const tree = await seed(bs, { 'bad.txt': 'x', 'a.txt': 'alpha' });
    lockedPaths.add('bad.txt');

    const err = await new FsAgent(targetDir, bs)
      .restore(tree, targetDir)
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(PartialRestoreError);
    expect((err as NodeJS.ErrnoException).code).toBe('EIO');
  });

  // The consequence that makes this more than a convenience. After a partial
  // restore the folder holds the new bytes for every file EXCEPT the locked
  // one. If the node advertises that state, peers adopt a tree carrying the
  // OLD bytes for the locked file — one user with a document open silently
  // reverts it for everyone.
  it('does not advertise the half-applied state to peers', async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    const treeKey = 'fsTree';
    await db.core.createTableWithInsertHistory(createTreesTableCfg(treeKey));

    const bs = new BsMem();
    // The target starts out holding the OLD content of both files.
    await writeFile(join(targetDir, 'open.dbf'), 'old locked');
    await writeFile(join(targetDir, 'a.txt'), 'old alpha');

    const incoming = await seed(bs, {
      'open.dbf': 'new locked',
      'a.txt': 'new alpha',
    });
    const { FsDbAdapter } = await import('../src/fs-db-adapter.ts');
    const ref = await new FsDbAdapter(db, treeKey).storeFsTree(incoming);

    const agent = new FsAgent(targetDir, bs, {
      timeouts: {
        debounceMs: 1,
        processRefRetries: 0,
        processRefRetryDelayMs: 1,
        recoveryRetries: 0,
      },
    });
    const connector = createProbeConnector(db, treeKey);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stopTo = await agent.syncToDb(db, connector, treeKey);
    const stopFrom = await agent.syncFromDb(db, connector, treeKey);
    connector.sent.length = 0;

    lockedPaths.add('open.dbf');
    connector.simulateIncoming(ref);
    await new Promise((r) => setTimeout(r, 600));

    // a.txt landed…
    expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('new alpha');
    // …open.dbf did not, and crucially the node stayed quiet rather than
    // telling its peers that "old locked" is the current state.
    expect(await readFile(join(targetDir, 'open.dbf'), 'utf-8')).toBe(
      'old locked',
    );
    expect(connector.sent).toEqual([]);

    stopTo();
    stopFrom();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('succeeds cleanly once the file is released', async () => {
    const bs = new BsMem();
    const tree = await seed(bs, { 'open.dbf': 'locked content', 'a.txt': 'alpha' });
    lockedPaths.add('open.dbf');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = new FsAgent(targetDir, bs);

    await expect(target.restore(tree, targetDir)).rejects.toBeInstanceOf(
      PartialRestoreError,
    );

    // The user closes the document; the next attempt completes.
    lockedPaths.clear();
    await expect(target.restore(tree, targetDir)).resolves.toBeUndefined();
    expect(await readFile(join(targetDir, 'open.dbf'), 'utf-8')).toBe(
      'locked content',
    );
    warnSpy.mockRestore();
  });
});
