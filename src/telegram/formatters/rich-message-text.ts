/**
 * Plain-text extraction from Bot API rich messages (Premium rich text editor).
 * Interim safety net so rich messages land in the DB instead of vanishing;
 * will be superseded by telegram-md-entities richBlocksToMarkdown.
 */
import type { RichMessage, RichText, RichBlock } from 'grammy/types';

const richTextToPlain = (richText: RichText): string => {
    if (typeof richText === 'string') return richText;
    if (Array.isArray(richText)) return richText.map(richTextToPlain).join('');

    switch (richText.type) {
        case 'custom_emoji':
            return richText.alternative_text;
        case 'mathematical_expression':
            return richText.expression;
        case 'anchor':
            return '';
        default:
            return richTextToPlain(richText.text);
    }
};

const blocksToPlain = (blocks: RichBlock[]): string =>
    blocks.map(blockToPlain).filter((line) => line.length > 0).join('\n');

const captionToPlain = (caption?: { text: RichText }): string =>
    caption ? richTextToPlain(caption.text) : '';

const blockToPlain = (block: RichBlock): string => {
    switch (block.type) {
        case 'paragraph':
        case 'heading':
        case 'pre':
        case 'footer':
            return richTextToPlain(block.text);
        case 'pullquote':
            return richTextToPlain(block.text)
                + (block.credit ? `\n— ${richTextToPlain(block.credit)}` : '');
        case 'blockquote':
            return blocksToPlain(block.blocks)
                + (block.credit ? `\n— ${richTextToPlain(block.credit)}` : '');
        case 'details':
            return `${richTextToPlain(block.summary)}\n${blocksToPlain(block.blocks)}`;
        case 'list':
            return block.items
                .map((item) => `${item.label} ${blocksToPlain(item.blocks)}`.trim())
                .join('\n');
        case 'table': {
            const rows = block.cells.map((row) =>
                row.map((cell) => (cell.text ? richTextToPlain(cell.text) : '')).join(' | ')
            );
            const captionText = block.caption ? richTextToPlain(block.caption) : '';
            return [captionText, ...rows].filter((line) => line.length > 0).join('\n');
        }
        case 'mathematical_expression':
            return block.expression;
        case 'collage':
        case 'slideshow':
            return blocksToPlain(block.blocks) + (captionToPlain(block.caption) ? `\n${captionToPlain(block.caption)}` : '');
        case 'photo':
            return `[图片] ${captionToPlain(block.caption)}`.trim();
        case 'video':
            return `[视频] ${captionToPlain(block.caption)}`.trim();
        case 'animation':
            return `[动图] ${captionToPlain(block.caption)}`.trim();
        case 'audio':
            return `[音频] ${captionToPlain(block.caption)}`.trim();
        case 'voice_note':
            return `[语音] ${captionToPlain(block.caption)}`.trim();
        case 'map':
            return `[地图 ${block.location.latitude},${block.location.longitude}]`;
        case 'divider':
            return '———';
        case 'anchor':
        case 'thinking':
            return '';
        default:
            return '';
    }
};

/**
 * Flatten a rich message to readable plain text (one block per line).
 * Returns undefined when there is no rich message.
 */
export const extractRichMessagePlainText = (
    richMessage: RichMessage | undefined
): string | undefined => {
    if (!richMessage) return undefined;
    const text = blocksToPlain(richMessage.blocks).trim();
    return text.length > 0 ? text : undefined;
};
