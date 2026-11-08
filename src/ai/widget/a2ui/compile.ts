/**
 * Fixed compiler: an A2UI v1.0 surface subset (`tg-card-v1` catalog) to one
 * static Telegram widget HTML fragment.
 *
 * The output has no JS: text is escaped at compile time, BarChart becomes CSS
 * bars with precomputed heights, Sparkline becomes a precomputed inline-SVG
 * polyline and Icon becomes a table-driven inline SVG path. Data bindings are
 * resolved against the surface data model here, so the widget itself is inert.
 */
import { checkWidgetBudget } from '../widget-size.js';
import {
    A2UI_ALIGN,
    A2UI_BUTTON_VARIANTS,
    A2UI_ICON_NAMES,
    A2UI_ICON_PATHS,
    A2UI_JUSTIFY,
    A2UI_LIST_DIRECTIONS,
    A2UI_REJECTED_COMPONENTS,
    A2UI_SUPPORTED_COMPONENTS_TEXT,
    A2UI_TEXT_VARIANTS,
    isA2uiButtonVariant,
    isA2uiComponentName,
    isA2uiIconName,
    isA2uiListDirection,
    isA2uiTextVariant,
    type A2uiButtonVariant,
    type A2uiComponentName,
    type A2uiIconName,
    type A2uiListDirection,
    type A2uiTextVariant,
} from './catalog.js';
import {
    A2UI_MAX_GZIP_BYTES,
    A2UI_MAX_HTML_BYTES,
    type A2uiCompileErrorCode,
    type A2uiCompileOptions,
    type A2uiCompileResult,
    type A2uiComponent,
    type A2uiScope,
    type A2uiSurface,
} from './types.js';

