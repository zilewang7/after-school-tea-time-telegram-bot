/**
 * The rich-answer snapshot gate shared by the panel views and the share
 * surfaces (v5.1 design 2026-1115-2355 §三.1, v5.3 design 2026-1116-0310 §三.1).
 *
 * A version's stored `richAnswerMarkdown` is the rendered body the v1 renderer
 * wrote: block-level markdown with the inline formatting already applied and
 * pictures at the place the model put them. Only that dialect may be handed to
 * a renderer, so the snapshot is exposed only when the version claims both the
 * rich delivery and the v1 renderer; a later dialect falls back to the old text
 * rendering instead of being misread.
 */
import type { ResponseVersion } from '../../db/index.js';

/**
 * The answer snapshot to show for `version`, or undefined when it has none the
 * renderer can read: a version that did not deliver a rich body (entities), one
 * written by another renderer, or an empty snapshot.
 */
export const richAnswerSnapshotOf = (version: ResponseVersion | null | undefined): string | undefined => {
    if (version === undefined || version === null) return undefined;
    if (version.delivery === undefined || version.richRenderer !== 'v1') return undefined;
    const markdown = version.richAnswerMarkdown;
    return typeof markdown === 'string' && markdown.trim() !== '' ? markdown : undefined;
};

/** Whether the snapshot embeds a picture by media id, i.e. a page must lay it out */
export const snapshotEmbedsPictures = (markdown: string): boolean => markdown.includes('tg://photo?id=');
