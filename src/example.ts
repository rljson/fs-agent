// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { FsAgent } from './fs-agent.ts';
import { FsScanner } from './fs-scanner.ts';


export const example = async () => {
  // Print methods
  const l = console.log;
  const h1 = (text: string) => l(`${text}`);
  const h2 = (text: string) => l(`  ${text}`);
  const p = (text: string) => l(`    ${text}`);

  // Example 1: Basic FsAgent
  h1('FsAgent.example');
  h2('Returns an instance of the FsAgent.');
  const fsAgent = FsAgent.example;
  p(JSON.stringify(fsAgent, null, 2));

  // Example 2: File System Scanner
  h1('\nFsScanner - Scan file system');
  h2('Scans a directory and extracts RLJSON tree structure');

  const scanner = new FsScanner('./src', {
    ignore: ['node_modules', '.git'],
    maxDepth: 3,
  });

  const tree = await scanner.scan();
  p(`Scanned ${tree.trees.size} tree nodes`);
  p(`Root hash: ${tree.rootHash}`);

  // Show root tree
  h2('Root tree:');
  const rootTree = scanner.getRootTree();
  if (rootTree) {
    p(`ID: ${rootTree.id}`);
    p(`Is Parent: ${rootTree.isParent}`);
    p(`Children: ${rootTree.children?.length || 0}`);
  }

  // Show some trees
  h2('Sample trees:');
  let count = 0;
  for (const [hash, treeNode] of tree.trees) {
    if (count++ >= 5) break;
    const meta = treeNode.meta as any;
    p(
      `${meta.type === 'directory' ? '📁' : '📄'} ${meta.name} [${hash.substring(0, 8)}...]`,
    );
  }

  // Example 3: Watch for changes
  h1('\nFsScanner - Watch for changes');
  h2('Register a callback to be notified of file system changes');

  scanner.onChange(async (change) => {
    p(`${change.type.toUpperCase()}: ${change.path}`);
  });

  p('Scanner is ready. Changes will be logged.');
  p('(Call scanner.watch() to start watching)');

  // Example 4: Automatic Database Sync
  h1('\nFsAgent - Automatic Database Sync');
  h2('Automatically sync filesystem changes to database');
  p('When creating FsAgent with db and treeKey options,');
  p('it automatically starts watching and syncing changes:');
  p('');
  p('const agent = new FsAgent(');
  p('  "./my-project",');
  p('  myBlobStorage,');
  p('  {');
  p('    db: myDatabase,');
  p('    treeKey: "projectTree",');
  p('    ignore: ["node_modules", ".git"]');
  p('  }');
  p(');');
  p('');
  p('// Agent now automatically:');
  p('// 1. Watches for file changes');
  p('// 2. Extracts trees and stores blobs');
  p('// 3. Syncs to database on changes');
  p('');
  p('// Clean up when done:');
  p('agent.dispose();');
};

/*
// Run via "npx vite-node src/example.ts"
example();
*/
