/**
 * The `tg-card-v1` catalog: the only A2UI components and prop values the
 * Telegram widget compiler accepts. Anything outside this file is rejected
 * with an actionable error so the model can rewrite the surface.
 */
export const A2UI_CATALOG_ID = 'tg-card-v1';

export const A2UI_COMPONENT_NAMES = [
    'Card',
    'Column',
    'Row',
    'List',
    'Text',
    'Divider',
    'Icon',
    'Button',
    'Table',
    'BarChart',
    'Sparkline',
] as const;

export type A2uiComponentName = (typeof A2UI_COMPONENT_NAMES)[number];

/** Used by error messages: the full supported list, in catalog order. */
export const A2UI_SUPPORTED_COMPONENTS_TEXT = A2UI_COMPONENT_NAMES.join('、');

/**
 * Real A2UI primitives the Telegram widget profile cannot render (input
 * controls, media, overlays). The reason is shown to the model instead of a
 * generic "unknown component".
 */
export const A2UI_REJECTED_COMPONENTS: Readonly<Record<string, string>> = {
    TextField: '输入控件，Telegram widget 没有键盘输入；请改成 Text 展示，或让用户用文字回复',
    CheckBox: '输入控件，Telegram widget 没有输入元素；请用 Text/Icon 表示状态',
    Slider: '输入控件，Telegram widget 没有拖拽输入；请用 Text 显示数值',
    DateTimeInput: '输入控件，Telegram widget 没有日期选择器；请用 Text 列出候选时间',
    ChoicePicker: '输入控件，Telegram widget 没有选择器；请用多个 Button 或 Text 列表代替',
    Image: 'Telegram widget 只允许 data: 内联图片且总预算 4KB，图片基本不可行；请用 Icon 或 emoji 代替',
    Video: '视频元素在 widget profile 里被移除；请发普通视频消息',
    AudioPlayer: '音频元素在 widget profile 里被移除；请发普通音频消息',
    Modal: '弹层在 widget 里不可靠（600px 高、内部不能滚动）；请直接用 Column 展示内容',
    Tabs: 'Tabs 需要 JS 交互，Phase 0 只渲染静态内容；请拆成多个 Column/Card',
};

export const isA2uiComponentName = (value: string): value is A2uiComponentName =>
    A2UI_COMPONENT_NAMES.some((name) => name === value);

export const A2UI_TEXT_VARIANTS = ['body', 'caption', 'h1', 'h2', 'h3', 'h4'] as const;
export type A2uiTextVariant = (typeof A2UI_TEXT_VARIANTS)[number];

export const isA2uiTextVariant = (value: string): value is A2uiTextVariant =>
    A2UI_TEXT_VARIANTS.some((variant) => variant === value);

export const A2UI_BUTTON_VARIANTS = ['primary', 'default'] as const;
export type A2uiButtonVariant = (typeof A2UI_BUTTON_VARIANTS)[number];

export const isA2uiButtonVariant = (value: string): value is A2uiButtonVariant =>
    A2UI_BUTTON_VARIANTS.some((variant) => variant === value);

export const A2UI_LIST_DIRECTIONS = ['vertical', 'horizontal'] as const;
export type A2uiListDirection = (typeof A2UI_LIST_DIRECTIONS)[number];

export const isA2uiListDirection = (value: string): value is A2uiListDirection =>
    A2UI_LIST_DIRECTIONS.some((direction) => direction === value);

/** A2UI `justify` (main axis) to CSS for a flex container. */
export const A2UI_JUSTIFY: Readonly<Record<string, string>> = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    spaceAround: 'space-around',
    spaceBetween: 'space-between',
    spaceEvenly: 'space-evenly',
    stretch: 'stretch',
};

/** A2UI `align` (cross axis) to CSS for a flex container. */
export const A2UI_ALIGN: Readonly<Record<string, string>> = {
    start: 'flex-start',
    center: 'center',
    end: 'flex-end',
    stretch: 'stretch',
};

/** Icon names the widget compiler knows; each maps to one inline SVG path. */
export const A2UI_ICON_NAMES = [
    'check',
    'star',
    'info',
    'warn',
    'arrow',
    'clock',
    'chat',
    'chart',
    'heart',
    'close',
] as const;

export type A2uiIconName = (typeof A2UI_ICON_NAMES)[number];

export const isA2uiIconName = (value: string): value is A2uiIconName =>
    A2UI_ICON_NAMES.some((name) => name === value);

/** 16x16 stroke paths; only this table reaches the SVG, never model strings. */
export const A2UI_ICON_PATHS: Readonly<Record<A2uiIconName, string>> = {
    check: 'M2 8.5l4 4 8-9',
    star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z',
    info: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 108 1.8zM8 7v6M8 4.6v.2',
    warn: 'M8 1.8L15 14H1zM8 6v4M8 12v.2',
    arrow: 'M2 8h11M9 4l4 4-4 4',
    clock: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 108 1.8zM8 4.4V8l2.6 1.6',
    chat: 'M2 3h12v8H8l-3 3v-3H2z',
    chart: 'M3 14V8M8 14V4M13 14V6',
    heart: 'M8 13.5S2 10 2 5.8A3 3 0 018 4a3 3 0 016 1.8c0 4.2-6 7.7-6 7.7z',
    close: 'M3 3l10 10M13 3L3 13',
};
