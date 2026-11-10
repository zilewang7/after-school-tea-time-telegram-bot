/**
 * One-line plain-text excerpts of stored markdown, for reply blocks and preview
 * lines: markup is rendered away so a public page's "回复 xxx：…" reads like the
 * message, not like its markdown source.
 */
import { renderMarkdown } from 'telegram-md-entities';

/** The message text as one plain line, capped at `maxLength`; null when empty */
export const plainExcerptOf = (markdown: string | null, maxLength: number): string | null => {
    if (markdown === null) return null;
    const line = renderMarkdown(markdown).text.replace(/\s+/g, ' ').trim();
    if (line === '') return null;
    return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
};
