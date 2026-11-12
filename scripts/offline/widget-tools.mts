/**
 * Offline cases for the two widget tools — send_widget and get_ui_guide
 * (no containers, no network).
 *
 * The tools are pure: send_widget compiles/prechecks a payload into the reply's
 * media state, get_ui_guide returns a version-fixed document. Delivery is not
 * exercised here (that needs Telegram); the point is the state machine, the
 * one-attachment guard and the model-facing error messages.
 *
 * Run: npx tsx scripts/offline/widget-tools.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ToolHandler } from '../../src/ai/tools/tool-types.js';

// Tool availability reads model capabilities, and the platforms refuse to load
// without credentials; nothing here sends a request.
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const { createSendWidgetTool } = await import('../../src/reply/tools/send-widget-tool.js');
const { createUiGuideTool } = await import('../../src/reply/tools/ui-guide-tool.js');
const { createReplyMediaState, ONE_ATTACHMENT_PER_REPLY } = await import(
    '../../src/reply/tools/reply-media-state.js'
);
const { readToolConfig } = await import('../../src/config/tool-config.js');
const { resolveToolAvailability } = await import('../../src/reply/tools/tool-availability.js');
const { normalizeToolOverrides } = await import('../../src/services/tool-overrides.js');

const LIMITS = { allowHtml: false, maxHtmlBytes: 32768, maxGzipBytes: 4096 };

/** One property of a tool's input schema, as a plain record */
const schemaPropertyOf = (tool: ToolHandler, name: string): Record<string, unknown> => {
    const properties = tool.definition.inputSchema.properties;
    if (typeof properties !== 'object' || properties === null) return {};
    const property = Object.fromEntries(Object.entries(properties))[name];
    return typeof property === 'object' && property !== null
        ? Object.fromEntries(Object.entries(property))
        : {};
};

const columnSurface = (): Record<string, unknown> => ({
    version: '1.0',
    createSurface: {
        surfaceId: 'main',
        catalogId: 'tg-card-v1',
        components: [
            { id: 'root', component: 'Column', children: ['title', 'stats'] },
            { id: 'title', component: 'Text', text: '# 群聊日报', variant: 'h3' },
            { id: 'stats', component: 'Row', children: ['a', 'b'] },
            { id: 'a', component: 'Text', text: '消息 **10**' },
            { id: 'b', component: 'Text', text: '活跃 **3**' },
        ],
    },
});

const run = async (tool: ToolHandler, args: Record<string, unknown>) =>
    tool.execute(args, new AbortController().signal);

const results: CaseResult[] = [];

results.push(
    await runCase('send_widget compiles an A2UI surface into the reply attachment', async () => {
        const state = createReplyMediaState();
        const tool = createSendWidgetTool({ state, limits: LIMITS });
        const result = await run(tool, { mode: 'a2ui', surface: columnSurface(), caption: '日报' });

        expect(!result.isError, 'the tool accepts a valid surface');
        expect(state.hasReplyWidget, 'the one-attachment flag is set');
        expect(state.widget?.mode === 'a2ui', 'the delivery is an A2UI card');
        expect(state.widget?.html.includes('<div'), 'the compiled HTML is stored');
        expect(state.widget?.caption === '日报', 'the caption is stored');
        expect(state.widget?.surface !== undefined, 'the surface is kept for a later read');
        expect(result.widgets?.length === 1, 'the tool result carries the widget chunk');
        expect(result.widgets?.[0] === state.widget, 'the chunk is the prepared delivery');
        expect(result.content.includes('压缩后'), 'the model reads the measured size');
    })
);

results.push(
    await runCase('a second send_widget is refused by the one-attachment rule', async () => {
        const state = createReplyMediaState();
        const tool = createSendWidgetTool({ state, limits: LIMITS });
        const first = await run(tool, { mode: 'a2ui', surface: columnSurface() });
        expect(!first.isError, 'the first card is accepted');

        const second = await run(tool, { mode: 'a2ui', surface: columnSurface() });
        expect(second.isError, 'the second card is refused');
        expect(second.content === ONE_ATTACHMENT_PER_REPLY, 'the shared attachment message is used');
    })
);

results.push(
    await runCase('an earlier picture blocks send_widget the same way', async () => {
        const state = createReplyMediaState();
        state.hasReplyImage = true;
        const tool = createSendWidgetTool({ state, limits: LIMITS });
        const result = await run(tool, { mode: 'a2ui', surface: columnSurface() });
        expect(result.isError, 'the card is refused');
        expect(result.content === ONE_ATTACHMENT_PER_REPLY, 'the shared message explains it');
        expect(state.widget === undefined, 'nothing was stored');
    })
);

