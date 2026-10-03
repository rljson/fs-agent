// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A transport that carries no ancestry must say so, once, loudly.
//
// Without `causalOrdering` nothing on the wire says what a sender had seen when
// it spoke, so a tree that merely PREDATES this node's newest write cannot be
// told from one DELETING it. The prune rule has a deliberate escape hatch for
// that — judging silence as "has not seen my state" refused every deletion
// across twenty tests — and the hatch is where `KNOWN-WEAKNESSES.md` §3 lives:
// *"two people save different files at the same moment on different machines,
// one file disappears, and the node that lost it is the one that created it"*,
// reproduced in eleven seconds.
//
// It cannot be closed from inside the agent. Three local prune rules were built
// and withdrawn proving it: the only predicate that protects the writer also
// protects it from every legitimate deletion, because the AUTHOR of a file
// never receives its own path back — and the one that closed §3 broke §1 at
// four nodes in the same run.
//
// So `causalOrdering` is a REQUIREMENT, and the point of these tests is that a
// configuration which silently loses data cannot be reached silently.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem, SocketMock } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';

import { existsSync, readFileSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const TREE = 'fsTree';

describe('FsAgent — a transport with no ancestry', () => {
  let dir = '';
  let nth = 0;
  const stops: Array<() => void> = [];
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-ancestry-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * Starts `syncFromDb` against a connector with the given sync config.
   * @param causalOrdering - What to put on the Connector, or `undefined` for
   *   no `SyncConfig` at all — the shape the register's own reproduction
   *   script uses.
   * @returns Nothing; the agent is registered for teardown.
   */
  const start = async (causalOrdering?: boolean): Promise<void> => {
    const io = new IoMem();
    await io.init();
    const db = new Db(io);
    await db.core.createTableWithInsertHistory(createTreesTableCfg(TREE));
    const connector = new Connector(
      db,
      Route.fromFlat(`/${TREE}`),
      new SocketMock(),
      causalOrdering === undefined
        ? undefined
        : { causalOrdering, includeClientIdentity: true },
    );
    const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
    agents.push(agent);
    stops.push(await agent.syncFromDb(db, connector, TREE));
  };

  // ...........................................................................
  it('warns when no SyncConfig is given at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start(undefined);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(said).toContain('carries no ancestry');
    expect(said).toContain('causalOrdering');
  });

  // ...........................................................................
  it('warns when causalOrdering is explicitly off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start(false);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(said).toContain('carries no ancestry');
  });

  // ...........................................................................
  it('records it where a support request can find it', async () => {
    // A console line is gone the moment the terminal scrolls. The register's
    // §3 was a field report, and a field report is written from what is on the
    // machine afterwards.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start(false);
    warn.mockRestore();

    const log = join(dir, SYNC_ERROR_FILE);
    expect(existsSync(log), 'nothing was written to the sync error log').toBe(
      true,
    );
    expect(readFileSync(log, 'utf-8')).toContain('causalOrdering is off');
  });

  // ...........................................................................
  it('says nothing in the configuration the product ships', async () => {
    // The counterpart, and the one that keeps this honest: a warning that
    // fires on a correct setup is noise, and noise is how a real warning gets
    // ignored.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start(true);

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    expect(said).not.toContain('carries no ancestry');
    expect(existsSync(join(dir, SYNC_ERROR_FILE))).toBe(false);
  });
});
