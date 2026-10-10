// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { RefStamp } from '@rljson/rljson';

import { describe, expect, it } from 'vitest';

import {
  copyName,
  DIR_MARKER,
  joinCopyName,
  merge3,
  recoveredName,
  type ContentMap,
  type Introducer,
  type MergeSide,
} from '../src/fs-merge.ts';

const map = (entries: Record<string, string>): ContentMap =>
  new Map(Object.entries(entries));

const stamp = (n: number, hub = 'hub'): RefStamp => ({
  domain: 'office',
  epoch: 1,
  hub,
  n,
});

const side = (
  content: Record<string, string>,
  nodeId: string,
  stampOf: (path: string) => RefStamp | undefined = () => undefined,
): MergeSide => ({
  content: map(content),
  introducer: (path): Introducer => ({
    entry: `${nodeId}-entry-${path}`,
    stamp: stampOf(path),
    nodeId,
  }),
});

const asObject = (m: Map<string, string>) => Object.fromEntries([...m].sort());

describe('merge3 — the conflict table', () => {
  it('C1/C2: takes the side that changed a path, and keeps both sides’ new paths', () => {
    const base = map({ 'a.txt': 'a0', 'b.txt': 'b0', 'gone.txt': 'g0' });
    const ours = side({ 'a.txt': 'a1', 'b.txt': 'b0', 'gone.txt': 'g0', 'mine.txt': 'm' }, 'A');
    const theirs = side({ 'a.txt': 'a0', 'b.txt': 'b1', 'yours.txt': 'y' }, 'B');

    const out = merge3(base, ours, theirs);

    expect(asObject(out.merged)).toEqual({
      'a.txt': 'a1',
      'b.txt': 'b1',
      'mine.txt': 'm',
      'yours.txt': 'y',
    });
    expect(out.conflicts).toEqual([]);
    expect(out.unknownStamps).toEqual([]);
  });

  it('C1/C2: two sides that made the same change agree without a conflict', () => {
    const out = merge3(
      map({ 'a.txt': 'a0' }),
      side({ 'a.txt': 'same' }, 'A'),
      side({ 'a.txt': 'same' }, 'B'),
    );
    expect(asObject(out.merged)).toEqual({ 'a.txt': 'same' });
    expect(out.conflicts).toEqual([]);
  });

  it('C3: keeps both versions; the later stamp keeps the name, the other a copy', () => {
    const base = map({ 'doc.txt': 'v0' });
    const ours = side({ 'doc.txt': 'mine' }, 'A', () => stamp(5));
    const theirs = side({ 'doc.txt': 'yours' }, 'B', () => stamp(9));

    const out = merge3(base, ours, theirs);

    expect(asObject(out.merged)).toEqual({
      'doc.txt': 'yours',
      'doc (conflicted copy hub-5 A).txt': 'mine',
    });
    expect(out.conflicts).toEqual([
      {
        kind: 'conflict/arbitrary',
        path: 'doc.txt',
        copyPath: 'doc (conflicted copy hub-5 A).txt',
      },
    ]);
  });

  it('C3: decides the same on both nodes — the verdict does not depend on who merges', () => {
    const base = map({ 'doc.txt': 'v0' });
    const a = side({ 'doc.txt': 'mine' }, 'A', () => stamp(5));
    const b = side({ 'doc.txt': 'yours' }, 'B', () => stamp(9));
    expect(merge3(base, a, b).merged).toEqual(merge3(base, b, a).merged);
  });

  it('C3: breaks a tie of equal stamps on the introducing entry', () => {
    const base = map({ 'doc.txt': 'v0' });
    const a = side({ 'doc.txt': 'mine' }, 'A', () => stamp(5));
    const b = side({ 'doc.txt': 'yours' }, 'B', () => stamp(5));
    const out = merge3(base, a, b);
    expect(out.merged.get('doc.txt')).toBe('yours');
    expect(merge3(base, b, a).merged).toEqual(out.merged);
  });

  it('C3: defers when either version’s stamp is not known yet', () => {
    const base = map({ 'doc.txt': 'v0' });
    const out = merge3(
      base,
      side({ 'doc.txt': 'mine' }, 'A', () => stamp(5)),
      side({ 'doc.txt': 'yours' }, 'B'),
    );
    expect(out.unknownStamps).toEqual(['doc.txt']);
    expect(out.merged.has('doc.txt')).toBe(false);
  });

  it('C4: an edit beats a concurrent deletion, either way round, and is reported', () => {
    const base = map({ 'doc.txt': 'v0' });
    for (const [ours, theirs] of [
      [side({}, 'A'), side({ 'doc.txt': 'v1' }, 'B')],
      [side({ 'doc.txt': 'v1' }, 'A'), side({}, 'B')],
    ]) {
      const out = merge3(base, ours, theirs);
      expect(asObject(out.merged)).toEqual({ 'doc.txt': 'v1' });
      expect(out.conflicts).toEqual([{ kind: 'conflict/arbitrary', path: 'doc.txt' }]);
    }
  });

  it('C5: a folder and a file at one path keep both — the folder its whole subtree', () => {
    const base = map({});
    const ours = side({ p: DIR_MARKER, 'p/x.txt': 'x', 'p/sub': DIR_MARKER, 'p/sub/y.txt': 'y' }, 'A');
    const theirs = side({ p: 'file' }, 'B', () => stamp(3));

    const out = merge3(base, ours, theirs);

    expect(asObject(out.merged)).toEqual({
      p: DIR_MARKER,
      'p (conflicted copy B)': 'file',
      'p/sub': DIR_MARKER,
      'p/sub/y.txt': 'y',
      'p/x.txt': 'x',
    });
    expect(out.conflicts).toEqual([
      { kind: 'collision/type', path: 'p', copyPath: 'p (conflicted copy B)' },
    ]);
  });

  it('C5: a folder replaced by a file while the other side added to it is a collision', () => {
    const base = map({ p: DIR_MARKER, 'p/old.txt': 'o' });
    const ours = side({ p: DIR_MARKER, 'p/old.txt': 'o', 'p/new.txt': 'n' }, 'A');
    const theirs = side({ p: 'file' }, 'B');

    const out = merge3(base, ours, theirs);

    expect(asObject(out.merged)).toEqual({
      p: DIR_MARKER,
      'p (conflicted copy B)': 'file',
      'p/new.txt': 'n',
      'p/old.txt': 'o',
    });
    expect(out.conflicts.map((c) => c.kind)).toEqual(['collision/type']);
  });

  it('C5: keeps the folder side’s own deletions inside the folder it keeps', () => {
    const base = map({ p: DIR_MARKER, 'p/old.txt': 'o' });
    const ours = side({ p: DIR_MARKER, 'p/new.txt': 'n' }, 'A');
    const theirs = side({ p: 'file' }, 'B');

    expect(asObject(merge3(base, ours, theirs).merged)).toEqual({
      p: DIR_MARKER,
      'p (conflicted copy B)': 'file',
      'p/new.txt': 'n',
    });
  });

  it('a folder replaced by a file that nobody else touched is an ordinary edit', () => {
    const base = map({ p: DIR_MARKER, 'p/old.txt': 'o', 'q.txt': 'q' });
    const ours = side({ p: DIR_MARKER, 'p/old.txt': 'o', 'q.txt': 'q2' }, 'A');
    const theirs = side({ p: 'file', 'q.txt': 'q' }, 'B');

    const out = merge3(base, ours, theirs);

    expect(asObject(out.merged)).toEqual({ p: 'file', 'q.txt': 'q2' });
    expect(out.conflicts).toEqual([]);
  });

  it('a file turned into a folder that nobody else touched is an ordinary edit', () => {
    const base = map({ p: 'file' });
    const out = merge3(
      base,
      side({ p: 'file' }, 'A'),
      side({ p: DIR_MARKER, 'p/x.txt': 'x' }, 'B'),
    );
    expect(asObject(out.merged)).toEqual({ p: DIR_MARKER, 'p/x.txt': 'x' });
    expect(out.conflicts).toEqual([]);
  });

  it('decides a collision once, for the outermost path', () => {
    const base = map({});
    const ours = side({ p: DIR_MARKER, 'p/q': DIR_MARKER, 'p/q/z.txt': 'z' }, 'A');
    const theirs = side({ p: DIR_MARKER, 'p/q': 'file-q' }, 'B');
    const out = merge3(base, ours, theirs);
    expect(out.conflicts).toEqual([
      { kind: 'collision/type', path: 'p/q', copyPath: 'p/q (conflicted copy B)' },
    ]);
    expect(out.merged.get('p/q/z.txt')).toBe('z');
  });
});

