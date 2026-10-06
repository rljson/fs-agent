// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A transport that carries no ancestry must say so, once, loudly.
//
// WHY IT MATTERS HAS CHANGED, and the tests have not — which is the point of
// asserting on the WARNING and not on its wording.
//
// It used to be about data loss. Without `causalOrdering` a tree that merely
// PREDATES this node's newest write could not be told from one DELETING it,
// the prune rule needed an escape hatch for that case, and the hatch was where
// `the weakness register` §3 lived: *"two people save different files at the same
// moment on different machines, one file disappears, and the node that lost it
// is the one that created it"* — reproduced in eleven seconds. Three local
// prune rules were built and withdrawn proving it could not be closed from
// inside the agent.
//
// **There is no prune rule any more.** An absence is never a deletion; a
// removal arrives stated in the chain, written down by the node that performed
// it. So the question those three rules tried to answer is not asked, and §3's
// scenario is asserted green at mesh tier as F2 — *two nodes writing DIFFERENT
// files at the same instant keep both*.
//
// `causalOrdering` is still a REQUIREMENT, for what it carries rather than for
// what its absence destroys: the predecessor refs are what let the merge gate
// fire, so a transport without it reconciles no conflicting edit to one file.
// A configuration that quietly gives that up must not be reachable quietly.
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
