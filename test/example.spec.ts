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
    // `example()` prints a JSON.stringify'd agent, so on win32 the project
    // root appears with its separators escaped (C:\\Users\\…) as well as raw
    // (C:\Users\…). Matching only the raw form silently no-ops there — the
    // substitution finds nothing and the golden captures the developer's own
    // absolute path, which then fails for everyone else. Replace the escaped
    // form first, since it is the longer of the two.
    const escapeRe = (literal: string) =>
      literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cwd = process.cwd();
    const cwdJsonEscaped = JSON.stringify(cwd).slice(1, -1);

    const output = logMessages
      .join('\n')
      .replace(new RegExp(escapeRe(cwdJsonEscaped), 'g'), '<PROJECT_ROOT>')
      .replace(new RegExp(escapeRe(cwd), 'g'), '<PROJECT_ROOT>');

    // Write golden file
    await expectGolden('example.log').toBe(output);

    // Restore console.log
    console.log = log;
    expect('hello').toBe('hello');
  });
});
