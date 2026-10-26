/**
 * Compare the live ColorfulHachimi pack with src/services/sticker-catalog.ts.
 *
 * The catalog is keyed by file_unique_id, so a pack edit (the author adding
 * 67_戴蓝黑条纹帽, or replacing the duplicate 72) shows up as a position
 * change, a new id, or a removed id. This script prints what changed; it does
 * not rewrite the catalog, because a new sticker needs a human label.
 *
 * Run: npx tsx scripts/stickers/refresh-catalog.ts [setName]
 */
import 'dotenv/config';
import { STICKER_CATALOG } from '../../src/services/sticker-catalog.js';

interface LiveSticker {
    readonly file_unique_id: string;
    readonly file_id: string;
    readonly emoji: string;
}

interface LiveStickerSet {
    readonly stickers: readonly LiveSticker[];
}

const setName = process.argv[2] ?? process.env.STICKER_SET_NAME ?? 'ColorfulHachimi';
const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is required (read from .env)');

const response = await fetch(
    `https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(setName)}`
);
const payload = (await response.json()) as { ok: boolean; description?: string; result?: LiveStickerSet };
if (!payload.ok || !payload.result) {
    throw new Error(`getStickerSet(${setName}) failed: ${payload.description ?? response.status}`);
}

const live = payload.result.stickers;
const byUniqueId = new Map(STICKER_CATALOG.map((entry) => [entry.fileUniqueId, entry]));
const liveIds = new Set(live.map((sticker) => sticker.file_unique_id));

console.log(`live pack: ${setName}, ${live.length} stickers; catalog: ${STICKER_CATALOG.length}`);
console.log('');

let changes = 0;
for (const [index, sticker] of live.entries()) {
    const position = index + 1;
    const known = byUniqueId.get(sticker.file_unique_id);
    if (!known) {
        changes += 1;
        console.log(
            `NEW   position ${String(position).padStart(2, '0')}  emoji ${sticker.emoji}  ` +
                `unique ${sticker.file_unique_id}  -> add a catalog entry with an actual-picture label`
        );
        continue;
    }
    if (known.packIndex !== position) {
        changes += 1;
        console.log(
            `MOVE  ${String(known.packIndex).padStart(2, '0')} -> ${String(position).padStart(2, '0')}  ` +
                `${known.label}  (unique ${known.fileUniqueId})`
        );
    }
}

for (const entry of STICKER_CATALOG) {
    if (!liveIds.has(entry.fileUniqueId)) {
        changes += 1;
        console.log(
            `GONE  ${String(entry.packIndex).padStart(2, '0')}  ${entry.label}  ` +
                `(unique ${entry.fileUniqueId})`
        );
    }
}

if (changes === 0) {
    console.log('no changes: the catalog matches the live pack, positions and unique ids.');
} else {
    console.log('');
    console.log(`${changes} change(s). Update src/services/sticker-catalog.ts, then restart the bot.`);
}
