/**
 * Production build of the panel frontend into webapp/dist (or WEBAPP_OUT_DIR).
 * The bot serves dist/index.html for history routes and dist/assets/* as immutable files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { createBaseConfig, webappRoot } from './vite-config.mts';

/**
 * Output directory, relative to webapp/. The deploy script builds into a
 * staging directory and swaps it in once the server build succeeded too.
 */
const outDir = process.env.WEBAPP_OUT_DIR || 'dist';

/**
 * The browsers Vite 7 built for by default. Vite 8 moved its default up to
 * Safari 16.4. The panel runs in the web view of whatever phone opens it, so
 * the older baseline stays until someone decides to drop those devices.
 */
const BROWSER_TARGETS = ['chrome107', 'edge107', 'firefox104', 'safari16'];

/** A script tag without `src`: the page's Content-Security-Policy (src/panel/static.ts) blocks it */
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i;

await build({
    ...createBaseConfig(),
    mode: 'production',
    build: {
        outDir,
        assetsDir: 'assets',
        emptyOutDir: true,
        sourcemap: false,
        reportCompressedSize: true,
        target: BROWSER_TARGETS,
    },
});

// A bundler or plugin that starts to inline a loader would leave a page that
// opens blank in production; fail the build here, where the start script and
// `pnpm verify` both notice.
const builtPage = readFileSync(resolve(webappRoot, outDir, 'index.html'), 'utf8');
if (INLINE_SCRIPT.test(builtPage)) {
    throw new Error('the built index.html contains an inline script, which the Content-Security-Policy of the panel blocks');
}
