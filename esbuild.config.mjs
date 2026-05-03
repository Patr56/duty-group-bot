import { build } from 'esbuild';

await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'dist/index.js',
    sourcemap: true,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
});
