<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Files of any size, block by block

## Motivation

- A folder holds files of every size: setups of several hundred megabytes
  beside notes of a few bytes. The agent has to move all of them, and a
  small edit to a large file should not cost the whole file again.
- Its blob store, `@rljson/bs`, now stores and moves every blob as
  content-defined blocks. The agent has to take part: keep the blocks a
  file arrives in, write conflicted copies without holding a whole file,
  and keep scanning a folder while a large file is still being copied in.

## Strategy

- Prove the large case first, over real Socket.IO with a 50 MB message cap,
  before changing anything.
- Write a conflicted copy as a stream, like every other file.
- Discard a scan cache that names blobs the store no longer holds.
- Keep scanning past a file another program still has open.

## A test above the message cap

- `test/client-server/large-file.spec.ts`: two agents, a hub, real
  Socket.IO with `maxHttpBufferSize` 50 MB. A 60 MB file is added, changed
  in its middle, edited on both sides while apart and deleted.
- It counts the bytes the hub's sockets carry: the whole file crosses as
  126 MB (author to hub, hub to receiver), a 1 KB change as 3.1 MB.

## Conflicted copies and the scan cache

- A conflicted copy is written with `getBlobStream` and the atomic stream
  writer, instead of reading the whole blob into memory first.
- The persisted scan cache carries version 2, and a cache of any other
  version is discarded: the first scan reads and stores every file again.
  A cached blob id is only worth reusing while the store still holds it.

## A folder in motion

- A file that cannot be opened — locked by a program copying it (`EBUSY`)
  or not readable (`EPERM`, `EACCES`) — failed the whole scan. Every other
  change waited until the copy ended. It now keeps its last version, the
  next scan reads it again, and it is reported once, not on every scan.
- A safety rescan does not start while one is running. During a long copy,
  seven ticks of the five-second timer joined one scan and each reported
  the same drift.

## Dependency updates

- `@rljson/bs` and `@rljson/server` with blocks: a restore fetches only the
  blocks the local store lacks, keeps them, and asks for four ahead; a peer
  read no longer holds what it read until its link closes.

## Result

- Files of 120, 240 and 400 MB were added and removed on Windows machines
  within seconds; a receiver stayed at 144 MB of memory with the 400 MB
  file.
- 814 tests, 100 % coverage.

## Open Points

- Blocks of files that are gone stay in the store; nothing removes them.
- A scan without a watcher still fails for a locked file, since no later
  scan would come back for it.
