// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WHAT A HOST SHOWS ABOUT A FOLDER, AND GOING BACK — on a running mesh.
//
// The walk itself is tested by hand in `fs-history.spec.ts`. This is the other
// half: that a real fleet produces the history a person expects — a pull is
// in it, a merge is in it with both parents — and that restoring a revision
// makes every folder EXACTLY that revision, as an edit the fleet follows.
//
// EXACTLY is the point of the restore. Writing a revision's files over the
// folder leaves everything made after it in place, and the folder ends up in a
// state no revision ever had — which is what a host got from `loadFromDb`.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FsAgent,
  MASS_DELETE_MIN_FILES,
  MassDeleteRefusedError,
  RECOVERED_DIR,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import { ORIGIN_FIXTURE } from './origin-fixture.ts';
import {
  buildFsMesh,
  whyNot,
  type FsMesh,
  type FsMeshNode,
} from './mesh/fs-mesh.ts';

const root = (name: string) => join(process.cwd(), `test-temp-history-${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `check` holds.
 * @param check - The condition.
 * @param what - What is awaited, for the failure message.
 * @param timeoutMs - How long to allow.
 */
const until = async (
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
    await sleep(50);
  }
};

describe('FsAgent — the history a host reads, and going back', () => {
  let mesh: FsMesh | undefined;

  afterEach(async () => {
    await mesh?.stop();
    mesh = undefined;
  });

  /**
   * Two converged nodes holding `files`.
   * @param name - The scenario, for the folder names.
   * @param files - What both folders start with.
   * @returns The nodes.
   */
  const twoNodes = async (name: string, files: Record<string, string>) => {
    mesh = await buildFsMesh({
      root: root(name),
      names: ['A', 'B'],
      seed: async (folders) => {
        for (const folder of Object.values(folders)) {
          for (const [path, content] of Object.entries(files)) {
            await writeFile(join(folder, path), content);
          }
        }
      },
    });
    const start = await mesh.converged();
    expect(start.converged, whyNot(start)).toBe(true);
    return { a: mesh.node('A'), b: mesh.node('B') };
  };

  /**
   * Runs `change` on a node and waits until it is in that node's chain.
   * @param node - The node.
   * @param change - What it does to its folder.
   */
  const authors = async (node: FsMeshNode, change: () => Promise<void>) => {
    const before = node.agent.ownHead;
    await change();
    await until(() => node.agent.ownHead !== before, `${node.name} authored`);
  };

  /**
   * Waits until two nodes stand on one head.
   * @param a - One node.
   * @param b - The other.
   */
  const agree = (a: FsMeshNode, b: FsMeshNode) =>
    until(
      () => a.agent.ownHead !== undefined && a.agent.ownHead === b.agent.ownHead,
      `${a.name} and ${b.name} stand on one head`,
      60_000,
    );

  // ...........................................................................
  describe('before a sync runs', () => {
    it('has no head, no history, no relation, and nothing to restore', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'fs-agent-history-'));
      try {
        const agent = new FsAgent(dir, new BsMem(), ORIGIN_FIXTURE);
        expect(await agent.headInfo()).toBeUndefined();
        expect(await agent.history()).toEqual({ entries: [], missing: [] });
        expect(await agent.relationTo('any')).toBeUndefined();
        await expect(agent.restoreRevision('any')).rejects.toThrow(
          /no history to restore from/,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ...........................................................................
  describe('where the folder stands', () => {
    it('names the head, what it changed, and the stamp the hub gave it', async () => {
      const { a, b } = await twoNodes('head', { 'doc.txt': 'v1' });

      await authors(a, () => a.write('doc.txt', 'v2'));
      await until(
        async () => (await a.agent.headInfo())?.stamp !== undefined,
        'the hub said the head back',
      );
      const info = await a.agent.headInfo();
      expect(info).toMatchObject({
        head: a.agent.ownHead,
        kind: 'edit',
        changed: ['doc.txt'],
        removed: [],
        stamp: { domain: 'mesh', hub: 'hub' },
      });
      expect(info?.at).toBeGreaterThan(0);

      // A pull is history too: the node that took the edit stands on the same
      // entry, and says the same about it.
      await agree(a, b);
      await until(
        async () =>
          JSON.stringify(await b.agent.headInfo()) === JSON.stringify(info),
        'B describes the head as A does',
      );
    });
  });

  // ...........................................................................
  describe('the history', () => {
    it('lists a merge with both sides below it, down to the root', async () => {
      const { a, b } = await twoNodes('merge', { 'base.txt': 'base' });

      b.cut();
      await authors(a, () => a.write('from-a.txt', 'A'));
      await authors(b, () => b.write('from-b.txt', 'B'));
      b.heal();
      await agree(a, b);

      const page = await a.agent.history();
      expect(page.missing).toEqual([]);
      expect(page.cursor).toBeUndefined();
      expect(page.entries.map((e) => e.kind)).toEqual([
        'merge',
        'edit',
        'edit',
        'root',
      ]);
      const [merge, ...below] = page.entries;
      expect([...merge.previous].sort()).toEqual(
        [below[0].head, below[1].head].sort(),
      );
      expect(below.slice(0, 2).map((e) => e.changed[0]).sort()).toEqual([
        'from-a.txt',
        'from-b.txt',
      ]);

      // One order, on every node.
      await until(
        async () =>
          JSON.stringify((await b.agent.history()).entries.map((e) => e.head)) ===
          JSON.stringify(page.entries.map((e) => e.head)),
        'B lists the history in the same order',
      );
    });

    it('reads a page at a time', async () => {
      const { a } = await twoNodes('pages', { 'doc.txt': 'v0' });
      for (let i = 1; i <= 4; i++) {
        await authors(a, () => a.write('doc.txt', `v${i}`));
      }

      const whole = (await a.agent.history()).entries.map((e) => e.head);
      expect(whole).toHaveLength(5);

      const first = await a.agent.history({ limit: 2 });
      const rest = await a.agent.history({ cursor: first.cursor });
      expect([...first.entries, ...rest.entries].map((e) => e.head)).toEqual(
        whole,
      );
    });

    it('starts wherever it is asked to', async () => {
      const { a } = await twoNodes('from', { 'doc.txt': 'v0' });
      const origin = a.agent.ownHead as string;
      await authors(a, () => a.write('doc.txt', 'v1'));

      const page = await a.agent.history({ from: origin });
      expect(page.entries.map((e) => e.head)).toEqual([origin]);
    });
  });

  // ...........................................................................
  describe('how two heads stand', () => {
    it('says the same, ahead and behind', async () => {
      const { a, b } = await twoNodes('relation', { 'doc.txt': 'v1' });
      const before = a.agent.ownHead as string;
      await authors(a, () => a.write('doc.txt', 'v2'));
      const after = a.agent.ownHead as string;

      expect(await a.agent.relationTo(after)).toEqual({ verdict: 'same' });
      expect(await a.agent.relationTo(before)).toEqual({ verdict: 'ahead' });

      // Behind: A stops listening, and B moves on. A can read B's entry
      // through the hub, and has not applied it.
      await agree(a, b);
      a.down();
      await authors(b, () => b.write('doc.txt', 'v3'));
      expect(await a.agent.relationTo(b.agent.ownHead as string)).toEqual({
        verdict: 'behind',
      });
    });
  });

  // ...........................................................................
  describe('going back to a revision', () => {
    it('makes the folder exactly that revision, as an edit every node follows', async () => {
      const { a, b } = await twoNodes('restore', { 'doc.txt': 'v1' });
      const revision = (await a.agent.headInfo())!;
      await authors(a, () => a.write('doc.txt', 'v2'));
      await authors(a, () => a.write('later.txt', 'made after the revision'));
      await agree(a, b);

      expect(await a.agent.restoreRevision(revision.head)).toBe('restored');

      // Exactly: what the revision lacks is gone, what it holds is back.
      expect(await a.files()).toEqual(['doc.txt']);
      expect(await a.read('doc.txt')).toBe('v1');

      // As a NEW edit on top: the revision stays where it was in the history,
      // and the edit names the revision's tree and what it took back.
      const head = await a.agent.headInfo();
      expect(head).toMatchObject({
        kind: 'edit',
        treeRef: revision.treeRef,
        changed: ['doc.txt'],
        removed: ['later.txt'],
      });
      expect(head?.head).not.toBe(revision.head);
      expect(
        (await a.agent.history()).entries.map((e) => e.head),
      ).toContain(revision.head);

      // And every node follows.
      expect(await b.settlesOn(['doc.txt'])).toEqual(['doc.txt']);
      await until(async () => (await b.read('doc.txt')) === 'v1', 'B went back');
      await agree(a, b);
    });

    it('records work nobody recorded yet before going back, so it is not lost', async () => {
      const { a } = await twoNodes('pending', { 'doc.txt': 'v1' });
      const revision = a.agent.ownHead as string;

      // Written, and restored away before the watcher's own debounce ran.
      await a.write('unsaved.txt', 'mine');
      expect(await a.agent.restoreRevision(revision)).toBe('restored');

      expect(await a.files()).toEqual(['doc.txt']);
      const page = await a.agent.history();
      const recorded = page.entries.find((e) => e.changed.includes('unsaved.txt'));
      expect(recorded, 'the work was never recorded').toBeDefined();
      // Below the restore, so it can be restored in turn.
      expect(page.entries[0].removed).toEqual(['unsaved.txt']);
    });

    it('waits out a file being written, and gives up rather than lose it', async () => {
      const { a } = await twoNodes('busy', { 'doc.txt': 'v1' });
      const revision = a.agent.ownHead as string;
      await authors(a, () => a.write('later.txt', 'later'));
      await a.write('growing.log', 'x');
      let size = 1;
      const writer = setInterval(() => {
        void a.write('growing.log', 'x'.repeat(++size));
      }, 20);
      try {
        expect(await a.agent.restoreRevision(revision)).toBe('busy');
      } finally {
        clearInterval(writer);
      }
      // Nothing was changed: what the revision lacks is all still there.
      expect(await a.read('later.txt')).toBe('later');
      expect(await a.read('growing.log')).toBeDefined();
    });

    it('leaves alone what no revision holds: its own log, the set-aside copies', async () => {
      const { a } = await twoNodes('bookkeeping', { 'doc.txt': 'v1' });
      const revision = a.agent.ownHead as string;
      await authors(a, () => a.write('later.txt', 'later'));
      // A copy a join set aside: the person was told it is there.
      await a.write(`${RECOVERED_DIR}/old (recovered).txt`, 'kept for a person');
      await a.write(SYNC_ERROR_FILE, 'an earlier error\n');

      await a.agent.restoreRevision(revision);

      expect(await a.files()).toEqual(['doc.txt']);
      expect(
        await a.read(`${RECOVERED_DIR}/old (recovered).txt`),
        'a set-aside copy was deleted',
      ).toBe('kept for a person');
      expect(await a.read(SYNC_ERROR_FILE)).toContain('an earlier error');
    });

    it('changes nothing for a revision this node cannot read', async () => {
      const { a } = await twoNodes('unknown', { 'doc.txt': 'v1' });
      const head = a.agent.ownHead;

      expect(await a.agent.restoreRevision('no-such-entry')).toBe('unknown');
      expect(await a.files()).toEqual(['doc.txt']);
      expect(a.agent.ownHead).toBe(head);
    });

    it('refuses a revision that would delete most of the folder, and changes nothing', async () => {
      // The guard every prune has. A restore is a person asking, but a person
      // who picked the wrong row empties every node's folder with one click.
      const { a } = await twoNodes('refused', { 'doc.txt': 'v1' });
      const revision = a.agent.ownHead as string;
      const many = MASS_DELETE_MIN_FILES + 20;
      for (let i = 0; i < many; i++) await a.write(`f${i}.txt`, `${i}`);
      await a.write('doc.txt', 'v2');
      await until(async () => {
        const page = await a.agent.history({ limit: 500 });
        const changed = new Set(page.entries.flatMap((e) => e.changed));
        return changed.size === many + 1;
      }, 'every file is recorded');
      const head = a.agent.ownHead;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(a.agent.restoreRevision(revision)).rejects.toBeInstanceOf(
        MassDeleteRefusedError,
      );

      errSpy.mockRestore();
      expect(await a.files()).toHaveLength(many + 1);
      // Nothing written either: the guard judges before the restore writes.
      expect(await a.read('doc.txt')).toBe('v2');
      expect(a.agent.ownHead).toBe(head);
      expect(a.agent.signalsNeedingAction.map((s) => s.kind)).toContain(
        'deletion/refused',
      );
    });
  });
});
