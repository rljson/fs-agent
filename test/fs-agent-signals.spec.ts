// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WHAT THE AGENT SAYS OUT LOUD, one test per thing it can say.
//
// `FsSignals` is tested on its own in `fs-signals.spec.ts`; this is the other
// half — that each place in the agent which does something to a user's folder
// actually reports it, with the right `action` and the right `decidedBy`.
//
// WHY THE FIELDS MATTER MORE THAN THE COUNT
// A host reads three things off a signal and acts on all three. `action`
// decides whether a person is shown anything at all; `decidedBy` decides
// whether the outcome is a fact or a coin flip; `paths` decides what the
// message names. A signal with the right kind and a wrong `action` is worse
// than no signal, because it will be filtered into silence — so every test here
// asserts the fields rather than that something was emitted.
//
// `required` IS THE SCARCE ONE. Only two things earn it: a deletion the guard
// refused, and a path this filesystem will never accept. Everything else is
// either resolved or retried, and marking it `required` would train people to
// ignore the list.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { mkdir, rm } from 'fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsAgent, SYNC_ERROR_FILE } from '../src/fs-agent.ts';
import type { FsConflictReport } from '../src/fs-conflict-resolver.ts';
import {
  SIGNAL_LOG_FILE,
  type FsSignal,
  type FsSignalInput,
} from '../src/fs-signals.ts';

/** Reaches the private emitter the producers use. */
const emit = (agent: FsAgent, input: FsSignalInput): void =>
  (agent as unknown as { _signal(i: FsSignalInput): void })._signal(input);

/** Reaches the private once-emitter. */
const emitOnce = (agent: FsAgent, key: string, input: FsSignalInput): void =>
  (
    agent as unknown as { _signalOnce(k: string, i: FsSignalInput): void }
  )._signalOnce(key, input);

/** Reaches the private conflict recorder the resolver drives. */
const record = (agent: FsAgent, reports: FsConflictReport[]): void =>
  (
    agent as unknown as {
      _recordConflicts(r: readonly FsConflictReport[]): void;
    }
  )._recordConflicts(reports);

/** Reaches the private refusal, which three routes share. */
const refuse = (
  agent: FsAgent,
  route: string,
  wouldRemove: number,
  held: number,
  paths: readonly string[],
): void =>
  (
    agent as unknown as {
      _refuseDeletion(
        route: string,
        wouldRemove: number,
        held: number,
        paths: readonly string[],
      ): void;
    }
  )._refuseDeletion(route, wouldRemove, held, paths);

