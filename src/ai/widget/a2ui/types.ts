/**
 * Public types of the fixed A2UI v1.0 -> Telegram widget compiler
 * (custom catalog `tg-card-v1`). The compiler input is untrusted model JSON,
 * so every type here describes a value *after* validation, not the raw input.
 */
import type { WidgetSize } from '../widget-size.js';

/** Telegram widget hard limits: 32768 B of HTML, 4096 B after zlib level 9. */
export const A2UI_MAX_HTML_BYTES = 32768;
export const A2UI_MAX_GZIP_BYTES = 4096;

export interface A2uiCompileOptions {
    /** Uncompressed HTML limit in bytes; defaults to 32768. */
    readonly maxHtmlBytes?: number;
    /** zlib level 9 limit in bytes; defaults to 4096. */
    readonly maxGzipBytes?: number;
}

export type A2uiCompileErrorCode =
    | 'invalid-input'
    | 'invalid-json'
    | 'invalid-surface'
    | 'unsupported-component'
    | 'invalid-binding'
    | 'too-large';

export interface A2uiCompileFailure {
    readonly ok: false;
    readonly code: A2uiCompileErrorCode;
    /** Chinese, model-actionable: it names the component/id/prop to fix. */
    readonly message: string;
}

export interface A2uiCompileSuccess {
    readonly ok: true;
    readonly html: string;
    readonly size: WidgetSize;
    /** Component names actually rendered, in first-use order. */
    readonly components: readonly string[];
    readonly warnings: readonly string[];
}

export type A2uiCompileResult = A2uiCompileSuccess | A2uiCompileFailure;

/** One row of the flat adjacency table, after its id/component were checked. */
export interface A2uiComponent {
    readonly id: string;
    /** A2UI component name, e.g. "Card" or "Text". */
    readonly type: string;
    /** All raw props (including id/component); every read is validated. */
    readonly props: Readonly<Record<string, unknown>>;
}

/** A validated surface: flat components plus the optional data model. */
export interface A2uiSurface {
    readonly components: readonly unknown[];
    readonly dataModel: unknown;
}

/**
 * Data-binding scope of the component being rendered. Absolute `@path` values
 * read `dataModel`; relative ones read the current List item (`item`).
 */
export interface A2uiScope {
    readonly dataModel: unknown;
    readonly item: unknown;
    readonly depth: number;
    /** Hook so the compiler can report an unused data model. */
    readonly onDataModelRead?: () => void;
}
