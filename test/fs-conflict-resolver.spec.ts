// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Conflict } from '@rljson/db';
import type { InsertHistoryRow } from '@rljson/rljson';

import { describe, expect, it, vi } from 'vitest';

import {
  compareTips,
  conflictCopyName,
  ConflictResolverDeps,
  ContentMap,
  decideWinner,
  DIR_MARKER,
  findCommonAncestor,
  formatConflictTimestamp,
  FsConflictResolver,
  fsTreeToContentMap,
  threeWayMerge,
} from '../src/fs-conflict-resolver.ts';
import type { FsTree } from '../src/fs-scanner.ts';

// ...........................................................................
// Helpers
// ...........................................................................

/** Build a fake FsTree whose nodes carry just the meta the resolver reads. */
function treeFrom(
  entries: Array<
    | { dir: string }
    | { file: string; blob?: string }
    | { raw: Record<string, unknown> }
  >,
): FsTree {
  const trees = new Map<string, unknown>();
  let i = 0;
  for (const e of entries) {
    const hash = `h${i++}`;
    if ('dir' in e) {
      trees.set(hash, {
        meta: { type: 'directory', relativePath: e.dir, name: e.dir },
      });
    } else if ('file' in e) {
      trees.set(hash, {
        meta: {
          type: 'file',
          relativePath: e.file,
          name: e.file,
          blobId: e.blob,
        },
      });
    } else {
      trees.set(hash, e.raw);
    }
  }
  return { rootHash: 'h0', trees: trees as Map<string, never> };
}

function cmap(obj: Record<string, string>): ContentMap {
  return new Map(Object.entries(obj));
}

// ...........................................................................
describe('fsTreeToContentMap', () => {
  it('maps files to blobIds, dirs to the marker, and skips root/meta-less', () => {
    const tree = treeFrom([
      { dir: '.' }, // root → skipped
      { dir: 'sub' }, // dir → marker
      { file: 'sub/a.txt', blob: 'a1' }, // file → blobId
      { file: 'noblob.txt' }, // file without blobId → ''
      { raw: { notMeta: true } }, // node without meta → skipped
      { raw: { meta: { type: 'symlink', relativePath: 'x' } } }, // other type → skipped
    ]);
    const map = fsTreeToContentMap(tree);
    expect(map.get('sub')).toBe(DIR_MARKER);
    expect(map.get('sub/a.txt')).toBe('a1');
    expect(map.get('noblob.txt')).toBe('');
    expect(map.has('.')).toBe(false);
    expect(map.has('x')).toBe(false);
    expect(map.size).toBe(3);
  });
});

// ...........................................................................
describe('compareTips / decideWinner', () => {
  const tip = (
    ref: string,
    clientId: string,
    timestamp: number,
    timeId = 't',
  ) => ({ timeId, ref, clientId, timestamp });

  it('orders by timestamp, then clientId, then content ref (not per-db timeId)', () => {
    expect(compareTips(tip('a', 'c', 2), tip('b', 'c', 1))).toBeGreaterThan(0);
    expect(compareTips(tip('a', 'z', 1), tip('b', 'a', 1))).toBeGreaterThan(0);
    expect(compareTips(tip('a', 'a', 1), tip('b', 'z', 1))).toBeLessThan(0);
    // Final tiebreak is the shared ref (timeId is ignored even when it differs).
    expect(compareTips(tip('z', 'a', 1), tip('a', 'a', 1))).toBeGreaterThan(0);
    expect(compareTips(tip('a', 'a', 1), tip('z', 'a', 1))).toBeLessThan(0);
    expect(
      compareTips(tip('a', 'a', 1, 'X'), tip('a', 'a', 1, 'Y')),
    ).toBe(0);
  });

  it('decideWinner picks the higher-ranked tip on either side', () => {
    const hi = tip('a', 'a', 5);
    const lo = tip('b', 'a', 1);
    expect(decideWinner(hi, lo).winner).toBe(hi);
    expect(decideWinner(lo, hi).winner).toBe(hi);
    expect(decideWinner(lo, hi).loser).toBe(lo);
  });
});

