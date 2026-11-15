/**
 * A rich reply's snapshot rendered the way the chat showed it (v5.1 design
 * 2026-1115-2355 §三): the blocks of `parseRichAnswer` with their pictures in
 * place, their captions under them, and the remaining attachments after the
 * body in chat order.
 *
 * No HTML is built here and nothing is injected as raw markup: every run is a
 * React element, only http(s)/tg links become anchors, and pictures go through
 * the existing `MediaAttachmentView` (signed `/m/…` URLs).
 */
import { Fragment, useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { match } from 'ts-pattern';
import type { MediaAttachment } from '../api';
import { MediaAttachmentView } from '../components/media-attachment-view';
import {
    inlineRuns,
    isSafeLinkUrl,
    type RichAnswerBlock,
    type RichAnswerRun,
    unreferencedMediaIndexes,
} from './rich-answer';

const LINK_STYLE = 'text_link:';

/** Outer-to-inner order, so a link wraps its bold label and code stays innermost */
const STYLE_RANK: Readonly<Record<string, number>> = {
    text_link: 0,
    bold: 1,
    italic: 2,
    underline: 3,
    strikethrough: 4,
    spoiler: 5,
    code: 6,
    blockquote: 7,
    expandable_blockquote: 7,
};

const styleRankOf = (style: string): number => {
    if (style.startsWith(LINK_STYLE)) return 0;
    if (style.startsWith('pre:')) return 6;
    return STYLE_RANK[style] ?? 8;
};

/** A Telegram spoiler: hidden until tapped (or focused and activated) */
function Spoiler({ children }: { readonly children: ReactNode }) {
    const [revealed, setRevealed] = useState(false);
    const reveal = useCallback(() => setRevealed(true), []);
    const onKeyDown = useCallback(
        (event: KeyboardEvent<HTMLSpanElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            reveal();
        },
        [reveal]
    );
    return (
        <span
            className={revealed ? 'rich-answer__spoiler revealed' : 'rich-answer__spoiler'}
            role="button"
            tabIndex={0}
            aria-label={revealed ? '剧透' : '显示剧透'}
            onClick={reveal}
            onKeyDown={onKeyDown}
        >
            {children}
        </span>
    );
}

/** One style key of a run as an element; unknown keys keep the text only */
const decorate = (style: string, children: ReactNode): ReactNode => {
    if (style.startsWith(LINK_STYLE)) {
        const url = style.slice(LINK_STYLE.length);
        return isSafeLinkUrl(url)
            ? (
                  <a className="rich-answer__link" href={url} target="_blank" rel="noreferrer noopener">
                      {children}
                  </a>
              )
            : children;
    }
    return match(style)
        .with('bold', () => <strong>{children}</strong>)
        .with('italic', () => <em>{children}</em>)
        .with('underline', () => <u>{children}</u>)
        .with('strikethrough', () => <del>{children}</del>)
        .with('spoiler', () => <Spoiler>{children}</Spoiler>)
        .with('code', () => <code className="rich-answer__code">{children}</code>)
        .with('blockquote', 'expandable_blockquote', () => (
            <span className="rich-answer__inline-quote">{children}</span>
        ))
        .otherwise(() => children);
};

/** One run: the text inside its (stable-ordered) style elements */
function RichAnswerRunText({ run }: { readonly run: RichAnswerRun }) {
    const ordered = useMemo(
        () => [...run.styles].sort((left, right) => styleRankOf(left) - styleRankOf(right) || left.localeCompare(right)),
        [run.styles]
    );
    let node: ReactNode = run.text;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        node = decorate(ordered[index] ?? '', node);
    }
    return <>{node}</>;
}

function RichAnswerRuns({ runs }: { readonly runs: readonly RichAnswerRun[] }) {
    return (
        <>
            {runs.map((run, index) => (
                <Fragment key={index}>
                    <RichAnswerRunText run={run} />
                </Fragment>
            ))}
        </>
    );
}

interface FigureProps {
    readonly media: readonly MediaAttachment[];
    readonly mediaIndex: number;
    readonly compact: boolean;
    readonly showCaptions: boolean;
}

/** One picture of the body: the media view plus its caption runs */
function RichAnswerFigure({ media, mediaIndex, compact, showCaptions }: FigureProps) {
    const item = media[mediaIndex];
    const caption = item?.caption ?? '';
    const captionRuns = useMemo(
        () => (showCaptions && caption !== '' ? inlineRuns(caption) : []),
        [showCaptions, caption]
    );
    if (item === undefined) return null;
    return (
        <figure className="rich-answer__figure">
            <MediaAttachmentView media={item} compact={compact} />
            {captionRuns.length > 0 && (
                <figcaption className="rich-answer__caption">
                    <RichAnswerRuns runs={captionRuns} />
                </figcaption>
            )}
        </figure>
    );
}