const MAX_COMPONENT_DEPTH = 32;
const MAX_COMPONENT_COUNT = 2000;
const MAX_TABLE_ROWS = 200;
const MAX_VALUE_POINTS = 500;
const MAX_TABLE_ROWS_WARNING = 20;
const MAX_BAR_COUNT_WARNING = 30;
const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 30;
const HEADING_PATTERN = /^(#{1,6})\s+([^\n]+)$/;

/** Fixed stylesheet: paid once per widget, identical for every surface. */
const WIDGET_STYLE = [
    'body{margin:0;padding:10px 12px;font:15px/1.4 system-ui;color:var(--tg-theme-text-color,#111)}',
    '.tw-root{display:grid;gap:6px}',
    '.c{display:flex;flex-direction:column;gap:6px}',
    '.r{display:flex;gap:8px;align-items:center}',
    '.card{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-radius:10px;background:var(--tg-theme-secondary-bg-color,#f1f1f1)}',
    '.cap{font-size:12px;color:var(--tg-theme-hint-color,#777)}',
    '.h{font-weight:600}',
    '.h1{font-size:18px}.h2{font-size:16px}.h3{font-size:15px}.h4{font-size:14px}',
    '.sep{border:0;border-top:1px solid var(--tg-theme-secondary-bg-color,#ddd);margin:2px 0}',
    '.ic{vertical-align:-2px;color:var(--tg-theme-hint-color,#777)}',
    '.btn{border:0;border-radius:8px;padding:7px 12px;font:600 14px system-ui;background:var(--tg-theme-button-color,#3390ec);color:var(--tg-theme-button-text-color,#fff)}',
    '.btn2{background:rgba(128,128,128,.16);color:var(--tg-theme-text-color,#111)}',
    '.tbl{width:100%;border-collapse:collapse;font-size:13px}',
    '.tbl td,.tbl th{padding:3px 0;border-bottom:1px solid var(--tg-theme-secondary-bg-color,#ddd)}',
    '.tbl th{text-align:left;font-weight:600;color:var(--tg-theme-hint-color,#777)}',
    '.bars{display:flex;align-items:flex-end;gap:4px;height:76px}',
    '.bar{flex:1;border-radius:2px 2px 0 0;background:var(--tg-theme-button-color,#3390ec)}',
    '.labs{display:flex;gap:4px;font-size:11px;color:var(--tg-theme-hint-color,#777)}',
    '.labs span{flex:1;text-align:center}',
    '.sp{display:block;width:100%;height:36px;color:var(--tg-theme-button-color,#3390ec)}',
].join('');

interface LayoutDefaults {
    readonly justify: string;
    readonly align: string;
}

/** CSS defaults of `.c` / `.card` (flex column) and `.r` (flex row). */
const COLUMN_LAYOUT_DEFAULTS: LayoutDefaults = { justify: 'flex-start', align: 'stretch' };
const ROW_LAYOUT_DEFAULTS: LayoutDefaults = { justify: 'flex-start', align: 'center' };

class SurfaceError extends Error {    readonly code: A2uiCompileErrorCode;

    constructor(code: A2uiCompileErrorCode, message: string) {
        super(message);
        this.name = 'SurfaceError';
        this.code = code;
    }
}

function fail(code: A2uiCompileErrorCode, message: string): never {
    throw new SurfaceError(code, message);
}

interface CompileState {
    readonly components: ReadonlyMap<string, A2uiComponent>;
    readonly root: A2uiComponent;
    readonly dataModel: unknown;
    readonly rendered: Set<string>;
    readonly used: Set<A2uiComponentName>;
    readonly usedOrder: A2uiComponentName[];
    readonly warnings: string[];
    readonly visiting: string[];
    dataModelUsed: boolean;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compile an A2UI v1.0 surface (JSON string, envelope, bare surface or a JSON
 * array of messages) into a static widget HTML fragment.
 */
export const compileA2uiSurface = (input: unknown, options?: A2uiCompileOptions): A2uiCompileResult => {
    try {
        const surface = toSurface(findSurfaceRecord(decodeJsonInput(input)));
        const state = createCompileState(surface);
        const body = renderSurfaceBody(state);
        const html = buildWidgetHtml(body);
        const limits = {
            maxHtmlBytes: options?.maxHtmlBytes ?? A2UI_MAX_HTML_BYTES,
            maxGzipBytes: options?.maxGzipBytes ?? A2UI_MAX_GZIP_BYTES,
        };
        const budget = checkWidgetBudget(html, limits);
        if (!budget.ok) {
            const code: A2uiCompileErrorCode = budget.code === 'html-too-large' ? 'too-large' : 'invalid-surface';
            return { ok: false, code, message: budget.message };
        }
        return { ok: true, html, size: budget.size, components: state.usedOrder, warnings: state.warnings };
    } catch (error) {
        if (error instanceof SurfaceError) {
            return { ok: false, code: error.code, message: error.message };
        }
        throw error;
    }
};

// ---------------------------------------------------------------------------
// Input parsing: JSON string -> surface record -> validated flat component list
// ---------------------------------------------------------------------------

const decodeJsonInput = (input: unknown): unknown => {
    if (typeof input !== 'string') {
        if (!isRecord(input) && !Array.isArray(input)) {
            fail('invalid-input', '输入必须是 A2UI JSON 字符串、JSON 对象或 JSON 数组；请给出 createSurface 信封。');
        }
        return input;
    }
    const trimmed = input.trim();
    if (trimmed === '') {
        fail('invalid-input', '输入是空字符串；请给出 A2UI v1.0 的 createSurface JSON。');
    }
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(
            'invalid-json',
            `输入不是合法 JSON：${detail}。请检查引号、逗号和括号是否闭合；如果是多行 JSONL，请合并成一个 JSON 数组。`
        );
    }
};

/** Envelope keys this Phase 0 compiler does not support (no streaming/updates). */
const UNSUPPORTED_ENVELOPE_KEYS = [
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
    'callRendererFunction',
    'agentFunctionResponse',
] as const;

const rejectUnsupportedEnvelopes = (message: JsonRecord): void => {
    for (const key of UNSUPPORTED_ENVELOPE_KEYS) {
        if (key in message) {
            fail(
                'invalid-surface',
                `不支持 ${key} 消息：编译器只接受一条 createSurface（一次性给全 components 与 dataModel），没有增量更新或流式渲染。`
            );
        }
    }
};

/** Accept a bare surface, a v1.0 envelope, a `{messages:[]}` wrapper or a message array. */
const findSurfaceRecord = (decoded: unknown): JsonRecord => {
    if (Array.isArray(decoded)) {
        const messages = decoded.filter(isRecord);
        messages.forEach(rejectUnsupportedEnvelopes);
        const surfaces = messages.map((message) => message.createSurface).filter(isRecord);
        const surface = surfaces[0];
        if (surface === undefined) {
            fail('invalid-surface', 'JSON 数组里没有 createSurface 消息；请给出 {"version":"1.0","createSurface":{...}}。');
        }
        if (surfaces.length > 1) {
            fail('invalid-surface', `一个输入里只能有一条 createSurface（找到 ${surfaces.length} 条），每个 widget 只渲染一个 surface。`);
        }
        return surface;
    }
    if (!isRecord(decoded)) {
        fail('invalid-input', '输入必须是 A2UI JSON 字符串或对象；请给出 createSurface 信封。');
    }
    if (!isRecord(decoded.createSurface) && decoded.createSurface !== undefined) {
        fail('invalid-surface', 'createSurface 必须是对象（里面放 components 和可选的 dataModel）。');
    }
    if (isRecord(decoded.createSurface)) {
        return decoded.createSurface;
    }
    rejectUnsupportedEnvelopes(decoded);
    if (Array.isArray(decoded.messages)) {
        return findSurfaceRecord(decoded.messages);
    }
    if (Array.isArray(decoded.components)) {
        return decoded;
    }
    fail(
        'invalid-surface',
        '找不到 surface：请给出 A2UI v1.0 信封 {"version":"1.0","createSurface":{"components":[...],"dataModel":{...}}}，或直接给 {"components":[...]}。'
    );
};

const toSurface = (raw: JsonRecord): A2uiSurface => {
    const rawComponents = raw.components;
    if (!Array.isArray(rawComponents)) {
        fail(
            'invalid-surface',
            'createSurface.components 必须是非空数组（扁平邻接表，每项形如 {"id":"root","component":"Card","child":"col"}）。'
        );
    }
    if (rawComponents.length === 0) {
        fail('invalid-surface', 'createSurface.components 是空数组；至少要有 {"id":"root", ...} 根组件。');
    }
    const rawDataModel = raw.dataModel;
    const dataModel = rawDataModel === null || rawDataModel === undefined ? undefined : rawDataModel;
    if (dataModel !== undefined && !isRecord(dataModel)) {
        fail(
            'invalid-surface',
            `createSurface.dataModel 必须是 JSON 对象（当前是 ${describeValue(dataModel)}），例如 {"items":[{"label":"…"}]}。`
        );
    }
    return { components: rawComponents, dataModel };
};

const readCoordinate = (item: JsonRecord, key: 'id' | 'component', index: number): string => {
    const value = item[key];
    if (typeof value !== 'string' || value.trim() === '') {
        fail('invalid-surface', `components[${index}] 的 ${key} 必须是非空字符串（当前是 ${describeValue(value)}）。`);
    }
    return value;
};

const indexComponents = (items: readonly unknown[]): ReadonlyMap<string, A2uiComponent> => {
    if (items.length > MAX_COMPONENT_COUNT) {
        fail('invalid-surface', `组件过多：${items.length} 个（上限 ${MAX_COMPONENT_COUNT}，widget 最多 2000 个 DOM 节点）。`);
    }
    const components = new Map<string, A2uiComponent>();
    items.forEach((item, index) => {
        if (!isRecord(item)) {
            fail('invalid-surface', `components[${index}] 必须是对象（当前是 ${describeValue(item)}）。`);
        }
        const id = readCoordinate(item, 'id', index);
        const type = readCoordinate(item, 'component', index);
        if (components.has(id)) {
            fail('invalid-surface', `组件 id="${id}" 重复；邻接表里每个组件必须用唯一 id。`);
        }
        components.set(id, { id, type, props: item });
    });
    return components;
};

const createCompileState = (surface: A2uiSurface): CompileState => {
    const components = indexComponents(surface.components);
    const root = components.get('root');
    if (root === undefined) {
        const known = [...components.keys()].slice(0, 10).join('、');
        fail('invalid-surface', `components 里必须有 id="root" 的根组件；当前 id：${known === '' ? '无' : known}。`);
    }
    return {
        components,
        root,
        dataModel: surface.dataModel,
        rendered: new Set(),
        used: new Set(),
        usedOrder: [],
        warnings: [],
        visiting: [],
        dataModelUsed: false,
    };
};

// ---------------------------------------------------------------------------
// Rendering: recursive walk over the adjacency table
// ---------------------------------------------------------------------------

const renderSurfaceBody = (state: CompileState): string => {
    const body = renderComponent(state, state.root, {
        dataModel: state.dataModel,
        item: undefined,
        depth: 0,
        onDataModelRead: () => {
            state.dataModelUsed = true;
        },
    });
    addUnreferencedComponentWarning(state);
    if (state.dataModel !== undefined && !state.dataModelUsed) {
        warn(state, 'createSurface 里给了 dataModel，但没有任何 {"@path":"/x"} 绑定读取它；可以直接把值写进组件，或补上绑定。');
    }
    return body;
};

const buildWidgetHtml = (body: string): string =>
    `<meta charset=utf-8><style>${WIDGET_STYLE}</style><div class="tw-root">${body}</div>`;

const enterComponent = (state: CompileState, component: A2uiComponent, depth: number): void => {
    if (depth > MAX_COMPONENT_DEPTH) {
        fail('invalid-surface', `组件嵌套超过 ${MAX_COMPONENT_DEPTH} 层（id=${component.id}）；请把组件树压平。`);
    }
    const cycleStart = state.visiting.indexOf(component.id);
    if (cycleStart >= 0) {
        const cycle = [...state.visiting.slice(cycleStart), component.id].join(' → ');
        fail('invalid-surface', `组件树存在环：${cycle}。children/child 引用必须组成一棵树。`);
    }
    state.visiting.push(component.id);
    state.rendered.add(component.id);
};

const recordUsed = (state: CompileState, name: A2uiComponentName): void => {
    if (state.used.has(name)) {
        return;
    }
    state.used.add(name);
    state.usedOrder.push(name);
};

const renderComponent = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    enterComponent(state, component, scope.depth);
    try {
        return renderNamedComponent(state, component, scope);
    } finally {
        state.visiting.pop();
    }
};