// ...........................................................................
describe('findCommonAncestor', () => {
  const row = (timeId: string, previous: string[]): InsertHistoryRow<string> =>
    ({ timeId, previous }) as unknown as InsertHistoryRow<string>;

  it('finds the nearest shared ancestor of a fork', () => {
    // A → B → D (tipB) and A → B → E (tipC). LCA = B.
    const rows = [
      row('A', []),
      row('B', ['A']),
      row('D', ['B']),
      row('E', ['B']),
    ];
    expect(findCommonAncestor(rows, 'D', 'E')).toBe('B');
  });

  it('returns the tip itself when one is an ancestor of the other (linear)', () => {
    const rows = [row('A', []), row('B', ['A']), row('C', ['B'])];
    expect(findCommonAncestor(rows, 'A', 'C')).toBe('A');
  });

  it('tolerates rows whose previous field is absent', () => {
    const rows = [
      { timeId: 'A' } as unknown as InsertHistoryRow<string>, // no previous
      row('B', ['A']),
    ];
    expect(findCommonAncestor(rows, 'A', 'B')).toBe('A');
  });

  it('handles diamonds (re-visited ancestors) and missing previous', () => {
    // A → B, A → C, B+C → D ; tips D and a separate branch from A.
    const rows = [
      row('A', []),
      row('B', ['A']),
      row('C', ['A']),
      row('D', ['B', 'C']), // diamond: A reachable twice
      row('E', ['A']),
    ];
    expect(findCommonAncestor(rows, 'D', 'E')).toBe('A');
  });

  it('handles a diamond on the walked (tipB) side without infinite revisit', () => {
    // tipB = D2 has two parents re-converging on X2 (NOT an ancestor of tipA)
    // before reaching the shared ancestor G — exercises the visited-revisit path.
    const rows = [
      row('G', []),
      row('PA', ['G']), // tipA side
      row('X2', ['G']),
      row('B2', ['X2']),
      row('C2', ['X2']),
      row('D2', ['B2', 'C2']), // tipB side diamond
    ];
    expect(findCommonAncestor(rows, 'PA', 'D2')).toBe('G');
  });

  it('returns null when no common ancestor, tolerating dangling predecessors', () => {
    const rows = [row('P', ['GHOST']), row('Q', ['GHOST2'])];
    expect(findCommonAncestor(rows, 'P', 'Q')).toBeNull();
  });
});

// ...........................................................................
describe('formatConflictTimestamp', () => {
  it('formats as stable UTC YYYY-MM-DD HHMMSS', () => {
    // 2026-06-18T09:15:07Z
    const ms = Date.UTC(2026, 5, 18, 9, 15, 7);
    expect(formatConflictTimestamp(ms)).toBe('2026-06-18 091507');
  });
});

// ...........................................................................
describe('conflictCopyName', () => {
  it('inserts the marker before the extension', () => {
    const ts = Date.UTC(2026, 5, 18, 9, 15, 0);
    expect(conflictCopyName('document.txt', 'NB-2510', ts, new Set())).toBe(
      'document (conflicted copy NB-2510 2026-06-18 091500).txt',
    );
  });

  it('appends when there is no extension and preserves the directory', () => {
    const ts = Date.UTC(2026, 5, 18, 0, 0, 0);
    expect(conflictCopyName('dir/README', 'C1', ts, new Set())).toBe(
      'dir/README (conflicted copy C1 2026-06-18 000000)',
    );
  });

  it('treats a leading-dot file as extensionless', () => {
    const ts = Date.UTC(2026, 5, 18, 0, 0, 0);
    expect(conflictCopyName('.gitignore', 'C1', ts, new Set())).toBe(
      '.gitignore (conflicted copy C1 2026-06-18 000000)',
    );
  });

  it('disambiguates with a numeric suffix when the name is taken', () => {
    const ts = Date.UTC(2026, 5, 18, 0, 0, 0);
    const taken = new Set<string>();
    const first = conflictCopyName('a.txt', 'C1', ts, taken);
    const second = conflictCopyName('a.txt', 'C1', ts, taken);
    expect(first).toBe('a (conflicted copy C1 2026-06-18 000000).txt');
    expect(second).toBe('a (conflicted copy C1 2026-06-18 000000) (1).txt');
  });
});

