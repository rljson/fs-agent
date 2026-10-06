// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// WHICH FILES THE SYNC DOES NOT SEE.
//
// The rule used to be `name === pattern || name.startsWith(pattern)`, which
// cannot express a file EXTENSION: `*.exe` matches nothing, because no file is
// called `*.exe` and none begins with it. The One Client has shipped `'*.log'`
// in its default ignore list all along — a line that has never had any effect —
// and `ensureSystemIgnores` in that package actively STRIPS `~$*`, `~*.tmp` and
// `.~lock.*` from older configs, with the comment *"FsScanner uses startsWith,
// so '~$*' is a literal prefix that never matches anything useful"*. Somebody
// wrote globs, they did nothing, and the workaround was to delete them.
//
// Q3 backlog X3, Kritisch: *"Die gelieferte Liste wäre nicht anwendbar"* — the
// ignore list a deployment is given cannot be applied at all.
//
// THE COMPATIBILITY RULE, and it is the whole reason this is safe to land:
//
//   A pattern containing none of `*`, `?`, `/` or `\`, not starting with `!`
//   and not ending with `/` keeps its OLD MEANING EXACTLY — equal to, or a
//   prefix of, any path segment.
//
// That is not politeness about old config files. `~$` and `.~lock.` are the
// Office and LibreOffice lock-file prefixes the product relies on, and
// `ATOMIC_TMP_PREFIX` (`.fsagent-tmp-`) is how this agent hides its own
// in-progress writes from its own watcher. Under pure glob semantics all three
// would match only a file named exactly that, every atomic write would come
// back as a change event, and the debounce that batches a push would be reset
// before it could fire — which is a defect this package has already had once
// and recorded in `fs-scanner.ts`.
//
// Anything else is a glob, in the notation X3 asks for: `*`, `?`, `**`,
// folders with `/`, anchored at the root, exceptions with `!`, case
// insensitive, and `/` and `\` equivalent.
// .............................................................................

/** One compiled line of an ignore list. */
interface IgnoreRule {
  /** An `!` line, which RESCUES what an earlier line ignored. */
  readonly negated: boolean;
  /** A trailing `/`: the pattern names a directory, not a file. */
  readonly dirOnly: boolean;
  /**
   * - `literal` — the old prefix rule, kept for patterns with no glob syntax.
   * - `segment` — a glob with no `/`: tested against each path segment.
   * - `path` — a glob with a `/`: tested against the whole relative path.
   */
  readonly kind: 'literal' | 'segment' | 'path';
  /** For `literal`. */
  readonly literal: string;
  /** For `segment` and `path`. */
  readonly re: RegExp | undefined;
}

/** Characters whose presence makes a pattern a glob rather than a prefix. */
const GLOB_CHARS = /[*?/\\]/;

/**
 * Escapes the regular-expression metacharacters that are NOT glob syntax.
 *
 * `*` and `?` are handled by the translator and must not reach this.
 * @param text - A run of literal characters from a glob.
 * @returns The same text, safe to embed in a regular expression.
 */
const escapeLiteral = (text: string): string =>
  text.replace(/[.+^${}()|[\]\\\-]/g, '\\$&');

/**
 * Translates a glob into an anchored, case-insensitive regular expression.
 *
 * `*` and `?` stop at a separator, `**` crosses them. A `**` followed by `/`
 * also matches ZERO directories, so `**\/x` matches `x` at the root as well as
 * at any depth — the one piece of gitignore's behaviour that is not obvious
 * from the characters.
 * @param glob - The pattern, separators already normalised to `/`.
 * @returns A regular expression matching the whole string.
 */
export const globToRegExp = (glob: string): RegExp => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // `**/` — any number of directories, including none.
          out += '(?:[^/]+/)*';
          i++;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(char);
    }
  }
  return new RegExp(`^${out}$`, 'i');
};

/**
 * Normalises a path the way every comparison here expects it.
 *
 * Windows separators become `/`, a leading `./` or `/` goes, and a trailing
 * `/` goes — so one path has one spelling whichever side produced it. The
 * watcher reports `sub\dir\file` on Windows and `sub/dir/file` elsewhere for
 * the same file.
 * @param path - A path relative to the sync root.
 * @returns The normalised form.
 */
const normalise = (path: string): string => {
  const slashed = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  // A bare `.` is the root itself, not a segment called `.` — and a scan asks
  // about `.` first, so a pattern like `*` would otherwise ignore the folder
  // it is scanning.
  return slashed === '.' ? '' : slashed;
};

