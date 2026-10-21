// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { hip } from '@rljson/hash';
import type { Tree } from '@rljson/rljson';

import type { FsNodeMeta, FsTree } from './fs-scanner.ts';

// .............................................................................
// WHAT A NODE DOES NOT SEE, IT CARRIES.
//
// Every node has its own ignore list, and nothing in a tree says which list
// made it. A node authored its edits from its scan alone, so a path it ignores
// was missing from every edit it made — and the chain reads a missing path as
// a deletion. Files other nodes synced were deleted on every machine as soon
// as a node that ignored them changed anything. A node whose own head named
// such a path fared no better: the removal waited for the scan to catch up
// with a file still on disk, which a scan that ignores the file never does,
// and the node authored nothing again.
//
// So an edit holds, at every path its author ignores, what the author's own
// head holds there: carried, never read from the folder and never changed.
// Adding a pattern then means the files stay where they are, on every
// machine, and stop syncing from this one.
//
// A node whose head names nothing it ignores — every node, for as long as the
// lists agree — carries nothing, and every tree it authors is its scan's own.
// .............................................................................

/**
 * A node's path, `.` for the root.
 * @param node - The node.
 * @returns Its relative path.
 */
const pathOf = (node: Tree): string =>
  (node.meta as unknown as FsNodeMeta).relativePath;

/**
 * Whether a node is a directory.
 * @param node - The node.
 * @returns True for a directory.
 */
const isDirectory = (node: Tree): boolean =>
  (node.meta as unknown as FsNodeMeta).type === 'directory';

/**
 * The directory holding a path, `.` for a top-level one.
 * @param path - A relative path other than `.`.
 * @returns Its parent.
 */
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
};

/**
 * How deep a path is: `.` is 0, a top-level path 1.
 * @param path - A relative path.
 * @returns Its depth.
 */
const depthOf = (path: string): number =>
  path === '.' ? 0 : path.split('/').length;

/**
 * The nodes of a tree a scan with this ignore rule leaves out.
 *
 * Walked from the root, as the scanner walks the folder: an ignored directory
 * is taken whole, with everything below it, and nothing below it is asked.
 * @param tree - The tree, typically a head's.
 * @param ignores - The scanner's rule: a path, and whether it is a directory.
 * @returns The left-out nodes, files and directories, by path.
 */
export const carriedNodes = (
  tree: FsTree,
  ignores: (path: string, isDirectory: boolean) => boolean,
): Map<string, Tree> => {
  const carried = new Map<string, Tree>();
  const childrenOf = (node: Tree | undefined): string[] =>
    (node?.children as string[] | null | undefined) ?? [];
  const take = (node: Tree): void => {
    carried.set(pathOf(node), node);
    for (const hash of childrenOf(node)) {
      const child = tree.trees.get(hash);
      if (child) take(child);
    }
  };
  const visit = (node: Tree | undefined): void => {
    for (const hash of childrenOf(node)) {
      const child = tree.trees.get(hash);
      if (!child) continue;
      if (ignores(pathOf(child), isDirectory(child))) take(child);
      else if (isDirectory(child)) visit(child);
    }
  };
  visit(tree.trees.get(tree.rootHash));
  return carried;
};

/**
 * A file node holding a version of another file under a new path — a merge
 * keeping both versions of one file.
 * @param path - Where the version is kept.
 * @param blobId - The version.
 * @param size - Its size in bytes.
 * @returns The node, hashed, in the scanner's own format.
 */
export const fileNode = (path: string, blobId: string, size: number): Tree => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const meta: FsNodeMeta = {
    name,
    type: 'file',
    relativePath: path,
    size,
    blobId,
  };
  const node: Tree = { id: name, isParent: false, meta, children: null };
  hip(node);
  return node;
};

/**
 * A tree holding what `tree` holds and the carried nodes besides — built as
 * the scanner builds one, so a folder that holds its carried paths after all
 * gives the same ref either way.
 *
 * The folder's own entries come first: a carried path the scan holds itself
 * is not carried, and neither is one below a path the scan holds as a file.
 * A directory a carried path needs and the scan lacks — the folder lost it
 * around a file it does not see — is put back, holding just that.
 * @param tree - The folder, as scanned.
 * @param carried - What to carry, by path — see {@link carriedNodes}. A file
 *   node is used as it is; every directory is rebuilt from its children.
 * @returns The tree, and the carried paths it holds; `tree` itself when it
 *   holds none of them.
 */
export const graftTree = (
  tree: FsTree,
  carried: ReadonlyMap<string, Tree>,
): { tree: FsTree; carried: Map<string, Tree> } => {
  const added = new Map<string, Tree>();
  if (carried.size === 0) return { tree, carried: added };

  const scanned = new Map<string, Tree>();
  for (const node of tree.trees.values()) scanned.set(pathOf(node), node);

  // Shallowest first, so a path below one that did not fit does not either.
  for (const path of [...carried.keys()].sort(
    (a, b) => depthOf(a) - depthOf(b),
  )) {
    if (scanned.has(path)) continue;
    let fits = true;
    for (let at = parentOf(path); at !== '.'; at = parentOf(at)) {
      const holder = scanned.get(at) ?? added.get(at);
      if (holder !== undefined && !isDirectory(holder)) {
        fits = false;
        break;
      }
    }
    if (fits) added.set(path, carried.get(path) as Tree);
  }
  if (added.size === 0) return { tree, carried: added };

  // Every directory that changes: each one above a carried path, and a
  // carried directory itself, which is rebuilt like the rest.
  const touched = new Set<string>();
  for (const [path, node] of added) {
    if (isDirectory(node)) touched.add(path);
    for (let at = parentOf(path); ; at = parentOf(at)) {
      touched.add(at);
      if (at === '.') break;
    }
  }

  // Who is in each of them.
  const members = new Map<string, string[]>();
  const enter = (path: string): void => {
    if (path === '.') return;
    const parent = parentOf(path);
    if (!touched.has(parent)) return;
    const list = members.get(parent);
    if (list) list.push(path);
    else members.set(parent, [path]);
  };
  for (const path of scanned.keys()) enter(path);
  for (const path of added.keys()) if (!touched.has(path)) enter(path);
  for (const path of touched) if (!scanned.has(path)) enter(path);

  const trees = new Map(tree.trees);
  for (const path of touched) {
    const old = scanned.get(path);
    if (old) trees.delete(old._hash as string);
  }
  for (const node of added.values()) {
    if (!isDirectory(node)) trees.set(node._hash as string, node);
  }

  // Deepest first, so every child's hash is known before its directory's.
  const rebuilt = new Map<string, Tree>();
  for (const path of [...touched].sort((a, b) => depthOf(b) - depthOf(a))) {
    const children = (members.get(path) ?? [])
      .map(
        (child) =>
          (rebuilt.get(child) ?? scanned.get(child) ?? added.get(child))
            ?._hash as string,
      )
      .sort();
    const name = path === '.' ? '.' : path.slice(path.lastIndexOf('/') + 1);
    const meta: FsNodeMeta = { name, type: 'directory', relativePath: path };
    const node: Tree = {
      id: name,
      isParent: children.length > 0,
      meta,
      children: children.length > 0 ? children : null,
    };
    hip(node);
    rebuilt.set(path, node);
    trees.set(node._hash as string, node);
  }

  return {
    tree: { rootHash: rebuilt.get('.')?._hash as string, trees },
    carried: added,
  };
};
