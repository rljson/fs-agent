/*
 * @license
 * Copyright (c) 2025 Rljson
 *
 * Use of this source code is governed by terms that can be
 * found in the LICENSE file in the root of this package.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { chdir } from 'process';
import { fileURLToPath } from 'url';
import { gray, red } from './functions/colors.js';
import { getRepoUrls } from './functions/get-repo-urls.js';
import { runCommand } from './functions/run-command.js';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEST_DIR = `${__dirname}/../../`;

// Create destination directory if it doesn't exist
if (!existsSync(DEST_DIR)) {
  mkdirSync(DEST_DIR);
}
chdir(DEST_DIR);

var repos;
try {
  repos = await getRepoUrls();
} catch (e) {
  console.error(
    [red(`Error while getting repo URLs.`), e.message.trim()].join('\n'),
  );
  process.exit(1);
}

if (repos.length === 0) {
  console.log('No repositories found.');
  process.exit(0);
}

for (const repoUrl of repos) {
  try {
    const repoName = repoUrl.split('/').pop().replace('.git', '');
    if (!existsSync(repoName)) {
      runCommand(`git clone "${repoUrl}"`, false, false);
    } else {
      console.log(gray(`${repoName} already cloned.`));
    }
  } catch (err) {
    console.error(red(`Error while cloning ${repoUrl}:`), gray(err.message));
  }
}
