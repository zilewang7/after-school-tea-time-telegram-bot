/**
 * Dev server for the panel frontend.
 *
 * /api and the public share routes (/s) are proxied to a running bot
 * (PANEL_API_ORIGIN, default http://127.0.0.1:8080). The page only works inside
 * Telegram, because every request needs a signed initData — except the share page.
 */
import { createServer } from 'vite';
import { createBaseConfig } from './vite-config.mts';

const apiOrigin = process.env.PANEL_API_ORIGIN || 'http://127.0.0.1:8080';
const port = Number(process.env.PANEL_DEV_PORT || 5173);

const server = await createServer({
    ...createBaseConfig(),
    mode: 'development',
    server: {
        port,
        strictPort: true,
        proxy: {
            '/api': { target: apiOrigin, changeOrigin: true },
            // The share page's widget iframes and media come from the public /s/ routes
            // ('/s/' matches the public routes but not the SPA's own /share/:token page)
            '/s/': { target: apiOrigin, changeOrigin: true },
        },
    },
});

await server.listen();
server.printUrls();
console.log(`[webapp] /api and /s -> ${apiOrigin}`);
