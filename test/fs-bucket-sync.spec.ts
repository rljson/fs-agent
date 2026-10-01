// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// The bucket-sync protocol, against a stub host.
//
// No sockets, no folders, no peers — the module decides what to say and what a
// reply means, and a host supplies the manifest and performs the plan. Two
// stubs wired to each other are a complete two-node conversation, which is how
// the whole exchange is tested in milliseconds.
// .............................................................................

import { describe, expect, it } from 'vitest';

import {
  BE,
  BG,
  BQ,
  BR,
  decodeEntries,
  decodeRoots,
  decodeWanted,
  encodeEntries,
  encodeRoots,
  encodeWanted,
  FsBucketSync,
  isBucketSync,
  type BucketSyncHost,
} from '../src/fs-bucket-sync.ts';
import {
  bucketRoots,
  TOMBSTONE_BLOB,
  type ManifestEntry,
  type ReconcilePlan,
} from '../src/fs-manifest.ts';

/** A host whose folder is a plain map, and whose wire is an array. */
class StubHost implements BucketSyncHost {
  readonly sent: string[] = [];
  readonly plans: ReconcilePlan[] = [];
  isReady = true;

  constructor(private readonly _files: Map<string, string>) {}

  manifest() {
    return this._files;
  }
  send(ref: string) {
    this.sent.push(ref);
  }
  async apply(plan: ReconcilePlan) {
    this.plans.push(plan);
  }
  ready() {
    return this.isReady;
  }
}

const host = (files: Record<string, string>) =>
  new StubHost(new Map(Object.entries(files)));

/**
 * Runs the conversation to completion between two sides.
 * @param a - The side that starts.
 * @param b - The side that answers.
 * @returns How many messages crossed.
 */
const converse = async (
  a: { sync: FsBucketSync; host: StubHost },
  b: { sync: FsBucketSync; host: StubHost },
): Promise<number> => {
  let crossed = 0;
  let from = a;
  let to = b;
  a.sync.start();

  // Each side hands whatever it just said to the other. Bounded, because a
  // protocol that cannot terminate is the defect this whole plan is about.
  for (let hop = 0; hop < 12; hop++) {
    const pending = from.host.sent.splice(0);
    if (pending.length === 0) break;
    for (const ref of pending) {
      await to.sync.receive(ref);
      crossed++;
    }
    [from, to] = [to, from];
  }
  return crossed;
};

const pair = (ours: Record<string, string>, theirs: Record<string, string>) => {
  const a = host(ours);
  const b = host(theirs);
  return {
    a: { host: a, sync: new FsBucketSync(a) },
    b: { host: b, sync: new FsBucketSync(b) },
  };
};

describe('the wire format', () => {
  it('recognises its own messages and nothing else', () => {
    for (const prefix of [BQ, BR, BG, BE]) {
      expect(isBucketSync(`${prefix}body`)).toBe(true);
    }
    // A tree ref is a content hash and never starts with `~`, which is what
    // lets both share one channel.
    expect(isBucketSync('kM3xQp7bZt')).toBe(false);
    // Nor does it claim the chain head's prefix.
    expect(isBucketSync('~H~abc')).toBe(false);
  });

  it('round-trips roots', () => {
    const roots = bucketRoots(new Map([['a.txt', 'blob-1']]));
    expect(decodeRoots(encodeRoots(roots))).toEqual(roots);
  });

  it('round-trips an EMPTY manifest, which is a real state', () => {
    expect(decodeRoots(encodeRoots({}))).toEqual({});
    expect(decodeRoots(BR)).toEqual({});
  });

  it('round-trips wanted buckets, empty list included', () => {
    expect(decodeWanted(encodeWanted([7, 19, 4095]))).toEqual([7, 19, 4095]);
    expect(decodeWanted(encodeWanted([]))).toEqual([]);
    expect(decodeWanted(BG)).toEqual([]);
  });

  it('round-trips entries, tombstones included', () => {
    const entries: ManifestEntry[] = [
      ['a.txt', 'blob-1'],
      ['gone.txt', TOMBSTONE_BLOB],
    ];
    expect(decodeEntries(encodeEntries(entries))).toEqual(entries);
    expect(decodeEntries(encodeEntries([]))).toEqual([]);
    expect(decodeEntries(BE)).toEqual([]);
  });

  it('survives a path containing the characters a delimiter would need', () => {
    // The reason the body is JSON. On a POSIX filesystem a filename may
    // contain any byte but `/` and NUL — pipes, tabs, newlines, quotes and
    // control characters included. A delimited format would need escaping, and
    // an escaping bug in a message that carries DELETIONS is the expensive
    // kind.
    const nasty: ManifestEntry[] = [
      ['dir/a|b.txt', 'blob-1'],
      ['dir/tab\there.txt', 'blob-2'],
      ['dir/new\nline.txt', TOMBSTONE_BLOB],
      ['dir/quote".txt', 'blob-3'],
      ['dir/ctrl.txt', 'blob-4'],
    ];
    expect(decodeEntries(encodeEntries(nasty))).toEqual(nasty);
  });
});

