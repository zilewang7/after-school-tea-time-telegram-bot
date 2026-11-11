/**
 * Guide registry: maps a widget mode to its version-fixed authoring guide.
 *
 * The texts live in widget-guide.ts (HTML mode) and a2ui-guide.ts (A2UI mode);
 * this file only assembles them so the version number has a single source.
 */
import { WIDGET_GUIDE_A2UI_TEXT, WIDGET_GUIDE_A2UI_TITLE } from './a2ui-guide.js';
import type { WidgetGuide, WidgetGuideKind } from './types.js';
import { WIDGET_GUIDE_HTML_TEXT, WIDGET_GUIDE_HTML_TITLE } from './widget-guide.js';

/**
 * Version of the guide snapshot. Bump when either text changes (or the
 * upstream widget-sandbox snapshot is refreshed); the get_ui_guide tool logs it.
 *
 * v2: split bot roundtrip (`request()`/state, unavailable in Phase 0) from
 * local sandbox interaction (inline script + click, supported by profile 1);
 * the v1 text said both "JS and taps work" and "output zero JS" (issue #6).
 * v3: the A2UI guide's tool-argument example is a valid escaped JSON string
 * (v2 rendered `"` where the model must write `\"`).
 */
export const WIDGET_GUIDE_VERSION = 3;

const GUIDES: Readonly<Record<WidgetGuideKind, WidgetGuide>> = Object.freeze({
    html: Object.freeze({
        kind: 'html',
        version: WIDGET_GUIDE_VERSION,
        title: WIDGET_GUIDE_HTML_TITLE,
        text: WIDGET_GUIDE_HTML_TEXT,
    }),
    a2ui: Object.freeze({
        kind: 'a2ui',
        version: WIDGET_GUIDE_VERSION,
        title: WIDGET_GUIDE_A2UI_TITLE,
        text: WIDGET_GUIDE_A2UI_TEXT,
    }),
});

/** Look up a guide; the kind is a closed union, so every value is present. */
export const getWidgetGuide = (kind: WidgetGuideKind): WidgetGuide => GUIDES[kind];
