/**
 * Offline cases for the A2UI v1.0 -> Telegram widget compiler and the widget
 * size accounting (zlib level 9: 32768 B raw / 4096 B compressed, as the
 * Telegram server enforces it).
 *
 * Run: npx tsx scripts/offline/widget-a2ui.mts
 */
import { deflateSync } from 'node:zlib';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    A2UI_MAX_GZIP_BYTES,
    A2UI_MAX_HTML_BYTES,
    checkWidgetBudget,
    compileA2uiSurface,
    measureWidgetHtml,
    type A2uiCompileOptions,
    type A2uiCompileSuccess,
    type WidgetBudgetLimits,
} from '../../src/ai/widget/index.js';

// ---------------------------------------------------------------------------
// Fixtures (mirroring tmp/research/a2ui/samples)
// ---------------------------------------------------------------------------

const surfaceOf = (components: readonly unknown[], dataModel?: unknown): unknown => ({
    version: '1.0',
    createSurface: {
        surfaceId: 'offline',
        catalogId: 'tg-card-v1',
        components,
        ...(dataModel === undefined ? {} : { dataModel }),
    },
});

const CARD = surfaceOf([
    { id: 'root', component: 'Card', child: 'col' },
    { id: 'col', component: 'Column', children: ['title', 'sub', 'line', 'row', 'foot'], justify: 'start', align: 'stretch' },
    { id: 'title', component: 'Text', text: '上海 · 多云转晴' },
    { id: 'sub', component: 'Text', text: '体感 23°C · 湿度 61%', variant: 'caption' },
    { id: 'line', component: 'Divider', axis: 'horizontal' },
    { id: 'row', component: 'Row', children: ['hi', 'lo'], justify: 'spaceBetween' },
    { id: 'hi', component: 'Text', text: '最高 27°C' },
    { id: 'lo', component: 'Text', text: '最低 18°C' },
    { id: 'foot', component: 'Text', text: '更新于 14:30 · 数据源 中央气象台', variant: 'caption' },
]);

const LIST_DATA = {
    items: [
        { label: '回复 @alice 的问题' },
        { label: '部署 10.4 测试实例' },
        { label: '整理 A2UI 调研笔记' },
        { label: '跑离线测试 489 PASS' },
        { label: '给 Lead 发摘要' },
    ],
};

const LIST = surfaceOf(
    [
        { id: 'root', component: 'Card', child: 'col' },
        { id: 'col', component: 'Column', children: ['hd', 'list', 'btn'] },
        { id: 'hd', component: 'Text', text: '今日待办', variant: 'caption' },
        { id: 'list', component: 'List', children: { componentId: 'item', path: '/items' }, direction: 'vertical' },
        { id: 'item', component: 'Row', children: ['dot', 'lab'], justify: 'start', align: 'center' },
        { id: 'dot', component: 'Icon', name: 'check' },
        { id: 'lab', component: 'Text', text: { '@path': 'label' } },
        { id: 'btn', component: 'Button', child: 'bt', action: { event: { name: 'refresh' } } },
        { id: 'bt', component: 'Text', text: '刷新' },
    ],
    LIST_DATA
);

const TABLE = surfaceOf([
    {
        id: 'root',
        component: 'Table',
        columns: ['话题', '条数'],
        rows: [
            ['模型 / 工具', '42'],
            ['游戏', '31'],
            ['表情包', '18'],
            ['其它', '9'],
        ],
    },
]);

const CHART = surfaceOf([
    { id: 'root', component: 'Card', child: 'col' },
    { id: 'col', component: 'Column', children: ['title', 'chart', 'cap'] },
    { id: 'title', component: 'Text', text: '本周活跃度' },
    { id: 'chart', component: 'BarChart', values: [12, 18, 9, 24, 31, 22, 27], labels: ['一', '二', '三', '四', '五', '六', '日'] },
    { id: 'cap', component: 'Text', text: '单位：消息数 / 天', variant: 'caption' },
]);

