<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Contributors Guide

- [Prepare](#prepare)
- [Develop](#develop)
- [Administrate](#administrate)
- [Fast Coding](#fast-coding)

## ⚠️ Important: ESLint Version

**Do NOT update ESLint to v10.x** - The package is pinned to `eslint ~9.39.2` because `eslint-plugin-tsdoc@0.5.0` is incompatible with ESLint v10's API changes (specifically `context.getSourceCode()` was removed). Updating to v10 will break the build.

## Prepare

Read [prepare.md](doc/prepare.md)

<!-- ........................................................................-->

## Develop

Read [develop.md](doc/develop.md)

## Administrate

Read [create-new-repo.md](doc/create-new-repo.md)

## Fast Coding

Read [fast-coding-guide.md](doc/fast-coding-guide.md)
