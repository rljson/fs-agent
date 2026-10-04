// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A node comes back WRONG: empty, or holding last week.
//
// Taken from `nextcloud/desktop`'s `test/testallfilesdeleted.cpp`, which is the
// closest thing in any comparable product to our mass-delete guard and carries
// seven cases where this repo had one shape. The two that matter here:
//
//  - `testResetServer` — "server state completely resets to initial
//    configuration while local changes exist … bulk deletion protection
//    activates ONLY when the server resets". A peer that comes back EMPTY is
//    not reporting a deletion; it has lost its data.
//  - `testDataFingetPrint` — a whole mechanism for the case where the server was
//    RESTORED FROM BACKUP, so that "server-side deletions during restoration
//    don't remove local equivalents". They needed a protocol field for it.
//
// Both are ours too, by different names: L4 asks for automated backups, and U7
// records that *"'frühere Version wiederherstellen' ist kein lokales
// Rückgängig: Der Ordner wird überschrieben und die Änderung geht an alle
// Rechner."* A restore is a deletion plus an overwrite announced to the fleet.
//
// And they are reachable here without a hub rebuild: a node whose folder was
// wiped while it was away is the same thing from the other end, and a node
// reverted to an older copy is the backup case exactly. The question in both is
// whether the FLEET follows the wrong one back.
//
// Also from that file, the two NEGATIVE cases, which matter as much — a guard
// that fires on ordinary work is a sync that stops:
//  - `testSingleFileRenamed` — one rename must not look like a mass deletion.
//  - `testNotDeleteMetaDataChange` — a change that touches only metadata must
//    not either.
// .............................................................................

import { readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, whyNot, type FsMesh } from './fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-wiped-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Empties a folder without removing it, the way a wipe or a bad script does. */
const emptyFolder = async (folder: string): Promise<void> => {
  for (const entry of await readdir(folder)) {
    await rm(join(folder, entry), { recursive: true, force: true });
  }
};