const SPARKLINE = surfaceOf([
    { id: 'root', component: 'Card', child: 'sp' },
    { id: 'sp', component: 'Sparkline', values: [3, 6, 4, 9, 14, 11, 18, 22, 16, 12, 9, 7] },
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compileOk = (input: unknown, options?: A2uiCompileOptions): A2uiCompileSuccess => {
    const result = compileA2uiSurface(input, options);
    if (!result.ok) {
        throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    }
    return result;
};

const compileFailure = (input: unknown, options?: A2uiCompileOptions): { readonly code: string; readonly message: string } => {
    const result = compileA2uiSurface(input, options);
    if (result.ok) {
        throw new Error('expected a failure, got a compiled widget');
    }
    return result;
};

const budgetCode = (html: string, limits: WidgetBudgetLimits): string => {
    const check = checkWidgetBudget(html, limits);
    return check.ok ? 'ok' : check.code;
};

/** No active content may survive into the widget, whatever the surface says. */
const expectInert = (html: string): void => {
    expect(!html.includes('<script'), 'no <script> element');
    expect(!html.includes('<link') && !html.includes('<iframe'), 'no external resources');
    expect(!html.includes(' javascript:'), 'no javascript: URL');
    expect(!/<[^>]+\son[a-z]+\s*=/i.test(html), 'no inline event handler attribute');
};

const logSize = (label: string, result: A2uiCompileSuccess): void => {
    console.log(`    · ${label}: ${result.size.rawBytes} B raw / ${result.size.zlibBytes} B zlib9`);
};

const cases: CaseResult[] = [];

// ---------------------------------------------------------------------------
// Happy paths and size budgets
// ---------------------------------------------------------------------------

cases.push(
    await runCase('a card compiles to a zero-JS widget within the card budget', async () => {
        const result = compileOk(CARD);
        logSize('card', result);
        expect(result.html.startsWith('<meta charset=utf-8><style>'), 'meta charset then the fixed stylesheet');
        expect(result.html.includes('<div class="tw-root">'), 'root wrapper');
        expect(result.html.includes('class="card"'), 'card container');
        expect(result.html.includes('上海 · 多云转晴'), 'title text');
        expect(result.html.includes('justify-content:space-between'), 'row layout hint');
        expect(result.html.includes('body{margin:0;padding:10px 12px'), 'fixed body padding');
        expect(result.html.includes('system-ui'), 'system font stack');
        expect(result.html.includes('--tg-theme-'), 'theme variables');
        expect(result.size.zlibBytes <= 800, `card zlib9 ${result.size.zlibBytes} B <= 800 B`);
        expect(result.size.rawBytes <= A2UI_MAX_HTML_BYTES, `card raw ${result.size.rawBytes} B <= ${A2UI_MAX_HTML_BYTES} B`);
        expect(result.components.join(',') === 'Card,Column,Text,Divider,Row', `component order ${result.components.join(',')}`);
        expectInert(result.html);
    })
);

cases.push(
    await runCase('a list expands its data-model template and stays under the list budget', async () => {
        const result = compileOk(LIST);
        logSize('list(5 items)', result);
        for (const item of LIST_DATA.items) {
            expect(result.html.includes(item.label), `rendered item "${item.label}"`);
        }
        expect(result.html.includes('<svg class="ic"'), 'icon is inline SVG');
        expect(result.html.includes('<button class="btn btn2">刷新</button>'), 'button label only, no JS');
        expect(result.size.zlibBytes <= 1500, `list zlib9 ${result.size.zlibBytes} B <= 1500 B`);
        expect(result.components.includes('List') && result.components.includes('Icon'), 'List and Icon recorded as used');
        expect(
            result.warnings.some((warning) => warning.includes('action') && warning.includes('Phase 0')),
            'button action is reported as inert'
        );
        expectInert(result.html);
    })
);

cases.push(
    await runCase('a table compiles rows and headers within the table budget', async () => {
        const result = compileOk(TABLE);
        logSize('table(4 rows)', result);
        expect(result.html.includes('<table class="tbl">'), 'native table element');
        expect(result.html.includes('<th>话题</th>'), 'header cell');
        expect(result.html.includes('<td>模型 / 工具</td>'), 'body cell');
        expect(result.size.zlibBytes <= 1500, `table zlib9 ${result.size.zlibBytes} B <= 1500 B`);
        expectInert(result.html);
    })
);

cases.push(
    await runCase('charts compile to CSS bars and a precomputed SVG polyline', async () => {
        const chart = compileOk(CHART);
        logSize('barchart', chart);
        expect((chart.html.match(/class="bar"/g) ?? []).length === 7, 'one CSS bar per value');
        expect(chart.html.includes('style="height:100%"'), 'peak value spans the full height');
        expect(chart.html.includes('<div class="labs">'), 'labels row');
        expect(chart.size.zlibBytes <= 1200, `chart zlib9 ${chart.size.zlibBytes} B <= 1200 B`);

        const sparkline = compileOk(SPARKLINE);
        logSize('sparkline', sparkline);
        expect(sparkline.html.includes('<polyline points="'), 'polyline points are computed at compile time');
        expect(sparkline.html.includes('vector-effect="non-scaling-stroke"'), 'stroke stays crisp when stretched');
        expect(sparkline.size.zlibBytes <= 1200, `sparkline zlib9 ${sparkline.size.zlibBytes} B <= 1200 B`);
        expectInert(chart.html);
        expectInert(sparkline.html);
    })
);

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

cases.push(
    await runCase('a JSON string input compiles exactly like the object input', async () => {
        const fromObject = compileOk(CARD);
        const fromString = compileOk(JSON.stringify(CARD));
        expect(fromString.html === fromObject.html, 'same HTML');
        expect(fromString.size.zlibBytes === fromObject.size.zlibBytes, 'same size');
    })
);

cases.push(
    await runCase('compilation is deterministic', async () => {
        const first = compileOk(LIST);
        const second = compileOk(LIST);
        expect(first.html === second.html, 'identical HTML');
        expect(first.size.zlibBytes === second.size.zlibBytes, 'identical compressed size');
        expect(JSON.stringify(first.warnings) === JSON.stringify(second.warnings), 'identical warnings');
    })
);

cases.push(
    await runCase('a bare surface and a messages wrapper are accepted', async () => {
        const bare = compileOk({ components: [{ id: 'root', component: 'Text', text: '裸 surface' }] });
        expect(bare.html.includes('裸 surface'), 'bare {components} surface renders');
        const wrapped = compileOk({ messages: [CARD] });
        expect(wrapped.html === compileOk(CARD).html, 'messages wrapper delegates to createSurface');
    })
);

cases.push(
    await runCase('data bindings resolve against the data model, including List scope', async () => {
        const result = compileOk(
            surfaceOf(
                [
                    { id: 'root', component: 'Column', children: ['title', 'escaped', 'list'] },
                    { id: 'title', component: 'Text', text: { '@path': '/title' } },
                    { id: 'escaped', component: 'Text', text: { '@path': '/a~1b/c~0d' } },
                    { id: 'list', component: 'List', children: { componentId: 'item', path: '/items' } },
                    { id: 'item', component: 'Row', children: ['label', 'value'] },
                    { id: 'label', component: 'Text', text: { '@path': 'label' } },
                    { id: 'value', component: 'Text', text: { '@path': 'value' }, variant: 'caption' },
                ],
                {
                    title: '数据标题',
                    'a/b': { 'c~d': '转义值' },
                    items: [
                        { label: '甲', value: 1 },
                        { label: '乙', value: 2 },
                    ],
                }
            )
        );
        for (const expected of ['数据标题', '转义值', '甲', '乙', '>1<', '>2<']) {
            expect(result.html.includes(expected), `rendered "${expected}"`);
        }
        expect(!result.warnings.some((warning) => warning.includes('dataModel')), 'no unused-dataModel warning');
    })
);

cases.push(
    await runCase('null optional props are treated as absent', async () => {
        const emptyCard = compileOk(surfaceOf([{ id: 'root', component: 'Card', children: null }]));
        expect(emptyCard.html.includes('class="card"'), 'null children do not crash');
        expect(
            emptyCard.warnings.some((warning) => warning.includes('没有可渲染的子组件')),
            'null children are an empty container'
        );
        const nullSiblings = compileOk(
            surfaceOf([
                { id: 'root', component: 'Column', children: ['chart'], child: null },
                { id: 'chart', component: 'BarChart', values: [1, 2], labels: null },
            ])
        );
        expect(nullSiblings.html.includes('class="bars"'), 'a null child does not mask the children array');
        expect(!nullSiblings.html.includes('class="labs"'), 'null labels render no label row');
    })
);

// ---------------------------------------------------------------------------
// Rejections: catalog, structure, bindings, budget
// ---------------------------------------------------------------------------

cases.push(
    await runCase('input-only A2UI components are rejected with an actionable message', async () => {
        const failure = compileFailure(surfaceOf([{ id: 'root', component: 'TextField', label: '名字' }]));
        expect(failure.code === 'unsupported-component', `code ${failure.code} === unsupported-component`);
        expect(failure.message.includes('TextField'), 'message names the component');
        expect(failure.message.includes('tg-card-v1'), 'message lists the supported catalog');
        expect(failure.message.includes('输入控件') || failure.message.includes('键盘'), 'message says why it is impossible');
        const tabs = compileFailure(surfaceOf([{ id: 'root', component: 'Tabs' }]));
        expect(tabs.code === 'unsupported-component' && tabs.message.includes('Tabs'), 'Tabs is rejected too');
        const unknown = compileFailure(surfaceOf([{ id: 'root', component: 'Sparkle' }]));
        expect(unknown.message.includes('不在白名单'), 'unknown component says it is not in the whitelist');
    })
);

cases.push(
    await runCase('broken JSON and non-object input are reported precisely', async () => {
        const brokenJson = compileFailure('{"components": [');
        expect(brokenJson.code === 'invalid-json', `code ${brokenJson.code} === invalid-json`);
        expect(brokenJson.message.includes('JSON'), 'message mentions JSON');
        const emptyString = compileFailure('   ');
        expect(emptyString.code === 'invalid-input', 'blank string is invalid-input');
        const number = compileFailure(42);
        expect(number.code === 'invalid-input', 'a bare number is invalid-input');
    })
);

cases.push(
    await runCase('a surface without a root component or with dangling references is rejected', async () => {
        const noRoot = compileFailure(surfaceOf([{ id: 'col', component: 'Column', children: [] }]));
        expect(noRoot.code === 'invalid-surface' && noRoot.message.includes('root'), 'missing root is named');
        const dangling = compileFailure(surfaceOf([{ id: 'root', component: 'Card', child: 'nope' }]));
        expect(dangling.code === 'invalid-surface' && dangling.message.includes('不存在的组件'), 'dangling child is named');
        const v08 = compileFailure(surfaceOf([{ id: 'root', component: { Card: { child: 'x' } } }]));
        expect(v08.code === 'invalid-surface' && v08.message.includes('component'), 'nested v0.8 component shape is rejected');
        const cycle = compileFailure(
            surfaceOf([
                { id: 'root', component: 'Column', children: ['a'] },
                { id: 'a', component: 'Row', children: ['root'] },
            ])
        );
        expect(cycle.code === 'invalid-surface' && cycle.message.includes('环'), 'cycle is named');
    })
);

cases.push(
    await runCase('unsupported bindings are rejected instead of being half-rendered', async () => {
        const call = compileFailure(surfaceOf([{ id: 'root', component: 'Text', text: { '@call': 'formatString', args: {} } }]));
        expect(call.code === 'invalid-binding', `@call code ${call.code} === invalid-binding`);
        expect(call.message.includes('@call'), 'message names @call');
        const oldPath = compileFailure(surfaceOf([{ id: 'root', component: 'Text', text: { path: '/title' } }]));
        expect(oldPath.code === 'invalid-binding' && oldPath.message.includes('@path'), 'v0.9 path is redirected to @path');
        const missing = compileFailure(surfaceOf([{ id: 'root', component: 'Text', text: { '@path': '/nope' } }], { other: 1 }));
        expect(missing.code === 'invalid-binding' && missing.message.includes('找不到字段'), 'missing path is named');
        const relative = compileFailure(
            surfaceOf([
                { id: 'root', component: 'Text', text: { '@path': 'label' } },
            ])
        );
        expect(relative.code === 'invalid-binding' && relative.message.includes('List'), 'relative path outside a List is explained');
        const noDataModel = compileFailure(surfaceOf([{ id: 'root', component: 'Text', text: { '@path': '/x' } }]));
        expect(noDataModel.code === 'invalid-binding' && noDataModel.message.includes('dataModel'), 'missing dataModel is explained');
    })
);

cases.push(
    await runCase('invalid enum values cannot inject attributes', async () => {
        const variant = compileFailure(
            surfaceOf([{ id: 'root', component: 'Text', text: 'hi', variant: 'body" onmouseover="alert(1)' }])
        );
        expect(variant.code === 'invalid-surface', `variant code ${variant.code} === invalid-surface`);
        const justify = compileFailure(
            surfaceOf([
                { id: 'root', component: 'Row', children: ['t'], justify: 'start;background:url(https://evil.example)' },
                { id: 't', component: 'Text', text: 'x' },
            ])
        );
        expect(justify.code === 'invalid-surface', 'bad justify is rejected before any HTML is built');
    })
);

cases.push(
    await runCase('a surface over the compressed budget reports too-large', async () => {
        const failure = compileFailure(LIST, { maxGzipBytes: 300 });
        expect(failure.code === 'too-large', `code ${failure.code} === too-large`);
        expect(failure.message.includes('上限'), 'message carries the measured size and limits');
        expect(failure.message.includes('300'), 'message mentions the custom limit');
    })
);

// ---------------------------------------------------------------------------
// Safety, warnings, size helpers
// ---------------------------------------------------------------------------

cases.push(
    await runCase('model text is escaped and cannot inject markup', async () => {
        const xss = surfaceOf(
            [
                { id: 'root', component: 'Column', children: ['a', 'b', 'c'] },
                { id: 'a', component: 'Text', text: '危险 <script>alert("x")</script> & "引号"' },
                { id: 'b', component: 'Text', text: { '@path': '/evil' } },
                { id: 'c', component: 'Button', child: 'label' },
                { id: 'label', component: 'Text', text: '<b>点击</b>' },
            ],
            { evil: '<img src=x onerror=alert(1)>' }
        );
        const result = compileOk(xss);
        expect(result.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'script markup is fully escaped');
        expect(result.html.includes('&amp; &quot;引号&quot;'), 'ampersand and quotes are escaped');
        expect(result.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'data-model values are escaped');
        expect(!result.html.includes('<img'), 'no live img element');
        expect(result.html.includes('&lt;b&gt;点击&lt;/b&gt;'), 'button label is escaped, not parsed');
        expectInert(result.html);
    })
);

cases.push(
    await runCase('an unused data model and unreferenced components produce warnings', async () => {
        const unusedData = compileOk(surfaceOf([{ id: 'root', component: 'Text', text: '纯文本' }], { unused: 1 }));
        expect(unusedData.warnings.some((warning) => warning.includes('dataModel')), 'unused dataModel warning');
        const orphan = compileOk(
            surfaceOf([
                { id: 'root', component: 'Text', text: 'hi' },
                { id: 'ghost', component: 'Text', text: '没人引用我' },
            ])
        );
        expect(orphan.warnings.some((warning) => warning.includes('ghost')), 'unreferenced component is named');
        const emptyList = compileOk(
            surfaceOf(
                [
                    { id: 'root', component: 'List', children: { componentId: 'item', path: '/items' } },
                    { id: 'item', component: 'Text', text: { '@path': 'label' } },
                ],
                { items: [] }
            )
        );
        expect(emptyList.warnings.some((warning) => warning.includes('空数组')), 'empty List template warns');
        expect(
            !emptyList.warnings.some((warning) => warning.includes('没有被根组件引用')),
            'a dormant List template is not reported as unreferenced'
        );
        const dormantRejected = compileFailure(
            surfaceOf(
                [
                    { id: 'root', component: 'List', children: { componentId: 'item', path: '/items' } },
                    { id: 'item', component: 'Row', children: ['input'] },
                    { id: 'input', component: 'TextField', label: 'x' },
                ],
                { items: [] }
            )
        );
        expect(dormantRejected.code === 'unsupported-component', 'a dormant template is still validated');
    })
);

cases.push(
    await runCase('streaming and update envelopes are rejected as unsupported', async () => {
        const streaming = compileFailure([CARD, { version: '1.0', updateComponents: { components: [] } }]);
        expect(streaming.code === 'invalid-surface', `code ${streaming.code} === invalid-surface`);
        expect(streaming.message.includes('updateComponents'), 'message names updateComponents');
        const twoSurfaces = compileFailure([CARD, CARD]);
        expect(twoSurfaces.message.includes('createSurface'), 'two createSurface messages are rejected');
    })
);

cases.push(
    await runCase('widget size helpers mirror zlib level 9 and both limits', async () => {
        const html = '<div class="tw-root"><div>你好</div></div>';
        const measured = measureWidgetHtml(html);
        const expected = deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).byteLength;
        expect(measured.rawBytes === Buffer.byteLength(html, 'utf8'), 'raw bytes are UTF-8 length');
        expect(measured.zlibBytes === expected, 'zlib bytes match deflateSync level 9');
        expect(budgetCode(html, { maxHtmlBytes: 1000, maxGzipBytes: 1000 }) === 'ok', 'a small widget passes');
        expect(budgetCode(html, { maxHtmlBytes: 10, maxGzipBytes: 1000 }) === 'html-too-large', 'raw limit is enforced');
        expect(budgetCode(html, { maxHtmlBytes: 1000, maxGzipBytes: 10 }) === 'html-too-large', 'compressed limit is enforced');
        expect(budgetCode('   ', { maxHtmlBytes: 1000, maxGzipBytes: 1000 }) === 'html-too-empty', 'blank HTML is rejected');
        expect(A2UI_MAX_HTML_BYTES === 32768 && A2UI_MAX_GZIP_BYTES === 4096, 'default limits are the Telegram ones');
    })
);

reportResults(cases);
