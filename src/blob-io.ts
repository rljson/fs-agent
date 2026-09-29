// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobProperties, Bs } from '@rljson/bs';

import { FileHandle } from 'fs/promises';

// .............................................................................

/**
 * Above this size, a file is streamed into blob storage instead of read whole.
 *
 * **A threshold rather than "always stream", because both costs are real.** A
 * stream bounds memory to one chunk; it also sets up a reader, a queue and a
 * per-chunk round trip, and the scanner runs this once per file across trees of
 * hundreds of thousands of small files. Reading a file no bigger than one chunk
 * whole costs no more memory than streaming it would, so below the line the
 * cheaper call is also the bounded one and there is nothing to trade.
 *
 * Above it, the whole-file read is what put 487 MB of ArrayBuffers on the cloud
 * hub's heap and what made a 63 MB file unsyncable — a single socket message
 * over the 50 MB cap, refused by the transport with no way around it.
 *
 * The number is deliberately the same order as `@rljson/bs`'s
 * `BLOB_CHUNK_BYTES`, and deliberately NOT imported from it. Nothing breaks if
 * the two drift: this decides which of two correct paths a file takes, not what
 * either path does. A constant that has to match across a package boundary to
 * stay correct is a contract, and a contract that lives in a tuning value is
 * one nobody will keep.
 */
export const STREAM_ABOVE_BYTES = 4 * 1024 * 1024;

/**
 * Stores an already-open file in blob storage, streaming it when it is large.
 *
 * Takes an open handle rather than a path on purpose: opening is where a
 * vanished file announces itself, and every caller here already has to classify
 * that error its own way. By the time the bytes move, the descriptor is held, so
 * a file deleted underneath the transfer cannot truncate it.
 * @param bs - Where the blob goes.
 * @param handle - The open file.
 * @param size - Its size, already known to every caller from its stat.
 * @returns Properties of the stored blob.
 */
export const storeFileAsBlob = async (
  bs: Bs,
  handle: FileHandle,
  size: number,
): Promise<BlobProperties> => {
  if (size <= STREAM_ABOVE_BYTES) {
    return bs.setBlob(await handle.readFile());
  }
  return bs.setBlob(handle.readableWebStream() as ReadableStream);
};
