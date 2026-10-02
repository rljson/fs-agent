// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Names: unicode normalisation and case.
//
// Syncthing has a long public history on exactly this. Two Unicode spellings of
// the same character — "ü" as U+00FC, or U+0075 followed by U+0308 — are
// DIFFERENT BYTES and the same name to a user. macOS stores decomposed (NFD),
// Linux and Windows composed (NFC), so the same file copied between them
// changes its bytes without changing its name, and Syncthing's users report
// `normalizing path: item has UTF8 encoding conflict with another item`
// (issues #8128, #10314) and files that "no longer exist" under their converted
// names.
//
// This is not a foreign problem. These are German filenames — Größe, Übersicht,
// Maß — on a fleet of Windows machines with Mac development boxes, and the
// register already asks for it in D2: *"dazu Umlaute vereinheitlichen und
// Namenskollisionen bei Groß-/Kleinschreibung erkennen."*
//
// CASE is the sibling. Windows and macOS are case-INSENSITIVE by default, Linux
// is not. So `Angebot.docx` and `angebot.docx` are one file on three of our
// machines and two on the fourth, and a case-only rename is a no-op on one and
// a rename on the other.
//
// WHAT THESE TESTS DO. They do not assert a normalisation policy, because
// choosing one is a product decision with a migration attached. They assert the
// properties that must hold whichever policy is chosen — that the same name
// round-trips, that two spellings do not silently destroy each other, and that
// a case-only rename does not lose the file. Where today's behaviour is merely
// ACCEPTABLE rather than right, the test says so in words rather than pretending
// otherwise.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent } from '../src/fs-agent.ts';

/** "Größe.txt" composed: ö is one codepoint. */
const NFC = 'Größe.txt';
/** The same name decomposed: o followed by a combining diaeresis. */
const NFD = 'Größe.txt';

