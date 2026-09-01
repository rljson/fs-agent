// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BsMem } from '@rljson/bs';

import { FsScanner, SAFETY_RESCAN_INTERVAL_MS } from '../src/fs-scanner.ts';

// What one full tree walk costs on a folder the size of the customer's.
//
// The safety rescan fires on a fixed interval. If a scan costs a large
// fraction of that interval the agent is walking the tree almost continuously,
// and a single changed file has to win a slot in a pipeline that is already
// busy — which is what the lab measured: bulk convergence of 404 MB in 42s,
// then ONE added file taking 405s, or never arriving.
describe('scan cost on a customer-sized folder', () => {
  const dir = join(process.cwd(), 'test-temp-scan-cost');

  it('reports what a full scan costs against the rescan interval', async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (let d = 0; d < 700 && n < 3642; d++) {
      const sub = join(dir, `d${d}`);
      mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 6 && n < 3642; f++, n++) {
        writeFileSync(join(sub, `f${f}.bin`), Buffer.alloc(2048, n % 251));
      }
    }

    const scanner = new FsScanner(dir, { bs: new BsMem() });
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      await scanner.scan();
      timings.push(Date.now() - started);
    }
    console.log(
      `[scan-cost] ${n} files — scans ${timings.join('ms, ')}ms ` +
        `(safety rescan every ${SAFETY_RESCAN_INTERVAL_MS}ms)`,
    );
    scanner.stopWatch();
    rmSync(dir, { recursive: true, force: true });
    expect(timings.length).toBe(3);
  });
});
