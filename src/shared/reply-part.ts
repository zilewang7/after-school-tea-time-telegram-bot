/**
 * Which message of a bot reply one Telegram message is.
 *
 * A bot reply reaches the chat as several messages: the text body may be split,
 * the long CoT becomes a link message, the GoogleSearch footer and the Tools
 * block may fold into their own link messages, and the media (pictures, album,
 * GIF, sticker, file, widget) are separate messages of their own. The delivery
 * records one row per message (bot_reply_messages), a reaction row snapshots the
 * part it landed on, and the runtime block labels that part for the model.
 *
 * This module is the single source of the part vocabulary: it is shared by the
 * db (storage), the delivery (recording), the reply layer (rendering) and the
 * telegram layer (layout chunks), none of which may invent a new kind on its own.
 */

/** The parts a reply can be made of; `body` is the reply text itself */
export type ReplyPartKind =
    | 'body'
    | 'cot-link'
    | 'search-link'
    | 'tools-link'
    | 'picture'
    | 'gif'
    | 'sticker'
    | 'file'
    | 'widget'
    | 'widget-link';

/** Every kind, in render order inside one message's reaction lines */
export const REPLY_PART_ORDER: readonly ReplyPartKind[] = [
    'body',
    'cot-link',
    'search-link',
    'tools-link',
    'picture',
    'gif',
    'sticker',
    'file',
    'widget',
    'widget-link',
];

/** Fixed render rank of each kind; a body segment's index breaks ties */
const REPLY_PART_RANK = new Map<ReplyPartKind, number>(
    REPLY_PART_ORDER.map((kind, index) => [kind, index])
);

/** The body is the reply's text; every other kind is a product message of its own */
export const isBodyPart = (kind: ReplyPartKind): boolean => kind === 'body';

/** Whether a value from the database is a known kind (a bad string is not trusted) */
export const isReplyPartKind = (value: unknown): value is ReplyPartKind => {
    if (typeof value !== 'string') return false;
    return REPLY_PART_ORDER.some((kind) => kind === value);
};

/** Fixed render rank; unknown values sort last (defensive, storage is validated) */
export const replyPartRankOf = (kind: ReplyPartKind): number =>
    REPLY_PART_RANK.get(kind) ?? Number.MAX_SAFE_INTEGER;

const BODY_LABEL = '正文';
const PICTURE_LABEL = '图片';

/**
 * What one part reads as in the runtime block. The body's first segment is just
 * 「正文」; a later segment says which one it is. Media names itself: the model
 * must be able to tell a reaction on the sticker from one on the body.
 */
export const replyPartLabelOf = (kind: ReplyPartKind, index: number | null): string => {
    switch (kind) {
        case 'body':
            return index !== null && index > 1 ? `${BODY_LABEL}第 ${index} 段` : BODY_LABEL;
        case 'cot-link':
            return 'CoT 链接条';
        case 'search-link':
            return '搜索来源链接条';
        case 'tools-link':
            return '工具记录链接条';
        case 'picture':
            return index !== null && index > 0 ? `${PICTURE_LABEL} ${index}` : PICTURE_LABEL;
        case 'gif':
            return '动图';
        case 'sticker':
            return '贴纸';
        case 'file':
            return '文件';
        case 'widget':
            return '卡片';
        case 'widget-link':
            return '卡片链接';
    }
};
