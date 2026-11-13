/**
 * One picture, video or file, however many messages of a context carry it.
 *
 * The same sticker posted twice in a thread, a picture forwarded and then
 * re-posted, a message whose media also arrives through a t.me link preview:
 * the bytes are identical and the model pays for them again in full. This pass
 * keeps the first occurrence in reading order and replaces every later copy
 * with one line saying where the media already is, so nothing about the
 * conversation is lost — only the repeated tokens.
 *
 * Only media the model can actually see is considered. A text-only model gets
 * its images filtered out further downstream anyway, and a note about a picture
 * it cannot see would be noise.
 *
 * The pictures a message contributes to the tool index (`#N 的第 k 张图`) are
 * kept in step: a dropped part leaves the list, and the tools fall back to the
 * database for that message when the model still asks for it.
 */
import { createHash } from 'node:crypto';
import type { UnifiedContentPart, UnifiedMessage } from '../ai/types.js';
import type { ContextImage } from './context-images.js';

export interface MediaDedupeCapabilities {
    readonly supportsImageInput: boolean;
    readonly supportsMediaInput: boolean;
    /** messageId → `#N`, for naming where the kept copy is */
    readonly contextNumbers: ReadonlyMap<number, number>;
}

export interface MediaDedupeInput {
    readonly messageId: number;
    readonly message: UnifiedMessage;
    readonly images: readonly ContextImage[];
}

export interface MediaDedupeOutput {
    readonly messageId: number;
    readonly message: UnifiedMessage;
    readonly images: readonly ContextImage[];
}

export interface MediaDedupeResult {
    readonly turns: readonly MediaDedupeOutput[];
    /** How many media parts were replaced by a note */
    readonly removed: number;
}

/** The system's own contact sheet of a message's custom emoji, not conversation media */
const CUSTOM_EMOJI_ATLAS = 'custom_emoji_atlas';

/** A part whose content is a file the model would be charged for */
const isDedupable = (part: UnifiedContentPart, capabilities: MediaDedupeCapabilities): boolean => {
    // An atlas belongs to the message whose emoji it shows; its annotation
    // points at it, so it is never replaced by a pointer to another message
    if (part.mediaKind === CUSTOM_EMOJI_ATLAS) return false;
    if (part.type === 'image') return capabilities.supportsImageInput;
    if (part.type === 'media') return capabilities.supportsMediaInput;
    return false;
};

/**
 * Identity of a media part: the gs:// URI for cloud media, a hash of the
 * inline bytes otherwise. Hashing the base64 string is enough — the same bytes
 * always encode to the same string.
 */
const identityOf = (part: UnifiedContentPart): string | null => {
    if (part.fileUri) return `uri:${part.fileUri}`;
    const inline = part.imageData ?? part.mediaData;
    if (!inline) return null;
    return `sha256:${createHash('sha256').update(inline).digest('hex')}`;
};

const noteFor = (
    keptMessageId: number,
    currentMessageId: number,
    contextNumbers: ReadonlyMap<number, number>
): string => {
    if (keptMessageId === currentMessageId) {
        return '[system] the same media as an earlier part of this message — not attached again';
    }
    const number = contextNumbers.get(keptMessageId);
    return number === undefined
        ? '[system] the same media as an earlier message — not attached again'
        : `[system] the same media as #${number} — not attached again`;
};

interface KeptCopy {
    readonly messageId: number;
}

/**
 * A note stands at the position the media part stood, which since harness
 * issue #10 is inside the message block. Platforms join a message's text parts
 * with no separator (see workspace/volatile-section.ts), so the note carries a
 * leading newline of its own: it must not fuse into the body it follows.
 */
const SEPARATED_NOTE = '\n';

/**
 * Walk every turn in reading order, keep the first copy of each distinct file
 * and replace the rest with a one-line note on its own line, at the same
 * position.
 */
export const dedupeContextMedia = (
    turns: readonly MediaDedupeInput[],
    capabilities: MediaDedupeCapabilities
): MediaDedupeResult => {
    const seen = new Map<string, KeptCopy>();
    const output: MediaDedupeOutput[] = [];
    let removed = 0;

    for (const turn of turns) {
        const keptParts: UnifiedContentPart[] = [];
        for (const part of turn.message.content) {
            const identity = isDedupable(part, capabilities) ? identityOf(part) : null;
            if (identity === null) {
                keptParts.push(part);
                continue;
            }

            const kept = seen.get(identity);
            if (kept === undefined) {
                seen.set(identity, { messageId: turn.messageId });
                keptParts.push(part);
                continue;
            }

            removed += 1;
            const note = noteFor(kept.messageId, turn.messageId, capabilities.contextNumbers);
            keptParts.push({ type: 'text', text: `${SEPARATED_NOTE}${note}` });
        }

        // The pictures a turn keeps are the ones whose part survived, by identity
        const surviving = new Set<UnifiedContentPart>(keptParts);
        output.push({
            messageId: turn.messageId,
            message: { ...turn.message, content: keptParts },
            images: turn.images.filter((image) => surviving.has(image.part)),
        });
    }

    return { turns: output, removed };
};
