// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';

import type { InboundRefVerdict } from '../src/fs-agent.ts';
import { FsAgent, VERDICT_REASON } from '../src/fs-agent.ts';

// "Is this ref news to me" is the question this subsystem keeps getting wrong.
// It was answered in five separate places and each has been wrong at least
// once — an agent applying its own advertisement over its own newer edit, a
// delete that propagated only from the file's creator, a refusal that consumed
// the ref it refused, a restarted agent inheriting its predecessor's
// conclusions, a quiet join that announced anyway.
//
// Collecting the pre-fetch gates into one decision does not fix a sixth. It
// makes the answer testable in one place, in one order — which is what each of
// the five lacked.
describe('FsAgent — is an inbound ref news to this agent', () => {
  const dir = join(process.cwd(), 'test-temp-verdict');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Reaches the private decision, which is the point of the exercise. */
  const verdictOf = (
    agent: FsAgent,
    ref: string,
    isNewestFromSender: boolean,
  ): InboundRefVerdict =>
    (
      agent as unknown as {
        _inboundRefVerdict(r: string, n: boolean): InboundRefVerdict;
      }
    )._inboundRefVerdict(ref, isNewestFromSender);

  const agentWithLastSent = (lastSent?: string): FsAgent => {
    const agent = new FsAgent(dir, new BsMem());
    (agent as unknown as { _lastSentRef?: string })._lastSentRef = lastSent;
    return agent;
  };

  it('applies a ref from elsewhere that its sender calls newest', () => {
    expect(verdictOf(agentWithLastSent('mine'), 'theirs', true)).toBe('apply');
  });

  it('refuses this agent\'s own last advertisement', () => {
    expect(verdictOf(agentWithLastSent('mine'), 'mine', true)).toBe('own-echo');
  });

  it('refuses a ref its sender has already superseded', () => {
    expect(verdictOf(agentWithLastSent('mine'), 'theirs', false)).toBe('stale');
  });

  // The order is deliberate, not incidental. The own-echo check holds
  // regardless of what the sender believes: a bootstrap carries the SERVER as
  // origin, so the origin filter misses the echo, and the staleness check then
  // measures the server's sequence — which did advance, so the echo reads as
  // news. Reversing these two would let an agent overwrite its own newer edit
  // whenever the server's count happened to move.
  it('calls its own echo an echo even when the sender calls it newest', () => {
    expect(verdictOf(agentWithLastSent('mine'), 'mine', true)).toBe('own-echo');
  });

  // An agent that has never sent anything cannot be hearing its own echo.
  it('applies anything when it has advertised nothing', () => {
    expect(verdictOf(agentWithLastSent(undefined), 'theirs', true)).toBe(
      'apply',
    );
  });

  // KNOWN LIMIT, pinned so it is a decision rather than a surprise: only the
  // LAST sent ref is recognised. An echo of an older self-originated ref still
  // applies. Widening to a set would also suppress a peer's legitimate revert
  // to a state this agent once held; the real fix is for the bootstrap to carry
  // the originating client.
  it('does not recognise an OLDER self-originated ref', () => {
    const agent = agentWithLastSent('newest-i-sent');
    expect(verdictOf(agent, 'older-i-also-sent', true)).toBe('apply');
  });

  it('has a readable reason for every non-applying verdict', () => {
    expect(VERDICT_REASON['own-echo']).toMatch(/own last advertisement/);
    expect(VERDICT_REASON['stale']).toMatch(/newest its sender/);
  });
});