// ...........................................................................
describe('threeWayMerge', () => {
  const ts = Date.UTC(2026, 5, 18, 0, 0, 0);

  it('covers every row of the merge table', () => {
    const o = cmap({
      unchanged: 'u',
      bothdel: 'x',
      theirsdel: 'td', // ours keeps, theirs deletes → deleted
      onlyTheirs: 't0',
      onlyOurs: 'o0',
      conflict: 'c0',
      addsame: 'will-not-be-here', // present so add/add-same is over ancestor-less paths
    });
    o.delete('addsame');

    const ours = cmap({
      unchanged: 'u', // x/x/x
      theirsdel: 'td', // unchanged by ours
      onlyTheirs: 't0', // ours == ancestor → take theirs
      onlyOurs: 'o1', // only ours changed → take ours
      conflict: 'cB', // both changed differently
      addsame: 'same', // add same on both
      addOurs: 'ao', // added by ours only
    });
    const theirs = cmap({
      unchanged: 'u',
      // theirsdel absent → theirs deleted a path ours left unchanged
      onlyTheirs: 't1', // only theirs changed → take theirs
      onlyOurs: 'o0', // theirs == ancestor → take ours
      conflict: 'cC',
      addsame: 'same',
      addTheirs: 'at', // added by theirs only
      // bothdel absent on both → deleted
    });

    const plan = threeWayMerge(o, ours, theirs, 'theirs', 'LOSER', ts);

    expect(plan.merged.get('unchanged')).toBe('u');
    expect(plan.merged.has('bothdel')).toBe(false);
    expect(plan.merged.has('theirsdel')).toBe(false); // theirs deletion wins
    expect(plan.merged.get('onlyTheirs')).toBe('t1');
    expect(plan.merged.get('onlyOurs')).toBe('o1');
    expect(plan.merged.get('addsame')).toBe('same');
    expect(plan.merged.get('addOurs')).toBe('ao');
    expect(plan.merged.get('addTheirs')).toBe('at');
    // Conflict: theirs wins the path, ours preserved as a copy.
    expect(plan.merged.get('conflict')).toBe('cC');
    expect(plan.conflictPaths).toEqual(['conflict']);
    expect(plan.copies).toEqual([
      {
        path: 'conflict (conflicted copy LOSER 2026-06-18 000000)',
        blobId: 'cB',
      },
    ]);
  });

  it('winnerSide=ours keeps our value and renames theirs', () => {
    const o = cmap({ f: 'a' });
    const ours = cmap({ f: 'b' });
    const theirs = cmap({ f: 'c' });
    const plan = threeWayMerge(o, ours, theirs, 'ours', 'L', ts);
    expect(plan.merged.get('f')).toBe('b');
    expect(plan.copies[0].blobId).toBe('c');
  });

  it('edit/delete conflict: surviving edit is preserved even when winner deleted', () => {
    // ancestor has f; ours edits it, theirs deletes it. theirs (winner) deletes
    // → path removed, but ours edit survives as a copy (nothing lost).
    const o = cmap({ f: 'a' });
    const ours = cmap({ f: 'b' });
    const theirs = cmap({}); // deleted
    const plan = threeWayMerge(o, ours, theirs, 'theirs', 'L', ts);
    expect(plan.merged.has('f')).toBe(false); // winner deleted → not present
    expect(plan.copies[0].blobId).toBe('b'); // loser's edit preserved
  });

  it('makes no copy when the loser deleted a path the winner edited', () => {
    // ancestor f; ours (loser) deletes, theirs (winner) edits differently → a
    // conflict, winner keeps its edit, loser had nothing to preserve.
    const o = cmap({ f: 'a' });
    const ours = cmap({}); // loser deleted
    const theirs = cmap({ f: 'c' }); // winner edited
    const plan = threeWayMerge(o, ours, theirs, 'theirs', 'L', ts);
    expect(plan.merged.get('f')).toBe('c');
    expect(plan.conflictPaths).toEqual(['f']);
    expect(plan.copies).toEqual([]); // loser deleted → no copy
  });

  it('does not create a copy when the losing side is a directory', () => {
    const o = cmap({ p: 'a' });
    const ours = cmap({ p: DIR_MARKER }); // loser turned it into a dir
    const theirs = cmap({ p: 'c' }); // winner keeps a file
    const plan = threeWayMerge(o, ours, theirs, 'theirs', 'L', ts);
    expect(plan.merged.get('p')).toBe('c');
    expect(plan.copies).toEqual([]); // dir loser → no renamed file copy
  });
});

