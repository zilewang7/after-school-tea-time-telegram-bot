/**
 * Ask STWP's @biliarchiver_bot to archive a shared video to the Internet
 * Archive, feeding the public archive that our own IA fallback reads from.
 *
 * Telegram bots cannot message other bots, so the request relays through
 * luoxu's MTProto user account: a narrowly-scoped endpoint that can only ever
 * send a bare BV id to that one bot. Courtesy traffic — fire-and-forget,
 * deduped per process, and skipped when the video is already on the Archive.
 */
import { avToBv, hasArchiveOrgItem } from './bilibili-danmaku-archive.js';
import type { BilibiliVideoRef } from './bilibili-danmaku-service.js';

const luoxuBaseUrl = process.env.LUOXU_PREVIEW_URL;

const REQUEST_TIMEOUT_MS = 15_000;
const SUBMITTED_MAX_ENTRIES = 1000;

/** BV ids this process already submitted (or found archived) */
const submitted = new Set<string>();

const rememberSubmitted = (bvid: string): void => {
    if (submitted.size >= SUBMITTED_MAX_ENTRIES) {
        const oldest = submitted.values().next().value;
        if (oldest !== undefined) submitted.delete(oldest);
    }
    submitted.add(bvid);
};

const doSubmit = async (bvid: string): Promise<void> => {
    if (await hasArchiveOrgItem(bvid)) {
        console.log(`[biliarchiver] ${bvid} is already on the Archive, not submitting`);
        return;
    }

    const res = await fetch(`${luoxuBaseUrl}/biliarchiver/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bvid }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`luoxu /biliarchiver/submit HTTP ${res.status}`);
    }
    console.log(`[biliarchiver] submitted ${bvid} to @biliarchiver_bot`);
};

/**
 * Fire-and-forget archive request for one video. Never throws; a failed
 * submission is forgotten so a later share of the same video retries.
 */
export const submitVideoForArchiving = (ref: BilibiliVideoRef): void => {
    if (!luoxuBaseUrl) return;
    const bvid = ref.bvid ?? (ref.aid === null ? null : avToBv(ref.aid));
    if (bvid === null || submitted.has(bvid)) return;
    rememberSubmitted(bvid);

    void doSubmit(bvid).catch((error) => {
        submitted.delete(bvid);
        console.error(
            '[biliarchiver] submit failed:',
            error instanceof Error ? error.message : error
        );
    });
};
