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
    example();

    // Normalize paths in output to make test environment-independent.
    //
    // Twice: the log carries the path as-is AND inside JSON.stringify output,
    // where every backslash of a Windows path is escaped. Only the raw form
    // was replaced, so on Windows the escaped one reached the golden and the
    // test failed on every run there.
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cwd = process.cwd();
    const cwdInJson = JSON.stringify(cwd).slice(1, -1);
    const output = logMessages
      .join('\n')
      .replace(new RegExp(escapeRegExp(cwdInJson), 'g'), '<PROJECT_ROOT>')
      .replace(new RegExp(escapeRegExp(cwd), 'g'), '<PROJECT_ROOT>');

    // Write golden file
    await expectGolden('example.log').toBe(output);

    // Restore console.log
    console.log = log;
    expect('hello').toBe('hello');
  });
});
