/**
 * One volatile-tail section (workspace manifest, handoff note) appended as its
 * own text part on the trigger message.
 *
 * Platforms join a message's text parts with no separator of their own (Gemini
 * parts, OpenAI content parts), so a section pushed straight after another part
 * starts on that part's last line — the runtime block ends with the user roster
 * and the manifest would fuse into `……。 [system] 工作区` on the wire. Every tail
 * section goes through here, which leaves exactly one blank line between the
 * preceding block and the section (harness issue #9).
 */
import type { UnifiedMessage } from '../../ai/types.js';

/** One blank line: the section starts a paragraph of its own on the wire */
const SECTION_SEPARATOR = '\n\n';

/**
 * The text with trailing whitespace cut and exactly one blank line after it.
 * Text already shaped this way is returned byte-identical, so a repeated append
 * adds no newline; whitespace-only text is left alone.
 */
const separatedText = (text: string): string => {
    const body = text.trimEnd();
    if (body === '' || text === `${body}${SECTION_SEPARATOR}`) return text;
    return `${body}${SECTION_SEPARATOR}`;
};

/**
 * Append a section after the trigger message's last part, separated from it by
 * one blank line when that part is non-empty text. Everything else (a non-text
 * part, an empty text part, a missing trigger turn) is left untouched.
 */
export const appendVolatileSection = (
    messages: UnifiedMessage[],
    triggerTurnIndex: number,
    section: string
): void => {
    const message = messages[triggerTurnIndex];
    if (message === undefined) return;
    const lastIndex = message.content.length - 1;
    const previous = message.content[lastIndex];
    if (previous !== undefined && previous.type === 'text') {
        const text = previous.text ?? '';
        const separated = text === '' ? text : separatedText(text);
        if (separated !== text) message.content[lastIndex] = { ...previous, text: separated };
    }
    message.content.push({ type: 'text', text: section });
};
