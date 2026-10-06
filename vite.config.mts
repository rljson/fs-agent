// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { resolve } from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ include: ['src/**/*'] })],

  build: {
    copyPublicDir: false,
    minify: false,
    // sourcemap: 'inline',

    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@rljson/rljson',
        '@rljson/json',
        '@rljson/hash',
        // Add all peer depencies from package.json here
        '@rljson/bs',
        '@rljson/db',
        '@rljson/io',
        '@rljson/server',
        // Every node builtin this package imports has to be listed. Anything
        // missing is replaced by vite's browser shim, which exports nothing —
        // `crypto` was absent and the build failed with
        // `"createHash" is not exported by "__vite-browser-external"`.
        //
        // It went unnoticed because `prebuild` runs the tests first: while any
        // test failed the vite step never ran, so a red suite masked a package
        // that could not be built at all.
        'crypto',
        'fs',
        'fs/promises',
        'path',
        'node:stream',
        'node:http',
        'node:net',
        'socket.io',
        'socket.io-client',
      ],
      output: {
        globals: {},
      },
    },
  },
});
