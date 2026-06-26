// Emit the library distribution from one source of truth (src/public.ts):
//   - dist/finehash.js   single minified, dependency-free ESM bundle (CDN-friendly)
//   - dist/*.d.ts        type declarations, generated from the same wrapper (no hand-maintained
//                        duplicate). dist/public.d.ts is the entry the package's `types` points at.
// The readable, broken-out modules live upstream in src/. Run with: npm run dist

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

const bundle = 'dist/finehash.js';

const result = await esbuild.build({
  entryPoints: ['src/public.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020'], // broad enough for any modern runtime or bundler
  platform: 'neutral', // pure arithmetic - no node/browser assumptions
  legalComments: 'none',
  metafile: true,
  outfile: bundle,
});

// Declarations, generated from src/public.ts via tsc (single source - no drift).
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.dist.json'], { stdio: 'inherit' });

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`dist: ${bundle} (${(bytes / 1024).toFixed(1)} KB, single file, 0 deps) + generated dist/*.d.ts`);
