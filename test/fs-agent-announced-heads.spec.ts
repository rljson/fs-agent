// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { ANNOUNCED_HEAD_MAX, FsAgent } from '../src/fs-agent.ts';

// .............................................................................
// The bound on parked peer heads.
//
// A head is parked when an announcement resolves and consumed when the apply
// for that state runs, which is a debounce later. Announcements that never
// reach an apply — superseded by a newer one, refused by a guard, already
// satisfied — leave their head behind, so the map has to forget.
//
// Tested HERE rather than in the growth run (`fs-scale.spec.ts`), because that
// run is single-node: it receives no announcements, so the map stays empty and
// a cap asserted against it would be asserted against a structure nothing
// filled. That is the mistake the growth test warns about in its own comment,
// and it would have been made here.
// .............................................................................

describe('parked announcement heads', () => {
  /** Reaches the private map and the private recorder. */
  const inner = (agent: FsAgent) =>
    agent as unknown as {
      _announcedHeads: Map<string, string>;
      _rememberAnnouncedHead: (treeRef: string, head: string) => void;
    };

  it('forgets the oldest past the cap', () => {
    const agent = new FsAgent(process.cwd());
    const it_ = inner(agent);

    for (let i = 0; i < ANNOUNCED_HEAD_MAX + 50; i++) {
      it_._rememberAnnouncedHead(`tree-${i}`, `head-${i}`);
    }

    expect(it_._announcedHeads.size).toBe(ANNOUNCED_HEAD_MAX);
    // Oldest first: arrival order is insertion order, and the oldest parked
    // head is the one whose apply is least likely to still be coming.
    expect(it_._announcedHeads.has('tree-0')).toBe(false);
    expect(it_._announcedHeads.has('tree-49')).toBe(false);
    expect(it_._announcedHeads.get('tree-50')).toBe('head-50');
    expect(
      it_._announcedHeads.get(`tree-${ANNOUNCED_HEAD_MAX + 49}`),
    ).toBe(`head-${ANNOUNCED_HEAD_MAX + 49}`);
  });

  it('re-announcing a state refreshes its place in the queue', () => {
    // A state announced again is being talked about NOW, so it must not be
    // evicted ahead of heads that arrived before it and have gone quiet.
    const agent = new FsAgent(process.cwd());
    const it_ = inner(agent);

    it_._rememberAnnouncedHead('old', 'head-old');
    for (let i = 0; i < ANNOUNCED_HEAD_MAX - 1; i++) {
      it_._rememberAnnouncedHead(`filler-${i}`, `head-${i}`);
    }
    it_._rememberAnnouncedHead('old', 'head-old-again');

    // One more arrival evicts the oldest FILLER, not the refreshed entry.
    it_._rememberAnnouncedHead('newest', 'head-newest');
    expect(it_._announcedHeads.size).toBe(ANNOUNCED_HEAD_MAX);
    expect(it_._announcedHeads.get('old')).toBe('head-old-again');
    expect(it_._announcedHeads.has('filler-0')).toBe(false);
  });
});
