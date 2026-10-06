// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * Agent options for a fixture whose folder IS the origin of its history.
 *
 * **Why so many tests need this.** A folder with files and no history defers
 * its first announcement and asks the network for its state first
 * (`FsAgentOptions.joinWaitMs`, on by default), because announcing over an
 * established fleet is how a restored backup drags it back. Nearly every
 * fixture in this suite has exactly that shape — files written, then sync
 * started — and almost none of them has another node with a history to wait
 * for. So the wait has nothing to find and the only thing it can do is expire,
 * a second and a half later, after the assertions have already run.
 *
 * Setting it to zero says what is true of the fixture: this folder is the first
 * state of its own history, so there is nothing to join. It is not a way around
 * the behaviour — a test that means to exercise joining sets a real wait
 * instead, as `fs-mesh-matrix.spec.ts` does.
 */
export const ORIGIN_FIXTURE = { joinWaitMs: 0 } as const;
