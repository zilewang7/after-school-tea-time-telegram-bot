/**
 * URL-byte budget for split chunks.
 *
 * Telegram answers 400 ENTITIES_TOO_LONG once the URLs a message's entities
 * carry pass ~10000 UTF-16 units plus ~20 per link, no matter how short the
 * text is (measured 2026-10-22 against Bot API 10.2: 9600 in URLs across 20
 * links passed, 9640 across the same 20 was rejected). A search-grounding
 * footer with 39 source links plus 19 query links overran it; the edit was
 * refused, the dead-man switch delivered bare text, and the collapsed block
 * showed up expanded and unstyled.
 *
 * `splitMessage` only budgets text length and entity count, so this wraps it:
 * a chunk over the URL budget is cut again at the first link that would not
 * fit, which keeps every list entry, style and collapsed block intact — only
 * the message boundary moves.
 *
 * The same budget is built into telegram-md-entities >= 0.7.0
 * (`maxEntityUrlBytes`); this wrapper then finds every chunk already inside
 * the budget and does nothing. Drop it once that version is installed.
 */
import { splitMessage } from 'telegram-md-entities';
import type { MessageEntity, RenderedMessage, SplitOptions } from 'telegram-md-entities';

/** Budget per chunk, leaving room under the measured ~10000 hard limit */
const MAX_ENTITY_URL_BYTES = 9000;
/** What Telegram charges per URL entity on top of the URL itself */
const ENTITY_URL_OVERHEAD = 20;

const entityUrlBytes = (entities: readonly MessageEntity[]): number =>
    entities.reduce(
        (total, entity) => total + (entity.url ? entity.url.length + ENTITY_URL_OVERHEAD : 0),
        0
    );

/**
 * Offset of the first link that would overrun the budget — the cut that keeps
 * the URL payload inside it. A link that alone overruns cannot be fixed by
 * cutting, so it is charged and stepped over.
 */
const urlBudgetCeil = (
    entities: readonly MessageEntity[],
    budget: number
): number => {
    let spent = 0;
    for (const entity of entities) {
        const cost = entity.url ? entity.url.length + ENTITY_URL_OVERHEAD : 0;
        if (cost === 0) continue;
        if (spent + cost > budget && entity.offset > 0) return entity.offset;
        spent += cost;
    }
    return Number.POSITIVE_INFINITY;
};

/**
 * Split like `splitMessage`, then keep cutting over-budget chunks until every
 * one carries at most one message's worth of URLs.
 */
export const splitWithUrlBudget = (
    message: RenderedMessage,
    options?: SplitOptions
): RenderedMessage[] => {
    const chunks: RenderedMessage[] = [];
    const queue = splitMessage(message, options);

    for (let current = queue.shift(); current; current = queue.shift()) {
        if (entityUrlBytes(current.entities) <= MAX_ENTITY_URL_BYTES) {
            chunks.push(current);
            continue;
        }

        const ceil = urlBudgetCeil(current.entities, MAX_ENTITY_URL_BYTES);
        if (!Number.isFinite(ceil) || ceil <= 0 || ceil >= current.text.length) {
            // Nothing to gain from cutting (one over-long link, or the
            // overrun starts at the very first unit): deliver as is
            chunks.push(current);
            continue;
        }

        const pieces = splitMessage(current, { ...options, maxLength: ceil });
        if (pieces.length < 2) {
            chunks.push(current);
            continue;
        }
        queue.unshift(...pieces);
    }

    return chunks;
};
