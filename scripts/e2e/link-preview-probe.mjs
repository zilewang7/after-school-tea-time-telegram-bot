#!/usr/bin/env node
/**
 * Link-preview probe: does Telegram classify a URL as a large photo preview?
 *
 * Telegram's own crawler decides `webPage.type` / `has_large_media` server-side;
 * the only ground truth is reading back the sent message's media through MTProto.
 * This script posts the URLs from luoxu's userbot into the dedicated test group,
 * reads the `messageMediaWebPage.webpage` fields back, prints them, and deletes
 * the probe messages.
 *
 * Usage:
 *   node scripts/e2e/link-preview-probe.mjs https://example.com/s/abc [more...]
 *
 * Expected for a share page with a 1200x630 og:image:
 *   type=photo, large=true, photo=[1200,630]
 *
 * Requires: luoxu-api container running with the userbot session (same client
 * the bot's e2e harness uses), docker CLI on this host.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = 'luoxu-api';
const TEST_GROUP = 2311128579;

const urls = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const keepMessages = process.argv.includes('--keep');
if (urls.length === 0) {
    console.error('usage: node scripts/e2e/link-preview-probe.mjs <url> [url...] [--keep]');
    process.exit(2);
}

const probePy = String.raw`
import asyncio, json, sys, tomllib
from telethon import TelegramClient
from telethon.tl.types import PeerChannel, MessageMediaWebPage, WebPage, WebPageEmpty, WebPagePending

GROUP = ${TEST_GROUP}
KEEP = ${keepMessages ? 'True' : 'False'}

with open('/app/config.toml', 'rb') as f:
    cfg = tomllib.load(f)
tg = cfg['telegram']

async def main(urls):
    client = TelegramClient('/tmp/og-probe.session', tg['api_id'], tg['api_hash'], auto_reconnect=False)
    await client.connect()
    if not await client.is_user_authorized():
        print(json.dumps({'error': 'userbot session is not authorized'}))
        return
    ids = []
    for url in urls:
        msg = await client.send_message(PeerChannel(GROUP), url, link_preview=True)
        ids.append(msg.id)
    results = []
    for _attempt in range(10):
        await asyncio.sleep(4)
        msgs = await client.get_messages(PeerChannel(GROUP), ids=ids)
        pending = False
        results = []
        for m in msgs:
            media = m.media
            wp = getattr(media, 'webpage', None) if isinstance(media, MessageMediaWebPage) else None
            row = {'messageId': m.id, 'text': m.message}
            if wp is None:
                row['webpage'] = None
            elif isinstance(wp, WebPagePending):
                row['webpage'] = 'pending'; pending = True
            elif isinstance(wp, WebPageEmpty):
                row['webpage'] = 'empty'
            else:
                photo = getattr(wp, 'photo', None)
                dims = None
                if photo is not None:
                    best = None
                    for size in (getattr(photo, 'sizes', []) or []):
                        w = getattr(size, 'w', None)
                        if w and (best is None or w > best[0]):
                            best = (w, getattr(size, 'h', None))
                    dims = best
                row['webpage'] = {
                    'type': wp.type,
                    'site': wp.site_name,
                    'title': wp.title,
                    'url': wp.url,
                    'large': bool(getattr(wp, 'has_large_media', False)),
                    'photo': dims,
                }
            results.append(row)
        if not pending:
            break
    if not KEEP:
        await client.delete_messages(PeerChannel(GROUP), ids)
    print(json.dumps({'results': results}, ensure_ascii=False))
    await client.disconnect()

asyncio.run(main(sys.argv[1:]))
`;

const dir = mkdtempSync(join(tmpdir(), 'og-probe-'));
const localPy = join(dir, 'og-probe.py');
writeFileSync(localPy, probePy, 'utf8');

const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
    docker(['exec', CONTAINER, 'cp', '/app/mybot.session', '/tmp/og-probe.session']);
    docker(['cp', localPy, `${CONTAINER}:/tmp/og-probe.py`]);
    const output = docker(['exec', CONTAINER, 'python3', '/tmp/og-probe.py', ...urls]);
    const parsed = JSON.parse(output.trim().split('\n').at(-1));
    for (const row of parsed.results) {
        const page = row.webpage;
        const verdict =
            page && page !== 'pending' && page !== 'empty'
                ? `type=${page.type} large=${String(page.large)} photo=${JSON.stringify(page.photo)} url=${page.url}`
                : `webpage=${String(page)}`;
        console.log(`${row.text}\n  ${verdict}`);
    }
} finally {
    try {
        docker(['exec', CONTAINER, 'rm', '-f', '/tmp/og-probe.py', '/tmp/og-probe.session']);
    } catch {
        // cleanup is best effort
    }
    rmSync(dir, { recursive: true, force: true });
}
