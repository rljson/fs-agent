// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// Q3 BACKLOG X3 (Kritisch): glob patterns in the ignore list.
//
// The old rule was `name === pattern || name.startsWith(pattern)`, which
// cannot express an extension — and the One Client has shipped `'*.log'` in
// its default list all along, matching nothing. X3's own words: *"Die
// gelieferte Liste wäre nicht anwendbar"*.
//
// Two halves to prove, and the second matters more than the first:
//
//  1. the notation X3 asks for works — `*`, `?`, `**`, folders with `/`,
//     anchored at the root, `!` exceptions, case-insensitive, `/` ≡ `\`;
//  2. **every pattern that worked before still works identically.** `~$` and
//     `.~lock.` are the Office and LibreOffice lock prefixes the product
//     depends on, and `.fsagent-tmp-` is how the agent hides its own
//     in-progress writes from its own watcher. Breaking those would reinstate
//     a defect this package has already had: every atomic write coming back as
//     a change event, resetting the debounce that batches a push.
// .............................................................................

import { describe, expect, it } from 'vitest';

import { compileIgnore, globToRegExp } from '../src/fs-ignore.ts';

describe('compileIgnore', () => {
  // ...........................................................................
  describe('the patterns that already worked keep working', () => {
    // This block is the reason the change is safe to land. Each of these is a
    // pattern in the shipped config or in the agent's own list.

    it('matches a plain name exactly, at any depth', () => {
      const ignore = compileIgnore(['node_modules']);
      expect(ignore.ignores('node_modules')).toBe(true);
      expect(ignore.ignores('node_modules/left-pad/index.js')).toBe(true);
      expect(ignore.ignores('src/node_modules/x')).toBe(true);
      expect(ignore.ignores('src/index.ts')).toBe(false);
    });

    it('still matches by PREFIX, which is what `~$` and `.~lock.` need', () => {
      // `~$document.docx` is Word's lock file; `.~lock.file.odt#` is
      // LibreOffice's. Neither has a fixed name, and neither is a glob.
      const ignore = compileIgnore(['~$', '.~lock.']);
      expect(ignore.ignores('~$quarterly.docx')).toBe(true);
      expect(ignore.ignores('sub/dir/~$quarterly.docx')).toBe(true);
      expect(ignore.ignores('.~lock.notes.odt#')).toBe(true);
      expect(ignore.ignores('quarterly.docx')).toBe(false);
    });

    it("still matches the agent's own temp prefix", () => {
      // `ATOMIC_TMP_PREFIX`. If this stops matching, every atomic write the
      // agent makes during a restore returns as a change event.
      const ignore = compileIgnore(['.fsagent-tmp-']);
      expect(ignore.ignores('.fsagent-tmp-a1b2c3')).toBe(true);
      expect(ignore.ignores('sub/dir/.fsagent-tmp-a1b2c3')).toBe(true);
    });

    it('is not fooled into treating a dotted name as a glob', () => {
      // `.git` and `dist` have no glob characters, so they take the literal
      // path through the compiler. Worth pinning: a `.` is a regular-expression
      // metacharacter, and an unescaped one would make `.git` match `agit`.
      const ignore = compileIgnore(['.git']);
      expect(ignore.ignores('.git/HEAD')).toBe(true);
      expect(ignore.ignores('agit/HEAD')).toBe(false);
    });
  });

  // ...........................................................................
  describe('the notation X3 asks for', () => {
    it('excludes an extension — the case that did not work at all', () => {
      const ignore = compileIgnore(['*.log']);
      expect(ignore.ignores('server.log')).toBe(true);
      expect(ignore.ignores('var/logs/server.log')).toBe(true);
      expect(ignore.ignores('server.log.txt')).toBe(false);
      expect(ignore.ignores('catalogue.prj')).toBe(false);
    });

    it('matches a single character with `?`', () => {
      const ignore = compileIgnore(['draft-?.txt']);
      expect(ignore.ignores('draft-1.txt')).toBe(true);
      expect(ignore.ignores('draft-12.txt')).toBe(false);
    });

    it('anchors a pattern that contains a separator at the ROOT', () => {
      // `build/out.txt` is the build folder at the top, not every `build`
      // anywhere. This is the difference between a name and a path.
      const ignore = compileIgnore(['build/out.txt']);
      expect(ignore.ignores('build/out.txt')).toBe(true);
      expect(ignore.ignores('sub/build/out.txt')).toBe(false);
    });

    it('accepts a leading `/` as the same anchoring, written explicitly', () => {
      const ignore = compileIgnore(['/build/out.txt']);
      expect(ignore.ignores('build/out.txt')).toBe(true);
      expect(ignore.ignores('sub/build/out.txt')).toBe(false);
    });

    it('crosses directories with `**`', () => {
      const ignore = compileIgnore(['logs/**/*.txt']);
      expect(ignore.ignores('logs/a.txt')).toBe(true);
      expect(ignore.ignores('logs/2026/09/a.txt')).toBe(true);
      expect(ignore.ignores('logs/a.bin')).toBe(false);
    });

    it('lets a leading `**/` match at the root as well as at depth', () => {
      // The one piece of the notation that is not obvious from the characters:
      // `**/tmp` means tmp ANYWHERE, including the top.
      const ignore = compileIgnore(['**/tmp']);
      expect(ignore.ignores('tmp')).toBe(true);
      expect(ignore.ignores('a/tmp')).toBe(true);
      expect(ignore.ignores('a/b/tmp/file.txt')).toBe(true);
      expect(ignore.ignores('a/temp')).toBe(false);
    });

    it('does not let `*` cross a separator', () => {
      const ignore = compileIgnore(['logs/*.txt']);
      expect(ignore.ignores('logs/a.txt')).toBe(true);
      expect(ignore.ignores('logs/2026/a.txt')).toBe(false);
    });

    it('ignores a whole folder, contents included, with a trailing `/`', () => {
      const ignore = compileIgnore(['build/']);
      expect(ignore.ignores('build', true)).toBe(true);
      expect(ignore.ignores('build/out/app.js')).toBe(true);
      // A FILE called `build` is not a folder called `build`.
      expect(ignore.ignores('build', false)).toBe(false);
    });

    it('keeps the directory half when the pattern also names a PATH', () => {
      // `src/build/` is both directory-only and a path, which takes a
      // different branch from the bare `build/` above: the pattern keeps its
      // separator, so it is matched against the whole relative path rather
      // than segment by segment. A FILE at that path is still not the folder.
      const ignore = compileIgnore(['src/build/']);
      expect(ignore.ignores('src/build', true)).toBe(true);
      expect(ignore.ignores('src/build/app.js')).toBe(true);
      expect(ignore.ignores('src/build', false)).toBe(false);
    });

    it('treats a directory pattern as a folder when the caller cannot say', () => {
      // The watcher reports a path and no type. Refusing to match there would
      // leave an ignored folder's own entry syncing.
      const ignore = compileIgnore(['build/']);
      expect(ignore.ignores('build')).toBe(true);
    });

    it('ignores case, because Windows does', () => {
      const ignore = compileIgnore(['*.LOG', 'Thumbs.db*']);
      expect(ignore.ignores('server.log')).toBe(true);
      expect(ignore.ignores('THUMBS.DB')).toBe(true);
    });

    it('treats `\\` and `/` as the same separator, in path AND pattern', () => {
      // The watcher reports `sub\dir\file` on Windows for the same file
      // another machine reports as `sub/dir/file`. One spelling, either side.
      const ignore = compileIgnore(['logs\\*.txt']);
      expect(ignore.ignores('logs/a.txt')).toBe(true);
      expect(ignore.ignores('logs\\a.txt')).toBe(true);
    });
  });

  // ...........................................................................
  describe('exceptions with `!`', () => {
    it('rescues one file from a wider pattern', () => {
      const ignore = compileIgnore(['*.log', '!keep.log']);
      expect(ignore.ignores('server.log')).toBe(true);
      expect(ignore.ignores('keep.log')).toBe(false);
    });

    it('is decided by the LAST matching line, not by being an exception', () => {
      // Order is the whole mechanism: reversed, the exception is overruled.
      // Asserting this stops someone "tidying" the list into alphabetical
      // order and silently changing what syncs.
      const ignore = compileIgnore(['!keep.log', '*.log']);
      expect(ignore.ignores('keep.log')).toBe(true);
    });

    it('can rescue a path inside an ignored path pattern', () => {
      const ignore = compileIgnore(['logs/**', '!logs/audit.txt']);
      expect(ignore.ignores('logs/debug.txt')).toBe(true);
      expect(ignore.ignores('logs/audit.txt')).toBe(false);
    });
  });

  // ...........................................................................
  describe('the edges a config file actually contains', () => {
    it('ignores blank lines and `#` comments', () => {
      const ignore = compileIgnore(['', '   ', '# build output', 'dist']);
      expect(ignore.ignores('dist/app.js')).toBe(true);
      expect(ignore.ignores('build output')).toBe(false);
    });

    it('treats an undefined or empty list as ignoring nothing', () => {
      expect(compileIgnore(undefined).ignores('anything')).toBe(false);
      expect(compileIgnore([]).ignores('anything')).toBe(false);
    });

    it('says nothing is ignored for an empty path', () => {
      // The root itself. Asking about it is how a scan of `.` would ignore the
      // whole folder.
      const ignore = compileIgnore(['*']);
      expect(ignore.ignores('')).toBe(false);
      expect(ignore.ignores('.')).toBe(false);
      expect(ignore.ignores('/')).toBe(false);
    });

    it('survives a pattern that is only a separator', () => {
      const ignore = compileIgnore(['/', '\\']);
      expect(ignore.ignores('a.txt')).toBe(false);
    });

    it('trims surrounding whitespace but keeps it inside a name', () => {
      const ignore = compileIgnore(['  *.tmp  ', 'my file*']);
      expect(ignore.ignores('a.tmp')).toBe(true);
      expect(ignore.ignores('my file.txt')).toBe(true);
    });

    it('does not let a regular-expression metacharacter act as one', () => {
      // A user writing `a+b.txt` means a file called `a+b.txt`.
      const ignore = compileIgnore(['a+b.txt', 'x(1).txt', '$money*']);
      expect(ignore.ignores('a+b.txt')).toBe(true);
      expect(ignore.ignores('aab.txt')).toBe(false);
      expect(ignore.ignores('x(1).txt')).toBe(true);
      expect(ignore.ignores('$money-2026.csv')).toBe(true);
    });
  });
});

// ...........................................................................
describe('globToRegExp', () => {
  // Exported because the translation is the part worth reading on its own, and
  // a wrong anchor is the failure mode that looks like everything working.
  it('anchors at both ends', () => {
    const re = globToRegExp('a*.txt');
    expect(re.test('ab.txt')).toBe(true);
    expect(re.test('xab.txt')).toBe(false);
    expect(re.test('ab.txt.bak')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(globToRegExp('*.txt').flags).toContain('i');
  });

  it('lets a bare `**` cross separators', () => {
    expect(globToRegExp('a/**').test('a/b/c')).toBe(true);
  });
});
