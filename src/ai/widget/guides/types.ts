/**
 * Types shared by the on-demand widget guides. A guide is a version-fixed
 * read-only document: the model asks for one with get_ui_guide(kind), then
 * calls send_widget with the produced payload.
 */

/** The two widget authoring modes. */
export type WidgetGuideKind = 'html' | 'a2ui';

export interface WidgetGuide {
    readonly kind: WidgetGuideKind;
    /** Snapshot version; bump when the guide text changes. */
    readonly version: number;
    readonly title: string;
    /** Full authoring instructions, ready to hand to the model as-is. */
    readonly text: string;
}