/**
 * Compiles one line of an ignore list.
 * @param pattern - The line, as the user or the product wrote it.
 * @returns The rule, or undefined for a blank line or a `#` comment.
 */
const compileRule = (pattern: string): IgnoreRule | undefined => {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;

  const negated = trimmed.startsWith('!');
  const body = negated ? trimmed.slice(1) : trimmed;

  // THE COMPATIBILITY RULE. See the header: `~$`, `.~lock.` and
  // `.fsagent-tmp-` are prefixes the product and this agent depend on.
  if (!negated && !GLOB_CHARS.test(body)) {
    return {
      negated: false,
      dirOnly: false,
      kind: 'literal',
      literal: body,
      re: undefined,
    };
  }

  const dirOnly = /[/\\]$/.test(body);
  const glob = normalise(body);
  if (glob === '') return undefined;

  return {
    negated,
    dirOnly,
    kind: glob.includes('/') ? 'path' : 'segment',
    literal: glob,
    re: globToRegExp(glob),
  };
};

/**
 * Whether one rule covers a path.
 * @param rule - The compiled rule.
 * @param path - The normalised relative path.
 * @param segments - That path, split on `/`.
 * @param isDirectory - True, false, or undefined when the caller cannot say.
 * @returns True when the rule matches.
 */
const ruleMatches = (
  rule: IgnoreRule,
  path: string,
  segments: readonly string[],
  isDirectory: boolean | undefined,
): boolean => {
  if (rule.kind === 'literal') {
    // Every segment, because a pattern names a directory as readily as a file —
    // and a nested match never fired while only the watcher's full relative
    // path was tested. That is recorded in `fs-scanner.ts`.
    return segments.some(
      (segment) =>
        segment === rule.literal || segment.startsWith(rule.literal),
    );
  }

  const re = rule.re as RegExp;

  if (rule.kind === 'segment') {
    // A SEGMENT rule can still be directory-only: `build/` normalises to
    // `build`, which has no separator left in it. The last segment is the
    // thing itself and needs the caller's answer; any earlier segment is an
    // ancestor DIRECTORY by construction, so a match there always counts.
    const last = segments.length - 1;
    return segments.some((segment, index) => {
      if (!re.test(segment)) return false;
      if (!rule.dirOnly) return true;
      return index < last || isDirectory !== false;
    });
  }

  // A path pattern matches the path itself...
  if (re.test(path) && !(rule.dirOnly && isDirectory === false)) {
    return true;
  }
  // ...and anything BENEATH a directory it matches, so `build/` or `logs/**`
  // covers the contents and not merely the folder entry. Walking the ancestors
  // is what makes "ignore this folder" mean what it says.
  let ancestor = '';
  for (const segment of segments.slice(0, -1)) {
    ancestor = ancestor === '' ? segment : `${ancestor}/${segment}`;
    if (re.test(ancestor)) return true;
  }
  return false;
};

/** Decides whether a path is ignored. Compiled once, asked many times. */
export interface IgnoreMatcher {
  /**
   * @param relativePath - Path relative to the sync root, either separator.
   * @param isDirectory - Pass it when known; a directory-only pattern needs it.
   * @returns True when the sync must not see this path.
   */
  ignores(relativePath: string, isDirectory?: boolean): boolean;
}

/**
 * Compiles an ignore list into a matcher.
 *
 * **Order matters, and the LAST match decides** — the gitignore rule, and the
 * only one under which `!` can mean anything: `['*.log', '!keep.log']` keeps
 * `keep.log` and `['!keep.log', '*.log']` does not. One caveat inherited with
 * the semantics: the scanner does not descend into an ignored directory, so a
 * `!` line cannot rescue a file inside one.
 * @param patterns - The ignore list, in the order it was written.
 * @returns A matcher over those patterns.
 */
export const compileIgnore = (
  patterns: readonly string[] | undefined,
): IgnoreMatcher => {
  const rules: IgnoreRule[] = [];
  for (const pattern of patterns ?? []) {
    const rule = compileRule(pattern);
    if (rule !== undefined) rules.push(rule);
  }

  return {
    ignores: (relativePath: string, isDirectory?: boolean): boolean => {
      const path = normalise(relativePath);
      if (path === '') return false;
      const segments = path.split('/').filter((s) => s !== '');
      let ignored = false;
      for (const rule of rules) {
        if (ruleMatches(rule, path, segments, isDirectory)) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
};