describe('a node comes back empty, or holding an older copy', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  // ...........................................................................
  it('a node whose folder was WIPED does not empty the fleet', async () => {
    // Nextcloud's `testResetServer`. A disk replaced, a folder deleted by a
    // cleanup script, a profile reset: the node is not telling the fleet that
    // 300 files were deleted, it has lost them. Following it is how one broken
    // machine takes the others with it.
    mesh = await buildFsMesh({
      root: root('wipe'),
      names: ['A', 'B', 'LOST'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (let i = 0; i < 150; i++) {
            await writeFile(join(folder, `doc-${i}.txt`), `content ${i}`);
          }
        }
      },
    });
    const seeded = await mesh.converged({ timeoutMs: 60_000 });
    expect(seeded.converged).toBe(true);
    expect(seeded.snapshot['A'].length).toBe(150);

    // Away, wiped, back — which is the order it happens in.
    mesh.node('LOST').cut();
    await emptyFolder(mesh.node('LOST').folder);
    await sleep(600);
    mesh.node('LOST').heal();

    await sleep(6_000);
    for (const name of ['A', 'B']) {
      const held = await mesh.node(name).files();
      expect(
        held.length,
        `${name} followed a wiped peer down to ${held.length} files`,
      ).toBe(150);
    }
    // The guard fires on all three paths it has — a peer's edit, an incoming
    // tree, and a bucket-sync round — and says so loudly. Whether the wiped
    // node then RECOVERS is a separate question, and the answer is below.
  }, 180_000);

  // ...........................................................................
  // OPEN — measured. 150 files, one node wiped while away, and after it
  // rejoins:
  //
  //   MASS DELETE REFUSED on A: a peer's edit would remove 150 of 150 files
  //   MASS DELETE REFUSED on B: the incoming tree would remove 152 of 152
  //   MASS DELETE REFUSED on A: a bucket-sync round would remove 150 of 150
  //   … and the wiped node still holds 0 files after sixty seconds.
  //
  // The fleet is protected and the casualty is abandoned. This is
  // `KNOWN-WEAKNESSES.md` §16 — *"the mass-delete guard can deadlock a branch,
  // and it does not heal"* — reproduced in just over a minute, and it is worse
  // than the register's version because the node is not merely out of step: it
  // is EMPTY and it stays empty. Replace a disk, reinstall a machine, and that
  // machine never gets the folder back.
  //
  // F4 covers the sparse-versus-full standoff and passes, so this is not the
  // same shape: there both nodes were populated from the start and neither had
  // ever announced emptiness. Here a node that HELD the files lost them, which
  // is the case that happens in an office.
  //
  // Reported rather than patched because the fix is a policy decision. A guard
  // that refuses a deletion has to leave a way for the refused node to be
  // REFILLED, and deciding what that is — treat an empty peer as a joiner,
  // require an operator to approve, keep refusing but push anyway — is the
  // same decision L1 is waiting on for `approved-mass-delete`.
  // ...........................................................................
  it('a wiped node is refilled rather than abandoned', async () => {
    mesh = await buildFsMesh({
      root: root('refill'),
      names: ['A', 'B', 'LOST'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (let i = 0; i < 150; i++) {
            await writeFile(join(folder, `doc-${i}.txt`), `content ${i}`);
          }
        }
      },
    });
    const seeded = await mesh.converged({ timeoutMs: 60_000 });
    expect(seeded.converged).toBe(true);

    mesh.node('LOST').cut();
    await emptyFolder(mesh.node('LOST').folder);
    await sleep(600);
    mesh.node('LOST').heal();

    expect(
      (await mesh.node('LOST').settlesOn(seeded.snapshot['A'], 60_000)).length,
      'the wiped node was never refilled',
    ).toBe(150);
  }, 180_000);

  // ...........................................................................
  // OPEN — measured, and the sharper half of the same policy.
  //
  // The test above uses 150 files because the guard has an absolute floor of
  // `MASS_DELETE_MIN_FILES = 100`. At FORTY files the same wipe takes the whole
  // fleet down with it: measured, `A followed a wiped peer down to 0 files`.
  //
  // That is deliberate today — there is a test asserting it, *"bounds nothing
  // below the floor — emptying a small folder is an edit"* — and for a folder
  // of five files it is the right call. For forty files lost to a disk failure
  // it is data loss on every machine, and no amount of files makes a WIPE into
  // an edit.
  //
  // `nextcloud/desktop` draws the line elsewhere and it is worth comparing:
  // `testallfilesdeleted` fires on ALL files being gone, whatever the count,
  // and asks the user to keep or delete — `aboutToRemoveAllFiles`, a failed
  // sync, then recovery. A ratio with no floor plus a question, rather than a
  // floor with no question.
  // ...........................................................................
  // THE BAND BETWEEN THE TWO FLOORS, named here because this test sits in it.
  //
  // Forty files is above the receiver's floor (`ALL_GONE_MIN_FILES`, ten) and
  // below the author's (`MASS_DELETE_MIN_FILES`, a hundred). So this wiped node
  // DOES announce its emptiness, and the point of the test is that A and B
  // refuse it — which they do, and which is what protects the data.
  //
  // What it does not get is a REFILL. Its head descends from the fleet's, so
  // the fleet's state arrives at it as a rollback and is ignored, while the
  // fleet ignores its emptiness: both sides are right and nothing moves. Above
  // a hundred files the push path recognises the loss and re-joins (the test
  // above, 150 files); below ten nothing is refused in the first place.
  //
  // The two floors differ deliberately — refusing to APPLY is free, refusing
  // to ANNOUNCE resurrects the user's own deletion — and the band is the
  // price. Closing it needs a signal this agent does not have: that an
  // announcement was REFUSED. A node cannot tell "nobody followed my deletion
  // because it was refused" from "nobody has heard it yet", and guessing is
  // how a legitimate deletion of fifty files comes back.
  it('a small folder survives a wiped peer too', async () => {
    mesh = await buildFsMesh({
      root: root('smallwipe'),
      names: ['A', 'B', 'LOST'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (let i = 0; i < 40; i++) {
            await writeFile(join(folder, `doc-${i}.txt`), `content ${i}`);
          }
        }
      },
    });
    expect((await mesh.converged({ timeoutMs: 60_000 })).converged).toBe(true);

    mesh.node('LOST').cut();
    await emptyFolder(mesh.node('LOST').folder);
    await sleep(600);
    mesh.node('LOST').heal();
    await sleep(6_000);

    for (const name of ['A', 'B']) {
      expect(
        (await mesh.node(name).files()).length,
        `${name} followed a wiped peer`,
      ).toBe(40);
    }
  }, 180_000);

  // ...........................................................................
  // OPEN — measured: `A went back to last week's content`.
  //
  // Somebody restores the folder from a backup on ONE machine. Every file in it
  // is older than what the fleet holds and one file is missing entirely, and
  // the fleet follows it backwards — the week's work is gone everywhere.
  //
  // This is `KNOWN-WEAKNESSES.md` U7 exactly: *"'frühere Version
  // wiederherstellen' ist kein lokales Rückgängig: Der Ordner wird
  // überschrieben und die Änderung geht an alle Rechner."* It is recorded there
  // as a UI problem — show how many files are affected, confirm, route it
  // through a bulk-operation mode — and it is also this: with no UI at all, one
  // restore reverts the fleet.
  //
  // `nextcloud/desktop` needed a PROTOCOL FIELD for it. `testDataFingetPrint`
  // drives a `data-fingerprint` property the server sets when it has been
  // restored, after which the client treats remote changes as a restoration
  // rather than as deletions, so that *"server-side deletions during
  // restoration don't remove local equivalents"*. There is no local rule that
  // substitutes: a node holding older content is indistinguishable from a node
  // that deliberately reverted it, and the chain cannot tell them apart either,
  // because the restore produces genuinely new edits.
  //
  // So this is a design decision and not a patch — which is why it is skipped
  // with the measurement rather than quietly left out.
  // ...........................................................................
  // A RUNNING NODE'S REVERT IS NOT DECIDABLE FROM THE CHAIN. Kept skipped
  // deliberately, with the reason, because the reason is the result.
  //
  // This node CONVERGED on the week's work before it was reverted — the
  // `settlesOn` above asserts it for all three. So its head descends from the
  // edit that added `added-later.txt`: it adopted that edit, and now the file
  // is gone from its folder. Against the chain that is character for character
  // what a user deleting the file looks like. The same holds for the bytes of
  // `shared.txt`: a node that adopted v2 and now holds other bytes is a node
  // that edited it.
  //
  // So neither mechanism this package has can separate the two. Per-path
  // ancestry (`lastEditOf`) says the remover had adopted the edit it is
  // removing, which is the condition for a LEGITIMATE deletion. Authorship
  // claims cannot help either: claims are recorded after a push, so a node is
  // a stranger to its own newest work at the moment it would be judged — which
  // is how three attempts at a restore detector each suppressed ordinary work
  // instead (a rename's target, an atomic save, and a file created, deleted
  // and created again all look exactly like a restored copy by that measure).
  //
  // What could separate them is outside the chain by design: mtimes going
  // backwards, which are deliberately not part of content identity, or breadth
  // — and two files is below every floor the mass-delete guard has.
  //
  // THE FIELD SHAPE IS COVERED. A folder restored from a backup is restored
  // while the agent is NOT running, and that node then JOINS: `planJoin` puts
  // every path the history removed in its `recover` bucket, renames it aside
  // and announces nothing (`fs-plan-join.spec.ts`, and J5 of the matrix). The
  // uncovered case is a revert performed under a live agent, which no backup
  // tool does.
  it.skip('a node reverted to an older copy does not drag the fleet back', async () => {
    // Nextcloud's `testDataFingetPrint`, and our U7. Somebody restores the
    // folder from a backup — on one machine. Every file in it is OLDER than
    // what the fleet holds, and several files the fleet has do not exist in it
    // at all. The restored machine must catch up; the others must not go
    // backwards.
    mesh = await buildFsMesh({
      root: root('revert'),
      names: ['A', 'B', 'OLD'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'shared.txt'), 'week 1');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // The fleet does a week's work.
    await mesh.node('A').write('shared.txt', 'week 2');
    await mesh.node('A').write('added-later.txt', 'new this week');
    const current = ['added-later.txt', 'shared.txt'];
    for (const name of ['A', 'B', 'OLD']) {
      expect(await mesh.node(name).settlesOn(current, 30_000)).toEqual(current);
    }

    // OLD is restored from last week's backup: the old content, and without
    // the file that was added since.
    mesh.node('OLD').cut();
    await emptyFolder(mesh.node('OLD').folder);
    await mesh.node('OLD').write('shared.txt', 'week 1');
    await sleep(600);
    mesh.node('OLD').heal();

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 6_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);

    // Nobody lost the week's work.
    for (const name of ['A', 'B', 'OLD']) {
      expect(
        await mesh.node(name).read('shared.txt'),
        `${name} went back to last week's content`,
      ).toBe('week 2');
      expect(
        await mesh.node(name).read('added-later.txt'),
        `${name} lost the file added after the backup was taken`,
      ).toBe('new this week');
    }
  }, 180_000);

  // ...........................................................................
  it('one rename does not look like a mass deletion', async () => {
    // Nextcloud keeps this as its own case (`testSingleFileRenamed`) for the
    // same reason it is here: a guard that fires on ordinary work stops the
    // sync, and the register's D5 is exactly that failure at folder scale.
    mesh = await buildFsMesh({
      root: root('onerename'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'before.txt'), 'content');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    const { rename } = await import('fs/promises');
    await rename(
      join(mesh.node('A').folder, 'before.txt'),
      join(mesh.node('A').folder, 'after.txt'),
    );

    const after = ['after.txt'];
    expect(
      await mesh.node('B').settlesOn(after, 30_000),
      'a single rename did not propagate',
    ).toEqual(after);
    expect(await mesh.node('B').read('after.txt')).toBe('content');
  }, 120_000);

  // ...........................................................................
  it('touching a file without changing it does not look like a deletion', async () => {
    // Nextcloud's `testNotDeleteMetaDataChange`: a change that alters only
    // metadata must not trip the bulk protection. Ours is the same question in
    // the form this agent can produce it — every file's timestamp moves, no
    // content changes — which is what an archive extracted over a folder, a
    // permission sweep or a backup restore with `--times` does.
    mesh = await buildFsMesh({
      root: root('touch'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (let i = 0; i < 40; i++) {
            await writeFile(join(folder, `f-${i}.txt`), `c${i}`);
          }
        }
      },
    });
    const seeded = await mesh.converged({ timeoutMs: 60_000 });
    expect(seeded.converged).toBe(true);

    const { utimes } = await import('fs/promises');
    const when = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 40; i++) {
      await utimes(join(mesh.node('A').folder, `f-${i}.txt`), when, when);
    }

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    for (const name of ['A', 'B']) {
      expect(
        result.snapshot[name].length,
        `${name} lost files to a metadata-only change`,
      ).toBe(40);
    }
  }, 180_000);
});
