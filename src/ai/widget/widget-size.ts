/**
 * Widget HTML size accounting, mirroring Telegram's server-side check:
 * UTF-8 bytes of the HTML plus zlib level 9 bytes (PHP `gzcompress($html, 9)`).
 * The limits themselves are enforced with `checkWidgetBudget`.
 */
import { deflateSync } from 'node:zlib';

export interface WidgetSize {
    readonly rawBytes: number;
    readonly zlibBytes: number;
}

export interface WidgetBudgetLimits {
    readonly maxHtmlBytes: number;
    readonly maxGzipBytes: number;
}

export type WidgetBudgetCheck =
    | { readonly ok: true; readonly size: WidgetSize }
    | {
          readonly ok: false;
          readonly code: 'html-too-large' | 'html-too-empty';
          readonly message: string;
          readonly size: WidgetSize;
      };

/** Measure like the server: UTF-8 length and zlib level 9 length. */
export const measureWidgetHtml = (html: string): WidgetSize => {
    const raw = Buffer.from(html, 'utf8');
    const compressed = deflateSync(raw, { level: 9 });
    return { rawBytes: raw.byteLength, zlibBytes: compressed.byteLength };
};

const describeSize = (size: WidgetSize, limits: WidgetBudgetLimits): string =>
    `原文 ${size.rawBytes} B（上限 ${limits.maxHtmlBytes} B），zlib9 ${size.zlibBytes} B（上限 ${limits.maxGzipBytes} B）`;

/** Check both Telegram widget limits; the failure message is model-actionable. */
export const checkWidgetBudget = (html: string, limits: WidgetBudgetLimits): WidgetBudgetCheck => {
    const size = measureWidgetHtml(html);
    if (html.trim() === '') {
        return {
            ok: false,
            code: 'html-too-empty',
            message: `widget HTML 为空：至少要有可见内容（${describeSize(size, limits)}）。`,
            size,
        };
    }
    if (size.rawBytes > limits.maxHtmlBytes || size.zlibBytes > limits.maxGzipBytes) {
        return {
            ok: false,
            code: 'html-too-large',
            message: `widget HTML 超过体积上限：${describeSize(size, limits)}。请缩短文字、减少表格行数或图表数据点。`,
            size,
        };
    }
    return { ok: true, size };
};
