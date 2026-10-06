// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// The register's own reproduction scripts, run verbatim.
//
// `cos-one-client/the weakness register` supplies two of these as code, with
// timings and the line that fails. They are followed exactly rather than
// reinterpreted: the whole value of a field observation is that somebody wrote
// down what they saw, and an approximation of it is a different test.
//
// It matters that these use the BARE two-client setup — no `resolveConflicts`,
// no state beacon, no anti-entropy tuning. A mesh wired like production has an
// inline three-way merge that can mask the defect, so a scenario that passes
// there says nothing about a scenario that failed here.
// .............................................................................

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { createTreesTableCfg, Route } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';

const TREE = 'sharedTree';

describe('the weakness register reproductions, verbatim', () => {
  const base = join(process.cwd(), 'test-temp-field-repro');
  let teardown: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });

  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * The register's `createMultiClientSetup` + `startAllSync`, inlined.
   * @param folders - One folder per client.
   * @returns The started agents, in the order the folders were given.
   */
  const bareSetup = async (
    folders: string[],
    production = false,
  ): Promise<FsAgent[]> => {
    const route = Route.fromFlat(`/${TREE}`);
    const treeCfg = createTreesTableCfg(TREE);
    const serverIo = new IoMem();
    await serverIo.init();
    await new Db(serverIo).core.createTableWithInsertHistory(treeCfg);
    const server = new Server(route, serverIo, new BsMem());
    await server.init();

    const clients: Client[] = [];
    const stops: Array<() => void> = [];
    const agents: FsAgent[] = [];

    for (const folder of folders) {
      await mkdir(folder, { recursive: true });
      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      await server.addSocket(serverSocket);

      const localIo = new IoMem();
      await localIo.init();
      await localIo.isReady();
      await new Db(localIo).core.createTableWithInsertHistory(treeCfg);
      const client = new Client(clientSocket, localIo, new BsMem());
      await client.init();
      clients.push(client);

      const db = new Db(client.io!);
      const connector = new Connector(
        db,
        route,
        clientSocket,
        production
          ? { causalOrdering: true, includeClientIdentity: true }
          : undefined,
      );
      const agent = new FsAgent(folder, client.bs, {
      ...ORIGIN_FIXTURE,
        resolveConflicts: production,
      });
      agents.push(agent);

      stops.push(await agent.syncToDb(db, connector, TREE));
      stops.push(
        await agent.syncFromDb(db, connector, TREE, { cleanTarget: true }),
      );
    }

    await new Promise((r) => setTimeout(r, 500));
    teardown = async () => {
      for (const stop of stops) stop();
      for (const agent of agents) agent.scanner.stopWatch();
      for (const client of clients) await client.tearDown();
      await server.tearDown();
    };
    return agents;
  };

  /**
   * The register's `waitForFile`.
   * @param filePath - What to wait for.
   * @param expected - The content it must hold.
   * @param timeout - How long to allow.
   * @returns What it held when it gave up.
   */
  const waitForFile = async (
    filePath: string,
    expected: string,
    timeout = 10_000,
  ): Promise<string> => {
    const deadline = Date.now() + timeout;
    let seen = '<missing>';
    while (Date.now() < deadline) {
      try {
        seen = await readFile(filePath, 'utf8');
      } catch {
        seen = '<missing>';
      }
      if (seen === expected) return seen;
      await new Promise((r) => setTimeout(r, 100));
    }
    return seen;
  };

  // ...........................................................................
  // §3, pinned down 2026-09-15, *"reproduces in 11 seconds, off a real fleet"*.
  //
  //   "Both writes propagate fine, and then one file is DELETED from the node
  //    that wrote it. Two clients write DIFFERENT files against the same parent
  //    state at the same instant. Each push therefore describes a folder the
  //    other's file is not in, and whichever lands second prunes it."
  //
  // WHAT THIS CONFIGURATION CAN AND CANNOT GUARANTEE, because the difference
  // was measured rather than assumed.
  //
  // The register's script builds the `Connector` with no `SyncConfig`, so NO
  // ancestry reaches the wire — `declaresAncestry=false` in the agent's own
  // apply log. The prune rule has a deliberate escape hatch for that case,
  // because judging silence as "the sender has not seen my state" refused
  // every deletion across twenty tests when it was last tried.
  //
  // That hatch cannot be closed by a local rule, and three were built and
  // withdrawn proving it. The distinction §3 needs is between a tree that
  // PREDATES this node's write and one that POSTDATES somebody deleting it,
  // and no fact available on one machine separates those: the only purely
  // local predicate that protects the writer — "no sender has ever listed this
  // path" — also protects it from every legitimate deletion, because the
  // AUTHOR of a file never receives its own path back. Measured: it took §3
  // from 8-of-8 red to 8-of-8 green and simultaneously broke §1, the register's
  // most-reproduced entry, at four nodes. Separating them is what ancestry IS,
  // and `causalOrdering` is what puts it on the wire.
  //
  // So this test asserts the invariant that holds with no ancestry at all —
  // the file is never lost from the NETWORK, only from its author — and the
  // per-node guarantee is asserted below, in the configuration the product
  // actually ships. Which is the one that matters: a One Client sets
  // `causalOrdering` on, and this bare shape is reachable only by turning it
  // off.
  // ...........................................................................
  it('§3 with no ancestry on the wire: both files survive in the network', async () => {
    const folderA = join(base, 'a');
    const folderB = join(base, 'b');
    await bareSetup([folderA, folderB]);

    await Promise.all([
      writeFile(join(folderA, 'sim-a.txt'), 'from-A'),
      writeFile(join(folderB, 'sim-b.txt'), 'from-B'),
    ]);

    // The register records these two as passing, and they do.
    expect(await waitForFile(join(folderB, 'sim-a.txt'), 'from-A')).toBe(
      'from-A',
    );
    expect(await waitForFile(join(folderA, 'sim-b.txt'), 'from-B')).toBe(
      'from-B',
    );

    // Then it records A losing the file A created — and without ancestry it
    // may. What must NOT happen is both copies going: a file that is gone from
    // every node is gone from a deployment, and that is a different severity
    // from a file that moved off its author.
    //
    // Settled, not sampled: the whole point is that the prune lands late, so a
    // reading taken before it has nothing to say.
    await new Promise((r) => setTimeout(r, 8_000));
    for (const [name, content] of [
      ['sim-a.txt', 'from-A'],
      ['sim-b.txt', 'from-B'],
    ]) {
      const held = await Promise.all(
        [folderA, folderB].map(async (folder) => {
          try {
            return await readFile(join(folder, name), 'utf8');
          } catch {
            return undefined;
          }
        }),
      );
      expect(
        held.filter((c) => c === content).length,
        `${name} is held by no node at all`,
      ).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);

  // ...........................................................................
  // §1, REPRODUCED AGAIN 2026-09-23 on four machines.
  //
  //   "create `dir/inner/a.txt`, sync, remove the directory, assert the peer's
  //    tree loses it. Two nodes, seconds."
  //
  // The register's own reduction, and its reason for insisting on it: a
  // directory removal is "delete everything and re-add" to this system, and the
  // 20-of-20 run that closed the file-level entry never covered it.
  // ...........................................................................
  it('§1: removing a directory reaches the peer', async () => {
    const folderA = join(base, 'a');
    const folderB = join(base, 'b');
    await bareSetup([folderA, folderB]);

    await writeFile(join(folderA, 'keeper.txt'), 'keeper');
    expect(await waitForFile(join(folderB, 'keeper.txt'), 'keeper')).toBe(
      'keeper',
    );

    await mkdir(join(folderA, 'doomed-dir', 'inner'), { recursive: true });
    await writeFile(join(folderA, 'doomed-dir/inner/a.txt'), 'inner');
    expect(
      await waitForFile(join(folderB, 'doomed-dir/inner/a.txt'), 'inner'),
    ).toBe('inner');

    await rm(join(folderA, 'doomed-dir'), { recursive: true, force: true });

    const gone = await waitForFile(
      join(folderB, 'doomed-dir/inner/a.txt'),
      '<missing>',
      20_000,
    );
    expect(gone, 'the peer still holds the deleted directory').toBe(
      '<missing>',
    );
  }, 60_000);

  // ...........................................................................
  // §3 again, with the configuration a One Client actually ships.
  //
  // The bare case above is the register's script, and it uses a `Connector`
  // with no `SyncConfig` — so no ancestry reaches the wire at all. The prune
  // rule has a deliberate escape hatch for that: *"a transport that carries no
  // ancestry may still delete"*, because judging silence as "has not seen my
  // state" refused every deletion across twenty tests when it was last tried.
  //
  // So the bare case cannot be fixed by reasoning about ancestry — there is
  // none. What matters is whether the configuration the product ships is fixed,
  // and that is this test: `causalOrdering` and `includeClientIdentity` on,
  // `resolveConflicts` on, exactly as `cos-one-client/src/config/
  // fs-sync-options.ts` sets them.
  // ...........................................................................
  it('§3 in the shipped configuration: neither node loses its own file', async () => {
    const folderA = join(base, 'a');
    const folderB = join(base, 'b');
    await bareSetup([folderA, folderB], true);

    await Promise.all([
      writeFile(join(folderA, 'sim-a.txt'), 'from-A'),
      writeFile(join(folderB, 'sim-b.txt'), 'from-B'),
    ]);

    expect(
      await waitForFile(join(folderA, 'sim-a.txt'), 'from-A', 20_000),
      'A lost its own file',
    ).toBe('from-A');
    expect(
      await waitForFile(join(folderB, 'sim-b.txt'), 'from-B', 20_000),
      'B lost its own file',
    ).toBe('from-B');
    // And both arrived at the other.
    expect(await waitForFile(join(folderB, 'sim-a.txt'), 'from-A')).toBe(
      'from-A',
    );
    expect(await waitForFile(join(folderA, 'sim-b.txt'), 'from-B')).toBe(
      'from-B',
    );
  }, 60_000);
});
