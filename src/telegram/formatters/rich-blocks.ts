/**
 * Composing a rich message's markdown from blocks: a block is a markdown
 * section or one HTML block (`toRichHtml` output), and blocks are separated by
 * a blank line so each stays a block of its own.
 */
import { toRichHtml } from 'telegram-md-entities';
import { italicText } from './entity-text.js';

/** Blocks of one rich document; an empty block is left out */
export const joinRichBlocks = (blocks: readonly string[]): string =>
    blocks.filter((block) => block !== '').join('\n\n');

/** The streaming status line (spinner word or running tool) as its own italic paragraph */
export const richStatusLine = (statusText: string): string => toRichHtml(italicText(statusText));

/** A streaming frame with the status line under it; the line alone for an empty frame */
export const withRichStatusLine = (frame: string, statusText: string): string =>
    joinRichBlocks([frame, richStatusLine(statusText)]);