const renderNamedComponent = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const type = component.type;
    if (!isA2uiComponentName(type)) {
        failUnsupportedComponent(component);
    }
    const name: A2uiComponentName = type;
    recordUsed(state, name);
    switch (name) {
        case 'Card':
            return renderContainer(state, component, scope, 'card', COLUMN_LAYOUT_DEFAULTS);
        case 'Column':
            return renderContainer(state, component, scope, 'c', COLUMN_LAYOUT_DEFAULTS);
        case 'Row':
            return renderContainer(state, component, scope, 'r', ROW_LAYOUT_DEFAULTS);
        case 'List':
            return renderList(state, component, scope);
        case 'Text':
            return renderText(state, component, scope);
        case 'Divider':
            return renderDivider(state, component);
        case 'Icon':
            return renderIcon(component, scope);
        case 'Button':
            return renderButton(state, component, scope);
        case 'Table':
            return renderTable(state, component, scope);
        case 'BarChart':
            return renderBarChart(state, component, scope);
        case 'Sparkline':
            return renderSparkline(component, scope);
        default:
            return assertNever(name);
    }
};

const assertNever = (value: never): never => {
    throw new Error(`unhandled A2UI component: ${String(value)}`);
};

function failUnsupportedComponent(component: A2uiComponent): never {
    const reason = A2UI_REJECTED_COMPONENTS[component.type];
    if (reason !== undefined) {
        fail(
            'unsupported-component',
            `组件 ${component.type}（id=${component.id}）不支持：${reason}。` +
                `tg-card-v1 支持：${A2UI_SUPPORTED_COMPONENTS_TEXT}。`
        );
    }
    fail(
        'unsupported-component',
        `组件 ${component.type}（id=${component.id}）不在白名单里。tg-card-v1 支持：${A2UI_SUPPORTED_COMPONENTS_TEXT}。`
    );
}

