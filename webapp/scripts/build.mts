/**
 * Production build of the panel frontend into webapp/dist (or WEBAPP_OUT_DIR).
 * The bot serves dist/index.html for history routes and dist/assets/* as immutable files.
 */
import { build } from 'vite';
import { createBaseConfig } from './vite-config.mts';

/**
 * Output directory, relative to webapp/. The deploy script builds into a
 * staging directory and swaps it in once the server build succeeded too.
 */
const outDir = process.env.WEBAPP_OUT_DIR || 'dist';

await build({
    ...createBaseConfig(),
    mode: 'production',
    build: {
        outDir,
        assetsDir: 'assets',
        emptyOutDir: true,
        sourcemap: false,
        reportCompressedSize: true,
    },
});
