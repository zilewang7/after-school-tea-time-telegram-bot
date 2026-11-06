/**
 * Shared Vite settings for the panel frontend.
 *
 * There is deliberately no vite.config.ts: Vite expects a default export there,
 * so build.mts and dev.mts drive Vite through its programmatic API instead.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { InlineConfig } from 'vite';

export const webappRoot = fileURLToPath(new URL('..', import.meta.url));

export const createBaseConfig = (): InlineConfig => ({
    root: webappRoot,
    // History routing: index.html is served for every non-asset path, so assets must be absolute
    base: '/',
    configFile: false,
    clearScreen: false,
    plugins: [react()],
});
