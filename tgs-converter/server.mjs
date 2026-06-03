/**
 * tgs-converter: a tiny HTTP wrapper around the rlottie + ffmpeg toolchain
 * (from edasriyan/lottie-to-webm) that converts Telegram .tgs animated
 * stickers to .webm video so multimodal models can "see" them.
 *
 * Endpoints:
 *   POST /convert   body = raw .tgs bytes  -> 200 video/webm bytes
 *   GET  /health                           -> 200 "ok"
 *
 * Zero npm dependencies: pure Node stdlib. Includes an in-process sha256 LRU
 * cache (second-line defense; the bot keeps the primary file_unique_id cache).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const CONVERT_SCRIPT = process.env.CONVERT_SCRIPT || 'lottie_to_webm.sh';
const MAX_INPUT_BYTES = Number(process.env.MAX_INPUT_BYTES || 5 * 1024 * 1024); // .tgs are tiny
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 30000);
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 200);

// Simple LRU: Map preserves insertion order; re-insert on hit, evict oldest.
/** @type {Map<string, Buffer>} */
const cache = new Map();

const cacheGet = (key) => {
    const val = cache.get(key);
    if (val === undefined) return undefined;
    cache.delete(key);
    cache.set(key, val);
    return val;
};

const cacheSet = (key, val) => {
    cache.set(key, val);
    while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_INPUT_BYTES) {
                reject(new Error(`input too large (> ${MAX_INPUT_BYTES} bytes)`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });

/**
 * Run the rlottie+ffmpeg conversion script on a .tgs buffer, return .webm bytes.
 */
const convertTgsToWebm = async (tgsBuffer) => {
    const dir = await mkdtemp(join(tmpdir(), 'tgs-'));
    const inPath = join(dir, 'in.tgs');
    const outPath = join(dir, 'out.webm');
    try {
        await writeFile(inPath, tgsBuffer);

        await new Promise((resolve, reject) => {
            const proc = spawn(CONVERT_SCRIPT, ['--output', outPath, inPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            proc.stderr.on('data', (d) => {
                stderr += d.toString();
            });
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error('conversion timed out'));
            }, CONVERT_TIMEOUT_MS);
            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`convert exited ${code}: ${stderr.slice(0, 500)}`));
            });
        });

        return await readFile(outPath);
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (req.method === 'POST' && req.url === '/convert') {
        try {
            const body = await readBody(req);
            if (body.length === 0) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('empty body');
                return;
            }

            const key = createHash('sha256').update(body).digest('hex');
            let webm = cacheGet(key);
            if (webm === undefined) {
                webm = await convertTgsToWebm(body);
                cacheSet(key, webm);
                console.log(`[tgs-converter] converted ${body.length}B tgs -> ${webm.length}B webm (cache miss)`);
            } else {
                console.log(`[tgs-converter] cache hit for ${key.slice(0, 12)}`);
            }

            res.writeHead(200, {
                'Content-Type': 'video/webm',
                'Content-Length': webm.length,
            });
            res.end(webm);
        } catch (err) {
            console.error('[tgs-converter] convert failed:', err?.message || err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`convert failed: ${err?.message || 'unknown'}`);
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
});

server.listen(PORT, () => {
    console.log(`[tgs-converter] listening on :${PORT}`);
});
