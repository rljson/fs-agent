// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Telling somebody a conflict happened must not be able to break the merge.
//
// Resolving a same-file conflict used to be silent: a renamed file appeared and
// nothing said why, which version was live, or where the other one went. The
// notification that fixes that now sits inside the merge path — so the first
// question is what happens when IT fails, because a notification that can abort
// a merge is worse than no notification at all.
//
// Two ways it can fail, both ordinary: the folder cannot be written (read-only,
// full, gone), and the host's own listener throws. Neither is exotic enough to
// leave untested.
// .............................................................................

import { BsMem } from '@rljson/bs';

import { chmod, mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFLICT_LOG_FILE,
  CONFLICT_LOG_MAX,
  FsAgent,
  SYNC_ERROR_FILE,
} from '../src/fs-agent.ts';
import type { FsConflictReport } from '../src/fs-conflict-resolver.ts';

/**
 * A report, with as little ceremony as possible.
 * @param path - The conflicting path.
 * @returns One report.
 */
const report = (path: string): FsConflictReport => ({
  path,
  copyPath: `${path} (conflicted copy 2026-10-01 120000)`,
  winnerRef: 'wref',
  loserRef: 'lref',
  loserAt: 1_790_000_000_000,
  resolvedAt: 1_790_000_000_001,
});

/** Reaches the private recorder the resolver drives. */
const record = (agent: FsAgent, reports: FsConflictReport[]): void =>
  (
    agent as unknown as {
      _recordConflicts(r: readonly FsConflictReport[]): void;
    }
  )._recordConflicts(reports);

describe('FsAgent — recording a resolved conflict', () => {
  let dir = '';
  let nth = 0;
  const agents: FsAgent[] = [];

  beforeEach(async () => {
    dir = join(process.cwd(), `test-temp-conflictlog-${++nth}`);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.scanner.stopWatch();
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * An agent over the temp folder.
   * @param onConflict - Optional listener.
   * @returns The agent, registered for teardown.
   */
  const agentFor = (
    onConflict?: (r: FsConflictReport[]) => void,
  ): FsAgent => {
    const agent = new FsAgent(dir, new BsMem(), { onConflict });
    agents.push(agent);
    return agent;
  };

  // ...........................................................................
  it('writes the log, warns, and calls the listener', async () => {
    // All three, because they serve different readers: the file a UI that
    // starts later, the console a support request, the listener a UI that is
    // running now.
    const seen: FsConflictReport[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    record(agentFor((r) => seen.push(r)), [report('doc.txt')]);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();

    expect(said).toContain('CONFLICT on "doc.txt"');
    expect(said).toContain('kept both');
    expect(seen).toEqual([[report('doc.txt')]]);

    const logged: unknown = JSON.parse(
      await readFile(join(dir, CONFLICT_LOG_FILE), 'utf-8'),
    );
    expect(logged).toEqual([report('doc.txt')]);
  });

  // ...........................................................................
  it('appends to what an earlier conflict left, and stays bounded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = agentFor();
    // One more than the bound, written in two goes so the append path runs.
    record(agent, [report('first.txt')]);
    record(
      agent,
      Array.from({ length: CONFLICT_LOG_MAX }, (_, i) =>
        report(`later-${i}.txt`),
      ),
    );
    warn.mockRestore();

    const logged = JSON.parse(
      await readFile(join(dir, CONFLICT_LOG_FILE), 'utf-8'),
    ) as FsConflictReport[];
    // Bounded, and it is the OLDEST that goes — the newest is what a user is
    // being told about.
    expect(logged.length).toBe(CONFLICT_LOG_MAX);
    expect(logged.some((e) => e.path === 'first.txt')).toBe(false);
    expect(logged[logged.length - 1].path).toBe(
      `later-${CONFLICT_LOG_MAX - 1}.txt`,
    );
  });

  // ...........................................................................
  it('survives a log it cannot write, and files the reason', async () => {
    // A read-only folder: the conflict still has to be announced, because the
    // merge has already happened and both versions are already on disk.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: FsConflictReport[][] = [];
    const agent = agentFor((r) => seen.push(r));
    await chmod(dir, 0o555);

    expect(() => record(agent, [report('doc.txt')])).not.toThrow();

    await chmod(dir, 0o755);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    warn.mockRestore();
    // The console and the listener still ran.
    expect(said).toContain('CONFLICT on "doc.txt"');
    expect(seen.length).toBe(1);
  });

  // ...........................................................................
  it('survives a listener that throws, and files the reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = agentFor(() => {
      throw new Error('host listener exploded');
    });

    expect(() => record(agent, [report('doc.txt')])).not.toThrow();
    warn.mockRestore();

    // The log was still written — the host's fault must not cost the record.
    const logged = JSON.parse(
      await readFile(join(dir, CONFLICT_LOG_FILE), 'utf-8'),
    ) as FsConflictReport[];
    expect(logged.map((e) => e.path)).toEqual(['doc.txt']);
    // And the failure is on record rather than swallowed.
    expect(await readFile(join(dir, SYNC_ERROR_FILE), 'utf-8')).toContain(
      'host listener exploded',
    );
  });

  // ...........................................................................
  it('ignores a log file that is not an array', async () => {
    // Anything may be on disk — a half-written file, something a user edited.
    // A corrupt log must not stop the next conflict being recorded.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = agentFor();
    const { writeFile } = await import('fs/promises');
    await writeFile(join(dir, CONFLICT_LOG_FILE), '{"not":"an array"}');

    record(agent, [report('doc.txt')]);
    warn.mockRestore();

    const logged = JSON.parse(
      await readFile(join(dir, CONFLICT_LOG_FILE), 'utf-8'),
    ) as FsConflictReport[];
    expect(logged.map((e) => e.path)).toEqual(['doc.txt']);
  });
});
