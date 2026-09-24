// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, vi } from 'vitest';

import {
  AntiEntropyAction,
  antiEntropyDecision,
  AntiEntropyView,
  DEFAULT_ANTI_ENTROPY,
  FsAntiEntropy,
  stateBeaconEvent,
} from '../src/fs-anti-entropy.ts';

const view = (v: Partial<AntiEntropyView> = {}): AntiEntropyView => ({
  origin: 'me',
  currentRef: 'S1',
  lastAppliedRef: undefined,
  lastPushedRef: undefined,
  ...v,
});

describe('antiEntropyDecision', () => {
  it('has nothing to compare before the folder has a state', () => {
    expect(
      antiEntropyDecision({ ref: 'S1' }, view({ currentRef: undefined })),
    ).toBe('unknown');
  });

  it('agrees when the hub holds our state', () => {
    expect(
      antiEntropyDecision({ ref: 'S1', predecessors: ['S0'] }, view()),
    ).toBe('in-sync');
  });

  it('pulls a hub state made from the one we are in', () => {
    // A forward we never received.
    expect(
      antiEntropyDecision({ ref: 'S2', predecessors: ['S1'] }, view()),
    ).toBe('pull');
  });

  it('pulls a hub state made from the one we last applied', () => {
    expect(
      antiEntropyDecision(
        { ref: 'S2', predecessors: ['A1'] },
        view({ lastAppliedRef: 'A1' }),
      ),
    ).toBe('pull');
  });

  // The two cases that look identical in refs and ancestry. Only the origin
  // of the hub's state tells them apart — see the header of the module.
  describe('a deletion that returns the folder to a state it held', () => {
    it('pulls it when a PEER deleted', () => {
      // A created the file (S0 → S1); B deleted it (S1 → S0).
      expect(
        antiEntropyDecision(
          { ref: 'S0', origin: 'B', predecessors: ['S1'] },
          view({ currentRef: 'S1', lastPushedRef: 'S1' }),
        ),
      ).toBe('pull');
    });

    it('pushes it when WE deleted and the hub missed it', () => {
      // A created the file (S0 → S1), then deleted it (S1 → S0) and that
      // push was lost: the hub still holds A's own S1, made from S0.
      expect(
        antiEntropyDecision(
          { ref: 'S1', origin: 'me', predecessors: ['S0'] },
          view({ currentRef: 'S0', lastPushedRef: 'S0' }),
        ),
      ).toBe('push');
    });

    it('pulls it when the state it returns to is one we once applied', () => {
      // A adopted S0 (the seed), created a file (S1), and B deleted it —
      // back to S0, which is also A's last applied state. The ancestry says
      // S0 was made FROM S1, and that outranks "the hub holds what we
      // applied". Pushing here put the deleted file back on every node.
      expect(
        antiEntropyDecision(
          { ref: 'S0', origin: 'B', predecessors: ['S1'] },
          view({ currentRef: 'S1', lastPushedRef: 'S1', lastAppliedRef: 'S0' }),
        ),
      ).toBe('pull');
    });
  });

  it('pushes when the hub still holds what we applied before our push', () => {
    expect(
      antiEntropyDecision(
        { ref: 'A1', origin: 'B' },
        view({ lastAppliedRef: 'A1', lastPushedRef: 'S1' }),
      ),
    ).toBe('push');
  });

  // An apply can leave the folder short of what it applied. Re-announcing
  // that would roll the peers back, so only our OWN pushed state is pushed.
  it('never pushes a state it did not author', () => {
    expect(
      antiEntropyDecision(
        { ref: 'A1', origin: 'me' },
        view({ lastAppliedRef: 'A1', lastPushedRef: 'S0' }),
      ),
    ).toBe('merge');
  });

  it('merges a hub state it knows nothing about', () => {
    expect(
      antiEntropyDecision({ ref: 'X', origin: 'B', predecessors: ['Y'] }, view()),
    ).toBe('merge');
  });

  it('merges a seeded hub state, which carries no ancestry', () => {
    expect(
      antiEntropyDecision(
        { ref: 'X', origin: '__server__' },
        view({ lastPushedRef: 'S1' }),
      ),
    ).toBe('merge');
  });
});

