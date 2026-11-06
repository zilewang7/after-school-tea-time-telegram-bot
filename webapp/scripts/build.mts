/**
 * Production build of the panel frontend into webapp/dist.
 * The bot serves dist/index.html for history routes and dist/assets/* as immutable files.
 */
import { build } from 'vite';
import { createBaseConfig } from './vite-config.mts';

await build({
    ...createBaseConfig(),
    mode: 'production',
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        emptyOutDir: true,
        sourcemap: false,
        reportCompressedSize: true,
    },
});
