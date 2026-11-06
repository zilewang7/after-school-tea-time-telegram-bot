/**
 * Dev server for the panel frontend.
 *
 * /api is proxied to a running bot (PANEL_API_ORIGIN, default http://127.0.0.1:8080).
 * The page only works inside Telegram, because every request needs a signed initData.
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
        },
    },
});

await server.listen();
server.printUrls();
console.log(`[webapp] /api -> ${apiOrigin}`);