describe('copyName', () => {
  it('names the loser by stamp and node, and keeps the extension', () => {
    const taken = new Set<string>();
    expect(copyName('dir/report.pdf', 'node-7', stamp(12, 'hub-a'), taken)).toBe(
      'dir/report (conflicted copy hub-a-12 node-7).pdf',
    );
  });

  it('leaves the stamp out when none is given, and has no extension to keep', () => {
    expect(copyName('Makefile', 'node-7', undefined, new Set())).toBe(
      'Makefile (conflicted copy node-7)',
    );
    expect(copyName('.env', 'node-7', undefined, new Set())).toBe(
      '.env (conflicted copy node-7)',
    );
  });

  it('leaves out an unknown author, and has a name with neither stamp nor author', () => {
    expect(copyName('a.txt', '', stamp(3, 'hub-a'), new Set())).toBe(
      'a (conflicted copy hub-a-3).txt',
    );
    expect(copyName('a.txt', '', undefined, new Set())).toBe('a (conflicted copy).txt');
  });

  it('numbers a name that is taken', () => {
    const taken = new Set(['a (conflicted copy n).txt']);
    expect(copyName('a.txt', 'n', undefined, taken)).toBe('a (conflicted copy n) (1).txt');
    expect(taken.has('a (conflicted copy n) (1).txt')).toBe(true);
  });
});

