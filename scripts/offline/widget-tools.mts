/**
 * Offline cases for send_widget and its paired load_skill specs (`widget-a2ui`
 * and `widget-html`, no containers, no network).
 *
 * The tools are pure: send_widget compiles/prechecks a payload into the reply's
 * media state, load_skill loads version-fixed widget skill specs. Delivery is
 * not exercised here (that needs Telegram); the point is the state machine, the
 * one-attachment guard, availability gating, and model-facing error messages.
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
const { createLoadSkillTool, createSkillToolState } = await import('../../src/reply/tools/load-skill-tool.js');
const {
    filterAvailableSkills,
    getSkillRegistry,
    WIDGET_ALLOW_HTML_FLAG,
} = await import('../../src/reply/skills/skill-registry.js');
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
    await runCase('load_skill returns widget-a2ui / widget-html specs and gates widget-html on WIDGET_ALLOW_HTML', async () => {
        const allSkills = getSkillRegistry();
        const a2uiOnly = filterAvailableSkills({
            skills: allSkills,
            declaredToolNames: new Set(['send_widget']),
            activeFlags: new Set(),
            scope: 'private',
            isOwner: false,
        });
        expect(
            a2uiOnly.map((skill) => skill.name).join(',') === 'widget-a2ui',
            `without widget-allow-html only widget-a2ui is available (got ${a2uiOnly.map((s) => s.name).join(',')})`
        );

        const a2uiTool = createLoadSkillTool({ state: createSkillToolState(), availableSkills: a2uiOnly });
        const a2ui = await run(a2uiTool, { names: ['widget-a2ui'] });
        expect(!a2ui.isError && a2ui.content.length > 2000, 'the A2UI spec is long enough to be useful');
        expect(a2ui.content.includes('tg-card-v1'), 'the A2UI spec names the catalog');
        expect(a2ui.content.includes('version 4'), 'the spec version is announced');

        const blockedHtml = await run(a2uiTool, { names: ['widget-html'] });
        expect(blockedHtml.isError, 'widget-html is refused when widget-allow-html flag is off');

        const withHtmlSkills = filterAvailableSkills({
            skills: allSkills,
            declaredToolNames: new Set(['send_widget']),
            activeFlags: new Set([WIDGET_ALLOW_HTML_FLAG]),
            scope: 'private',
            isOwner: false,
        });
        expect(
            withHtmlSkills.some((skill) => skill.name === 'widget-html'),
            'with widget-allow-html flag, widget-html is available'
        );
        const htmlTool = createLoadSkillTool({ state: createSkillToolState(), availableSkills: withHtmlSkills });
        const htmlGuide = await run(htmlTool, { names: ['widget-html'] });
        expect(!htmlGuide.isError && htmlGuide.content.length > 5000, 'the HTML spec is long enough');
        expect(htmlGuide.content.includes('32768'), 'the HTML spec states the raw limit');
        expect(htmlGuide.content.includes('4096'), 'the HTML spec states the compressed limit');

        const invalid = await run(htmlTool, { names: ['markdown'] });
        expect(invalid.isError, 'an unknown skill name is refused');
    })
);

results.push(
    await runCase('the panel switch turns widget on and off, load_skill disable turns widget off, and groups stay gated', async () => {
        const config = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_CHAT_IDS: '603421700',
            TOOL_CHAT_IDS: '603421700',
            OWNER_USER_ID: '603421700',
        });
        const enabled = resolveToolAvailability('gemini-4-argon', 603421700, config);
        expect(enabled.widget && enabled.skills, 'the whitelisted private chat gets send_widget and skills');

        const normalized = normalizeToolOverrides({ widget: false });
        expect(normalized.ok && normalized.value?.widget === false, 'widget is a known panel group');
        const disabled = resolveToolAvailability(
            'gemini-4-argon',
            603421700,
            config,
            normalized.ok ? normalized.value : null
        );
        expect(!disabled.widget, 'the panel switch can turn widget off');

        const loadSkillOffConfig = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_CHAT_IDS: '603421700',
            TOOL_CHAT_IDS: '603421700',
            OWNER_USER_ID: '603421700',
            DISABLED_TOOLS: 'load_skill',
        });
        const loadSkillOff = resolveToolAvailability('gemini-4-argon', 603421700, loadSkillOffConfig);
        expect(!loadSkillOff.widget && !loadSkillOff.skills, 'DISABLED_TOOLS=load_skill disables widget too');

        const groupOverride = normalizeToolOverrides({ widget: true });
        const group = resolveToolAvailability(
            'gemini-4-argon',
            -1001415974153,
            config,
            groupOverride.ok ? groupOverride.value : null
        );
        expect(!group.widget, 'a group chat stays off even when the panel asks for it');
    })
);

results.push(
    await runCase('send_widget description points to load_skill instead of get_ui_guide', async () => {
        const tool = createSendWidgetTool({ state: createReplyMediaState(), limits: LIMITS });
        expect(
            tool.definition.description.includes("load_skill(['widget-a2ui'])") &&
                !tool.definition.description.includes('get_ui_guide'),
            `send_widget directs to load_skill (got ${tool.definition.description})`
        );
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
