// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { DIR_MARKER } from '../src/fs-conflict-resolver.ts';
import { planAuthoring, type AuthoringQuestion } from '../src/fs-send.ts';

const FLOORS = { minFiles: 100, maxRatio: 0.3, allGoneMinFiles: 10 };

/** `count` files `f0.txt…`, each with its own content. */
const files = (count: number, prefix = 'f'): Map<string, string> =>
  new Map(
    Array.from({ length: count }, (_, i) => [`${prefix}${i}.txt`, `blob-${prefix}${i}`]),
  );

const ask = (
  head: Map<string, string>,
  folder: Map<string, string>,
  watched: string[] = [],
): ReturnType<typeof planAuthoring> =>
  planAuthoring({
    head,
    folder,
    watched: new Set(watched),
    ...FLOORS,
  } satisfies AuthoringQuestion);

describe('planAuthoring — the sender answers for its edits', () => {
  it('authors nothing when the folder is what the head says', () => {
    expect(ask(files(3), files(3))).toEqual({ kind: 'unchanged' });
  });

  it('authors additions, modifications and removals, sorted, folders included', () => {
    const head = new Map([
      ['b.txt', 'b0'],
      ['a.txt', 'a0'],
      ['gone', DIR_MARKER],
      ['gone/x.txt', 'x0'],
    ]);
    const folder = new Map([
      ['b.txt', 'b1'],
      ['a.txt', 'a0'],
      ['new', DIR_MARKER],
      ['c.txt', 'c0'],
    ]);
    expect(ask(head, folder)).toEqual({
      kind: 'author',
      changed: ['b.txt', 'c.txt', 'new'],
      removed: ['gone', 'gone/x.txt'],
    });
  });

  it('authors a few files deleted while the agent was down', () => {
    const head = files(200);
    const folder = files(200);
    folder.delete('f0.txt');
    folder.delete('f1.txt');
    expect(ask(head, folder)).toMatchObject({
      kind: 'author',
      removed: ['f0.txt', 'f1.txt'],
    });
  });

  it('refuses a large disappearance nobody watched — a failed mount', () => {
    const head = files(200);
    const folder = files(50);
    const plan = ask(head, folder);
    expect(plan.kind).toBe('refused');
    expect(plan).toMatchObject({ held: 200 });
    expect((plan as { disappeared: string[] }).disappeared).toHaveLength(150);
  });

  it('authors the same disappearance when the watcher saw it happen', () => {
    const head = files(200);
    const folder = files(50);
    const watched = [...head.keys()].filter((p) => !folder.has(p));
    expect(ask(head, folder, watched).kind).toBe('author');
  });

  it('counts a deleted folder the watcher saw as watching everything in it', () => {
    const head = new Map([...files(150, 'project/'), ['keep.txt', 'k']]);
    const folder = new Map([['keep.txt', 'k']]);
    expect(ask(head, folder, ['project']).kind).toBe('author');
    expect(ask(head, folder, ['elsewhere']).kind).toBe('refused');
  });

  it('authors a folder renamed while the agent was down — nothing disappeared', () => {
    const head = files(200, 'old/');
    const folder = new Map(
      [...head].map(([path, blob]) => [path.replace('old/', 'new/'), blob]),
    );
    expect(ask(head, folder).kind).toBe('author');
  });

  it('refuses a folder of 40 left empty, though 40 is under the size floor', () => {
    expect(ask(files(40), new Map())).toMatchObject({ kind: 'refused', held: 40 });
  });

  it('authors emptying a small folder, and a watched emptying of a large one', () => {
    expect(ask(files(8), new Map()).kind).toBe('author');
    const head = files(40);
    expect(ask(head, new Map(), [...head.keys()]).kind).toBe('author');
  });
});
