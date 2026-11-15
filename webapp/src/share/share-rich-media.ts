/**
 * The public share JSON's media views as the panel's `MediaAttachment` shape, so
 * a shared rich reply renders through the same `RichAnswerView` as the reply
 * detail (v5.3 design 2026-1116-0310 §三.3).
 *
 * Pure module (no React) so the offline cases can cover the URL/order/id rules.
 * The bytes stay behind the share's own media route: the token is the only
 * permission, and the server refuses media the share does not expose.
 */
import type { MediaAttachment, PublicShareMedia, PublicShareMediaItem } from '../api';
import { parseRichAnswer, type RichAnswerBlock } from '../rich/rich-answer';
import { shareMediaUrlOf } from './share-asset-urls';

/** The route slot a media view loads from; documents use their own slot */
const shareSlotOf = (media: PublicShareMedia): 'image' | 'file' =>
    media.kind === 'file' ? 'file' : 'image';

const attachmentOf = (
    token: string,
    messageId: number,
    media: PublicShareMedia,
    index: number | undefined
): MediaAttachment => ({
    kind: media.kind,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    fileName: media.fileName,
    ...(media.caption === undefined ? {} : { caption: media.caption }),
    ...(media.placement === undefined ? {} : { placement: media.placement }),
    ...(media.id === undefined ? {} : { id: media.id }),
    url: shareMediaUrlOf(token, messageId, shareSlotOf(media), index),
});

/**
 * A reply share's pictures: every one belongs to the pinned version's first
 * message, and its position is the list order (inline pictures first). A first
 * picture keeps the URL it minted before v5; later ones name `?i=`.
 */
export const shareRichMediaOf = (
    token: string,
    messageId: number,
    media: readonly PublicShareMedia[]
): MediaAttachment[] =>
    media.map((item, index) => attachmentOf(token, messageId, item, index === 0 ? undefined : index));

/**
 * A conversation bubble's pictures: each item names the message that owns its
 * bytes, and its `index` is the position inside that message's picture list.
 */
export const shareRichMediaItemsOf = (
    token: string,
    media: readonly PublicShareMediaItem[]
): MediaAttachment[] =>
    media.map((item) => attachmentOf(token, item.messageId, item, item.index));

/**
 * The display blocks of a shared bot body, or null when the payload carries no
 * snapshot (older shares, entities versions, blank answer): the page then keeps
 * its plain text layout unchanged.
 */
export const shareRichAnswerBlocksOf = (
    markdown: string | undefined,
    media: readonly PublicShareMedia[]
): RichAnswerBlock[] | null => {
    if (markdown === undefined || markdown.trim() === '') return null;
    const blocks = parseRichAnswer(markdown, media);
    // A snapshot that parses to nothing (e.g. only empty block-level <p> tags) is
    // no richer than the stored text: keep the plain layout instead of an empty body.
    return blocks.length === 0 ? null : blocks;
};
