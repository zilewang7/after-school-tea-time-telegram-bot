/**
 * Tiny constructors for hand-built RenderedMessage fragments (section titles,
 * labeled links, markers) composed via concatMessages. Building entities
 * directly means arbitrary runtime strings never go through a markdown
 * round-trip, so nothing ever needs escaping.
 */
import type { RenderedMessage } from 'telegram-md-entities';

export const plainText = (text: string): RenderedMessage => ({ text, entities: [] });

export const boldText = (text: string): RenderedMessage => ({
    text,
    entities: text ? [{ type: 'bold', offset: 0, length: text.length }] : [],
});

export const italicText = (text: string): RenderedMessage => ({
    text,
    entities: text ? [{ type: 'italic', offset: 0, length: text.length }] : [],
});

/**
 * Clickable text; Telegram silently drops text_link entities whose scheme is
 * not http(s)/tg, so those degrade to plain text up front.
 */
export const linkText = (text: string, url: string): RenderedMessage => {
    const label = text || url;
    if (!label || !/^(https?|tg):/i.test(url)) {
        return plainText(label);
    }
    return {
        text: label,
        entities: [{ type: 'text_link', offset: 0, length: label.length, url }],
    };
};
