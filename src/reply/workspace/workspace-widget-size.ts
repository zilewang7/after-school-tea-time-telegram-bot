/**
 * The widget budget of a workspace HTML draft, as the workspace tools report it.
 *
 * A widget's binding limit is zlib level 9 (4 096 B), while the workspace
 * otherwise reports raw UTF-8 bytes only — and the model cannot predict how a
 * draft compresses. Reporting both numbers on every write/edit is what lets it
 * trim a draft deliberately instead of rewriting it and paying for a preview or
 * a rejected `send_widget` just to learn the compressed size.
 */
import { baseNameOf, extensionOf } from '../../shared/file-name.js';
import {
    measureWidgetHtml,
    widgetSizeText,
    type WidgetBudgetLimits,
} from '../../ai/widget/widget-size.js';

/** HTML drafts are the only workspace files a widget can deliver */
const WIDGET_DRAFT_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

export const isWidgetDraftPath = (path: string): boolean =>
    WIDGET_DRAFT_EXTENSIONS.has(extensionOf(baseNameOf(path)));

/**
 * The line a write/edit result adds: the draft's real widget size. Empty for
 * anything that is not an HTML draft, or when this turn offers no widget tools.
 */
export const widgetDraftSizeLineOf = (
    path: string,
    content: string,
    limits: WidgetBudgetLimits | null | undefined
): string => {
    if (limits === null || limits === undefined || !isWidgetDraftPath(path)) return '';
    return `widget 体积：${widgetSizeText(measureWidgetHtml(content), limits)}`;
};

/**
 * One `workspace_list` line's detail for an HTML draft: raw bytes, zlib9 and the
 * gap. A file already over the raw cap cannot be a widget at all, so its
 * compressed size is not measured (and `content` is absent).
 */
export const widgetDraftListDetailOf = (
    sizeBytes: number,
    content: string | undefined,
    limits: WidgetBudgetLimits
): string => {
    if (sizeBytes > limits.maxHtmlBytes) {
        return `原文 ${sizeBytes} B，已超 widget 原文上限 ${limits.maxHtmlBytes} B`;
    }
    if (content === undefined) return `原文 ${sizeBytes} B`;
    const size = measureWidgetHtml(content);
    const gap = limits.maxGzipBytes - size.zlibBytes;
    const gapText = gap < 0 ? `超 ${-gap} B` : `余 ${gap} B`;
    return `原文 ${sizeBytes} B，zlib9 ${size.zlibBytes} B，${gapText}`;
};