describe('filenames: unicode and case', () => {
  let base = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    base = join(process.cwd(), `test-temp-names-${++nth}`);
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(join(base, 'a'), { recursive: true });
    await mkdir(join(base, 'b'), { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(base, { recursive: true, force: true, maxRetries: 10 });
  });

  const pair = () => {
    const bs = new BsMem();
    const a = new FsAgent(join(base, 'a'), bs);
    const b = new FsAgent(join(base, 'b'), bs);
    agents.push(a, b);
    return { a, b };
  };

  const sync = async (a: FsAgent, b: FsAgent): Promise<unknown> => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await b
      .restore(await a.extract(), join(base, 'b'), { cleanTarget: true })
      .then(() => undefined)
      .catch((e: unknown) => e);
    await b.extract();
    warn.mockRestore();
    err.mockRestore();
    return outcome;
  };

  // ...........................................................................
  it('a German filename survives a round trip byte for byte', async () => {
    // The floor. Whatever normalisation happens, it has to be the SAME
    // normalisation on both sides, or the name a user sees changes by itself.
    const { a, b } = pair();
    await writeFile(join(base, 'a', NFC), 'Größe');
    expect(await sync(a, b)).toBeUndefined();

    const landed = await readdir(join(base, 'b'));
    const synced = landed.filter((n) => !n.startsWith('.'));
    expect(synced.length, JSON.stringify(synced)).toBe(1);
    // Compared as code points, because the two spellings are equal to the eye
    // and to many comparisons, and the whole question is which bytes arrived.
    expect(
      [...synced[0]].map((c) => c.codePointAt(0)),
      `the name changed spelling in transit: sent ${JSON.stringify([...NFC])}, ` +
        `received ${JSON.stringify([...synced[0]])}`,
    ).toEqual([...NFC].map((c) => c.codePointAt(0)));
    expect(await readFile(join(base, 'b', NFC), 'utf-8')).toBe('Größe');
  }, 60_000);

  // ...........................................................................
  it('two spellings of one name do not destroy each other', async () => {
    // The case Syncthing reports as an "encoding conflict". On a filesystem
    // that treats the two spellings as one name, the second write lands on the
    // first and there is ONE file — acceptable, because that is the
    // filesystem's own answer. What must not happen is content disappearing
    // with no trace: whatever the count, every surviving file must hold
    // content somebody wrote.
    const { a, b } = pair();
    await writeFile(join(base, 'a', NFC), 'composed');
    await writeFile(join(base, 'a', NFD), 'decomposed');

    const here = (await readdir(join(base, 'a'))).filter(
      (n) => !n.startsWith('.'),
    );
    expect(await sync(a, b)).toBeUndefined();
    const there = (await readdir(join(base, 'b'))).filter(
      (n) => !n.startsWith('.'),
    );

    // The peer holds exactly what the sender holds — no more, no fewer.
    expect(
      there.length,
      `sender has ${JSON.stringify(here)}, peer has ${JSON.stringify(there)}`,
    ).toBe(here.length);
    for (const name of there) {
      const content = await readFile(join(base, 'b', name), 'utf-8');
      expect(
        ['composed', 'decomposed'],
        `"${name}" holds ${JSON.stringify(content)}, which nobody wrote`,
      ).toContain(content);
    }
  }, 60_000);

  // ...........................................................................
  it('a case-only rename does not lose the file', async () => {
    // `Angebot.docx` → `angebot.docx`. On a case-insensitive filesystem this
    // is the same path, so the receiver may legitimately keep one name — but
    // the FILE must still be there, under one spelling or the other, with its
    // content.
    const { a, b } = pair();
    await writeFile(join(base, 'a', 'Angebot.docx'), 'offer');
    expect(await sync(a, b)).toBeUndefined();
    expect(existsSync(join(base, 'b', 'Angebot.docx'))).toBe(true);

    await rename(join(base, 'a', 'Angebot.docx'), join(base, 'a', 'angebot.docx'));
    expect(await sync(a, b)).toBeUndefined();

    const there = (await readdir(join(base, 'b'))).filter(
      (n) => !n.startsWith('.'),
    );
    expect(
      there.length,
      `a case-only rename left ${JSON.stringify(there)}`,
    ).toBe(1);
    expect(there[0].toLowerCase()).toBe('angebot.docx');
    expect(await readFile(join(base, 'b', there[0]), 'utf-8')).toBe('offer');
  }, 60_000);

  // ...........................................................................
  it('two names differing only in case do not destroy each other', async () => {
    // Linux can hold both; Windows and macOS cannot. Either answer is
    // defensible — losing content without saying so is not.
    const { a, b } = pair();
    await writeFile(join(base, 'a', 'Report.txt'), 'upper');
    await writeFile(join(base, 'a', 'report.txt'), 'lower');

    const here = (await readdir(join(base, 'a'))).filter(
      (n) => !n.startsWith('.'),
    );
    expect(await sync(a, b)).toBeUndefined();
    const there = (await readdir(join(base, 'b'))).filter(
      (n) => !n.startsWith('.'),
    );

    expect(
      there.length,
      `sender ${JSON.stringify(here)} vs peer ${JSON.stringify(there)}`,
    ).toBe(here.length);
    for (const name of there) {
      expect(['upper', 'lower']).toContain(
        await readFile(join(base, 'b', name), 'utf-8'),
      );
    }
  }, 60_000);

  // ...........................................................................
  it('carries the awkward names a real folder contains', async () => {
    // Not edge cases for their own sake: every one of these is in somebody's
    // documents folder. A name that breaks a path join, a shell quote or a
    // URL encode somewhere in the stack takes the whole folder with it, which
    // is the shape of D2.
    const { a, b } = pair();
    const names = [
      'Angebot 2026 (Entwurf).docx',
      "Kunde's Projekt.txt",
      'Maß & Gewicht.csv',
      'a#b?c=d.txt',
      'Ümläute Übersicht.txt',
      '100% fertig.txt',
      'dash-and_underscore.txt',
      'Ordner mit Leerzeichen/datei.txt',
    ];
    for (const name of names) {
      await mkdir(join(base, 'a', name, '..'), { recursive: true });
      await writeFile(join(base, 'a', name), `content of ${name}`);
    }

    expect(await sync(a, b)).toBeUndefined();

    for (const name of names) {
      expect(
        await readFile(join(base, 'b', name), 'utf-8').catch(() => undefined),
        `"${name}" did not arrive`,
      ).toBe(`content of ${name}`);
    }
  }, 60_000);
});
