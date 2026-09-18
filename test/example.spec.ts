// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { example } from '../src/example';

import { expectGolden } from './setup/goldens';

describe('example', () => {
  it('should run without error', async () => {
    // Execute example
    const logMessages: string[] = [];
    const log = console.log;
    console.log = (message: string) => logMessages.push(message);
    await example();

    // Normalize paths in output to make test environment-independent.
    // The project root shows up both as a raw path (e.g. inside plain text)
    // and JSON-escaped (e.g. inside JSON.stringify output, where every "\"
    // becomes "\\" on Windows), so both forms must be matched.
    const escapeRegExp = (s: string) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cwd = process.cwd();
    const jsonEscapedCwd = JSON.stringify(cwd).slice(1, -1);
    const projectRootPattern = new RegExp(
      [cwd, jsonEscapedCwd].map(escapeRegExp).join('|'),
      'g',
    );
    // File hashes (root hash and the truncated per-file hashes) depend on
    // the exact bytes read from disk, which differ between CRLF (Windows
    // checkout) and LF (Linux/macOS checkout) — so they can never be equal
    // across platforms and must be normalized out too.
    const output = logMessages
      .join('\n')
      .replace(projectRootPattern, '<PROJECT_ROOT>')
      .replace(/Root hash: [\w-]+/g, 'Root hash: <HASH>')
      .replace(/\[[\w-]{8}\.\.\.\]/g, '[<HASH>...]');

    // Write golden file
    await expectGolden('example.log').toBe(output);

    // Restore console.log
    console.log = log;
    expect('hello').toBe('hello');
  });
});
