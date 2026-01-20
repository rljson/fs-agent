// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { FsAgent } from '../src/fs-agent';


describe('FsAgent', () => {
  it('should validate a template', () => {
    const fsAgent = FsAgent.example;
    expect(fsAgent).toBeDefined();
  });
});
