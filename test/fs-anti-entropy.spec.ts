// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, vi } from 'vitest';

import {
  AntiEntropyAction,
  CONTENT_AGREED_MAX,
  antiEntropyDecision,
  AntiEntropyView,
  DEFAULT_ANTI_ENTROPY,
  FsAntiEntropy,
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

  // A fork: local work the hub has not seen, and a hub state descending from
  // an ancestor both sides share. The first case below is a KNOWN DEFECT and
  // says so; the rest are the behaviour that must not move while it is fixed.
  describe('a fork, with local work that has not reached the hub', () => {
    // The test that used to live here asserted the WRONG answer on purpose —
    // a node holding work the hub had not seen decided it was behind and
    // pulled, discarding that work (§1.1, measured on node-C). Its comment
    // said: "When D1 goes green that test is deleted, not amended."
    //
    // D1 is green (`fs-anti-entropy-level1.spec.ts`), so it is deleted. The
    // fix is the 0.0.84 narrowing plus the origin tie-break that makes it
    // safe; the cases below are the ones that had to keep working.

    it('pushes when the hub sits on the very state our work was made from', () => {
      // The ordinary "our push was missed" case, which must keep working.
      expect(
        antiEntropyDecision(
          { ref: 'ca3ls', origin: 'hub', predecessors: ['S'] },
          view({
            currentRef: 'qFU9',
            lastPushedRef: 'qFU9',
            lastAppliedRef: 'ca3ls',
          }),
        ),
      ).toBe('push');
    });

    it('still pulls when the hub state was made from what we hold NOW', () => {
      // Being genuinely behind is unchanged: a forward built on our current
      // state is a forward, authored work or not.
      expect(
        antiEntropyDecision(
          { ref: 'S2', origin: 'hub', predecessors: ['qFU9'] },
          view({ currentRef: 'qFU9', lastPushedRef: 'qFU9', lastAppliedRef: 'S' }),
        ),
      ).toBe('pull');
    });

    it('keeps counting what we applied while we have authored nothing', () => {
      // The guard is scoped to authorship on purpose: a node that only ever
      // applied has no work of its own to lose, and pulling a forward built on
      // the state it adopted is still right.
      expect(
        antiEntropyDecision(
          { ref: 'S2', predecessors: ['A1'] },
          view({ lastAppliedRef: 'A1' }),
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
    // One deferred answer per ref, so a test can hold a content check open and
    // watch what a repeat announcement does with it.
    const asked: string[] = [];
    const pending = new Map<string, (v: ContentComparison) => void>();
    const ae = new FsAntiEntropy(options, {
      view: () => state,
      busy: () => busy,
      repair: (...args) => repairs.push(args),
      sameContent: (ref) => {
        asked.push(ref);
        return new Promise<ContentComparison>((resolve) =>
          pending.set(ref, resolve),
        );
      },
      now: () => now,
      log,
    });
    return {
      ae,
      state,
      repairs,
      log,
      asked,
      answer: async (ref: string, same: boolean) => {
        pending.get(ref)?.({ same, differing: same ? [] : ['some/path'] });
        pending.delete(ref);
        await Promise.resolve();
        await Promise.resolve();
      },
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
      // Empty, and that is not the same as "they agree" — `diverged` says
      // which. See `AntiEntropyStatus.differingPaths`.
      differingPaths: [],
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

  // The review's case (an earlier change): another machine writes every few seconds, so
  // the hub's state never holds still. The grace period used to restart on
  // every one of those changes — and a node that missed them all never got a
  // repair, showing "noch kein Reparaturversuch" for good.
  it('repairs a node that sits still while the hub keeps moving', () => {
    const { ae, repairs, advance } = setup();
    ae.observe({ ref: 'H1', predecessors: ['S1'] });
    advance(40);
    ae.observe({ ref: 'H2', predecessors: ['H1'] });
    advance(40);
    ae.observe({ ref: 'H3', predecessors: ['H2'] });
    expect(repairs).toHaveLength(0); // 80 ms: still inside the grace
    advance(40);
    ae.observe({ ref: 'H4', predecessors: ['H3'] });
    // 120 ms, our state unchanged the whole time: repaired, against the
    // hub's LATEST state — however often it moved meanwhile.
    expect(repairs).toHaveLength(1);
    expect(repairs[0].slice(0, 2)).toEqual(['merge', 'H4']);
    expect(ae.status.divergedSince).toBe(1_000);
  });

  it('starts over when OUR state moves — a node keeping up needs no repair', () => {
    const { ae, state, repairs, advance } = setup();
    ae.observe({ ref: 'X' });
    advance(80);
    state.currentRef = 'S2'; // applied a forward: keeping up
    ae.observe({ ref: 'Y' });
    advance(80);
    ae.observe({ ref: 'Y' });
    expect(repairs).toHaveLength(0); // 80 ms since our last move
    // …but it has been diverged since the first sighting.
    expect(ae.status.divergedSince).toBe(1_000);
    advance(40);
    ae.observe({ ref: 'Y' });
    expect(repairs).toHaveLength(1);
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

  it('reports a blocked divergence without repairing it', () => {
    // The ancestry could not be resolved far enough to say who is behind, and
    // every action available is destructive in one direction or the other. So
    // the divergence stays open, nothing is applied, nothing is latched, and
    // the next announcement tries again — by which time the missing rows may
    // have arrived.
    //
    // Visible in `lastRepair.action`, because a node stuck this way has to be
    // diagnosable. NOT counted in `repairs`, because nothing was repaired —
    // a repair count that grew while nothing happened is how "it is trying"
    // gets read off a node that is doing nothing at all.
    const repairs: string[] = [];
    let now = 0;
    const ae = new FsAntiEntropy(
      { graceMs: 100 },
      {
        view: () => ({
          origin: 'me',
          currentRef: 'S1',
          lastAppliedRef: undefined,
          lastPushedRef: undefined,
        }),
        busy: () => false,
        repair: (action) => repairs.push(action),
        now: () => now,
        log: () => {},
      },
    );

    const hub = {
      ref: 'S2',
      origin: 'hub',
      predecessors: ['S0'],
      reachability: 'incomplete' as const,
    };
    ae.observe(hub);
    now += 200;
    ae.observe(hub);

    expect(repairs).toEqual([]);
    expect(ae.status.repairs).toBe(0);
    expect(ae.status.lastRepair?.action).toBe('blocked');
    expect(ae.status.diverged).toBe(true);
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

  // ...........................................................................
  describe('content agreement — two refs, one folder', () => {
    // §2.1b, and the last thing standing between this work and a lockstep
    // rollout.
    //
    // A tree ref hashes the whole tree, so two nodes derive different ones for
    // byte-identical content whenever anything outside the content map
    // differs. The scan's canonical child order removed one such cause — and
    // during a ROLLOUT a node on an older build still derives the old ref, by
    // construction, for every folder it holds.
    //
    // measured on a real fleet before any of this: both machines held 38 identical
    // files with identical hashes, and one reported `diverged: true` for over
    // EIGHT MINUTES across six merge repairs, logging "equivalent content,
    // skipping restore" every time. The apply path correctly saw nothing to
    // transfer; the anti-entropy correctly saw two refs; neither was wrong,
    // and the system deadlocked against itself by design.
    //
    // A bucket round settles what a ref comparison cannot: identical
    // per-bucket roots mean the folders ARE the same. That verdict is recorded
    // here, so the divergence stops being reported rather than rediscovered on
    // every beacon.
    const build = (onRepair: (a: AntiEntropyAction) => void = () => {}) => {
      let now = 0;
      const ae = new FsAntiEntropy(
        { graceMs: 100 },
        {
          view: () => ({
            origin: 'me',
            currentRef: 'OUR-NAME-FOR-IT',
            lastAppliedRef: undefined,
            lastPushedRef: 'OUR-NAME-FOR-IT',
          }),
          busy: () => false,
          repair: (action) => onRepair(action),
          now: () => now,
          log: () => {},
        },
      );
      return { ae, tick: (ms: number) => (now += ms) };
    };

    const theirName = { ref: 'THEIR-NAME-FOR-IT', origin: 'hub' };

    it('stops reporting a divergence once the content is proven equal', () => {
      const repairs: AntiEntropyAction[] = [];
      const { ae, tick } = build((a) => repairs.push(a));

      ae.observe(theirName);
      expect(ae.status.diverged).toBe(true);

      // The round ran and the roots matched.
      ae.agreedOn('THEIR-NAME-FOR-IT');
      expect(ae.status.diverged).toBe(false);

      // And it stays resolved however long the hub keeps announcing it — this
      // is the eight minutes.
      for (let i = 0; i < 20; i++) {
        tick(200);
        ae.observe(theirName);
      }
      expect(ae.status.diverged).toBe(false);
      expect(repairs).toEqual([]);
    });

    it('still reports a divergence against a ref it has NOT agreed on', () => {
      // The verdict is per ref, not a blanket "stop worrying". A hub that
      // genuinely moves on must still be noticed.
      const { ae, tick } = build();
      ae.agreedOn('THEIR-NAME-FOR-IT');
      ae.observe({ ref: 'SOMETHING-NEW', origin: 'hub' });
      tick(200);
      ae.observe({ ref: 'SOMETHING-NEW', origin: 'hub' });
      expect(ae.status.diverged).toBe(true);
    });

    it('agrees before the divergence is even noticed', () => {
      // Order-independent: a round can finish before the beacon that would
      // have reported the divergence arrives.
      const { ae } = build();
      ae.agreedOn('THEIR-NAME-FOR-IT');
      ae.observe(theirName);
      expect(ae.status.diverged).toBe(false);
    });

    // INVERTED, and the reason is a worse defect behind it.
    //
    // Keying the memo on the pair makes this pass and was measured doing so.
    // It also turns the divergence detector back on, and the repair behind it
    // is not safe yet: I7b (*a delivered deletion does not beat a later
    // re-creation*) went from 5 of 5 to 0 of 6, because the anti-entropy
    // decided `pull` for a node that was AHEAD and merged its freshly
    // re-created file away.
    //
    // NO LONGER INVERTED. This was red for a long time and said why: keying
    // the memo on the pair turned the divergence detector back on, and the
    // repair behind it then chose `pull` for a node that was AHEAD and merged
    // its freshly re-created file away.
    //
    // What made it safe was not the memo. `_classifyAnnouncedRef` was trusting
    // a chain verdict about a head that no longer named its own folder, so
    // `behind` was true of the head and false of the node. With that fixed —
    // a verdict requires the head to name the state the folder is in — the
    // repair stopped being wrong, and the memo could be corrected.
    //
    // The order mattered and it was the opposite of the obvious one: fix what
    // the repair is told, then stop hiding what it is told about.
    it('forgets the agreement once THIS node has moved on', async () => {
      // The agreement is about a PAIR — "the hub's ref describes the same
      // content as the state I am in" — and it is true only while neither side
      // moves. Keyed on the hub ref alone it survived this node changing
      // underneath it, so a later announcement of the same ref cleared the
      // divergence with no content check at all, for ever.
      //
      // Measured before this: all four nodes of a churn run reporting
      // `diverged=false` while their own `differingPaths` named `two.txt`,
      // stable, with the content genuinely different. The two signals
      // contradicted each other because one was memoised and the other was
      // not — and the repair is gated on the memoised one.
      let now = 0;
      let localRef = 'OUR-NAME-FOR-IT';
      const ae = new FsAntiEntropy(
        { graceMs: 100 },
        {
          view: () => ({
            origin: 'me',
            currentRef: localRef,
            lastAppliedRef: undefined,
            lastPushedRef: localRef,
          }),
          busy: () => false,
          repair: () => {},
          now: () => now,
          log: () => {},
        },
      );

      // Proven equal, so the divergence is correctly dropped.
      ae.observe(theirName);
      ae.agreedOn('THEIR-NAME-FOR-IT');
      expect(ae.status.diverged).toBe(false);

      // Now THIS node changes — a local edit, a merge, a conflict copy — and
      // the hub re-announces the state it was already in. The old agreement
      // says nothing about this new pair.
      localRef = 'OUR-NEW-STATE';
      now += 1_000;
      ae.observe(theirName);
      expect(
        ae.status.diverged,
        'a stale agreement suppressed a real divergence, and nothing would ' +
          'ever re-check it',
      ).toBe(true);
    });

    it('keeps the agreement while neither side has moved', () => {
      // The other direction, and the reason the memo exists: a repeating
      // beacon must not cost a content comparison every time.
      const { ae, tick } = build();
      ae.observe(theirName);
      ae.agreedOn('THEIR-NAME-FOR-IT');
      expect(ae.status.diverged).toBe(false);
      tick(1_000);
      ae.observe(theirName);
      expect(ae.status.diverged).toBe(false);
    });

    it('bounds what it remembers', () => {
      // Keyed on refs a PEER chooses, so a hub whose state changes constantly
      // must not grow this without limit.
      const { ae } = build();
      for (let i = 0; i < CONTENT_AGREED_MAX + 50; i++) ae.agreedOn(`r${i}`);
      // The oldest verdicts are forgotten, so an old ref is a divergence
      // again — which is the safe direction: it gets re-proven by a round.
      ae.observe({ ref: 'r0', origin: 'hub' });
      expect(ae.status.diverged).toBe(true);
      // The newest is still remembered.
      ae.observe({ ref: `r${CONTENT_AGREED_MAX + 49}`, origin: 'hub' });
      expect(ae.status.diverged).toBe(false);
    });
  });

  // ...........................................................................
  // Asking whether the content is the same, rather than whether the
  // fingerprints are.
  //
  // A state beacon carries a ref and triggers no apply, so without this
  // nothing in the agent ever reads the hub's tree and nothing discovers that
  // the two folders are identical. measured on a real fleet: `diverged: true` for
  // over EIGHT MINUTES on a node holding exactly the hub's 38 files, across
  // six merge repairs, logging "equivalent content, skipping restore" every
  // time.
  // ...........................................................................
  it('asks once per ref, not once per beacon', async () => {
    // A beacon repeats. A second fetch of the tree the first fetch is still
    // reading answers the same question at twice the cost.
    const h = setup({ currentRef: 'LOCAL', lastAppliedRef: 'LOCAL' });
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    expect(h.asked).toEqual(['HUB']);

    // And once the answer is yes, it is never asked again.
    await h.answer('HUB', true);
    expect(h.ae.status.diverged).toBe(false);
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    expect(h.asked).toEqual(['HUB']);
  });

  // ...........................................................................
  it('clears a divergence the content check disproves', async () => {
    const h = setup({ currentRef: 'LOCAL', lastAppliedRef: 'LOCAL' });
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    // Reported while it is genuinely unknown — the node has not read that
    // tree yet. The defect was never finding out, not reporting it meanwhile.
    expect(h.ae.status.diverged).toBe(true);

    await h.answer('HUB', true);
    expect(h.ae.status.diverged).toBe(false);
  });

  // ...........................................................................
  it('leaves a real divergence standing when the content differs', async () => {
    // The control. A signal that cannot go red is as useless as one that
    // cannot go green, and a `no` must not be cached either — content
    // differing is exactly what the repair is for.
    const h = setup({ currentRef: 'LOCAL', lastAppliedRef: 'LOCAL' });
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    await h.answer('HUB', false);
    expect(h.ae.status.diverged).toBe(true);

    // Not cached, so a later beacon asks again — the two sides move.
    h.ae.observe({ ref: 'HUB', predecessors: ['OTHER'] });
    expect(h.asked).toEqual(['HUB', 'HUB']);
  });

  // ...........................................................................
  it('survives a content check that fails', async () => {
    // An unreachable tree, a timeout, a peer gone. This was only ever an
    // opportunity to avoid a repair, so losing it must cost nothing but the
    // repair happening as it did before.
    const h = setup({ currentRef: 'LOCAL', lastAppliedRef: 'LOCAL' });
    const ae = new FsAntiEntropy(
      { graceMs: 100, maxBackoffMs: 350 },
      {
        view: () => h.state,
        busy: () => false,
        repair: () => {},
        sameContent: () => Promise.reject(new Error('tree unreachable')),
      },
    );
    expect(() =>
      ae.observe({ ref: 'HUB', predecessors: ['OTHER'] }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(ae.status.diverged).toBe(true);
  });

  // ...........................................................................
  it('works without a content check at all', () => {
    // Optional, because a host that cannot answer is no worse off than before:
    // the repair still runs and a bucket round still settles it.
    const h = setup({ currentRef: 'LOCAL', lastAppliedRef: 'LOCAL' });
    const ae = new FsAntiEntropy(
      { graceMs: 100, maxBackoffMs: 350 },
      { view: () => h.state, busy: () => false, repair: () => {} },
    );
    expect(() =>
      ae.observe({ ref: 'HUB', predecessors: ['OTHER'] }),
    ).not.toThrow();
    expect(ae.status.diverged).toBe(true);
  });
});
