// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A chain that appends onto the entry it appended last when a test gives no
// `previous` — the linear history most chain tests build.
//
// `FsEditChain` itself has no such default, deliberately: a table several
// nodes write has no tip of its own, and the agent says what every entry it
// writes was made from. This keeps that out of the tests that are about
// something else.
// .............................................................................

import type {
  FsAppendOptions,
  FsChainEntry,
  FsEditChain,
} from '../src/fs-edit-chain.ts';

/** An append whose `previous` defaults to the entry appended last. */
export type LinearAppend = Omit<FsAppendOptions, 'previous'> & {
  previous?: readonly string[];
};

/** A chain whose appends continue from the last one unless told otherwise. */
export type LinearChain = Omit<FsEditChain, 'append'> & {
  append(opts: LinearAppend): Promise<FsChainEntry>;
};

/**
 * Makes `chain` append onto its own last entry when no `previous` is given;
 * its first append is a root.
 * @param chain - The chain.
 * @returns The same chain.
 */
export const linearChain = (chain: FsEditChain): LinearChain => {
  let last: string | undefined;
  const append = chain.append.bind(chain);
  const linear = chain as unknown as LinearChain;
  linear.append = async (opts: LinearAppend) => {
    const entry = await append({
      ...opts,
      previous: opts.previous ?? (last === undefined ? [] : [last]),
    });
    last = entry.head;
    return entry;
  };
  return linear;
};