const renderContainer = (
    state: CompileState,
    component: A2uiComponent,
    scope: A2uiScope,
    className: string,
    defaults: LayoutDefaults
): string => {
    const children = renderChildren(state, component, scope);
    const hasChildProp = optionalProp(component, 'child') !== undefined || optionalProp(component, 'children') !== undefined;
    if (children === '' && !hasChildProp) {
        warn(state, `${component.type}（id=${component.id}）没有可渲染的子组件，输出为空容器。`);
    }
    const style = layoutStyle(component, defaults);
    const styleAttribute = style === '' ? '' : ` style="${style}"`;
    return `<div class="${className}"${styleAttribute}>${children}</div>`;
};

const renderList = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const direction = readListDirection(component);
    return direction === 'horizontal'
        ? renderContainer(state, component, scope, 'r', ROW_LAYOUT_DEFAULTS)
        : renderContainer(state, component, scope, 'c', COLUMN_LAYOUT_DEFAULTS);
};

/** JSON `null` is treated as an absent optional prop, as LLM JSON usually means it. */
const optionalProp = (component: A2uiComponent, key: string): unknown => {
    const value = component.props[key];
    return value === null ? undefined : value;
};

const renderChildren = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const child = optionalProp(component, 'child');
    const children = optionalProp(component, 'children');
    if (child !== undefined && children !== undefined) {
        fail('invalid-surface', `组件 ${component.type}（id=${component.id}）同时给了 child 和 children，只能二选一。`);
    }
    if (typeof child === 'string') {
        return renderChildById(state, child, scope, component);
    }
    if (child !== undefined) {
        fail('invalid-surface', `组件 ${component.type}（id=${component.id}）的 child 必须是组件 id 字符串。`);
    }
    if (Array.isArray(children)) {
        return renderChildList(state, children, scope, component);
    }
    if (isRecord(children)) {
        return renderTemplateList(state, children, scope, component);
    }
    if (children !== undefined) {
        fail(
            'invalid-surface',
            `组件 ${component.type}（id=${component.id}）的 children 必须是组件 id 数组，或 List 模板 {"componentId":"item","path":"/items"}。`
        );
    }
    return '';
};

const renderChildById = (state: CompileState, childId: string, scope: A2uiScope, parent: A2uiComponent): string => {
    const child = lookupComponent(state, childId, `${parent.type}（id=${parent.id}）的 child`);
    return renderComponent(state, child, descend(scope));
};

const renderChildList = (
    state: CompileState,
    children: readonly unknown[],
    scope: A2uiScope,
    parent: A2uiComponent
): string => {
    if (children.length === 0) {
        warn(state, `${parent.type}（id=${parent.id}）的 children 是空数组。`);
        return '';
    }
    return children
        .map((childId, index) => {
            if (typeof childId !== 'string') {
                fail(
                    'invalid-surface',
                    `${parent.type}（id=${parent.id}）的 children[${index}] 必须是组件 id 字符串（当前是 ${describeValue(childId)}）。`
                );
            }
            const where = `${parent.type}（id=${parent.id}）的 children[${index}]`;
            return renderComponent(state, lookupComponent(state, childId, where), descend(scope));
        })
        .join('');
};