describe('FsBucketSync', () => {
  it('says nothing when the two folders already agree', async () => {
    const files = { 'a.txt': 'blob-1', 'b.txt': 'blob-2' };
    const { a, b } = pair(files, files);
    await converse(a, b);
    expect(a.host.plans).toEqual([]);
    expect(b.host.plans).toEqual([]);
  });

  it('fetches a file the peer has and we lack', async () => {
    const { a, b } = pair({ 'a.txt': 'blob-1' }, {
      'a.txt': 'blob-1',
      'new.txt': 'blob-2',
    });
    await converse(a, b);
    expect(a.host.plans.length).toBe(1);
    expect(a.host.plans[0].fetch).toEqual([['new.txt', 'blob-2']]);
    expect(a.host.plans[0].drop).toEqual([]);
  });

  it('exchanges only the buckets that differ', async () => {
    // The O(differences) property, on the wire. One changed file out of fifty
    // must not put fifty entries on the channel.
    const ours: Record<string, string> = {};
    for (let i = 0; i < 50; i++) ours[`f${i}.txt`] = `blob-${i}`;
    const theirs = { ...ours, 'f7.txt': 'CHANGED' };

    const { a, b } = pair(ours, theirs);
    await converse(a, b);

    const plan = a.host.plans[0];
    expect(plan.conflict).toEqual(['f7.txt']);
    // Exactly one bucket's worth of entries was asked for.
    expect(plan.fetch).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('drops a file the peer tombstoned', async () => {
    // Delete wins, and this is the direction that was losing data: the peer
    // SAYS the path is gone, where an absence could never say it.
    const { a, b } = pair({ 'doomed.txt': 'blob-1' }, {
      'doomed.txt': TOMBSTONE_BLOB,
    });
    await converse(a, b);
    expect(a.host.plans[0].drop).toEqual(['doomed.txt']);
    expect(a.host.plans[0].fetch).toEqual([]);
  });

  it('re-asserts our tombstone when the peer still holds the file', async () => {
    const { a, b } = pair({ 'doomed.txt': TOMBSTONE_BLOB }, {
      'doomed.txt': 'blob-1',
    });
    await converse(a, b);
    expect(a.host.plans[0].redelete).toEqual(['doomed.txt']);
    expect(a.host.plans[0].fetch).toEqual([]);
  });

  it('converges a fork ADDITIVELY — both sides keep their work', async () => {
    // §1.1 and §1.2 in one assertion. Whole-folder replacement answered this
    // by picking a winner, and it picked wrong in both possible directions
    // within one day. There is no outcome here in which either side's file is
    // discarded: each fetches what it lacks.
    const { a, b } = pair(
      { 'shared.txt': 's', 'mine.txt': 'm' },
      { 'shared.txt': 's', 'theirs.txt': 't' },
    );
    await converse(a, b);
    await converse(b, a);

    expect(a.host.plans.some((p) => p.fetch.some(([q]) => q === 'theirs.txt')))
      .toBe(true);
    expect(b.host.plans.some((p) => p.fetch.some(([q]) => q === 'mine.txt')))
      .toBe(true);
    for (const plan of [...a.host.plans, ...b.host.plans]) {
      expect(plan.drop).toEqual([]);
      expect(plan.redelete).toEqual([]);
    }
  });

  it('terminates — the conversation is four messages, not a loop', async () => {
    const { a, b } = pair({ 'a.txt': '1' }, { 'a.txt': '1', 'b.txt': '2' });
    const crossed = await converse(a, b);
    // ask roots, roots, ask entries, entries. A protocol that cannot
    // terminate is the class of defect this whole plan exists to remove.
    expect(crossed).toBe(4);
  });

  it('stops after the roots when they agree — two messages, no entries', async () => {
    const files = { 'a.txt': '1' };
    const { a, b } = pair(files, files);
    const crossed = await converse(a, b);
    expect(crossed).toBe(2);
  });

  describe('the cold-start gate', () => {
    it('refuses to START while not ready', () => {
      const { a } = pair({ 'a.txt': '1' }, {});
      a.host.isReady = false;
      expect(a.sync.start()).toBe(false);
      expect(a.host.sent).toEqual([]);
    });

    it('refuses to ANSWER while not ready', async () => {
      // Mongo's reason, quoted in the module header: until a baseline is
      // complete the roots are partial "and would make a peer see spurious
      // differences". Answering with partial roots is worse than silence,
      // because the peer then exchanges entries to discover there are none.
      const { b } = pair({}, { 'a.txt': '1' });
      b.host.isReady = false;
      expect(await b.sync.receive(BQ)).toBe(true);
      expect(b.host.sent).toEqual([]);
    });

    it('is not busy before a round and not busy after one', async () => {
      const { a, b } = pair({ 'a.txt': '1' }, { 'a.txt': '1', 'b.txt': '2' });
      expect(a.sync.busy).toBe(false);
      await converse(a, b);
      expect(a.sync.busy).toBe(false);
    });

    it('will not start a second round while one is in flight', async () => {
      const { a, b } = pair({ 'a.txt': '1' }, { 'a.txt': '1', 'b.txt': '2' });
      a.sync.start();
      await b.sync.receive(a.host.sent[0]);
      await a.sync.receive(b.host.sent[0]); // roots → now awaiting entries
      expect(a.sync.busy).toBe(true);
      expect(a.sync.start()).toBe(false);
    });
  });

  it('ignores a ref that is not its own', async () => {
    const { a } = pair({ 'a.txt': '1' }, {});
    expect(await a.sync.receive('an-ordinary-tree-ref')).toBe(false);
    expect(await a.sync.receive('~H~a-chain-head')).toBe(false);
    expect(a.host.sent).toEqual([]);
  });

  it('acts on entries it did not ask for', async () => {
    // A reply whose request was lost still carries usable information, and the
    // buckets are derivable from the entries themselves. Discarding it would
    // waste a round trip already paid for — and would leave the difference
    // unreconciled until something else noticed it.
    const { a } = pair({}, {});
    expect(a.sync.busy).toBe(false);
    await a.sync.receive(encodeEntries([['surprise.txt', 'blob-9']]));
    expect(a.host.plans[0].fetch).toEqual([['surprise.txt', 'blob-9']]);
  });

  it('plans nothing when the difference is a file only WE have', async () => {
    // A one-sided difference. The roots differ, the entries are exchanged, and
    // the side that already HAS the file has nothing to do — the side that
    // lacks it does the fetching when it runs its own round.
    //
    // This is the additive property seen from the other end: there is no step
    // in which holding a file a peer lacks causes anything to happen to it.
    // Whole-folder replacement is precisely the opposite, and that is how a
    // copied folder was deleted off the machine that made it.
    const { a, b } = pair({ 'shared.txt': 's', 'ours.txt': 'o' }, {
      'shared.txt': 's',
    });
    await converse(a, b);
    expect(a.host.plans).toEqual([]);

    // And the peer, asking in its own turn, fetches it.
    await converse(b, a);
    expect(b.host.plans[0].fetch).toEqual([['ours.txt', 'o']]);
    expect(b.host.plans[0].drop).toEqual([]);
  });

  it('compares only the buckets exchanged, not the whole manifest', async () => {
    // Otherwise every path outside the exchange looks like something the peer
    // is missing, and a four-message round turns into a full manifest dump.
    const { a, b } = pair(
      { 'ours-only.txt': '1', 'shared.txt': 's' },
      { 'shared.txt': 'CHANGED' },
    );
    await converse(a, b);
    const plan = a.host.plans[0];
    expect(plan.conflict).toEqual(['shared.txt']);
    // `ours-only.txt` is in a bucket the peer also disagrees about (it has no
    // entry there), so it may appear as a redelete candidate only if we
    // tombstoned it. We did not, so nothing destructive is planned.
    expect(plan.drop).toEqual([]);
    expect(plan.redelete).toEqual([]);
  });
});