results.push(
    await runCase('an unsupported A2UI component comes back as an actionable error', async () => {
        const state = createReplyMediaState();
        const tool = createSendWidgetTool({ state, limits: LIMITS });
        const result = await run(tool, {
            mode: 'a2ui',
            surface: {
                components: [
                    { id: 'root', component: 'Column', children: ['img'] },
                    { id: 'img', component: 'Image', url: 'data:image/png;base64,AA' },
                ],
            },
        });
        expect(result.isError, 'the surface is refused');
        expect(result.content.includes('Image'), 'the error names the component');
        expect(state.widget === undefined, 'nothing was stored');
    })
);

results.push(
    await runCase('HTML mode is refused unless WIDGET_ALLOW_HTML is on', async () => {
        const state = createReplyMediaState();
        const tool = createSendWidgetTool({ state, limits: LIMITS });
        const refused = await run(tool, { mode: 'html', html: '<div>hi</div>' });
        expect(refused.isError, 'html mode is refused by default');
        expect(refused.content.includes('A2UI'), 'the error points at the A2UI mode');

        const htmlState = createReplyMediaState();
        const htmlTool = createSendWidgetTool({
            state: htmlState,
            limits: { ...LIMITS, allowHtml: true },
        });
        const accepted = await run(htmlTool, { mode: 'html', html: '<div>hi</div>' });
        expect(!accepted.isError, 'html mode is accepted when enabled');
        expect(htmlState.widget?.mode === 'html', 'the delivery is an html card');
        expect(htmlState.widget?.surface === undefined, 'html mode keeps no surface');
        expect(accepted.widgets?.length === 1, 'the html card also travels as a chunk');
    })
);

results.push(
    await runCase('get_ui_guide returns the version-fixed documents', async () => {
        const tool = createUiGuideTool();
        const a2ui = await run(tool, { kind: 'a2ui' });
        expect(!a2ui.isError && a2ui.content.length > 2000, 'the A2UI guide is long enough to be useful');
        expect(a2ui.content.includes('tg-card-v1'), 'the A2UI guide names the catalog');
        expect(a2ui.content.includes('version 4'), 'the guide version is announced');

        const htmlGuide = await run(tool, { kind: 'html' });
        expect(!htmlGuide.isError && htmlGuide.content.length > 5000, 'the HTML guide is long enough');
        expect(htmlGuide.content.includes('32768'), 'the HTML guide states the raw limit');
        expect(htmlGuide.content.includes('4096'), 'the HTML guide states the compressed limit');

        const invalid = await run(tool, { kind: 'markdown' });
        expect(invalid.isError, 'an unknown kind is refused');
    })
);

results.push(
    await runCase('the panel switch turns the widget pair on and off, but never opens groups', async () => {
        const config = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_CHAT_IDS: '603421700',
            TOOL_CHAT_IDS: '603421700',
            OWNER_USER_ID: '603421700',
        });
        const enabled = resolveToolAvailability('gemini-4-argon', 603421700, config);
        expect(enabled.widget && enabled.widgetGuide, 'the whitelisted private chat gets both tools');

        const normalized = normalizeToolOverrides({ widget: false });
        expect(normalized.ok && normalized.value?.widget === false, 'widget is a known panel group');
        const disabled = resolveToolAvailability(
            'gemini-4-argon',
            603421700,
            config,
            undefined,
            normalized.ok ? normalized.value : null
        );
        expect(!disabled.widget && !disabled.widgetGuide, 'the panel switch can turn both off');

        const groupOverride = normalizeToolOverrides({ widget: true });
        const group = resolveToolAvailability(
            'gemini-4-argon',
            -1001415974153,
            config,
            undefined,
            groupOverride.ok ? groupOverride.value : null
        );
        expect(!group.widget, 'a group chat stays off even when the panel asks for it');
    })
);

results.push(
    await runCase('the surface parameter is a minified JSON string (harness issue #5)', async () => {
        const tool = createSendWidgetTool({ state: createReplyMediaState(), limits: LIMITS });
        const surfaceSchema = schemaPropertyOf(tool, 'surface');
        expect(surfaceSchema.type === 'string', 'surface is declared as a string, not an untyped value');
        expect(
            /minified/i.test(String(surfaceSchema.description ?? '')),
            'the description asks for minified JSON'
        );

        // A JSON string is accepted and stored as JSON for a later context
        const state = createReplyMediaState();
        const stringTool = createSendWidgetTool({ state, limits: LIMITS });
        const result = await run(stringTool, { mode: 'a2ui', surface: JSON.stringify(columnSurface()) });
        expect(!result.isError, 'the minified JSON string compiles');
        expect(
            typeof state.widget?.surface === 'object' && state.widget.surface !== null,
            'the stored surface is JSON, so a later context replays it as JSON'
        );
    })
);

reportResults(results);