const renderTemplateList = (
    state: CompileState,
    template: JsonRecord,
    scope: A2uiScope,
    parent: A2uiComponent
): string => {
    const where = `${parent.type}（id=${parent.id}）的 List 模板`;
    const componentId = template.componentId;
    const path = template.path;
    if (typeof componentId !== 'string') {
        fail('invalid-surface', `${where} 缺少 componentId（模板组件的 id）。`);
    }
    if (typeof path !== 'string') {
        fail('invalid-surface', `${where} 缺少 path（数据模型路径，例如 "/items"）。`);
    }
    const templateComponent = lookupComponent(state, componentId, where);
    ensureSupportedComponentType(templateComponent);
    const items = readPath(path, scope, where);
    if (!Array.isArray(items)) {
        fail('invalid-binding', `${where} 的 path "${path}" 必须指向数组（当前是 ${describeValue(items)}）。`);
    }
    if (items.length === 0) {
        warn(state, `${where} 的 path "${path}" 是空数组，渲染为空。`);
        // Validate and mark the dormant template so its types are checked and
        // it is not reported as an unreferenced component.
        touchSubtree(state, templateComponent, []);
        return '';
    }
    return items
        .map((item) =>
            renderComponent(state, templateComponent, {
                dataModel: state.dataModel,
                item,
                depth: scope.depth + 1,
                onDataModelRead: scope.onDataModelRead,
            })
        )
        .join('');
};

/** Walk a subtree that the data did not render: check types, refs and cycles. */
const touchSubtree = (state: CompileState, component: A2uiComponent, stack: readonly string[]): void => {
    ensureSupportedComponentType(component);
    if (stack.length > MAX_COMPONENT_DEPTH) {
        fail('invalid-surface', `组件嵌套超过 ${MAX_COMPONENT_DEPTH} 层（id=${component.id}）；请把组件树压平。`);
    }
    if (stack.includes(component.id)) {
        fail('invalid-surface', `组件树存在环：${[...stack, component.id].join(' → ')}。`);
    }
    state.rendered.add(component.id);
    const nextStack = [...stack, component.id];
    for (const childId of childIdsOf(component)) {
        const child = lookupComponent(state, childId, `${component.type}（id=${component.id}）的子组件`);
        touchSubtree(state, child, nextStack);
    }
};

const childIdsOf = (component: A2uiComponent): readonly string[] => {
    const ids: string[] = [];
    const child = component.props.child;
    if (typeof child === 'string') {
        ids.push(child);
    }
    const children = component.props.children;
    if (Array.isArray(children)) {
        for (const childId of children) {
            if (typeof childId === 'string') {
                ids.push(childId);
            }
        }
    } else if (isRecord(children) && typeof children.componentId === 'string') {
        ids.push(children.componentId);
    }
    return ids;
};

const ensureSupportedComponentType = (component: A2uiComponent): void => {
    if (isA2uiComponentName(component.type)) {
        return;
    }
    const reason = A2UI_REJECTED_COMPONENTS[component.type];
    const detail = reason === undefined ? '不在白名单里' : `不支持：${reason}`;
    fail(
        'unsupported-component',
        `组件 ${component.type}（id=${component.id}）${detail}。tg-card-v1 支持：${A2UI_SUPPORTED_COMPONENTS_TEXT}。`
    );
};

const descend = (scope: A2uiScope): A2uiScope => ({
    dataModel: scope.dataModel,
    item: scope.item,
    depth: scope.depth + 1,
    onDataModelRead: scope.onDataModelRead,
});

const lookupComponent = (state: CompileState, id: string, where: string): A2uiComponent => {
    const component = state.components.get(id);
    if (component !== undefined) {
        return component;
    }
    const known = [...state.components.keys()].slice(0, 12).join('、');
    fail('invalid-surface', `${where} 引用了不存在的组件 id="${id}"。已定义的组件 id：${known}。`);
};

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const renderText = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const where = `Text（id=${component.id}）.text`;
    const text = toText(resolveBinding(component.props.text, scope, where), where);
    const variant = readTextVariant(component);
    if (text.trim() === '') {
        warn(state, `Text（id=${component.id}）的 text 为空，渲染为空行。`);
    }
    return renderTextHtml(text, variant);
};

const renderTextHtml = (text: string, variant: A2uiTextVariant): string => {
    if (variant === 'h1' || variant === 'h2' || variant === 'h3' || variant === 'h4') {
        return `<div class="h ${variant}">${renderInlineMarkdown(text)}</div>`;
    }
    if (variant === 'caption') {
        return `<div class="cap">${renderInlineMarkdown(text)}</div>`;
    }
    const heading = HEADING_PATTERN.exec(text);
    if (heading !== null) {
        const level = Math.min((heading[1] ?? '').length, 4);
        return `<div class="h h${String(level)}">${renderInlineMarkdown(heading[2] ?? '')}</div>`;
    }
    return `<div>${renderInlineMarkdown(text)}</div>`;
};

const renderDivider = (state: CompileState, component: A2uiComponent): string => {
    const axis = readStringProp(component, 'axis');
    if (axis !== undefined && axis !== 'horizontal') {
        warn(state, `Divider（id=${component.id}）的 axis="${axis}" 不支持，已按水平线渲染；竖线请用 Row 分隔。`);
    }
    return '<hr class="sep">';
};

