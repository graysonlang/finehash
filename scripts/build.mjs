import { runBuild } from '@graysonlang/esp/esbuild-runner';

// getOptions receives resolved CLI flags (minify, banner, etc.) plus any
// unknown flags forwarded from the command line as esbuild overrides
// (e.g. --sourcemap or --no-minify).
function getOptions(args) {
  return {
    assetNames: '[name]',
    bundle: true,
    entryPoints: {
      main: 'demo/main.js',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    // The demo builds into www/ (what Pages deploys); dist/ stays reserved
    // for npm package artifacts, matching the sibling slim-webp-enc layout.
    outdir: 'www',
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