describe('joinCopyName', () => {
  // A joining folder's own version, set aside beside the network's. No stamp
  // orders it, so the name says when and whose.
  it('names it by the UTC time it was set aside, before the extension', () => {
    const at = Date.UTC(2026, 5, 18, 9, 15, 7);
    expect(joinCopyName('dir/doc.txt', at, new Set())).toBe(
      'dir/doc (conflicted copy 2026-06-18 091507 local).txt',
    );
  });

  it('numbers a name that is taken', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    const taken = new Set<string>();
    expect(joinCopyName('.env', at, taken)).toBe(
      '.env (conflicted copy 2026-01-02 030405 local)',
    );
    expect(joinCopyName('.env', at, taken)).toBe(
      '.env (conflicted copy 2026-01-02 030405 local) (1)',
    );
  });
});

describe('recoveredName', () => {
  // Set aside, not announced: content the fleet deliberately deleted is kept
  // where its owner can see it and nothing is said about it.
  it('names a set-aside file, before the extension', () => {
    const taken = new Set<string>();
    expect(recoveredName('doc.txt', taken)).toBe('doc (recovered).txt');
    expect(recoveredName('deep/dir/notes.md', taken)).toBe(
      'deep/dir/notes (recovered).md',
    );
  });

  it('treats a dotfile and an extensionless name as extensionless', () => {
    const taken = new Set<string>();
    expect(recoveredName('.gitignore', taken)).toBe('.gitignore (recovered)');
    expect(recoveredName('Makefile', taken)).toBe('Makefile (recovered)');
  });

  it('never collides with a name already set aside', () => {
    // A folder restored twice, or two deleted paths whose set-aside names
    // would meet. Losing one to the other is losing a file.
    const taken = new Set<string>();
    expect(recoveredName('doc.txt', taken)).toBe('doc (recovered).txt');
    expect(recoveredName('doc.txt', taken)).toBe('doc (recovered) (1).txt');
    expect(recoveredName('doc.txt', taken)).toBe('doc (recovered) (2).txt');
  });
});
