/**
 * The image nodes of one markdown document: `collectRichImages` from
 * telegram-md-entities.
 *
 * Everything the inline picture support does is driven by this output: the
 * scan replaces exactly the source slices the parser reports, and its `block`
 * is the only shape Telegram's rich message accepts a picture in (an image
 * alone on a root-level paragraph; inside a quote, a list, a table, a heading,
 * a `<details>`, a link or a sentence it is not a block).
 *
 * This file is the one place that names the package's parser, so a change in
 * its discovery rules (a new markdown construct, a new id form) is looked for
 * here and nowhere else.
 */
export { collectRichImages } from 'telegram-md-entities';
export type { RichImageRef } from 'telegram-md-entities';
