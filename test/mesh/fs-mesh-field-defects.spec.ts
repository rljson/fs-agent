// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// The field defects from `cos-one-client/KNOWN-WEAKNESSES.md`, reduced.
//
// WHY THIS FILE EXISTS SEPARATELY
// `fs-mesh.spec.ts` holds the scenarios `PLAN-fs-edit-chain.md` named, and the
// plan was written from two incidents on one day. The One Client's register is
// the longer list — sixteen entries, several REPRODUCED more than once, with
// machine names and frequencies against them — and four of its filesystem
// entries were not covered by anything here.
//
// Each test below names its register entry, its measured frequency, and the
// reduction the register itself asked for. Where the register supplies a
// reproduction script it is followed rather than reinterpreted: these are
// observations from four machines, and the whole value of them is that somebody
// wrote down exactly what they saw.
// .............................................................................

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONFLICT_LOG_FILE } from '../../src/fs-agent.ts';
import { buildFsMesh, whyNot, type FsMesh } from './fs-mesh.ts';

describe('field defects, reduced off-lab', () => {
  let mesh: FsMesh | undefined;

  const root = (name: string) => join(process.cwd(), `test-temp-field-${name}`);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  // §1 — "Deletions do not reliably propagate", REPRODUCED AGAIN 2026-09-23.
  //
  // Four machines, build 69f9774 (fs-agent 0.0.78), the first unattended run of
  // the day: a file inside a directory that was created and then deleted
  // survived on EVERY other machine for the whole 140-second budget. The
  // deleting node was the fourth, so the deletion was applied locally and
  // reached nobody.
  //
  // The register is emphatic that this is not the same finding as the
  // file-level one it had just closed: *"that one ran `folder-delta` and
  // `projekte-shape`, which delete files IN PLACE. This deletes a DIRECTORY
  // with a file inside it. A rename or a directory removal is 'delete
  // everything and re-add' to this system, and nothing in the 20-of-20 run
  // covered that case. The old measurement is not wrong; it measured something
  // narrower than the entry claimed."*
  //
  // Nothing in this repo covered it either. Every deletion test here, mine
  // included, removes a single file in place.
  //
  // The reduction is the register's own: *"create `dir/inner/a.txt`, sync,
  // remove the directory, assert the peer's tree loses it."* It asks for two
  // nodes; this uses FOUR, and deletes on the LAST of them, because that is
  // the detail the lab log turns on — *"the deleting node was the fourth, so
  // the deletion was applied locally and reached nobody"*.
  //
  // The difference is not cosmetic and was measured: at two nodes this went
  // 8 of 8 GREEN against the broken code and red only once in a longer run, so
  // the two-node form proves nothing either way. At four, with the deletion on
  // the node the others do not pull from first, it is red every time.
  // ...........................................................................
  it('F1: removing a DIRECTORY propagates, not just removing a file', async () => {
    mesh = await buildFsMesh({
      root: root('dirdel'),
      names: ['A', 'B', 'C', 'D'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'keeper.txt'), 'keeper');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // A nested directory with a file in it, the exact shape the lab saw.
    await mesh.node('A').write('doomed-dir/inner/a.txt', 'inner');
    const withDir = ['doomed-dir/inner/a.txt', 'keeper.txt'];
    for (const name of ['A', 'B', 'C', 'D']) {
      expect(await mesh.node(name).settlesOn(withDir, 30_000)).toEqual(withDir);
    }

    // Remove the DIRECTORY, not the file — on the node that did not create it.
    await rm(join(mesh.node('D').folder, 'doomed-dir'), {
      recursive: true,
      force: true,
    });

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    for (const name of ['A', 'B', 'C', 'D']) {
      expect(result.snapshot[name], `node ${name}`).toEqual(['keeper.txt']);
    }
  }, 180_000);

  // ...........................................................................
  // §3 — "Concurrent writes do not converge", 4 of 6 runs on the lab, and
  // pinned down 2026-09-15 to something that reproduces in ELEVEN SECONDS.
  //
  // *"Both writes propagate fine, and then one file is DELETED from the node
  // that wrote it. Two clients write DIFFERENT files against the same parent
  // state at the same instant. Each push therefore describes a folder the
  // other's file is not in, and whichever lands second prunes it."*
  //
  // Severity, in the register's words: *"Silent data loss in an ordinary
  // office: two people save different files at the same moment on different
  // machines, one file disappears, and the node that lost it is the one that
  // created it."*
  //
  // And why nothing caught it: *"The fs-agent's own 'concurrent writes' test is
  // deliberately SEQUENTIAL; its comment reads 'Sequential to avoid sync
  // contention with 3 clients'. Simultaneity, which is the entire risk, was
  // never exercised."* Still true of this repo until now — and it is the
  // `simultaneous-adds-both-survive` recipe the plan listed and never wrote.
  //
  // No partition here, deliberately. This is the ordinary case.
  // ...........................................................................
  it('F2: two nodes writing DIFFERENT files at the same instant keep both', async () => {
    mesh = await buildFsMesh({
      root: root('simadd'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // The same instant, which is the entire risk.
    await Promise.all([
      mesh.node('A').write('sim-a.txt', 'from-A'),
      mesh.node('B').write('sim-b.txt', 'from-B'),
    ]);

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    const expected = ['seed.txt', 'sim-a.txt', 'sim-b.txt'];
    // The register's assertion order matters: the one that fails is the writer
    // losing its OWN file, which is the third line of its script.
    expect(result.snapshot['B']).toEqual(expected);
    expect(result.snapshot['A']).toEqual(expected);
  }, 120_000);

  // ...........................................................................
  // §3 again, at three nodes — the "stable 2/2 split" form.
  //
  // *"The second form is a stable 2/2 split that persists past the budget"* —
  // `holding NB-2505=3652 NB-21624=3650 NB-2510=3652 NB-2744=3650`. Two
  // sub-networks that never merged, or one DAG branch conflict resolution left
  // unresolved. With three writers the split cannot be even, which is a
  // sharper assertion than four.
  // ...........................................................................
  it('F3: three nodes writing at once do not split into camps', async () => {
    mesh = await buildFsMesh({
      root: root('split'),
      names: ['A', 'B', 'C'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await Promise.all([
      mesh.node('A').write('three-a.txt', 'a'),
      mesh.node('B').write('three-b.txt', 'b'),
      mesh.node('C').write('three-c.txt', 'c'),
    ]);

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    const expected = ['seed.txt', 'three-a.txt', 'three-b.txt', 'three-c.txt'];
    for (const node of ['A', 'B', 'C']) {
      expect(result.snapshot[node], `node ${node}`).toEqual(expected);
    }
  }, 120_000);

  // ...........................................................................
  // §16 — "The mass-delete guard can deadlock a branch, and it does not heal",
  // EVERY TIME the sandbox held a large leftover set.
  //
  // Four nodes, four different trees, each refusing the others' as a mass
  // delete — and the refusal is SYMMETRIC, so nothing propagates while it
  // lasts and every recipe fails for a reason unrelated to what it tests. It
  // did not resolve on its own; it was cleared by hand.
  //
  // *"Why this matters beyond the lab. The provoking condition was leftover
  // fixture files, but nothing about the deadlock is specific to a test: two
  // branches that diverge far enough, with one side sparse, is the same shape.
  // A customer branch in this state would sync nothing and report no error
  // anybody is looking at."*
  //
  // The register's own reduction: *"two nodes, one with a large tree and one
  // with a small one, both refusing."* Additive reconciliation should make the
  // shape impossible rather than survivable — a sparse node has no TOMBSTONES
  // for what it lacks, so the full node is never asked to drop anything, and
  // the sparse one fetches. That is a claim worth a test, because the failure
  // mode is silence.
  // ...........................................................................
  it('F4: a sparse branch and a full one converge, without a standoff', async () => {
    mesh = await buildFsMesh({
      root: root('standoff'),
      names: ['FULL', 'SPARSE'],
      seed: async (folders) => {
        // Far enough apart that the old guard refused in both directions:
        // 150 files against 2, well over MASS_DELETE_MIN_FILES and the 0.3
        // ratio.
        for (let i = 0; i < 150; i++) {
          await writeFile(join(folders['FULL'], `bulk-${i}.txt`), String(i));
        }
        await mkdir(folders['SPARSE'], { recursive: true });
        await writeFile(join(folders['SPARSE'], 'lonely.txt'), 'lonely');
      },
    });

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, 'the two branches never agreed').toBe(true);

    // Converged UPWARD: nothing was refused and nothing was destroyed. The
    // union is the only answer additive reconciliation can give.
    expect(result.snapshot['FULL'].length).toBe(151);
    expect(result.snapshot['SPARSE'].length).toBe(151);
    expect(result.snapshot['FULL']).toContain('lonely.txt');
    expect(result.snapshot['SPARSE']).toContain('bulk-0.txt');
  }, 180_000);
  // ...........................................................................
  // §4 — "Conflict resolution can leave three versions of one file", 2 of 6
  // runs, observed with the lab's clocks synced to 0 s spread:
  //
  //   nodes diverged on conflict/shared.txt after 60s: 3 distinct versions
  //     [NB-2505=263d5dab…, NB-21624=4ca963ab…, NB-2510=263d5dab…,
  //      NB-2744=bd4d35fe…]
  //
  // Four nodes, THREE hashes, stable. The register is careful about what that
  // does and does not implicate: *"the resolver never runs; it runs on every
  // node but with different inputs; or it runs with the same inputs and picks
  // differently. Only the third is a resolver bug — the first two are delivery
  // bugs."* This test cannot tell those apart, and does not try. It asserts
  // the only thing a user cares about: ONE version in the end.
  //
  // Three hashes at four nodes is the sharp detail. Two would be a race still
  // in flight; three means at least one node resolved differently from the
  // others, or never resolved at all — so `converged()` is not enough here and
  // the contents are compared directly.
  // ...........................................................................
  it('F5: four nodes editing ONE file at once end on one version', async () => {
    const names = ['A', 'B', 'C', 'D'];
    mesh = await buildFsMesh({
      root: root('threeversions'),
      names,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await mkdir(join(folder, 'conflict'), { recursive: true });
          await writeFile(join(folder, 'conflict/shared.txt'), 'base');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // The lab's shape exactly: every node edits the same path at once, each
    // with content only it has.
    await Promise.all(
      names.map((name) =>
        mesh!.node(name).write('conflict/shared.txt', `from-${name}`),
      ),
    );

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);

    // Stable file LISTS are not agreement — the lab's four nodes all listed
    // the same one file and held three different versions of it.
    const contents = await Promise.all(
      names.map((name) => mesh!.node(name).read('conflict/shared.txt')),
    );
    const distinct = [...new Set(contents)];
    expect(
      distinct.length,
      `versions held: ${JSON.stringify(
        Object.fromEntries(names.map((n, i) => [n, contents[i]])),
      )}`,
    ).toBe(1);
    // And the surviving version is one somebody actually wrote, not a merge
    // artefact or the base nobody kept.
    expect(names.map((n) => `from-${n}`)).toContain(distinct[0]);
  }, 180_000);

  // ...........................................................................
  // §5 — "A file written during a scan can be lost", 2 of 6 runs.
  //
  //   file "churn-survivor.txt" not found on NB-2744
  //     [NB-21624=ok, NB-2505=ok, NB-2510=ok, NB-2744=missing]
  //
  // *"The recipe's other assertions pass — the watcher survives the churn, a
  // later write reaches every peer, no churned file is left behind. Only the
  // file written DURING the churn goes missing, on one node."*
  //
  // The register asks for exactly this test, in this repo: *"This is most
  // likely a scanner-level race — a file created after the scan snapshot but
  // before the announce is in neither the tree nor a subsequent change event,
  // because the scan's own writes coalesce the watcher's debounce. That is
  // testable in @rljson/fs-agent's unit suite without four machines."*
  //
  // So the survivor is written INTO the churn rather than after it, and the
  // churn is wide enough that a scan of it cannot complete between two events.
  // ...........................................................................
  it('F6: a file written in the middle of heavy churn reaches every node', async () => {
    const names = ['A', 'B', 'C'];
    mesh = await buildFsMesh({
      root: root('churn'),
      names,
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    const a = mesh.node('A');
    const CHURN = 60;

    // Churn and survivor interleaved, not sequenced: the survivor lands while
    // scans are in flight, which is the whole point. Writing it first or last
    // tests nothing — the recipe's own "a later write reaches every peer"
    // assertion already passed on the lab.
    const churning = (async () => {
      for (let i = 0; i < CHURN; i++) {
        await a.write(`churn-${i}.tmp`, `tmp-${i}`);
        if (i === CHURN / 2) await a.write('churn-survivor.txt', 'survivor');
      }
      for (let i = 0; i < CHURN; i++) {
        await a.del(`churn-${i}.tmp`);
      }
    })();
    await churning;

    const result = await mesh.converged({
      timeoutMs: 120_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);

    // The register's own three assertions, in its order.
    for (const name of names) {
      const node = mesh.node(name);
      expect(
        await node.read('churn-survivor.txt'),
        `the survivor is missing on ${name}`,
      ).toBe('survivor');
      // No churned file left behind.
      const left = (await node.files()).filter((f) => f.endsWith('.tmp'));
      expect(left, `churn residue on ${name}`).toEqual([]);
    }

    // The watcher survived the churn: a write AFTER it still propagates.
    await a.write('after-churn.txt', 'after');
    const expected = ['after-churn.txt', 'churn-survivor.txt', 'seed.txt'];
    for (const name of names) {
      expect(await mesh.node(name).settlesOn(expected, 30_000)).toEqual(
        expected,
      );
    }
  }, 240_000);

  // ...........................................................................
  // §7 — "A burst of deletions does not complete", 1 of 6 runs, and the run
  // that failed never finished at all: `burst-delete 600s: timed out after
  // 600000ms`. It had passed in 106 s before that.
  //
  // *"100 deletions issued back to back from one node, a quarter of a 400-file
  // folder — deliberately under the mass-delete guard's threshold, so a red is
  // about ordering rather than the guard refusing a catastrophe."*
  //
  // The sizes here are the recipe's, not reduced: 100 of 400 is 25%, under
  // `MASS_DELETE_MAX_RATIO`, and the point of the test evaporates if the guard
  // is what stops it. The register also asks for the sending-side count —
  // *"if 100 unlinks produce fewer than 100 removals across the announced
  // trees, the loss is on the sending side"* — which is what the deleting
  // node's own folder answers first.
  // ...........................................................................
  it('F7: a burst of 100 deletions out of 400 files completes everywhere', async () => {
    const TOTAL = 400;
    const BURST = 100;
    mesh = await buildFsMesh({
      root: root('burstdel'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await mkdir(folder, { recursive: true });
          for (let i = 0; i < TOTAL; i++) {
            await writeFile(join(folder, `f-${i}.txt`), String(i));
          }
        }
      },
    });
    const seeded = await mesh.converged({ timeoutMs: 120_000 });
    expect(seeded.converged, 'the 400-file seed never settled').toBe(true);

    // Back to back, no awaiting the sync between them.
    const a = mesh.node('A');
    for (let i = 0; i < BURST; i++) {
      await a.del(`f-${i}.txt`);
    }

    // The sending side first: the deleting node must actually be down 100.
    expect(
      (await a.files()).length,
      'the deleting node did not lose 100 files itself',
    ).toBe(TOTAL - BURST);

    const result = await mesh.converged({
      timeoutMs: 180_000,
      stableMs: 5_000,
    });
    expect(result.converged, 'the burst never settled').toBe(true);
    for (const name of ['A', 'B']) {
      expect(result.snapshot[name].length, `node ${name}`).toBe(TOTAL - BURST);
    }
  }, 300_000);

  // ...........................................................................
  // §6 — "A locked file blocks propagation to peers", 1 of 6 runs.
  //
  //   file "held-open.dbf" not found on NB-2510
  //     [NB-2510=missing, NB-2505=ok, NB-21624=missing, NB-2744=missing]
  //
  // *"The recipe exists to prove a file held open by another process does not
  // block the rest of sync. It reached one node of four."*
  //
  // The register's first question is whether the existing pattern already
  // covers it: *"PartialRestoreError is raised after the writes and the prune,
  // so the rest of the tree should already apply — the same shape as the fix
  // for unfetchable blobs."* That is the claim under test, and the failure mode
  // is silence, so it is worth asserting rather than assuming.
  //
  // A Windows mandatory lock has no equivalent here, so the unwritable half is
  // reproduced the portable way: a read-only DIRECTORY, which no write can
  // create a file in. The agent's own behaviour is what is being measured —
  // whether one path it cannot write stops the paths it can.
  // ...........................................................................
  it('F8: one unwritable path does not block the rest of the tree', async () => {
    mesh = await buildFsMesh({
      root: root('locked'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    const locked = join(mesh.node('B').folder, 'held');
    await mkdir(locked, { recursive: true });
    try {
      // r-xr-xr-x: B cannot create anything inside, not even as the owner.
      await chmod(locked, 0o555);

      // A writes into that directory AND outside it, in one go. The question
      // is whether the second survives the first.
      await mesh.node('A').write('held/held-open.dbf', 'dbf');
      await mesh.node('A').write('free.txt', 'free');

      // The rest of the tree must arrive regardless. Polled, so a slow
      // restore is not mistaken for a blocked one.
      const reachable = ['free.txt', 'seed.txt'];
      expect(
        await mesh.node('B').settlesOn(reachable, 30_000),
        'one unwritable path stopped a writable one',
      ).toEqual(reachable);
      expect(await mesh.node('B').read('free.txt')).toBe('free');

      // And the node that CAN hold it keeps it — the lock must not propagate
      // backwards as a deletion.
      expect(
        await mesh.node('A').read('held/held-open.dbf'),
        'the writer lost the file the peer could not store',
      ).toBe('dbf');
    } finally {
      await chmod(locked, 0o755);
    }

    // Once the obstruction lifts, the file it blocked arrives. A node that
    // gave up on a path for good would be the same defect one restore later.
    const healed = ['free.txt', 'held/held-open.dbf', 'seed.txt'];
    expect(await mesh.node('B').settlesOn(healed, 60_000)).toEqual(healed);
  }, 180_000);
  // ...........................................................................
  // §13 — "A multi-megabyte file reaches nobody", observed 2026-09-15 and
  // never investigated:
  //
  //   FAIL large-file-roundtrip  123389ms
  //        "big-blob.bin" never reached NB-2510, NB-2505, NB-21624, NB-2744
  //        after 120 attempts
  //
  // Not one of the four nodes, after two minutes of polling. *"The contrast
  // that makes this interesting: `large-file-near-cap` PASSED in the same run,
  // in 17.9 s. So a file close to the transport limit crossed fine while this
  // one reached nobody at all"* — the recipe's 8 MB was always INSIDE the
  // 50 MB cap, so size alone never explained it.
  //
  // And §2, "an oversized file leaves residue that is never cleaned up", which
  // the register records as having failed in ALL SIX suite runs on 2026-09-02:
  // `only NB-2744=3 of 2 after 240 attempts` — one node keeps the file after
  // deletion, so the folder never returns to its expected state.
  //
  // Both carry the same instruction — *"RE-MEASURE BEFORE INVESTIGATING"*,
  // because the whole blob path changed in 0.4.1: fetch is ranged, restore
  // streams to disk, `setBlob` hashes while writing. A removed cause is not a
  // measured pass, so this measures it, and the two halves belong in one test
  // because the second only means anything if the first worked.
  //
  // 8 MB is the recipe's own size, kept rather than reduced.
  // ...........................................................................
  it('F9: a multi-megabyte file crosses, and deleting it leaves no residue', async () => {
    const MB = 8;
    mesh = await buildFsMesh({
      root: root('bigblob'),
      names: ['A', 'B', 'C'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // Incompressible, so nothing in the path can make this cheap by accident.
    const big = Buffer.alloc(MB * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) & 0xff;
    await writeFile(join(mesh.node('A').folder, 'big-blob.bin'), big);

    const withBig = ['big-blob.bin', 'seed.txt'];
    for (const name of ['A', 'B', 'C']) {
      expect(
        await mesh.node(name).settlesOn(withBig, 120_000),
        `big-blob.bin never reached ${name}`,
      ).toEqual(withBig);
    }
    // The BYTES, not just the name — a truncated or empty file would satisfy
    // a file listing and is exactly what a broken ranged fetch produces.
    for (const name of ['B', 'C']) {
      const landed = await stat(join(mesh.node(name).folder, 'big-blob.bin'));
      expect(landed.size, `${name} holds the wrong number of bytes`).toBe(
        big.length,
      );
    }

    // §2: now delete it, and every node must come back to its expected state.
    await mesh.node('A').del('big-blob.bin');
    const result = await mesh.converged({
      timeoutMs: 120_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    for (const name of ['A', 'B', 'C']) {
      expect(result.snapshot[name], `residue on ${name}`).toEqual(['seed.txt']);
    }
  }, 300_000);
  // ...........................................................................
  // F10 — the same-file conflict, end to end, which NOTHING covered.
  //
  // `fs-conflict-resolver.spec.ts` has 26 tests on the merge: the winner
  // order, the copy naming, every row of the merge table, a fork collapsing.
  // All of them use in-memory fakes. Not one of them proved that two real
  // machines editing one real file end up with BOTH versions on real disk —
  // and that is the claim the whole design rests on, because the alternative
  // is one person's work being silently thrown away.
  //
  // Running it is how two defects were found that every unit test had agreed
  // with. The copy came out named
  //
  //   shared (conflicted copy db.insertTrees 1970-01-01 000000).txt
  //
  // `db.insertTrees` being the DB's name for its own operation rather than a
  // machine, and the epoch being `clientTimestamp` never set. Those are the
  // two PRIMARY keys the winner is chosen by, so with both dead the decision
  // fell through to whichever content hash sorted higher — converging, but
  // unrelated to who edited last. The unit tests passed throughout; one of
  // them even had the resulting double space baked into a string literal.
  //
  // So this asserts all four things that have to hold at once: both versions
  // survive, every node agrees which is which, the name is true, and somebody
  // was TOLD.
  // ...........................................................................
  it('F10: two nodes editing one file keep both versions, and say so', async () => {
    mesh = await buildFsMesh({
      root: root('samefile'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'shared.txt'), 'base');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await Promise.all([
      mesh.node('A').write('shared.txt', 'FROM-A'),
      mesh.node('B').write('shared.txt', 'FROM-B'),
    ]);

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);

    // WHETHER there is a conflict at all is not something this test may
    // assume, and assuming it made the test flaky — 1 run in 8.
    //
    // Two writes issued at the same instant do not always FORK: one can land
    // and propagate before the other is even scanned, and then the second is
    // an ordinary sequential overwrite of a state its author had already
    // seen. Nothing is lost in that case because nothing was concurrent, and
    // there is correctly no conflict copy. Demanding one asserts a race.
    //
    // So the branch is on what actually happened, and both branches carry a
    // real obligation.
    const files = result.snapshot['A'];
    expect(result.snapshot['B'], 'the two folders disagree').toEqual(files);
    const reported = mesh.conflicts.filter((c) => c.path === 'shared.txt');

    if (reported.length === 0) {
      // No fork: one version won sequentially. It must still be a version
      // somebody wrote, and the folders must hold nothing else.
      expect(files).toEqual(['shared.txt']);
      const live = await mesh.node('A').read('shared.txt');
      expect(['FROM-A', 'FROM-B']).toContain(live);
      expect(await mesh.node('B').read('shared.txt')).toBe(live);
      return;
    }

    // 1. A fork happened, so both nodes hold the live file and the copy.
    expect(files.length, whyNot(result)).toBe(2);
    const copyName = files.find((f) => f !== 'shared.txt');
    expect(copyName, 'a conflict was reported but no copy was made')
      .toBeDefined();

    // 2. Both VERSIONS survive — the whole point. Read as a set, because
    //    which one keeps the original path is the resolver's business.
    const held = new Set<string | undefined>();
    for (const name of ['A', 'B']) {
      held.add(await mesh.node(name).read('shared.txt'));
      held.add(await mesh.node(name).read(copyName!));
    }
    expect(held, `versions on disk: ${[...held].join(', ')}`).toEqual(
      new Set(['FROM-A', 'FROM-B']),
    );

    // 3. And both nodes agree which is live, or the folders have not really
    //    converged whatever their file lists say.
    expect(await mesh.node('A').read('shared.txt')).toBe(
      await mesh.node('B').read('shared.txt'),
    );

    // 4. The name is true: no DB operation masquerading as a machine, no
    //    1970, and no double space where an identity would have gone.
    expect(copyName).not.toContain('db.insertTrees');
    expect(copyName).not.toContain('1970');
    expect(copyName).not.toContain('copy  ');
    // An IDENTITY where there is one, and the losing CONTENT where there is
    // not — never a bare second-granularity timestamp. Two nodes losing
    // different content in the same second used to derive the same name, so
    // the copies conflicted with each other and a copy of a copy appeared.
    expect(copyName).toMatch(
      /^shared \(conflicted copy (.+ )?\d{4}-\d{2}-\d{2} \d{6}( \S+)?\)\.txt$/,
    );
    expect(
      copyName,
      'the name carries nothing but a timestamp, so two losers can collide',
    ).not.toMatch(/^shared \(conflicted copy \d{4}-\d{2}-\d{2} \d{6}\)\.txt$/);

    // 5. Somebody was told — in both channels, because they serve different
    //    readers: the callback a UI that is running, the file one that starts
    //    later.
    expect(reported[0].copyPath).toBe(copyName);
    expect(reported[0].winnerRef).not.toBe(reported[0].loserRef);
    expect(reported[0].resolvedAt).toBeGreaterThan(0);

    const logged: unknown = JSON.parse(
      await readFile(join(mesh.node('A').folder, CONFLICT_LOG_FILE), 'utf-8'),
    );
    expect(Array.isArray(logged)).toBe(true);
    expect(
      (logged as { path: string }[]).some((e) => e.path === 'shared.txt'),
      'nothing was written where a UI could find it after a restart',
    ).toBe(true);
  }, 180_000);
});