// ...........................................................................
describe('FsConflictResolver', () => {
  const TREE = 'sharedTree';

  type Disk = Map<string, string>;

  interface Harness {
    deps: ConflictResolverDeps;
    disk: Disk;
    stored: Array<{ previous: string[]; paths: string[] }>;
    deleted: string[];
    log: ReturnType<typeof vi.fn>;
  }

  /**
   * Builds an in-memory harness. `trees` maps a ref → content map; `refOf` maps
   * a timeId → ref; `rows` are the InsertHistory rows. Blob content for blobId
   * `b` is `Buffer.from(b)`, so writes round-trip through `content.toString()`.
   */
  function harness(opts: {
    refOf: Record<string, string | null>;
    trees: Record<string, Record<string, string>>;
    rows: InsertHistoryRow<string>[];
    withOnStored?: boolean;
  }): Harness {
    const disk: Disk = new Map();
    const stored: Harness['stored'] = [];
    const deleted: string[] = [];
    const log = vi.fn();

    const mkTree = (map: Record<string, string>): FsTree => {
      const entries = Object.entries(map).map(([rel, blob]) =>
        blob === DIR_MARKER
          ? ({ dir: rel } as const)
          : ({ file: rel, blob } as const),
      );
      return treeFrom(entries);
    };

    const deps: ConflictResolverDeps = {
      treeKey: TREE,
      getInsertHistory: async () => opts.rows,
      getRefOfTimeId: async (_t, timeId) => opts.refOf[timeId] ?? null,
      fetchTree: async (ref) => mkTree(opts.trees[ref]),
      getBlobContent: async (blobId) => Buffer.from(blobId),
      restoreTree: async (tree) => {
        disk.clear();
        for (const map of [fsTreeToContentMap(tree)]) {
          for (const [rel, blob] of map) {
            if (blob !== DIR_MARKER) disk.set(rel, blob);
          }
        }
      },
      writeFileAt: async (rel, content) => {
        disk.set(rel, content.toString());
      },
      deleteFileAt: async (rel) => {
        disk.delete(rel);
        deleted.push(rel);
      },
      scan: async () => {
        const entries = [...disk.entries()].map(
          ([rel, blob]) => ({ file: rel, blob }) as const,
        );
        return treeFrom(entries);
      },
      storeMerge: async (tree, previous) => {
        stored.push({
          previous,
          paths: [...fsTreeToContentMap(tree).keys()].sort(),
        });
        return 'mergeRef0000';
      },
      log,
      ...(opts.withOnStored ? { onMergeStored: vi.fn() } : {}),
    };
    return { deps, disk, stored, deleted, log };
  }

  const row = (
    timeId: string,
    previous: string[],
    origin?: string,
    clientTimestamp?: number,
  ): InsertHistoryRow<string> =>
    ({
      timeId,
      previous,
      ...(origin !== undefined ? { origin } : {}),
      ...(clientTimestamp !== undefined ? { clientTimestamp } : {}),
    }) as unknown as InsertHistoryRow<string>;

  const conflict = (branches?: string[]): Conflict =>
    ({
      table: TREE,
      type: 'dagBranch',
      detectedAt: 0,
      branches,
    }) as unknown as Conflict;

  it('ignores conflicts for a different table', async () => {
    const h = harness({ refOf: {}, trees: {}, rows: [] });
    const c = { ...conflict(['a', 'b']), table: 'other' } as Conflict;
    expect(await new FsConflictResolver(h.deps).resolve(c)).toBeNull();
  });

  it('ignores conflicts with fewer than two tips (incl. missing branches)', async () => {
    const h = harness({ refOf: {}, trees: {}, rows: [] });
    expect(
      await new FsConflictResolver(h.deps).resolve(conflict(['solo'])),
    ).toBeNull();
    expect(
      await new FsConflictResolver(h.deps).resolve(conflict(undefined)),
    ).toBeNull();
  });

  it('returns null and warns when a tip has no tree ref', async () => {
    const h = harness({
      refOf: { tA: null, tB: null },
      trees: {},
      rows: [], // no rows → toTip falls back to defaults
    });
    expect(
      await new FsConflictResolver(h.deps).resolve(conflict(['tA', 'tB'])),
    ).toBeNull();
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringContaining('missing tree ref'));
  });

  it('merges a fork: winner keeps the path, loser is renamed, fork collapses', async () => {
    // Ancestor O, loser B (older), winner C (newer). doc.txt conflicts.
    const h = harness({
      refOf: { O: 'refO', B: 'refB', C: 'refC' },
      trees: {
        refO: { 'doc.txt': 'v0', 'keep.txt': 'k0', sub: DIR_MARKER },
        refB: {
          'doc.txt': 'vB',
          'keep.txt': 'k0',
          'onlyB.txt': 'b0',
          sub: DIR_MARKER,
        },
        refC: {
          'doc.txt': 'vC',
          'keep.txt': 'k0',
          'onlyC.txt': 'c0',
          sub: DIR_MARKER,
        },
      },
      rows: [
        row('O', []),
        // loser B: origin/timestamp omitted → exercises the ?? fallbacks
        row('B', ['O']),
        // winner C: greater timestamp
        row('C', ['O'], 'NB-CCCC', 1000),
      ],
      withOnStored: true,
    });

    const ref = await new FsConflictResolver(h.deps).resolve(
      conflict(['C', 'B']),
    );
    expect(ref).toBe('mergeRef0000');

    // Winner content kept at doc.txt; both adds present; loser renamed.
    expect(h.disk.get('doc.txt')).toBe('vC');
    expect(h.disk.get('onlyB.txt')).toBe('b0'); // written via merge delta
    expect(h.disk.get('onlyC.txt')).toBe('c0'); // from winner restore
    const copyName = 'doc (conflicted copy  1970-01-01 000000).txt';
    expect(h.disk.get(copyName)).toBe('vB');

    // Merge revision references BOTH tips (loser first by identity order).
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].previous).toEqual(['B', 'C']);
    expect(h.deleted).toEqual([]); // nothing dropped
    expect((h.deps.onMergeStored as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'mergeRef0000',
    );
  });

  it('deletes winner files the merge resolved away (loser deletion wins)', async () => {
    // O has gone.txt; loser B deleted it; winner C kept it unchanged. Since only
    // the loser changed that path, the deletion wins → winner's on-disk copy is
    // removed. No onMergeStored provided here.
    const h = harness({
      refOf: { O: 'refO', B: 'refB', C: 'refC' },
      trees: {
        refO: { 'gone.txt': 'g0' },
        refB: {}, // loser deleted gone.txt
        refC: { 'gone.txt': 'g0' }, // winner unchanged
      },
      rows: [row('O', []), row('B', ['O'], 'A', 1), row('C', ['O'], 'A', 9)],
    });

    const ref = await new FsConflictResolver(h.deps).resolve(
      conflict(['B', 'C']),
    );
    expect(ref).toBe('mergeRef0000');
    expect(h.deleted).toEqual(['gone.txt']);
    expect(h.disk.size).toBe(0);
    expect(h.stored[0].previous).toEqual(['B', 'C']);
  });

  it('returns null when only the winner tip lacks a tree ref', async () => {
    const h = harness({
      refOf: { B: 'refB', C: null }, // loser resolvable, winner not
      trees: { refB: { 'x.txt': 'b' } },
      rows: [row('B', [], 'A', 1), row('C', [], 'A', 9)],
    });
    expect(
      await new FsConflictResolver(h.deps).resolve(conflict(['B', 'C'])),
    ).toBeNull();
  });

  it('merges with no common ancestor (everything is add/add)', async () => {
    // No shared predecessor → ancestor map is empty; the two add-only trees
    // union without conflict.
    const h = harness({
      refOf: { B: 'refB', C: 'refC' },
      trees: {
        refB: { 'b.txt': 'b0' },
        refC: { 'c.txt': 'c0' },
      },
      rows: [row('B', [], 'A', 1), row('C', [], 'A', 9)],
    });
    const ref = await new FsConflictResolver(h.deps).resolve(
      conflict(['B', 'C']),
    );
    expect(ref).toBe('mergeRef0000');
    expect(h.disk.get('b.txt')).toBe('b0');
    expect(h.disk.get('c.txt')).toBe('c0');
    expect(h.stored[0].previous).toEqual(['B', 'C']);
  });
});
