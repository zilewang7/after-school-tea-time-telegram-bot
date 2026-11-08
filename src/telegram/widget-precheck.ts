/**
 * Server-side precheck of a widget HTML payload.
 *
 * Telegram rejects a widget whose HTML is over 32 768 bytes or over 4 096 bytes
 * after zlib level 9 — but the Bot API itself does not validate the HTML (a
 * 100 KB payload only failed with "chat not found"), so the only place this can
 * fail visibly is here. The same helper is used by the A2UI compiler output and
 * by the model's own HTML, so both paths enforce one budget.
 *
 * The text scan is a policy check, not a parser: Telegram's sandbox removes
 * external resources and form controls on the client anyway, but a widget that
 * silently loses half of itself is worse than a tool error the model can read.
 */
import type { WidgetDelivery } from '../ai/types.js';
import {
    checkWidgetBudget,
    measureWidgetHtml,
    type WidgetSize,
} from '../ai/widget/widget-size.js';

export interface WidgetPrecheckLimits {
    /** WIDGET_ALLOW_HTML is on; false rejects `mode: 'html'` entirely */
    readonly allowHtml: boolean;
    readonly maxHtmlBytes: number;
    readonly maxGzipBytes: number;
}

export type WidgetPrecheckFailureCode =
    | 'html-mode-disabled'
    | 'empty-html'
    | 'too-large'
    | 'forbidden-markup';

export type WidgetPrecheckResult =
    | { readonly ok: true; readonly size: WidgetSize }
    | {
          readonly ok: false;
          readonly code: WidgetPrecheckFailureCode;
          readonly message: string;
      };

/** External resources / form controls / navigation the widget profile rejects */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
    // External files: no network in the sandbox, so such a reference only makes
    // the widget look broken on the client
    { pattern: /<\s*(?:script|link|iframe|object|embed)\b[^>]*\b(?:src|href)\s*=/i, reason: '外部 script/link/iframe 等资源不能加载' },
    { pattern: /@import\s+(?:url\()?['"]?https?:/i, reason: '@import 不能加载外部样式' },
    { pattern: /url\(\s*['"]?https?:/i, reason: 'CSS url() 不能加载外链资源' },
    // Interactive inputs: profile 1 deletes them; a form control would be lost
    { pattern: /<\s*(?:form|input|textarea|select|option|label|fieldset)\b/i, reason: '表单/输入控件在 widget 里会被删除' },
    // Media elements: removed from the profile
    { pattern: /<\s*(?:video|audio|source|track)\b/i, reason: 'video/audio 标签在 widget 里会被删除' },
    { pattern: /javascript\s*:/i, reason: 'javascript: URL 不被允许' },
];

const findForbiddenMarkup = (html: string): string | null => {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        if (pattern.test(html)) return reason;
    }
    return null;
};

/** Check a model-written or compiled widget before any network call */
export const precheckWidgetHtml = (
    mode: WidgetDelivery['mode'],
    html: string,
    limits: WidgetPrecheckLimits
): WidgetPrecheckResult => {
    if (mode === 'html' && !limits.allowHtml) {
        return {
            ok: false,
            code: 'html-mode-disabled',
            message:
                '当前只接受 A2UI 子集（组件 JSON），不接受直接写 HTML；请改用 mode="a2ui" 并通过 get_ui_guide(kind="a2ui") 查看组件规范。',
        };
    }
    const trimmed = html.trim();
    if (trimmed.length === 0) {
        return { ok: false, code: 'empty-html', message: 'widget HTML 为空。' };
    }
    const forbidden = findForbiddenMarkup(trimmed);
    if (forbidden !== null) {
        return {
            ok: false,
            code: 'forbidden-markup',
            message: `widget 里不能包含这些内容：${forbidden}。请改成自包含的静态 HTML（data: 图片、inline CSS/JS）。`,
        };
    }
    const budget = checkWidgetBudget(trimmed, {
        maxHtmlBytes: limits.maxHtmlBytes,
        maxGzipBytes: limits.maxGzipBytes,
    });
    if (!budget.ok) {
        return { ok: false, code: 'too-large', message: budget.message };
    }
    return { ok: true, size: budget.size };
};

/** Build the delivery object once the payload is accepted */
export const widgetDeliveryOf = (
    mode: WidgetDelivery['mode'],
    html: string,
    caption: string | undefined,
    surface: unknown
): WidgetDelivery => {
    const size = measureWidgetHtml(html);
    return {
        mode,
        html,
        ...(caption !== undefined && caption.trim().length > 0 ? { caption: caption.trim() } : {}),
        htmlBytes: size.rawBytes,
        zlibBytes: size.zlibBytes,
        ...(surface === undefined ? {} : { surface }),
    };
};
