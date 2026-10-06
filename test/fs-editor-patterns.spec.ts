// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// How real programs actually save files.
//
// Every test in this repo so far writes a file the way a test writes a file:
// one `writeFile`, start to finish. Almost nothing a user runs does that.
//
//  - Word, Excel and most editors save ATOMICALLY: write `~tmpXXXX`, flush,
//    rename over the original. The folder therefore sees a file appear, a file
//    be replaced, and a file vanish — three events for one save.
//  - Office also creates a LOCK FILE beside the document, `~$Angebot.docx`,
//    for as long as it is open, and deletes it on close. It is noise that
//    propagates to every machine and back.
//  - Editors leave BACKUPS: `document.txt~`, `.document.txt.swp`.
//  - the host application holds `.dbf` and `.PRJZ` open for the life of a document, which is
//    already covered — this is about what happens AROUND that.
//
// None of this needs a real fleet and none of it was tested. The register's D3 is
// the slow-copy half of the same family; this is the fast half, where the
// hazard is not a partial read but a storm of events for one logical change.
// .............................................................................

import { rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildFsMesh, whyNot, type FsMesh } from './mesh/fs-mesh.ts';

describe('how real programs save', () => {
  let mesh: FsMesh | undefined;

  const root = (name: string) => join(process.cwd(), `test-temp-editor-${name}`);

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ...........................................................................
  it('an atomic save (temp + rename over) converges on the new content', async () => {
    // What Word does. The danger is that the rename is seen as a DELETE of the
    // temp file plus a MODIFY of the document, in either order, and a peer
    // that applies them out of order ends up with the old content or none.
    mesh = await buildFsMesh({
      root: root('atomic'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'Angebot.docx'), 'version 1');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // Three saves in a row, each the way an editor does it.
    for (let v = 2; v <= 4; v++) {
      const folder = mesh.node('A').folder;
      const tmp = join(folder, `~tmp${v}.tmp`);
      await writeFile(tmp, `version ${v}`);
      await rename(tmp, join(folder, 'Angebot.docx'));
      await sleep(400);
    }

    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    // The temp files must not survive anywhere.
    for (const name of ['A', 'B']) {
      expect(
        result.snapshot[name],
        `temp files left behind on ${name}`,
      ).toEqual(['Angebot.docx']);
      expect(
        await mesh.node(name).read('Angebot.docx'),
        `${name} is not on the last saved version`,
      ).toBe('version 4');
    }
  }, 120_000);

  // ...........................................................................
  it('an Office lock file comes and goes without leaving residue', async () => {
    // `~$Angebot.docx` exists only while the document is open. It will
    // propagate — nothing ignores it today — and the thing that matters is
    // that its deletion propagates too, on every machine, rather than one
    // node keeping a lock file that tells everybody a document is open when it
    // is not.
    mesh = await buildFsMesh({
      root: root('lock'),
      names: ['A', 'B', 'C'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'Angebot.docx'), 'doc');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await mesh.node('A').write('~$Angebot.docx', 'lock');
    const open = ['Angebot.docx', '~$Angebot.docx'];
    for (const name of ['A', 'B', 'C']) {
      expect(await mesh.node(name).settlesOn(open, 30_000)).toEqual(open);
    }

    await mesh.node('A').del('~$Angebot.docx');
    const result = await mesh.converged({
      timeoutMs: 60_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    for (const name of ['A', 'B', 'C']) {
      expect(
        result.snapshot[name],
        `a stale lock file survived on ${name}, so the document reads as open`,
      ).toEqual(['Angebot.docx']);
    }
  }, 120_000);

  // ...........................................................................
  it('a save on one machine while another deletes the file', async () => {
    // Delete versus modify, which Unison treats as its own case and this repo
    // tested only in the resolver's unit fakes, never between two real agents.
    //
    // Either answer is defensible — the deletion wins, or the edit does — but
    // the fleet has to agree on ONE, and a surviving file must hold content
    // somebody actually wrote.
    mesh = await buildFsMesh({
      root: root('delmod'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'contested.txt'), 'original');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await Promise.all([
      mesh.node('A').write('contested.txt', 'edited by A'),
      mesh.node('B').del('contested.txt'),
    ]);

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(result.snapshot['A']).toEqual(result.snapshot['B']);
    for (const file of result.snapshot['A']) {
      const content = await mesh.node('A').read(file);
      expect(
        ['edited by A', 'original'],
        `"${file}" holds ${JSON.stringify(content)}, which nobody wrote`,
      ).toContain(content);
    }
  }, 150_000);

  // ...........................................................................
  it('two machines renaming one file to different names', async () => {
    // Unison lists "move conflicts" as its own scenario. A renames X to Y, B
    // renames X to Z: to this system that is two deletes and two adds, and the
    // outcomes range from both names surviving to neither.
    //
    // The invariant: the content is not lost, and the two folders agree.
    mesh = await buildFsMesh({
      root: root('movecon'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'original.txt'), 'the content');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    await Promise.all([
      rename(
        join(mesh.node('A').folder, 'original.txt'),
        join(mesh.node('A').folder, 'renamed-by-a.txt'),
      ),
      rename(
        join(mesh.node('B').folder, 'original.txt'),
        join(mesh.node('B').folder, 'renamed-by-b.txt'),
      ),
    ]);

    const result = await mesh.converged({
      timeoutMs: 90_000,
      stableMs: 5_000,
    });
    expect(result.converged, whyNot(result)).toBe(true);
    expect(result.snapshot['A']).toEqual(result.snapshot['B']);
    expect(
      result.snapshot['A'].length,
      `both folders ended up with ${JSON.stringify(result.snapshot['A'])} — ` +
        `the renamed content is gone`,
    ).toBeGreaterThan(0);
    for (const file of result.snapshot['A']) {
      expect(await mesh.node('A').read(file)).toBe('the content');
    }
  }, 150_000);

  // ...........................................................................
  it('a file created, deleted and created again at the same path', async () => {
    // The shape a tombstone gets wrong. The path is deleted — so it is
    // tombstoned — and then written again, and the tombstone must not refuse
    // the new file for the rest of the session.
    mesh = await buildFsMesh({
      root: root('recreate'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'seed.txt'), 'seed');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    for (let round = 1; round <= 3; round++) {
      await mesh.node('A').write('cycle.txt', `round ${round}`);
      const present = ['cycle.txt', 'seed.txt'];
      expect(
        await mesh.node('B').settlesOn(present, 30_000),
        `round ${round}: the re-created file never reached B`,
      ).toEqual(present);

      await mesh.node('A').del('cycle.txt');
      expect(
        await mesh.node('B').settlesOn(['seed.txt'], 30_000),
        `round ${round}: the deletion never reached B`,
      ).toEqual(['seed.txt']);
    }

    await mesh.node('A').write('cycle.txt', 'final');
    const last = ['cycle.txt', 'seed.txt'];
    expect(await mesh.node('B').settlesOn(last, 30_000)).toEqual(last);
    expect(await mesh.node('B').read('cycle.txt')).toBe('final');
  }, 240_000);

  // ...........................................................................
  it('a save that TRUNCATES before writing still converges on the final bytes', async () => {
    // The other way programs save, and the one the harness no longer does.
    //
    // `node.write()` in the mesh harness goes through temp-and-rename, because
    // a bare `writeFile` truncates first and leaves the file at ZERO BYTES for
    // an instant — which the route-invariant sampler observed as
    // `["v0","v1","v2","v3","","v4",…]` and correctly called a step backwards.
    // The harness was wrong there: no editor leaves a file empty between
    // saves, and baking that into every write in the suite manufactured
    // failures.
    //
    // But truncate-then-write is a REAL pattern — `>` in a shell, a program
    // opening with O_TRUNC — so it gets its own case rather than disappearing
    // with the harness fix. What is asserted is what can be asserted: an
    // intermediate empty state MAY be observed and propagated, because the
    // agent reports what the filesystem did; the fleet must still end on the
    // final bytes, and must not strand anyone on the empty one.
    mesh = await buildFsMesh({
      root: root('truncate'),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          await writeFile(join(folder, 'doc.txt'), 'original');
        }
      },
    });
    expect((await mesh.converged()).converged).toBe(true);

    // Not `node.write()`: straight at the file, truncating, five times over.
    const file = join(mesh.node('A').folder, 'doc.txt');
    for (let v = 1; v <= 5; v++) {
      await writeFile(file, `rewritten ${v}`);
      await sleep(250);
    }

    const result = await mesh.converged({ timeoutMs: 60_000, stableMs: 4_000 });
    expect(result.converged, whyNot(result)).toBe(true);
    for (const name of ['A', 'B']) {
      expect(
        await mesh.node(name).read('doc.txt'),
        `${name} did not end on the last of the five truncating saves`,
      ).toBe('rewritten 5');
    }
  }, 180_000);
});
