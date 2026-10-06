// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// HOW THIS AGENT PUTS BYTES ON DISK — one place, because it was three.
//
// Writing a file means staging it in a sibling temp and renaming over the
// target. The rename is atomic within a directory on POSIX and on NTFS, so a
// reader only ever sees a complete version and a crash leaves a temp behind
// rather than a half-written document.
//
// **This existed in three copies and two of them were wrong.** Each was fixed
// on its own, months apart, by somebody finding the same class of corruption
// from a different direction:
//
//  - the agent's buffered writer wrote IN PLACE on everything but win32,
//    deliberately, because a rename replaces the inode and `fs.watch` can lose
//    the watch;
//  - the agent's stream writer did the same until a 500 MB restore was found
//    growing at its final name, where the user and the scanner could both read
//    it half-finished;
//  - the blob adapter's `blobToFile` did the same, and was still doing it after
//    the other two were fixed.
//
// WHAT THE IN-PLACE WRITE COSTS, measured rather than argued. `writeFile` is
// `open('w')` — which TRUNCATES — followed by a write, so two concurrent writes
// of one path interleave as truncate, truncate, write "s20", write "s0", and
// leave the file holding `"s00"`: the second writer's two bytes over the first
// writer's three. Neither version. 2 000 such pairs left the blend **1 520
// times**; it is the common case. And a blend is worse than either version
// losing, because the scanner hashes it and announces it to the whole network
// as a legitimate state — which is how it was found, as a fuzz run where a
// node held `"s25"` in a file that had only ever been given `s2`, `s14`, `s15`
// and `s22`.
//
// The inode concern that justified writing in place is real, and the answer to
// it is a rescan rather than a corrupt file: the scanner's safety pass picks up
// what a lost watch misses, and nothing picks up a blend.
// .............................................................................

import { open, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * Filename prefix for the staging files used by atomic writes.
 *
 * The scanner ignores anything starting with this, so the transient
 * temp-and-rename never pollutes a tree or churns the watcher. See
 * `fs-ignore.ts`, where the prefix-matching rule exists partly to keep this
 * working.
 */
export const ATOMIC_TMP_PREFIX = '.fsagent-tmp-';

/**
 * A staging path beside `filePath`, in the same directory.
 *
 * Same directory so the rename stays within one filesystem and is therefore
 * atomic. The random suffix is what keeps two concurrent writers of one path
 * out of each other's staging file — without it they would trample the temp
 * instead of the target, which is the same bug one step removed.
 * @param filePath - The eventual destination.
 * @returns A path to stage into.
 */
export const atomicTmpPath = (filePath: string): string => {
  const rnd = `${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e9,
  ).toString(36)}`;
  return join(dirname(filePath), `${ATOMIC_TMP_PREFIX}${rnd}`);
};

/**
 * Writes bytes to `filePath` through a staging file.
 *
 * We do not `fsync` the temp: it adds significant per-file latency under
 * bursty restores, and durability-on-power-loss is secondary here since the
 * content is replicated and re-synced.
 * @param filePath - Destination path.
 * @param content - Bytes to write.
 */
export const atomicWriteFile = async (
  filePath: string,
  content: Buffer | string,
): Promise<void> => {
  const tmp = atomicTmpPath(filePath);
  try {
    await writeFile(tmp, content);
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // The temp may not exist — the staging write is what usually failed,
      // and an impossible directory fails before anything is staged at all.
    }
    throw err;
  }
};

/**
 * Writes a stream to `filePath` through a staging file, one chunk at a time.
 *
 * Never materialising the whole file is the point: a 500 MB document used to
 * cost 500 MB of Buffer on the receiving agent, another copy in the socket
 * parser, and the same again on the serving hub — memory that is work in
 * flight rather than garbage, so no collection can reclaim any of it. That is
 * the shape that exhausted a cloud relay.
 * @param filePath - Destination path.
 * @param stream - The bytes.
 * @param wrapReadError - Optional: given a failure that came from READING the
 * stream rather than writing the file, returns the error to throw instead.
 * Callers that must tell those two apart downstream pass a tagger here;
 * without one the original error is thrown unchanged.
 */
export const atomicWriteStream = async (
  filePath: string,
  stream: ReadableStream<Uint8Array>,
  wrapReadError?: (error: unknown) => Error,
): Promise<void> => {
  const tmp = atomicTmpPath(filePath);
  const handle = await open(tmp, 'w');
  try {
    const reader = stream.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // Both sides are exercised: the restore path passes a tagger, the blob
        // adapter does not.
        throw wrapReadError ? wrapReadError(error) : error;
      }
      if (chunk.done) break;
      await handle.write(chunk.value);
    }
  } catch (error) {
    await handle.close();
    // The partial file must not survive the failure — it is invisible to
    // everything while it carries this name, and leaving it behind is litter.
    /* v8 ignore next -- @preserve a temp file this call just created */
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await handle.close();

  try {
    await rename(tmp, filePath);
    /* v8 ignore start -- @preserve a rename within one directory, onto a path the caller owns */
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  /* v8 ignore stop -- @preserve */
};