const renderIcon = (component: A2uiComponent, scope: A2uiScope): string => {
    const where = `Icon（id=${component.id}）.name`;
    const name = toText(resolveBinding(component.props.name, scope, where), where);
    if (!isA2uiIconName(name)) {
        fail(
            'invalid-surface',
            `Icon（id=${component.id}）的 name="${name}" 不在图标白名单里；可用：${A2UI_ICON_NAMES.join('、')}。`
        );
    }
    return renderIconSvg(name);
};

const renderIconSvg = (name: A2uiIconName): string =>
    `<svg class="ic" viewBox="0 0 16 16" width="14" height="14">` +
    `<path d="${A2UI_ICON_PATHS[name]}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const renderButton = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const childId = readStringProp(component, 'child');
    if (childId === undefined) {
        fail('invalid-surface', `Button（id=${component.id}）需要 child 指向一个 Text 组件作为按钮文字。`);
    }
    const labelComponent = lookupComponent(state, childId, `Button（id=${component.id}）的 child`);
    if (labelComponent.type !== 'Text') {
        fail(
            'invalid-surface',
            `Button（id=${component.id}）的 child="${childId}" 必须是 Text 组件（当前是 ${labelComponent.type}）。`
        );
    }
    state.rendered.add(labelComponent.id);
    recordUsed(state, 'Text');
    const where = `Button（id=${component.id}）的按钮文字（Text id=${labelComponent.id}）`;
    const label = toText(resolveBinding(labelComponent.props.text, scope, where), where);
    if (label.trim() === '') {
        warn(state, `Button（id=${component.id}）的按钮文字为空。`);
    }
    if (component.props.action !== undefined) {
        warn(state, 'Button 的 action 在 Phase 0 不生效：widget 只渲染静态外观，交互等 Phase 1。');
    }
    const variant = readButtonVariant(component);
    const className = variant === 'primary' ? 'btn' : 'btn btn2';
    return `<button class="${className}">${renderInlineMarkdown(label)}</button>`;
};

const renderTable = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const where = `Table（id=${component.id}）`;
    const columns = toStringArray(resolveBinding(component.props.columns, scope, `${where}.columns`), scope, `${where}.columns`);
    if (columns.length === 0) {
        fail('invalid-surface', `${where} 需要非空的 columns 字符串数组。`);
    }
    const rows = toStringMatrix(resolveBinding(component.props.rows, scope, `${where}.rows`), scope, `${where}.rows`);
    if (rows.length === 0) {
        warn(state, `${where} 没有数据行，只渲染表头。`);
    }
    if (rows.length > MAX_TABLE_ROWS_WARNING) {
        warn(state, `${where} 有 ${rows.length} 行，超过 ${MAX_TABLE_ROWS_WARNING} 行时 widget 600px 高度会被裁切，建议精简。`);
    }
    if (rows.some((row) => row.length !== columns.length)) {
        warn(state, `${where} 有数据行的单元格数与 columns（${columns.length}）不一致，多出的单元格已忽略。`);
    }
    const header = `<tr>${columns.map((column) => `<th>${renderInlineMarkdown(column)}</th>`).join('')}</tr>`;
    const body = rows
        .map((row) => `<tr>${row.slice(0, columns.length).map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('');
    return `<table class="tbl">${header}${body}</table>`;
};

const renderBarChart = (state: CompileState, component: A2uiComponent, scope: A2uiScope): string => {
    const where = `BarChart（id=${component.id}）`;
    const values = toNumberArray(resolveBinding(component.props.values, scope, `${where}.values`), scope, `${where}.values`);
    if (values.length === 0) {
        fail('invalid-surface', `${where} 需要非空的 values 数字数组。`);
    }
    if (values.length > MAX_BAR_COUNT_WARNING) {
        warn(state, `${where} 有 ${values.length} 个柱子，超过 ${MAX_BAR_COUNT_WARNING} 个会挤在一起，建议精简。`);
    }
    if (values.some((value) => value < 0)) {
        warn(state, `${where} 含负数，负值按 0 绘制。`);
    }
    const labels =
        optionalProp(component, 'labels') === undefined
            ? []
            : toStringArray(resolveBinding(component.props.labels, scope, `${where}.labels`), scope, `${where}.labels`);
    if (labels.length > 0 && labels.length !== values.length) {
        warn(state, `${where} 的 labels（${labels.length} 个）与 values（${values.length} 个）数量不一致。`);
    }
    const peak = Math.max(...values.map((value) => Math.max(value, 0)), 1);
    const bars = values.map((value) => `<i class="bar" style="height:${String(barPercent(value, peak))}%"></i>`).join('');
    const labelsHtml =
        labels.length === 0 ? '' : `<div class="labs">${labels.map((label) => `<span>${renderInlineMarkdown(label)}</span>`).join('')}</div>`;
    return `<div class="c"><div class="bars">${bars}</div>${labelsHtml}</div>`;
};

