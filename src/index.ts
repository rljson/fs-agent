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
  FsAgent,
  SYNC_ERROR_FILE,
  type FsAgentOptions,
  type RestoreOptions,
  type TimeoutConfig,
} from './fs-agent.ts';
export {
  ATOMIC_TMP_PREFIX,
  atomicTmpPath,
  atomicWriteFile,
  atomicWriteStream,
} from './fs-atomic-write.ts';
export {
  compileIgnore,
  globToRegExp,
  type IgnoreMatcher,
} from './fs-ignore.ts';
export {
  antiEntropyDecision,
  DEFAULT_ANTI_ENTROPY,
  FsAntiEntropy,
  type AntiEntropyAction,
  type AntiEntropyDecision,
  type AntiEntropyDeps,
  type AntiEntropyOptions,
  type AntiEntropyStatus,
  type AntiEntropyView,
  type HubAnnouncement,
  type Reachability,
} from './fs-anti-entropy.ts';
export {
  createFsChainTables,
  FS_EDIT_ACTION,
  FsEditChain,
  compareTimeId,
  planRemovals,
  type FsAppendOptions,
  type FsChainEntry,
  type FsEditData,
  type RemovalPlan,
  type RemovalQuestion,
} from './fs-edit-chain.ts';
export {
  FsBlobAdapter,
  type BlobToFileOptions,
  type FileBlobMeta,
  type FileToBlobOptions,
} from './fs-blob-adapter.ts';
export { FsDbAdapter, type StoreFsTreeOptions } from './fs-db-adapter.ts';
export {
  compareTips,
  conflictCopyName,
  decideWinner,
  DIR_MARKER,
  findCommonAncestor,
  formatConflictTimestamp,
  FsConflictResolver,
  fsTreeToContentMap,
  threeWayMerge,
  type BranchTip,
  type ConflictCopy,
  type ConflictResolverDeps,
  type ContentMap,
  type MergePlan,
} from './fs-conflict-resolver.ts';
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