const headingTagOf = (size: 1 | 2 | 3 | 4 | 5 | 6): 'h3' | 'h4' | 'h5' => {
    if (size <= 2) return 'h3';
    if (size <= 4) return 'h4';
    return 'h5';
};

interface BlockProps {
    readonly block: RichAnswerBlock;
    readonly media: readonly MediaAttachment[];
    readonly compact: boolean;
    readonly showCaptions: boolean;
}

function RichAnswerBlockView({ block, media, compact, showCaptions }: BlockProps) {
    return match(block)
        .with({ kind: 'paragraph' }, (paragraph) => (
            <p className="rich-answer__paragraph">
                <RichAnswerRuns runs={paragraph.runs} />
            </p>
        ))
        .with({ kind: 'heading' }, (heading) => {
            const HeadingTag = headingTagOf(heading.size);
            return (
                <HeadingTag className={`rich-answer__heading rich-answer__heading--${heading.size}`}>
                    <RichAnswerRuns runs={heading.runs} />
                </HeadingTag>
            );
        })
        .with({ kind: 'pre' }, (pre) => (
            <pre className="rich-answer__pre">
                <code>{pre.text}</code>
            </pre>
        ))
        .with({ kind: 'list' }, (list) => {
            const ListTag = list.ordered ? 'ol' : 'ul';
            return (
                <ListTag className="rich-answer__list">
                    {list.items.map((item, index) => (
                        <li
                            key={index}
                            className="rich-answer__list-item"
                            style={{ marginInlineStart: `${item.depth * 16}px` }}
                        >
                            <RichAnswerRuns runs={item.runs} />
                        </li>
                    ))}
                </ListTag>
            );
        })
        .with({ kind: 'quote' }, (quote) => (
            <blockquote className="rich-answer__quote">
                <RichAnswerBlocks
                    blocks={quote.blocks}
                    media={media}
                    compact={compact}
                    showCaptions={showCaptions}
                />
            </blockquote>
        ))
        .with({ kind: 'table' }, (table) => (
            // A wide table scrolls inside its own box instead of the whole page
            <div className="rich-answer__table-wrap">
                <table className="rich-answer__table">
                    {table.header !== undefined && (
                        <thead>
                            <tr>
                                {table.header.map((cell, index) => (
                                    <th key={index}>
                                        <RichAnswerRuns runs={cell} />
                                    </th>
                                ))}
                            </tr>
                        </thead>
                    )}
                    <tbody>
                        {table.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                {row.map((cell, cellIndex) => (
                                    <td key={cellIndex}>
                                        <RichAnswerRuns runs={cell} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        ))
        .with({ kind: 'divider' }, () => <hr className="rich-answer__divider" />)
        .with({ kind: 'photo' }, (photo) => (
            <RichAnswerFigure
                media={media}
                mediaIndex={photo.mediaIndex}
                compact={compact}
                showCaptions={showCaptions}
            />
        ))
        .with({ kind: 'plain' }, (plain) => <p className="rich-answer__plain">{plain.text}</p>)
        .exhaustive();
}

interface BlocksProps {
    readonly blocks: readonly RichAnswerBlock[];
    readonly media: readonly MediaAttachment[];
    readonly compact: boolean;
    readonly showCaptions: boolean;
}

function RichAnswerBlocks({ blocks, media, compact, showCaptions }: BlocksProps) {
    return (
        <>
            {blocks.map((block, index) => (
                <Fragment key={index}>
                    <RichAnswerBlockView
                        block={block}
                        media={media}
                        compact={compact}
                        showCaptions={showCaptions}
                    />
                </Fragment>
            ))}
        </>
    );
}

export interface RichAnswerViewProps {
    readonly blocks: readonly RichAnswerBlock[];
    /** The version's attachments, inline pictures first (the snapshot indexes this list) */
    readonly media: readonly MediaAttachment[];
    /** Tree / flat view: smaller frames, no captions by default */
    readonly compact?: boolean;
    readonly showCaptions?: boolean;
}

/**
 * The rich answer as blocks, then every attachment the snapshot did not place
 * (an L2 fallback's pictures, a `send_image` album) in chat order.
 */
export const RichAnswerView = ({ blocks, media, compact = false, showCaptions = true }: RichAnswerViewProps) => {
    const unreferenced = useMemo(
        () => unreferencedMediaIndexes(blocks, media.length),
        [blocks, media.length]
    );
    const className = useMemo(() => (compact ? 'rich-answer compact' : 'rich-answer'), [compact]);
    return (
        <div className={className}>
            <RichAnswerBlocks blocks={blocks} media={media} compact={compact} showCaptions={showCaptions} />
            {unreferenced.map((mediaIndex) => (
                <RichAnswerFigure
                    key={mediaIndex}
                    media={media}
                    mediaIndex={mediaIndex}
                    compact={compact}
                    showCaptions={showCaptions}
                />
            ))}
        </div>
    );
};
