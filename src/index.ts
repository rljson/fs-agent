// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

export {
  FsSignals,
  SIGNAL_LOG_FILE,
  SIGNAL_LOG_MAX,
  SIGNAL_ONCE_MAX,
  SIGNAL_PATHS_MAX,
  type FsSignal,
  type FsSignalAction,
  type FsSignalDecidedBy,
  type FsSignalInput,
  type FsSignalKind,
  type FsSignalLog,
} from './fs-signals.ts';
export {
  BlobUnavailableError,
  DiskFullError,
  FsAgent,
  MassDeleteRefusedError,
  PartialRestoreError,
  RestoreIncompleteError,
  SYNC_ERROR_FILE,
  UnwritablePathError,
  type FsAgentOptions,
  type RestoreOptions,
  type TimeoutConfig,
} from './fs-agent.ts';
export {
  ATOMIC_TMP_PREFIX,
  atomicTmpPath,
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteStream,
} from './fs-atomic-write.ts';
export {
  FS_HISTORY_PAGE,
  readFsHistory,
  walkFsHistory,
  type FsHistoryEntry,
  type FsHistoryOptions,
  type FsHistoryPage,
  type FsHistorySource,
} from './fs-history.ts';
export { readFsStamps } from './fs-stamps.ts';
export {
  compileIgnore,
  globToRegExp,
  type IgnoreMatcher,
} from './fs-ignore.ts';
export type {
  AntiEntropyStatus,
  ReceiveOutcome,
  Relation,
} from './fs-receive.ts';
export {
  createFsChainTables,
  FS_EDIT_ACTION,
  FsEditChain,
  type FsAppendOptions,
  type FsChainEntry,
  type FsEditData,
} from './fs-edit-chain.ts';
export {
  FsBlobAdapter,
  type BlobToFileOptions,
  type FileBlobMeta,
  type FileToBlobOptions,
} from './fs-blob-adapter.ts';
export { FsDbAdapter, type StoreFsTreeOptions } from './fs-db-adapter.ts';
export {
  FsScanner,
  type FsChange,
  type FsChangeCallback,
  type FsChangeType,
  type FsNodeMeta,
  type FsScanOptions,
  type FsTree,
} from './fs-scanner.ts';

// Client-server utilities
export {
  runClientServerSetup,
  type ClientServerSetupOptions,
  type ClientServerSetupResult,
} from './client-server/client-server-setup.ts';
