// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// THE SINK, WITHOUT A FILESYSTEM.
//
// `FsSignals` does no I/O on purpose, which is what lets these tests assert the
// awkward parts directly: the cap dropping the oldest, the counters surviving
// that drop, a listener that throws, and a persisted log coming back from a
// shape nobody validated on the way out.
//
// The last one is the reason this file is strict about `restore`. A signal log
// is read from a folder that users, backup tools and other builds of this agent
// all write into. It will be truncated, half-written and occasionally produced
// by a newer version, and none of that may stop a folder from syncing — so every
// branch of that tolerance is asserted rather than assumed.
// .............................................................................

import { describe, expect, it, vi } from 'vitest';

import {
  FsSignals,
  SIGNAL_LOG_MAX,
  SIGNAL_ONCE_MAX,
  SIGNAL_PATHS_MAX,
  type FsSignal,
  type FsSignalInput,
} from '../src/fs-signals.ts';

/** A minimal signal, so each test states only what it is about. */
const aSignal = (over: Partial<FsSignalInput> = {}): FsSignalInput => ({
  kind: 'conflict/merged',
  paths: ['one.txt'],
  action: 'review',
  ...over,
});

describe('FsSignals', () => {
  // ...........................................................................
  describe('recording', () => {
    it('stamps the time and counts the paths', () => {
      const signals = new FsSignals();
      const before = Date.now();
      const signal = signals.add(aSignal({ paths: ['b.txt', 'a.txt'] }));

      expect(signal.at).toBeGreaterThanOrEqual(before);
      // SORTED, so two machines describing the same event describe it alike —
      // the same reason `ReconcilePlan` sorts every list it returns.
      expect(signal.paths).toEqual(['a.txt', 'b.txt']);
      expect(signal.pathCount).toBe(2);
      expect(signals.all).toEqual([signal]);
    });

    it('takes a fixed time, so a test is not at the clock’s mercy', () => {
      const signals = new FsSignals();
      expect(signals.add(aSignal({ at: 1234 })).at).toBe(1234);
    });

    it('names the first paths and COUNTS the rest', () => {
      // A mass deletion names thousands. The signal has to stay small enough to
      // keep 200 of, and `pathCount` is what stops the cap from lying about
      // the scale of what happened.
      const many = Array.from({ length: SIGNAL_PATHS_MAX + 5 }, (_, i) =>
        `f${String(i).padStart(3, '0')}.txt`,
      );
      const signal = new FsSignals().add(aSignal({ paths: many }));

      expect(signal.paths).toHaveLength(SIGNAL_PATHS_MAX);
      expect(signal.pathCount).toBe(SIGNAL_PATHS_MAX + 5);
      expect(signal.paths[0]).toBe('f000.txt');
    });

    it('drops the OLDEST past the cap, and still counts them', () => {
      const signals = new FsSignals();
      for (let i = 0; i < SIGNAL_LOG_MAX + 10; i++) {
        signals.add(aSignal({ paths: [`f${i}.txt`], at: i }));
      }
      expect(signals.all).toHaveLength(SIGNAL_LOG_MAX);
      // The newest are kept, because those describe the current state.
      expect(signals.all[signals.all.length - 1].paths).toEqual([
        `f${SIGNAL_LOG_MAX + 9}.txt`,
      ]);
      // And nothing is silently forgotten.
      expect(signals.totals()['conflict/merged']).toBe(SIGNAL_LOG_MAX + 10);
    });

    it('counts each kind separately', () => {
      const signals = new FsSignals();
      signals.add(aSignal({ kind: 'conflict/merged' }));
      signals.add(aSignal({ kind: 'deletion/refused', action: 'required' }));
      signals.add(aSignal({ kind: 'deletion/refused', action: 'required' }));

      expect(signals.totals()).toEqual({
        'conflict/merged': 1,
        'deletion/refused': 2,
      });
    });
  });

  // ...........................................................................
  describe('what a person still has to do', () => {
    it('separates `required` from everything already dealt with', () => {
      // THE FIELD THE OTHER SURFACES NEVER CARRIED. "Both versions kept" and
      // "your deletion was refused and nothing further will happen" are both
      // resolutions, and only one of them can be left alone.
      const signals = new FsSignals();
      signals.add(aSignal({ kind: 'conflict/merged', action: 'review' }));
      const refused = signals.add(
        aSignal({ kind: 'deletion/refused', action: 'required' }),
      );
      signals.add(aSignal({ kind: 'config/degraded', action: 'none' }));

      expect(signals.all).toHaveLength(3);
      expect(signals.needingAction).toEqual([refused]);
    });

    it('has nothing needing action when everything resolved itself', () => {
      const signals = new FsSignals();
      signals.add(aSignal());
      expect(signals.needingAction).toEqual([]);
    });
  });

  // ...........................................................................
  describe('subscribing', () => {
    it('tells every listener, in order', () => {
      const signals = new FsSignals();
      const seen: string[] = [];
      signals.subscribe((s) => seen.push(`a:${s.kind}`));
      signals.subscribe((s) => seen.push(`b:${s.kind}`));
      signals.add(aSignal({ kind: 'join/recovered' }));

      expect(seen).toEqual(['a:join/recovered', 'b:join/recovered']);
    });

    it('stops telling an unsubscribed listener', () => {
      const signals = new FsSignals();
      const seen: FsSignal[] = [];
      const off = signals.subscribe((s) => seen.push(s));
      signals.add(aSignal());
      off();
      signals.add(aSignal());

      expect(seen).toHaveLength(1);
    });

    it('survives a listener that throws, and still tells the next one', () => {
      // A host's UI bug must not stop a sync, and must not cost the OTHER
      // subscriber its notification either.
      const signals = new FsSignals();
      const seen: string[] = [];
      signals.subscribe(() => {
        throw new Error('listener is broken');
      });
      signals.subscribe((s) => seen.push(s.kind));

      expect(() => signals.add(aSignal())).not.toThrow();
      expect(seen).toEqual(['conflict/merged']);
      // And it was still recorded.
      expect(signals.all).toHaveLength(1);
    });
  });

  // ...........................................................................
  describe('reporting a standing condition once', () => {
    it('records the first and ignores the repeat', () => {
      const signals = new FsSignals();
      const first = signals.addOnce('cfg', aSignal({ kind: 'config/degraded' }));
      const again = signals.addOnce('cfg', aSignal({ kind: 'config/degraded' }));

      expect(first).toBeDefined();
      expect(again).toBeUndefined();
      expect(signals.all).toHaveLength(1);
      expect(signals.totals()['config/degraded']).toBe(1);
    });

    it('treats a different key as a different condition', () => {
      const signals = new FsSignals();
      signals.addOnce('a', aSignal());
      signals.addOnce('b', aSignal());
      expect(signals.all).toHaveLength(2);
    });

    it('bounds the keys it remembers, rather than leaking', () => {
      // A key can be derived from live state — the pair of refs a divergence is
      // between — so a churning fleet produces new keys indefinitely. Dropping
      // the oldest means such a signal may be reported again later, which is
      // noise rather than a falsehood. An unbounded set would be a leak, and
      // this package has shipped two of those.
      const signals = new FsSignals();
      for (let i = 0; i < SIGNAL_ONCE_MAX + 1; i++) {
        signals.addOnce(`k${i}`, aSignal({ at: i }));
      }
      // The first key was forgotten, so it reports again.
      expect(signals.addOnce('k0', aSignal())).toBeDefined();
      // The newest is still remembered.
      expect(signals.addOnce(`k${SIGNAL_ONCE_MAX}`, aSignal())).toBeUndefined();
    });
  });

  // ...........................................................................
  describe('persisting and coming back', () => {
    it('round trips the signals and the totals', () => {
      const signals = new FsSignals();
      for (let i = 0; i < 3; i++) signals.add(aSignal({ at: i }));
      const log = signals.persisted();

      const restored = new FsSignals();
      restored.restore(JSON.parse(JSON.stringify(log)));

      expect(restored.all).toHaveLength(3);
      expect(restored.totals()).toEqual({ 'conflict/merged': 3 });
    });

    it('brings back a total that is LARGER than the list', () => {
      // The point of persisting the counter separately: a folder that produced
      // two thousand refusals still says two thousand after a restart, even
      // though only the newest 200 are kept.
      const restored = new FsSignals();
      restored.restore({
        signals: [],
        totals: { 'deletion/refused': 2_000 },
      });
      expect(restored.totals()['deletion/refused']).toBe(2_000);
      expect(restored.all).toEqual([]);
    });

    it('applies the cap to what it reads, not just to what it records', () => {
      const tooMany = Array.from({ length: SIGNAL_LOG_MAX + 5 }, (_, i) => ({
        kind: 'conflict/merged',
        at: i,
        paths: [],
        pathCount: 0,
        action: 'review',
      }));
      const restored = new FsSignals();
      restored.restore({ signals: tooMany, totals: {} });
      expect(restored.all).toHaveLength(SIGNAL_LOG_MAX);
    });

    it('keeps a kind it has never heard of', () => {
      // A log written by a NEWER build. An unknown kind is still a true record
      // of something that happened to this folder, and dropping it would make a
      // downgrade lose history it could have shown.
      const restored = new FsSignals();
      restored.restore({
        signals: [
          {
            kind: 'something/invented-later',
            at: 1,
            paths: ['x.txt'],
            pathCount: 1,
            action: 'review',
          },
        ],
        totals: { 'something/invented-later': 1 },
      });
      expect(restored.all).toHaveLength(1);
      expect(restored.all[0].kind).toBe('something/invented-later');
    });

    // .........................................................................
    // TOLERANCE, one case per branch. A log that cannot be understood is
    // skipped, never thrown: a corrupt notification file must not stop a folder
    // from syncing.
    // .........................................................................
    it.each([
      ['not an object', 'a string' as unknown],
      ['null', null],
      ['no signals and no totals', {}],
      ['signals that is not an array', { signals: 'nope' }],
      ['totals that is not an object', { signals: [], totals: 'nope' }],
      ['totals that is null', { signals: [], totals: null }],
    ])('ignores a log that is %s', (_what, raw) => {
      const restored = new FsSignals();
      expect(() => restored.restore(raw)).not.toThrow();
      expect(restored.all).toEqual([]);
      expect(restored.totals()).toEqual({});
    });

    it.each([
      ['not an object', 'nope'],
      ['null', null],
      ['missing kind', { at: 1, paths: [], pathCount: 0, action: 'review' }],
      ['a kind that is not a string', { kind: 7, at: 1, paths: [], pathCount: 0, action: 'review' }],
      ['missing at', { kind: 'conflict/merged', paths: [], pathCount: 0, action: 'review' }],
      ['paths that is not an array', { kind: 'conflict/merged', at: 1, paths: 'x', pathCount: 0, action: 'review' }],
      ['missing pathCount', { kind: 'conflict/merged', at: 1, paths: [], action: 'review' }],
      ['missing action', { kind: 'conflict/merged', at: 1, paths: [], pathCount: 0 }],
    ])('skips an entry that is %s', (_what, entry) => {
      const restored = new FsSignals();
      restored.restore({ signals: [entry], totals: {} });
      expect(restored.all).toEqual([]);
    });

    it('skips a total that is not a finite number', () => {
      const restored = new FsSignals();
      restored.restore({
        signals: [],
        totals: { a: 'seven', b: Number.NaN, c: 3 },
      });
      expect(restored.totals()).toEqual({ c: 3 });
    });

    it('keeps the good entries from a log with one bad one', () => {
      // The realistic shape of a half-written file, and the reason the loop
      // skips rather than returns.
      const restored = new FsSignals();
      restored.restore({
        signals: [
          { kind: 'conflict/merged', at: 1, paths: [], pathCount: 0, action: 'review' },
          'rubbish',
          { kind: 'join/recovered', at: 2, paths: [], pathCount: 0, action: 'review' },
        ],
        totals: {},
      });
      expect(restored.all.map((s) => s.kind)).toEqual([
        'conflict/merged',
        'join/recovered',
      ]);
    });

    it('does not tell subscribers about what it restored', () => {
      // Restoring is not an event. A host attaching a listener on start wants
      // to hear what happens NEXT; replaying history through the callback would
      // make every restart look like a fresh folder-wide conflict.
      const restored = new FsSignals();
      const listener = vi.fn();
      restored.subscribe(listener);
      restored.restore({
        signals: [
          { kind: 'conflict/merged', at: 1, paths: [], pathCount: 0, action: 'review' },
        ],
        totals: {},
      });
      expect(listener).not.toHaveBeenCalled();
      expect(restored.all).toHaveLength(1);
    });
  });
});