describe('FsAntiEntropy', () => {
  const setup = (
    v: Partial<AntiEntropyView> = {},
    options: ConstructorParameters<typeof FsAntiEntropy>[0] = {
      graceMs: 100,
      maxBackoffMs: 350,
    },
  ) => {
    let now = 1_000;
    let busy = false;
    const state = view(v);
    const repairs: Array<[AntiEntropyAction, string, string[], number]> = [];
    const log = vi.fn();
    const ae = new FsAntiEntropy(options, {
      view: () => state,
      busy: () => busy,
      repair: (...args) => repairs.push(args),
      now: () => now,
      log,
    });
    return {
      ae,
      state,
      repairs,
      log,
      advance: (ms: number) => (now += ms),
      setBusy: (b: boolean) => (busy = b),
    };
  };

  it('defaults to on, with a ten-second grace', () => {
    expect(DEFAULT_ANTI_ENTROPY).toEqual({
      enabled: true,
      graceMs: 10_000,
      maxBackoffMs: 300_000,
    });
    const ae = new FsAntiEntropy(undefined, {
      view: () => view(),
      busy: () => false,
      repair: () => {},
    });
    expect(ae.enabled).toBe(true);
    expect(ae.status).toEqual({
      diverged: false,
      divergedSince: null,
      hubRef: null,
      localRef: null,
      repairs: 0,
      lastRepair: null,
    });
  });

  it('logs to the console by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    const ae = new FsAntiEntropy(
      { graceMs: 10 },
      {
        view: () => view(),
        busy: () => false,
        repair: () => {},
        now: () => now,
      },
    );
    ae.observe({ ref: 'S2', predecessors: ['S1'] });
    now = 20;
    ae.observe({ ref: 'S2', predecessors: ['S1'] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('anti-entropy: hub=S2'),
    );
    warn.mockRestore();
  });

  it('reads the real clock when none is given', () => {
    const ae = new FsAntiEntropy(
      {},
      { view: () => view(), busy: () => false, repair: () => {} },
    );
    const before = Date.now();
    ae.observe({ ref: 'S2' });
    expect(ae.status.divergedSince).toBeGreaterThanOrEqual(before);
  });

  it('ignores announcements before the folder has a state', () => {
    const { ae } = setup({ currentRef: undefined });
    ae.observe({ ref: 'S2' });
    expect(ae.status.hubRef).toBeNull();
  });

  it('waits out the grace period before it repairs', () => {
    const { ae, repairs, advance } = setup();
    const hub = { ref: 'S2', predecessors: ['S1'] };

    ae.observe(hub);
    expect(ae.status.diverged).toBe(true);
    expect(repairs).toHaveLength(0);

    advance(50);
    ae.observe(hub);
    expect(repairs).toHaveLength(0);

    advance(60);
    ae.observe(hub);
    expect(repairs).toEqual([['pull', 'S2', ['S1'], 1]]);
    expect(ae.status.repairs).toBe(1);
    expect(ae.status.lastRepair).toEqual({
      action: 'pull',
      at: 1_110,
      hubRef: 'S2',
      localRef: 'S1',
      attempt: 1,
    });
  });

  it('backs off between repeated repairs of the same divergence', () => {
    const { ae, repairs, advance } = setup();
    const hub = { ref: 'X' };
    ae.observe(hub); // first sighting
    advance(100);
    ae.observe(hub); // attempt 1, next after 100
    advance(100);
    ae.observe(hub); // attempt 2, next after 200
    advance(150);
    ae.observe(hub); // too early
    advance(50);
    ae.observe(hub); // attempt 3, capped at 350
    advance(349);
    ae.observe(hub); // too early
    advance(1);
    ae.observe(hub); // attempt 4
    expect(repairs.map((r) => r[3])).toEqual([1, 2, 3, 4]);
    expect(repairs[0][2]).toEqual([]);
  });

  it('starts over when the divergence changes', () => {
    const { ae, state, repairs, advance } = setup();
    ae.observe({ ref: 'X' });
    advance(100);
    ae.observe({ ref: 'Y' }); // a different divergence: grace again
    expect(repairs).toHaveLength(0);
    // …but it has been diverged since the first sighting.
    expect(ae.status.divergedSince).toBe(1_000);

    state.currentRef = 'S9';
    advance(100);
    ae.observe({ ref: 'Y' });
    expect(repairs).toHaveLength(0);
  });

  it('forgets a divergence once it heals', () => {
    const { ae, repairs, advance } = setup();
    ae.observe({ ref: 'X' });
    advance(100);
    ae.observe({ ref: 'S1' });
    expect(ae.status.diverged).toBe(false);
    advance(100);
    ae.observe({ ref: 'X' }); // new sighting, not a repair
    expect(repairs).toHaveLength(0);
  });

  it('does not repair while something is applying', () => {
    const { ae, repairs, advance, setBusy } = setup();
    ae.observe({ ref: 'X' });
    advance(100);
    setBusy(true);
    ae.observe({ ref: 'X' });
    expect(repairs).toHaveLength(0);
    setBusy(false);
    ae.observe({ ref: 'X' });
    expect(repairs).toHaveLength(1);
  });

  it('only observes when switched off', () => {
    const { ae, repairs, advance } = setup({}, { enabled: false, graceMs: 10 });
    expect(ae.enabled).toBe(false);
    ae.observe({ ref: 'X' });
    advance(100);
    ae.observe({ ref: 'X' });
    expect(repairs).toHaveLength(0);
    // Still says so: a divergence nobody repairs must at least be visible.
    expect(ae.status.diverged).toBe(true);
    expect(ae.status.hubRef).toBe('X');
  });

  it('hands the repair a copy of the ancestry', () => {
    const { ae, repairs, advance } = setup();
    const hub = { ref: 'S2', predecessors: ['S1'] };
    ae.observe(hub);
    advance(100);
    ae.observe(hub);
    expect(repairs[0][2]).toEqual(['S1']);
    expect(repairs[0][2]).not.toBe(hub.predecessors);
  });
});

describe('stateBeaconEvent', () => {
  // Must match @rljson/server's own helper; this package does not import it.
  it('is the route with :state', () => {
    expect(stateBeaconEvent('/sharedTree')).toBe('/sharedTree:state');
  });
});