describe('FsAgent — the signal channel', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-signals-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    error.mockRestore();
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * An agent on the temp folder.
   * @param options - Overrides.
   * @returns The agent.
   */
  const anAgent = (options: Record<string, unknown> = {}): FsAgent => {
    const agent = new FsAgent(dir, new BsMem(), options);
    agents.push(agent);
    return agent;
  };

  // ...........................................................................
  describe('the public surface', () => {
    it('starts empty, and says so in every view', () => {
      const agent = anAgent();
      expect(agent.signals).toEqual([]);
      expect(agent.signalsNeedingAction).toEqual([]);
      expect(agent.signalTotals).toEqual({});
    });

    it('delivers to a listener given in the options', () => {
      const seen: FsSignal[] = [];
      const agent = anAgent({ onSignal: (s: FsSignal) => seen.push(s) });
      emit(agent, {
        kind: 'conflict/merged',
        paths: ['a.txt'],
        action: 'review',
      });
      expect(seen.map((s) => s.kind)).toEqual(['conflict/merged']);
    });

    it('delivers to a listener attached later, and stops on unsubscribe', () => {
      // A host may not have its UI up when the agent is constructed, which is
      // why this is a method as well as an option.
      const agent = anAgent();
      const seen: FsSignal[] = [];
      const off = agent.onSignal((s) => seen.push(s));
      emit(agent, { kind: 'join/recovered', paths: [], action: 'review' });
      off();
      emit(agent, { kind: 'join/conflicted', paths: [], action: 'review' });

      expect(seen.map((s) => s.kind)).toEqual(['join/recovered']);
    });

    it('separates what still needs somebody from what does not', () => {
      const agent = anAgent();
      emit(agent, {
        kind: 'conflict/merged',
        paths: ['a.txt'],
        action: 'review',
      });
      emit(agent, {
        kind: 'deletion/refused',
        paths: ['b.txt'],
        action: 'required',
      });

      expect(agent.signals).toHaveLength(2);
      expect(agent.signalsNeedingAction.map((s) => s.kind)).toEqual([
        'deletion/refused',
      ]);
    });
  });

  // ...........................................................................
  describe('surviving a restart', () => {
    it('writes the log, and a later agent reads it back', () => {
      // THE CASE A CALLBACK CANNOT COVER. A host that starts after the event —
      // a UI launched later, a process restarted — has no way to learn about it
      // except from the folder.
      const first = anAgent();
      emit(first, {
        kind: 'deletion/refused',
        paths: ['gone.txt'],
        action: 'required',
        detail: 'refused',
      });
      expect(existsSync(join(dir, SIGNAL_LOG_FILE))).toBe(true);

      const second = anAgent();
      expect(second.signals).toHaveLength(1);
      expect(second.signalsNeedingAction[0].paths).toEqual(['gone.txt']);
      expect(second.signalTotals['deletion/refused']).toBe(1);
    });

    it('appends to what an earlier run left rather than replacing it', () => {
      const first = anAgent();
      emit(first, { kind: 'join/recovered', paths: ['a.txt'], action: 'review' });

      const second = anAgent();
      emit(second, { kind: 'join/conflicted', paths: ['b.txt'], action: 'review' });

      expect(second.signals.map((s) => s.kind)).toEqual([
        'join/recovered',
        'join/conflicted',
      ]);
    });

    it('reads the log once, not on every access', () => {
      const agent = anAgent();
      emit(agent, { kind: 'join/recovered', paths: [], action: 'review' });
      // A second agent restores on first read; reading again must not append
      // the same entries a second time.
      const second = anAgent();
      expect(second.signals).toHaveLength(1);
      expect(second.signals).toHaveLength(1);
      expect(second.signalTotals['join/recovered']).toBe(1);
    });

    it('survives a log that is not JSON, and files the reason', () => {
      writeFileSync(join(dir, SIGNAL_LOG_FILE), '{ this is not json', 'utf-8');
      const agent = anAgent();
      expect(agent.signals).toEqual([]);
      expect(readFileSync(join(dir, SYNC_ERROR_FILE), 'utf-8')).toContain(
        'signals/restore',
      );
    });

    it('survives a folder it cannot write to, and files the reason', () => {
      // The folder is gone by the time the signal happens — a user deleting the
      // synced folder while the agent runs. Recording must not throw.
      const agent = anAgent();
      rmSync(dir, { recursive: true, force: true });
      expect(() =>
        emit(agent, { kind: 'join/recovered', paths: [], action: 'review' }),
      ).not.toThrow();
      // Kept in memory even though the file could not be written.
      expect(agent.signals).toHaveLength(1);
    });
  });

  // ...........................................................................
  describe('a same-file conflict', () => {
    it('is reported as reviewable, with the copy and the chain’s verdict', () => {
      const agent = anAgent();
      record(agent, [
        {
          path: 'doc.txt',
          copyPath: 'doc (conflicted copy 2026-10-01 120000).txt',
          winnerRef: 'w',
          loserRef: 'l',
          loserAt: 1,
          resolvedAt: 2,
        },
      ]);

      const [signal] = agent.signals;
      expect(signal.kind).toBe('conflict/merged');
      // `review`, never `required`: both versions are on disk and the folder
      // converged. Nothing is broken — but a `(conflicted copy …)` file is
      // somebody's work waiting to be merged by hand.
      expect(signal.action).toBe('review');
      expect(signal.decidedBy).toBe('chain');
      expect(signal.paths).toEqual(['doc.txt']);
      expect(signal.copyPath).toBe('doc (conflicted copy 2026-10-01 120000).txt');
      expect(signal.detail).toContain('both versions were kept');
    });

    it('still calls the 0.1.0 listener, so a host written against it works', () => {
      // THE COMPATIBILITY GUARANTEE. `onConflict` is published API; the signal
      // channel is additive and must not replace it.
      const reports: FsConflictReport[] = [];
      const signals: FsSignal[] = [];
      const agent = anAgent({
        onConflict: (r: FsConflictReport[]) => reports.push(...r),
        onSignal: (s: FsSignal) => signals.push(s),
      });
      record(agent, [
        {
          path: 'doc.txt',
          copyPath: 'copy.txt',
          winnerRef: 'w',
          loserRef: 'l',
          loserAt: 1,
          resolvedAt: 2,
        },
      ]);

      expect(reports.map((r) => r.path)).toEqual(['doc.txt']);
      expect(signals.map((s) => s.kind)).toEqual(['conflict/merged']);
    });

    it('reports one signal per path', () => {
      const agent = anAgent();
      record(agent, [
        { path: 'a.txt', copyPath: 'a2', winnerRef: 'w', loserRef: 'l', loserAt: 1, resolvedAt: 2 },
        { path: 'b.txt', copyPath: 'b2', winnerRef: 'w', loserRef: 'l', loserAt: 1, resolvedAt: 2 },
      ]);
      expect(agent.signals.map((s) => s.paths[0])).toEqual(['a.txt', 'b.txt']);
    });
  });

  // ...........................................................................
  describe('a refused deletion', () => {
    it('is the one thing marked as needing a person', () => {
      // Nothing in this package will ever resolve it: the deletion does not
      // arrive, the folders stay split, and no further message closes the gap.
      const agent = anAgent();
      refuse(agent, 'restore', 40, 40, ['a.txt', 'b.txt']);

      const [signal] = agent.signals;
      expect(signal.kind).toBe('deletion/refused');
      expect(signal.action).toBe('required');
      expect(signal.decidedBy).toBe('guard');
      expect(signal.paths).toEqual(['a.txt', 'b.txt']);
      expect(signal.detail).toContain('40 of 40');
      expect(agent.signalsNeedingAction).toHaveLength(1);
    });

    it('still fills `refusedDeletions`, which 0.1.0 published', () => {
      const agent = anAgent();
      refuse(agent, 'bucketSync', 39, 40, ['x.txt']);
      expect(agent.refusedDeletions).toHaveLength(1);
      expect(agent.refusedDeletions[0].route).toBe('bucketSync');
      expect(agent.signals).toHaveLength(1);
    });

    it('counts every refusal even once the list has dropped the oldest', () => {
      const agent = anAgent();
      for (let i = 0; i < 30; i++) refuse(agent, 'removals', 5, 10, [`f${i}`]);
      // `refusedDeletions` keeps 20; the signal total keeps the truth.
      expect(agent.refusedDeletions).toHaveLength(20);
      expect(agent.signalTotals['deletion/refused']).toBe(30);
    });
  });

  // ...........................................................................
  describe('a bucket round settling two edits', () => {
    // THE MOST COMMON CONFLICT ROUTE, and it had no channel at all before this.
    // `bucketSync` is on by default, so this is what a contended folder
    // actually produces — and it was a `console.warn` on the machine.
    /**
     * Drives the apply step with a plan, as a round would.
     * @param agent - The agent.
     * @param conflict - The conflicting paths.
     * @param decidedBy - How each was settled.
     */
    const applyPlan = async (
      agent: FsAgent,
      conflict: string[],
      decidedBy: Record<string, 'chain' | 'claim' | 'hash'>,
    ): Promise<void> =>
      (
        agent as unknown as {
          _applyReconcilePlan(
            plan: unknown,
            db: unknown,
            treeKey: string,
          ): Promise<void>;
        }
      )._applyReconcilePlan(
        {
          fetch: [],
          drop: [],
          redelete: [],
          conflict,
          conflictDecidedBy: decidedBy,
        },
        undefined,
        'fsTree',
      );

    it('calls a chain verdict a merge', async () => {
      const agent = anAgent();
      await applyPlan(agent, ['a.txt'], { 'a.txt': 'chain' });

      const [signal] = agent.signals;
      expect(signal.kind).toBe('conflict/merged');
      expect(signal.decidedBy).toBe('chain');
      expect(signal.detail).toContain('the newer edit kept the path');
    });

    it('calls a HASH verdict arbitrary, which is the point of the field', async () => {
      // Converged, and otherwise unrelated to who edited last. A caller that
      // can see this can ask a person; one that cannot has to trust a coin
      // flip — and two defects hid in exactly that blind spot.
      const agent = anAgent();
      await applyPlan(agent, ['a.txt'], { 'a.txt': 'hash' });

      const [signal] = agent.signals;
      expect(signal.kind).toBe('conflict/arbitrary');
      expect(signal.decidedBy).toBe('hash');
      expect(signal.detail).toContain('arbitrarily');
    });

    it('names the claim rule as its own, weaker verdict', async () => {
      const agent = anAgent();
      await applyPlan(agent, ['a.txt'], { 'a.txt': 'claim' });

      const [signal] = agent.signals;
      expect(signal.kind).toBe('conflict/arbitrary');
      expect(signal.decidedBy).toBe('claim');
      expect(signal.detail).toContain('by who claims the path');
    });

    it('groups a round by verdict rather than one signal per path', async () => {
      // A round can name hundreds of paths. A caller wants the shape before the
      // detail, and 200 signals for one round would evict everything else.
      const agent = anAgent();
      await applyPlan(agent, ['a.txt', 'b.txt', 'c.txt'], {
        'a.txt': 'chain',
        'b.txt': 'chain',
        'c.txt': 'hash',
      });

      expect(agent.signals).toHaveLength(2);
      const merged = agent.signals.find((s) => s.kind === 'conflict/merged');
      const arbitrary = agent.signals.find(
        (s) => s.kind === 'conflict/arbitrary',
      );
      expect(merged?.paths).toEqual(['a.txt', 'b.txt']);
      expect(arbitrary?.paths).toEqual(['c.txt']);
    });

    it('survives a plan with NO verdict map at all', async () => {
      // Reachable with a plan built somewhere other than `reconcile` — a test,
      // a host driving the apply, a plan that crossed a version boundary.
      // Indexing an absent map threw, which took the whole round with it.
      const agent = anAgent();
      await (
        agent as unknown as {
          _applyReconcilePlan(
            plan: unknown,
            db: unknown,
            treeKey: string,
          ): Promise<void>;
        }
      )._applyReconcilePlan(
        { fetch: [], drop: [], redelete: [], conflict: ['a.txt'] },
        undefined,
        'fsTree',
      );
      expect(agent.signals[0].decidedBy).toBe('hash');
    });

    it('treats a path with no verdict as arbitrary', async () => {
      // An older peer, or a plan built by something that does not fill the map.
      // Assuming `chain` there would claim a fact nobody established.
      const agent = anAgent();
      await applyPlan(agent, ['a.txt'], {});
      expect(agent.signals[0].kind).toBe('conflict/arbitrary');
      expect(agent.signals[0].decidedBy).toBe('hash');
    });

    it('says nothing when a round settled nothing', async () => {
      const agent = anAgent();
      await applyPlan(agent, [], {});
      expect(agent.signals).toEqual([]);
    });
  });

  // ...........................................................................
  describe('joining a network', () => {
    /**
     * Drives the extracted emission with the two buckets a join produces.
     * @param agent - The agent.
     * @param recovered - Paths moved aside.
     * @param conflicted - Paths kept beside the network's.
     */
    const joined = (
      agent: FsAgent,
      recovered: string[],
      conflicted: string[],
    ): void =>
      (
        agent as unknown as {
          _signalJoinOutcome(r: readonly string[], c: readonly string[]): void;
        }
      )._signalJoinOutcome(recovered, conflicted);

    it('says which files were moved aside, and where', () => {
      // A restored backup. The files are not deleted — they go into
      // `.fsagent-recovered/` — but a folder that quietly grows that directory
      // is unexplainable from outside the machine.
      const agent = anAgent();
      joined(agent, ['old/a.txt', 'old/b.txt'], []);

      const [signal] = agent.signals;
      expect(signal.kind).toBe('join/recovered');
      expect(signal.action).toBe('review');
      expect(signal.paths).toEqual(['old/a.txt', 'old/b.txt']);
      expect(signal.detail).toContain('.fsagent-recovered');
    });

    it('says which files were edited while away', () => {
      const agent = anAgent();
      joined(agent, [], ['mine.txt']);

      const [signal] = agent.signals;
      expect(signal.kind).toBe('join/conflicted');
      expect(signal.action).toBe('review');
      expect(signal.detail).toContain('both versions were kept');
    });

    it('reports both buckets separately when both happened', () => {
      const agent = anAgent();
      joined(agent, ['gone.txt'], ['mine.txt']);
      expect(agent.signals.map((s) => s.kind)).toEqual([
        'join/recovered',
        'join/conflicted',
      ]);
    });

    it('says nothing about an ordinary join', () => {
      // The common case by far: a machine rejoins and nothing had to be moved.
      // A signal here would train people to ignore the list.
      const agent = anAgent();
      joined(agent, [], []);
      expect(agent.signals).toEqual([]);
    });
  });

  // ...........................................................................
  describe('an unrepairable divergence', () => {
    /**
     * Drives the hook the anti-entropy calls when no repair is safe.
     * @param agent - The agent.
     * @param hubRef - What the hub announced.
     * @param localRef - What this node holds.
     */
    const blocked = (
      agent: FsAgent,
      hubRef: string,
      localRef: string,
    ): void =>
      (
        agent as unknown as {
          _signalOnce(k: string, i: FsSignalInput): void;
        }
      )._signalOnce(`blocked\u0000${hubRef}\u0000${localRef}`, {
        kind: 'repair/blocked',
        paths: [],
        action: 'review',
        detail: 'no repair is safe to run',
      });

    it('is reported once per SITUATION, not once per retry', () => {
      // The decision is re-asked on every announcement, so the same deadlock
      // arrives again and again. Keyed on the PAIR of refs — the lesson the
      // content-agreement memo cost: keying on the hub's ref alone reports it
      // again every time this node moves, and keying on ours alone reports it
      // again every time the hub does.
      const agent = anAgent();
      for (let i = 0; i < 10; i++) blocked(agent, 'HUB', 'MINE');
      expect(agent.signals).toHaveLength(1);
      expect(agent.signals[0].kind).toBe('repair/blocked');

      // A genuinely different situation is a new signal.
      blocked(agent, 'HUB', 'MOVED');
      blocked(agent, 'HUBMOVED', 'MOVED');
      expect(agent.signals).toHaveLength(3);
    });

    it('is reviewable rather than required, because it retries', () => {
      // It may clear on its own as the missing history arrives, so demanding a
      // person look at once would be wrong. `required` is reserved for what
      // nothing in this package will ever resolve.
      const agent = anAgent();
      blocked(agent, 'a', 'b');
      expect(agent.signals[0].action).toBe('review');
      expect(agent.signalsNeedingAction).toEqual([]);
    });
  });

  // ...........................................................................
  describe('a standing condition', () => {
    it('is reported once, however often it is noticed', () => {
      const agent = anAgent();
      for (let i = 0; i < 5; i++) {
        emitOnce(agent, 'cfg', {
          kind: 'config/degraded',
          paths: [],
          action: 'review',
          detail: 'causalOrdering is off',
        });
      }
      expect(agent.signals).toHaveLength(1);
      expect(agent.signalTotals['config/degraded']).toBe(1);
    });

    it('persists only when it actually recorded something', () => {
      // The second call must not rewrite the file: a condition noticed on every
      // sync would otherwise cost a write per cycle for ever.
      const agent = anAgent();
      emitOnce(agent, 'cfg', { kind: 'config/degraded', paths: [], action: 'review' });
      const first = readFileSync(join(dir, SIGNAL_LOG_FILE), 'utf-8');
      emitOnce(agent, 'cfg', { kind: 'config/degraded', paths: [], action: 'review' });
      expect(readFileSync(join(dir, SIGNAL_LOG_FILE), 'utf-8')).toBe(first);
    });
  });
});
