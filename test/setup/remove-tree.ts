// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { rm } from 'fs/promises';

/**
 * Removes a temp folder tree that a still-settling agent may be writing into.
 *
 * Plain `rm(dir, { recursive: true, force: true })` is not enough in a teardown
 * that follows live sync, and both ways it fails were seen on CI (Linux) while
 * every run passed on macOS:
 *
 * - **`ENOTEMPTY`.** The `stop*` handles returned by `syncToDb` / `syncFromDb`
 *   are synchronous: they stop the node SUBSCRIBING, they do not await a restore
 *   already in flight. That restore recreates a file underneath the recursive
 *   delete. `maxRetries` is Node's documented answer for exactly this class
 *   (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM`).
 *
 * - **`ENOENT` from inside the watcher.** On platforms where recursive
 *   `fs.watch` is emulated in JS, the watcher `readdirSync`s a folder when it
 *   changes. A native event queued before `close()` is still delivered after
 *   it, and the `readdirSync` then throws from inside Node's own `emit` — where
 *   no `'error'` listener can catch it, so it surfaces as an unhandled
 *   exception and fails the run even though every assertion passed. Retrying
 *   the delete cannot help: the throw is the watcher's, not ours. Letting the
 *   queue drain while the folder still EXISTS is what avoids it.
 *
 * macOS and Windows watch recursively in the kernel and never take the
 * `readdirSync` path, which is why this only ever reproduced in CI.
 *
 * @param dir - Folder to remove.
 */
export const removeTree = async (dir: string): Promise<void> => {
  // Let watcher events queued before close() drain while `dir` still exists.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
};
