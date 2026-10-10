// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { receive, type ReceiveDeps, type Relation } from '../src/fs-receive.ts';

/** Fake agent: records every call, answers from the given script. */
const agent = (script: {
  own?: string;
  relation?: Relation;
  trees?: Record<string, string | undefined>;
  apply?: 'applied' | 'refused';
  merge?: 'merged' | 'deferred' | 'refused';
  flushTo?: string;
}) => {
  const calls: string[] = [];
  let own = script.own;
  const deps: ReceiveDeps = {
    ownHead: () => own,
    flushLocal: async () => {
      calls.push('flush');
      if (script.flushTo) own = script.flushTo;
    },
    relate: async (ours, theirs) => {
      calls.push(`relate ${ours} ${theirs}`);
      return script.relation ?? { verdict: 'incomplete' };
    },
    treeRefOf: async (head) => script.trees?.[head],
    applyBehind: async (head) => {
      calls.push(`apply ${head}`);
      if ((script.apply ?? 'applied') === 'applied') own = head;
      return script.apply ?? 'applied';
    },
    adopt: async (head) => {
      calls.push(`adopt ${head}`);
      own = head;
    },
    announceOwn: () => calls.push('announce'),
    merge: async (theirs, base) => {
      calls.push(`merge ${theirs} ${base}`);
      return script.merge ?? 'merged';
    },
    blocked: (head) => calls.push(`blocked ${head}`),
  };
  return { deps, calls };
};

describe('receive — what a node does with a head that arrived', () => {
  it('waits for a head of its own before anything else', async () => {
    const { deps, calls } = agent({});
    expect(await receive('H', deps)).toBe('no-head');
    expect(calls).toEqual([]);
  });

  it('does nothing for its own head, after authoring local work first', async () => {
    const { deps, calls } = agent({ own: 'O' });
    expect(await receive('O', deps)).toBe('in-sync');
    expect(calls).toEqual(['flush']);
  });

  it('authors local work before deciding, so a head never overwrites it', async () => {
    const { deps, calls } = agent({
      own: 'O',
      flushTo: 'O2',
      relation: { verdict: 'fork', base: 'O' },
      trees: { O2: 'mine', H: 'theirs' },
    });
    expect(await receive('H', deps)).toBe('merged');
    expect(calls).toEqual(['flush', 'relate O2 H', 'merge H O']);
  });

  it('applies a head that descends from its own, which adopts it', async () => {
    const { deps, calls } = agent({ own: 'O', relation: { verdict: 'behind' } });
    expect(await receive('H', deps)).toBe('applied');
    expect(calls).toEqual(['flush', 'relate O H', 'apply H']);
    expect(deps.ownHead()).toBe('H');
  });

  it('adopts nothing when the apply was refused', async () => {
    const { deps, calls } = agent({
      own: 'O',
      relation: { verdict: 'behind' },
      apply: 'refused',
    });
    expect(await receive('H', deps)).toBe('refused');
    expect(calls).not.toContain('adopt H');
  });

  it('announces its own head to a sender that is behind it', async () => {
    const { deps, calls } = agent({ own: 'O', relation: { verdict: 'ahead' } });
    expect(await receive('H', deps)).toBe('announced');
    expect(calls).toContain('announce');
  });

  it('does nothing, and says so, when the history cannot answer', async () => {
    const { deps, calls } = agent({ own: 'O', relation: { verdict: 'incomplete' } });
    expect(await receive('H', deps)).toBe('blocked');
    expect(calls).toEqual(['flush', 'relate O H', 'blocked H']);
  });

  it('treats a relation of the same head as in sync', async () => {
    const { deps } = agent({ own: 'O', relation: { verdict: 'same' } });
    expect(await receive('H', deps)).toBe('in-sync');
  });

  it('converges a fork of one state on the smaller ref, from either side', async () => {
    const fork: Relation = { verdict: 'fork', base: 'B' };
    const trees = { A1: 'same', Z9: 'same' };

    const smallerArrives = agent({ own: 'Z9', relation: fork, trees });
    expect(await receive('A1', smallerArrives.deps)).toBe('adopted');
    expect(smallerArrives.calls).toContain('adopt A1');

    const largerArrives = agent({ own: 'A1', relation: fork, trees });
    expect(await receive('Z9', largerArrives.deps)).toBe('announced');
    expect(largerArrives.calls).not.toContain('adopt Z9');
  });

  it('merges a fork of two states against its base, and reports a deferral', async () => {
    const { deps, calls } = agent({
      own: 'O',
      relation: { verdict: 'fork', base: 'B' },
      trees: { O: 'mine', H: 'theirs' },
      merge: 'deferred',
    });
    expect(await receive('H', deps)).toBe('deferred');
    expect(calls).toContain('merge H B');
  });

  it('blocks a fork whose trees cannot be read', async () => {
    const { deps, calls } = agent({
      own: 'O',
      relation: { verdict: 'fork', base: undefined },
      trees: { O: 'mine' },
    });
    expect(await receive('H', deps)).toBe('blocked');
    expect(calls).toContain('blocked H');
  });
});
