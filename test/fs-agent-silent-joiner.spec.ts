// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { FsAgent } from '../src/fs-agent.ts';

// A machine joining an idle network made EMPTINESS the current state.
//
// The network takes the newest claim as the truth, so an agent that announced
// its empty folder became that truth, and the bootstrap then handed emptiness
// back to everyone. The mass-delete guard stops that costing data, but it
// cannot make the joiner's folder fill: with its own empty tree as the latest
// ref there is nothing for the bootstrap to deliver.
//
// Measured on a real customer folder: 0 of 3642 files after 60 s, twice.
describe('FsAgent — an agent with nothing to say does not speak', () => {
  const dir = join(process.cwd(), 'test-temp-silent-joiner');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg('fsTree'));
    const socket = new SocketMock();
    const connector = new Connector(db, Route.fromFlat('/fsTree+'), socket);
    const sent: string[] = [];
    const realSend = connector.send.bind(connector);
    connector.send = (ref: string) => {
      sent.push(ref);
      return realSend(ref);
    };
    return { db, connector, sent };
  };

  const agentFor = (bs: BsMem) =>
    new FsAgent(dir, bs, {
      timeouts: { debounceMs: 1, processRefRetries: 0, recoveryRetries: 0 },
    });

  it('says nothing when the folder is empty and nothing is remembered', async () => {
    const { db, connector, sent } = await setup();
    const agent = agentFor(new BsMem());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));

    expect(sent).toEqual([]);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('joining quietly')),
    ).toBe(true);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

  // The folder the USER emptied is a different thing entirely: this agent was
  // tracking it, so its emptiness is a fact about a folder rather than a claim
  // about a treeKey, and it still has to go out.
  it('still announces an emptying it was tracking', async () => {
    const { db, connector, sent } = await setup();
    const bs = new BsMem();
    await writeFile(join(dir, 'a.txt'), 'a');

    const agent = agentFor(bs);
    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.length).toBe(1);

    sent.length = 0;
    await rm(join(dir, 'a.txt'));
    await new Promise((r) => setTimeout(r, 400));

    expect(sent.length).toBeGreaterThan(0);

    stop();
    agent.scanner.stopWatch();
  });

  it('speaks as soon as it has something of its own', async () => {
    const { db, connector, sent } = await setup();
    const agent = agentFor(new BsMem());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toEqual([]);

    await writeFile(join(dir, 'mine.txt'), 'mine');
    await new Promise((r) => setTimeout(r, 400));

    expect(sent.length).toBeGreaterThan(0);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

  // Deliberately conservative. A user who creates a folder and puts a directory
  // in it has made a statement about what should be there, and the silence is
  // only right for an agent that has established nothing at all. The other way
  // round, a folder holding only directories would never advertise until
  // something else happened to change.
  it('speaks for a folder holding only a directory', async () => {
    const { db, connector, sent } = await setup();
    await mkdir(join(dir, 'empty-dir'), { recursive: true });

    const agent = agentFor(new BsMem());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const stop = await agent.syncToDb(db, connector, 'fsTree');
    await new Promise((r) => setTimeout(r, 200));

    expect(sent.length).toBe(1);
    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('joining quietly')),
    ).toBe(false);

    stop();
    agent.scanner.stopWatch();
    warnSpy.mockRestore();
  });

});