const barPercent = (value: number, peak: number): number =>
    Math.max(0, Math.min(100, Math.round((Math.max(value, 0) / peak) * 100)));

const renderSparkline = (component: A2uiComponent, scope: A2uiScope): string => {
    const where = `Sparkline（id=${component.id}）`;
    const values = toNumberArray(resolveBinding(component.props.values, scope, `${where}.values`), scope, `${where}.values`);
    if (values.length < 2) {
        fail('invalid-surface', `${where} 至少需要 2 个数值才能画折线。`);
    }
    return (
        `<svg class="sp" viewBox="0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}" preserveAspectRatio="none">` +
        `<polyline points="${sparkPoints(values)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
    );
};

const sparkPoints = (values: readonly number[]): string => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const step = SPARK_WIDTH / (values.length - 1);
    return values
        .map((value, index) => {
            const ratio = span === 0 ? 0.5 : (value - min) / span;
            const x = round1(index * step);
            const y = round1(SPARK_HEIGHT - 3 - ratio * (SPARK_HEIGHT - 6));
            return `${x},${y}`;
        })
        .join(' ');
};

const round1 = (value: number): string => String(Math.round(value * 10) / 10);

// ---------------------------------------------------------------------------
// Props: layout, enums, bindings and coercion
// ---------------------------------------------------------------------------

const readStringProp = (component: A2uiComponent, key: string): string | undefined => {
    const value = component.props[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        fail(
            'invalid-surface',
            `组件 ${component.type}（id=${component.id}）的 ${key} 必须是字符串（当前是 ${describeValue(value)}）。`
        );
    }
    return value;
};

const readTextVariant = (component: A2uiComponent): A2uiTextVariant => {
    const variant = readStringProp(component, 'variant');
    if (variant === undefined) {
        return 'body';
    }
    if (!isA2uiTextVariant(variant)) {
        fail(
            'invalid-surface',
            `Text（id=${component.id}）的 variant="${variant}" 不支持；可用：${A2UI_TEXT_VARIANTS.join('、')}。`
        );
    }
    return variant;
};

const readButtonVariant = (component: A2uiComponent): A2uiButtonVariant => {
    const variant = readStringProp(component, 'variant');
    if (variant === undefined) {
        return 'default';
    }
    if (!isA2uiButtonVariant(variant)) {
        fail(
            'invalid-surface',
            `Button（id=${component.id}）的 variant="${variant}" 不支持；可用：${A2UI_BUTTON_VARIANTS.join('、')}。`
        );
    }
    return variant;
};

const readListDirection = (component: A2uiComponent): A2uiListDirection => {
    const direction = readStringProp(component, 'direction');
    if (direction === undefined) {
        return 'vertical';
    }
    if (!isA2uiListDirection(direction)) {
        fail(
            'invalid-surface',
            `List（id=${component.id}）的 direction="${direction}" 不支持；可用：${A2UI_LIST_DIRECTIONS.join('、')}。`
        );
    }
    return direction;
};

/** Emit only non-default layout declarations, so simple surfaces stay small. */
const layoutStyle = (component: A2uiComponent, defaults: LayoutDefaults): string => {
    const declarations: string[] = [];
    const justify = readStringProp(component, 'justify');
    if (justify !== undefined) {
        const mapped = mapLayoutValue(A2UI_JUSTIFY, justify, component, 'justify');
        if (mapped !== defaults.justify) {
            declarations.push(`justify-content:${mapped}`);
        }
    }
    const align = readStringProp(component, 'align');
    if (align !== undefined) {
        const mapped = mapLayoutValue(A2UI_ALIGN, align, component, 'align');
        if (mapped !== defaults.align) {
            declarations.push(`align-items:${mapped}`);
        }
    }
    return declarations.join(';');
};

const mapLayoutValue = (
    mapping: Readonly<Record<string, string>>,
    value: string,
    component: A2uiComponent,
    prop: string
): string => {
    const mapped = mapping[value];
    if (mapped === undefined) {
        fail(
            'invalid-surface',
            `组件 ${component.type}（id=${component.id}）的 ${prop}="${value}" 不支持；可用：${Object.keys(mapping).join('、')}。`
        );
    }
    return mapped;
};

const MISSING_PATH_HINT = '提示：路径要在 dataModel 里存在；大小写与层级都要一致。';

const resolveBinding = (value: unknown, scope: A2uiScope, where: string): unknown => {
    if (!isRecord(value)) {
        return value;
    }
    const path = value['@path'];
    if (path !== undefined) {
        if (typeof path !== 'string') {
            fail('invalid-binding', `${where} 的 @path 必须是字符串（JSON Pointer，例如 "/user/name"）。`);
        }
        return readPath(path, scope, where);
    }
    if ('@call' in value) {
        fail(
            'invalid-binding',
            `${where} 使用了 @call 函数绑定；编译器只支持字面量和 {"@path":"/x"} 绑定，请把值改成字面量或在 dataModel 里算好。`
        );
    }
    if ('path' in value) {
        fail('invalid-binding', `${where} 使用了 v0.9 的 "path" 写法；A2UI v1.0 的绑定必须写成 {"@path":"/x"}。`);
    }
    fail(
        'invalid-binding',
        `${where} 的值不能是对象（${describeValue(value)}）；这里只接受字面量或 {"@path":"/x"} 绑定。`
    );
};

const readPath = (path: string, scope: A2uiScope, where: string): unknown => {
    const absolute = path.startsWith('/');
    const root = absolute ? scope.dataModel : scope.item;
    if (root === undefined) {
        fail(
            'invalid-binding',
            absolute
                ? `${where} 的绑定 @path="${path}" 需要 dataModel，但 surface 里没有 dataModel。`
                : `${where} 的相对路径 "${path}" 只能用在 List 模板作用域里（读取当前列表项）。`
        );
    }
    if (absolute) {
        scope.onDataModelRead?.();
    }
    let current: unknown = root;
    for (const segment of path.split('/')) {
        if (segment === '') {
            continue;
        }
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isRecord(current)) {
            fail('invalid-binding', `${where} 的绑定 @path="${path}" 在 "${key}" 处不是对象，无法继续读取。${MISSING_PATH_HINT}`);
        }
        if (!(key in current)) {
            fail('invalid-binding', `${where} 的绑定 @path="${path}" 找不到字段 "${key}"。${MISSING_PATH_HINT}`);
        }
        current = current[key];
    }
    if (current === undefined) {
        fail('invalid-binding', `${where} 的绑定 @path="${path}" 解析为 undefined。${MISSING_PATH_HINT}`);
    }
    return current;
};

const toText = (value: unknown, where: string): string => {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (value === null || value === undefined) {
        return '';
    }
    fail('invalid-binding', `${where} 需要字符串，当前是 ${describeValue(value)}。`);
};

const toStringArray = (value: unknown, scope: A2uiScope, where: string): readonly string[] => {
    if (!Array.isArray(value)) {
        fail('invalid-binding', `${where} 必须是字符串数组（当前是 ${describeValue(value)}）。`);
    }
    return value.map((item, index) => {
        const at = `${where}[${index}]`;
        return toText(resolveBinding(item, scope, at), at);
    });
};

const toStringMatrix = (value: unknown, scope: A2uiScope, where: string): readonly (readonly string[])[] => {
    if (!Array.isArray(value)) {
        fail('invalid-binding', `${where} 必须是二维字符串数组（当前是 ${describeValue(value)}）。`);
    }
    if (value.length > MAX_TABLE_ROWS) {
        fail('invalid-binding', `${where} 有 ${value.length} 行，超过上限 ${MAX_TABLE_ROWS} 行。`);
    }
    return value.map((row, index) => {
        const at = `${where}[${index}]`;
        return toStringArray(resolveBinding(row, scope, at), scope, at);
    });
};

const toNumberArray = (value: unknown, scope: A2uiScope, where: string): readonly number[] => {
    if (!Array.isArray(value)) {
        fail('invalid-binding', `${where} 必须是数字数组（当前是 ${describeValue(value)}）。`);
    }
    if (value.length > MAX_VALUE_POINTS) {
        fail('invalid-binding', `${where} 有 ${value.length} 个数据点，超过上限 ${MAX_VALUE_POINTS} 个。`);
    }
    return value.map((item, index) => {
        const at = `${where}[${index}]`;
        const resolved = resolveBinding(item, scope, at);
        if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
            fail('invalid-binding', `${at} 必须是有限数字（当前是 ${describeValue(resolved)}）。`);
        }
        return resolved;
    });
};

// ---------------------------------------------------------------------------
// Text escaping, markdown subset, diagnostics
// ---------------------------------------------------------------------------

/** Every model string goes through here before it reaches the HTML. */
const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lightweight markdown: **bold**, `code`, newlines. Runs on escaped text. */
const renderInlineMarkdown = (text: string): string =>
    escapeHtml(text)
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');

const describeValue = (value: unknown): string => {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (Array.isArray(value)) {
        return `数组（${value.length} 项）`;
    }
    if (typeof value === 'object') {
        return '对象';
    }
    return typeof value;
};

const warn = (state: CompileState, message: string): void => {
    if (!state.warnings.includes(message)) {
        state.warnings.push(message);
    }
};

const addUnreferencedComponentWarning = (state: CompileState): void => {
    const unreferenced = [...state.components.keys()].filter((id) => !state.rendered.has(id));
    if (unreferenced.length === 0) {
        return;
    }
    const shown = unreferenced.slice(0, 8).join('、');
    const rest = unreferenced.length > 8 ? ` 等 ${unreferenced.length} 个` : '';
    warn(state, `有 ${unreferenced.length} 个组件没有被根组件引用：${shown}${rest}；请检查 children/child 是否写错。`);
};
