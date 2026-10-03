// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WP7 at level 2: the comparison that makes reconciliation ADDITIVE.
//
// Every reconciliation this agent has is whole-folder, so every wrong decision
// is maximally destructive. `reconcile` cannot produce a destructive outcome at
// all — its vocabulary is "fetch what we lack", "adopt the peer's side of a
// conflict", "drop what the peer proved it deleted" and "re-assert our own
// deletion". That is the property §3.1 says makes the two measured failures
// impossible rather than rarer, and the tests below are mostly about proving it
// has no other outcome.
// .............................................................................

import { describe, expect, it } from 'vitest';

import {
  BUCKET_COUNT,
  bucketOf,
  bucketRoots,
  differingBuckets,
  entriesInBuckets,
  reconcile,
  TOMBSTONE_BLOB,
  type ManifestEntry,
} from '../src/fs-manifest.ts';

const manifest = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe('bucketOf', () => {
  it('lands every path inside the bucket range', () => {
    for (let i = 0; i < 500; i++) {
      const index = bucketOf(`dir${i % 7}/file-${i}.txt`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('is deterministic — the same path, the same bucket, always', () => {
    // The property every node depends on. Two nodes that bucketed a path
    // differently cannot compare anything at all.
    expect(bucketOf('a/b/c.txt')).toBe(bucketOf('a/b/c.txt'));
  });

  it('ignores content: the same path buckets the same whatever it holds', () => {
    // On the PATH alone, deliberately. If the bucket depended on the content,
    // a modification would look like a delete in one bucket and an add in
    // another — two differences where there is one, and a reconciliation that
    // has to coordinate them.
    const before = bucketRoots(manifest({ 'a.txt': 'blob-1' }));
    const after = bucketRoots(manifest({ 'a.txt': 'blob-2' }));
    expect(Object.keys(before)).toEqual(Object.keys(after));
    expect(before).not.toEqual(after);
  });

  it('spreads a realistic folder over many buckets', () => {
    // Not a distribution proof — a sanity check that the low two bytes are not
    // degenerate, because every path in one bucket would make the comparison
    // O(size) again and nothing would fail loudly.
    const used = new Set<number>();
    for (let i = 0; i < 1200; i++) used.add(bucketOf(`f${i}.txt`));
    expect(used.size).toBeGreaterThan(600);
  });
});

describe('bucketRoots', () => {
  it('is order-independent', () => {
    // XOR for exactly this reason. Two nodes walk their folders in whatever
    // order their filesystems hand back — the same lesson as the canonical
    // child order, one level down.
    const a = bucketRoots(manifest({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' }));
    const b = bucketRoots(
      new Map([
        ['c.txt', '3'],
        ['a.txt', '1'],
        ['b.txt', '2'],
      ]),
    );
    expect(a).toEqual(b);
  });

  it('omits empty buckets rather than zeroing them', () => {
    // A folder is three orders of magnitude smaller than a mongo collection,
    // so 4096 fixed slots would be almost all empty. Sparse keeps the
    // comparability and a fraction of the bytes.
    const roots = bucketRoots(manifest({ 'only.txt': 'blob' }));
    expect(Object.keys(roots).length).toBe(1);
  });

  it('has no roots at all for an empty manifest', () => {
    expect(bucketRoots(new Map())).toEqual({});
  });

  it('changes when content changes', () => {
    const before = bucketRoots(manifest({ 'a.txt': 'blob-1' }));
    const after = bucketRoots(manifest({ 'a.txt': 'blob-2' }));
    expect(before).not.toEqual(after);
  });

  it('changes when a path is tombstoned', () => {
    // A tombstone is an ENTRY, so it moves the root and the comparison finds
    // it. That is what carries a deletion without a side channel.
    const live = bucketRoots(manifest({ 'a.txt': 'blob-1' }));
    const dead = bucketRoots(manifest({ 'a.txt': TOMBSTONE_BLOB }));
    expect(live).not.toEqual(dead);
  });

  it('combines several entries in one bucket without losing either', () => {
    // Two entries forced into one bucket: the root must depend on both, or a
    // change to one of them could hide behind the other.
    const paths: string[] = [];
    const target = bucketOf('seed-a');
    for (let i = 0; paths.length < 2 && i < 200_000; i++) {
      if (bucketOf(`p${i}`) === target) paths.push(`p${i}`);
    }
    expect(paths.length).toBe(2);

    const both = bucketRoots(manifest({ [paths[0]]: 'x', [paths[1]]: 'y' }));
    const first = bucketRoots(manifest({ [paths[0]]: 'x' }));
    const changed = bucketRoots(manifest({ [paths[0]]: 'x', [paths[1]]: 'z' }));

    expect(Object.keys(both)).toEqual([String(target)]);
    expect(both[target]).not.toBe(first[target]);
    expect(both[target]).not.toBe(changed[target]);
  });
});

describe('differingBuckets', () => {
  it('finds nothing when two manifests agree', () => {
    const m = manifest({ 'a.txt': '1', 'b.txt': '2' });
    expect(differingBuckets(bucketRoots(m), bucketRoots(m))).toEqual([]);
  });

  it('finds only the bucket that changed', () => {
    // The O(differences) property: one changed file must not make the whole
    // folder worth exchanging.
    const before = manifest({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    const after = manifest({ 'a.txt': '1', 'b.txt': 'CHANGED', 'c.txt': '3' });
    const diff = differingBuckets(bucketRoots(before), bucketRoots(after));
    expect(diff).toEqual([bucketOf('b.txt')]);
  });

  it('counts a bucket present on one side only', () => {
    // Absent means EMPTY, and empty is not equal to anything with content.
    const ours = bucketRoots(manifest({ 'a.txt': '1' }));
    const theirs = bucketRoots(manifest({ 'a.txt': '1', 'new.txt': '2' }));
    expect(differingBuckets(ours, theirs)).toEqual([bucketOf('new.txt')]);
  });

  it('is symmetric', () => {
    const ours = bucketRoots(manifest({ 'a.txt': '1' }));
    const theirs = bucketRoots(manifest({ 'b.txt': '2' }));
    expect(differingBuckets(ours, theirs)).toEqual(
      differingBuckets(theirs, ours),
    );
  });

  it('returns indices ascending, so both sides agree on the order', () => {
    const ours = bucketRoots(new Map());
    const theirs = bucketRoots(
      manifest({ a: '1', b: '2', c: '3', d: '4', e: '5' }),
    );
    const diff = differingBuckets(ours, theirs);
    expect(diff).toEqual([...diff].sort((x, y) => x - y));
  });
});

describe('entriesInBuckets', () => {
  it('returns only the entries in the buckets asked for', () => {
    const m = manifest({ 'a.txt': '1', 'b.txt': '2' });
    const got = entriesInBuckets(m, [bucketOf('a.txt')]);
    expect(got).toEqual([['a.txt', '1']]);
  });

  it('includes tombstones, because a deletion is an entry', () => {
    const m = manifest({ 'gone.txt': TOMBSTONE_BLOB });
    expect(entriesInBuckets(m, [bucketOf('gone.txt')])).toEqual([
      ['gone.txt', TOMBSTONE_BLOB],
    ]);
  });

  it('sorts by path, so two nodes serialise a bucket alike', () => {
    const buckets = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) =>
      Array.from({ length: BUCKET_COUNT }, (_, b) => b).slice(i, i + 1),
    );
    const m = new Map([
      ['z.txt', '1'],
      ['a.txt', '2'],
      ['m.txt', '3'],
    ]);
    const all = entriesInBuckets(m, [
      ...buckets,
      bucketOf('z.txt'),
      bucketOf('a.txt'),
      bucketOf('m.txt'),
    ]);
    expect(all.map(([p]) => p)).toEqual([...all.map(([p]) => p)].sort());
  });

  it('returns nothing for buckets with no entries', () => {
    const m = manifest({ 'a.txt': '1' });
    const other = (bucketOf('a.txt') + 1) % BUCKET_COUNT;
    expect(entriesInBuckets(m, [other])).toEqual([]);
  });
});

describe('reconcile', () => {
  const E = (path: string, blob: string): ManifestEntry => [path, blob];

  it('fetches what the peer has and we lack', () => {
    const plan = reconcile([], [E('new.txt', 'blob-1')]);
    expect(plan.fetch).toEqual([['new.txt', 'blob-1']]);
    expect(plan.drop).toEqual([]);
    expect(plan.redelete).toEqual([]);
    expect(plan.conflict).toEqual([]);
  });

  // ...........................................................................
  // WHOEVER EDITED IT KEEPS IT — and the hash decides only what nobody claims.
  //
  // The hash comparison is a total order every node computes identically, so it
  // CONVERGES; it just converges on whichever blob id sorts higher, which has
  // nothing to do with who edited last. Measured on the fleet as a writer at
  // version 8 and a peer still holding version 5 ending up on version 5 about
  // half the time — the writer's own folder going backwards.
  //
  // Each side's claim travels with its entry, so both are known here and the
  // two rules are mirror images: whichever node runs them reaches the same
  // verdict, which is what convergence requires. A ONE-SIDED version was tried
  // and measured worse — a peer claiming nothing kept its stale copy and the
  // fleet stayed split.
  // ...........................................................................
  describe('a same-path conflict', () => {
    const C = (path: string, blob: string): ManifestEntry => [path, blob, 1];

    it('is decided by the side whose history claims the path', () => {
      // Ours is claimed, theirs is not: we keep ours and fetch nothing, even
      // though their blob id sorts higher and the hash rule would take it.
      const plan = reconcile(
        [['doc.txt', 'aaa']],
        [['doc.txt', 'zzz']],
        new Set(['doc.txt']),
      );
      expect(plan.conflict).toEqual(['doc.txt']);
      expect(plan.fetch, 'a hash overruled the side that edited the file').toEqual(
        [],
      );
    });

    it('is decided the same way seen from the other side', () => {
      // The mirror, which is what makes it converge: they claim it, we do not,
      // so we fetch theirs even though OUR blob id sorts higher.
      const plan = reconcile([['doc.txt', 'zzz']], [C('doc.txt', 'aaa')]);
      expect(plan.fetch).toEqual([['doc.txt', 'aaa']]);
    });

    it('falls back to the hash when both sides claim it', () => {
      // Two people really did edit the same file. Nothing here distinguishes
      // them, and converging on an arbitrary-but-identical answer beats
      // sitting on two versions for ever.
      const higher = reconcile(
        [['doc.txt', 'aaa']],
        [C('doc.txt', 'zzz')],
        new Set(['doc.txt']),
      );
      expect(higher.fetch).toEqual([['doc.txt', 'zzz']]);
      const lower = reconcile(
        [['doc.txt', 'zzz']],
        [C('doc.txt', 'aaa')],
        new Set(['doc.txt']),
      );
      expect(lower.fetch).toEqual([]);
    });

    it('falls back to the hash when neither side claims it', () => {
      // Two nodes each holding bytes they received and neither authored — an
      // older peer that sends no claims at all looks exactly like this, which
      // is why the fallback has to stay.
      const plan = reconcile([['doc.txt', 'aaa']], [['doc.txt', 'zzz']]);
      expect(plan.fetch).toEqual([['doc.txt', 'zzz']]);
    });
  });

  it('does nothing where the two agree', () => {
    const plan = reconcile([E('a.txt', '1')], [E('a.txt', '1')]);
    expect(plan).toEqual({
      fetch: [],
      drop: [],
      redelete: [],
      conflict: [],
    });
  });

  it('does nothing where both sides agree a path is GONE', () => {
    const plan = reconcile(
      [E('gone.txt', TOMBSTONE_BLOB)],
      [E('gone.txt', TOMBSTONE_BLOB)],
    );
    expect(plan.fetch).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.redelete).toEqual([]);
  });

  it('drops what the peer tombstoned and we still hold', () => {
    // Delete wins. Not inferred from an absence — the peer SAYS the path is
    // gone, and that statement is what an absence could never be.
    const plan = reconcile(
      [E('doomed.txt', 'blob-1')],
      [E('doomed.txt', TOMBSTONE_BLOB)],
    );
    expect(plan.drop).toEqual(['doomed.txt']);
    expect(plan.fetch).toEqual([]);
  });

  it('re-asserts OUR tombstone when the peer still holds the file', () => {
    // The other direction, and the one mongo's demo hit as "deleted customer
    // came back". Without it the two sit at different manifests for ever
    // whenever a delete is missed.
    const plan = reconcile(
      [E('doomed.txt', TOMBSTONE_BLOB)],
      [E('doomed.txt', 'blob-1')],
    );
    expect(plan.redelete).toEqual(['doomed.txt']);
    expect(plan.fetch).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it('never FETCHES a tombstone for a path it does not hold', () => {
    // The whole reason tombstones travel as entries rather than absences: a
    // peer advertising "this is gone" must not cause us to go and get it.
    const plan = reconcile([], [E('gone.txt', TOMBSTONE_BLOB)]);
    expect(plan.fetch).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.redelete).toEqual([]);
  });

  describe('a genuine edit conflict', () => {
    // Naming it and stopping there was the first version, and it cost
    // convergence: three clients editing one file sat on three versions for
    // ever, because an additive step cannot resolve a conflict. So the rule
    // resolves it — and the rule has to give BOTH machines the same answer
    // from what each already has.

    it('is always reported, whichever side wins', () => {
      // Reported so the losing content can be preserved as a conflict copy,
      // and so the event is visible rather than silent.
      expect(
        reconcile([E('p', 'aaa')], [E('p', 'zzz')]).conflict,
      ).toEqual(['p']);
      expect(
        reconcile([E('p', 'zzz')], [E('p', 'aaa')]).conflict,
      ).toEqual(['p']);
    });

    it('adopts the peer’s version when theirs is the greater blob id', () => {
      const plan = reconcile([E('p', 'aaa')], [E('p', 'zzz')]);
      expect(plan.fetch).toEqual([['p', 'zzz']]);
    });

    it('keeps ours when ours is the greater — the peer adopts it', () => {
      const plan = reconcile([E('p', 'zzz')], [E('p', 'aaa')]);
      expect(plan.fetch).toEqual([]);
    });

    it('gives the two sides the SAME winner, which is the whole point', () => {
      // Each side sees both blob ids in the exchange, so each reaches the
      // same conclusion with no coordination and no extra message: exactly
      // one of them fetches. Arbitrary, and the same arbitrary choice
      // everywhere — unlike "whichever advertisement arrived last", which is
      // what it replaces.
      const ours = E('p', 'blob-A');
      const theirs = E('p', 'blob-B');
      const weSee = reconcile([ours], [theirs]);
      const theySee = reconcile([theirs], [ours]);
      expect(weSee.fetch.length + theySee.fetch.length).toBe(1);
      const winner =
        weSee.fetch.length === 1 ? weSee.fetch[0][1] : ours[1];
      expect(winner).toBe('blob-B');
    });

    it('never deletes anything to settle a conflict', () => {
      for (const [a, b] of [
        ['aaa', 'zzz'],
        ['zzz', 'aaa'],
      ] as const) {
        const plan = reconcile([E('p', a)], [E('p', b)]);
        expect(plan.drop).toEqual([]);
        expect(plan.redelete).toEqual([]);
      }
    });
  });

  it('produces NO destructive outcome for any additive difference', () => {
    // The property, stated as an enumeration rather than an example. Over
    // every pairing of {absent, live-x, live-y, tombstone} on both sides, the
    // only way `drop` or `redelete` appears is when one side holds a tombstone
    // for a path the other holds live. Nothing else can delete anything.
    const states: Array<[string, string | undefined]> = [
      ['absent', undefined],
      ['live-x', 'x'],
      ['live-y', 'y'],
      ['tomb', TOMBSTONE_BLOB],
    ];

    for (const [, ourBlob] of states) {
      for (const [, theirBlob] of states) {
        const ours = ourBlob === undefined ? [] : [E('p', ourBlob)];
        const theirs = theirBlob === undefined ? [] : [E('p', theirBlob)];
        const plan = reconcile(ours, theirs);

        // Still only about DESTRUCTION. A conflict may now produce a fetch —
        // that is the deterministic resolution — and a fetch is additive.
        const destructive = plan.drop.length + plan.redelete.length > 0;
        const oneSideDeleted =
          (ourBlob === TOMBSTONE_BLOB && theirBlob !== undefined &&
            theirBlob !== TOMBSTONE_BLOB) ||
          (theirBlob === TOMBSTONE_BLOB && ourBlob !== undefined &&
            ourBlob !== TOMBSTONE_BLOB);

        expect(
          destructive,
          `ours=${String(ourBlob)} theirs=${String(theirBlob)}`,
        ).toBe(oneSideDeleted);
      }
    }
  });

  it('sorts every list, so two nodes agree on the plan', () => {
    const plan = reconcile(
      [E('z-mine', TOMBSTONE_BLOB), E('a-mine', TOMBSTONE_BLOB)],
      [
        E('z-new', '1'),
        E('a-new', '2'),
        E('z-mine', 'live'),
        E('a-mine', 'live'),
      ],
    );
    expect(plan.fetch.map(([p]) => p)).toEqual(['a-new', 'z-new']);
    expect(plan.redelete).toEqual(['a-mine', 'z-mine']);
  });
});
