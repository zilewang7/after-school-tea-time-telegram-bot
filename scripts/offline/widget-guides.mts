/**
 * Offline cases for the on-demand widget specifications in skills/widget-a2ui
 * and skills/widget-html, loaded via load_skill (migrated from get_ui_guide).
 *
 * The specs are part of the model-facing contract: they must stay non-empty,
 * inside their size budget, cover the hard Telegram widget constraints, match
 * WIDGET_GUIDE_VERSION, and (for A2UI) match the compiler's tg-card-v1 catalog.
 * No DB, no network.
 *
 * Run: npx tsx scripts/offline/widget-guides.mts
 */
import { A2UI_COMPONENT_NAMES } from '../../src/ai/widget/a2ui/catalog.js';
import { WIDGET_GUIDE_VERSION } from '../../src/ai/widget/guides/index.js';
import {
    getSkillRegistry,
    SKILL_MAX_BODY_CHARS,
    SKILL_MAX_BODY_LINES,
    WIDGET_ALLOW_HTML_FLAG,
    type SkillEntry,
} from '../../src/reply/skills/skill-registry.js';
import { createLoadSkillTool, createSkillToolState } from '../../src/reply/tools/load-skill-tool.js';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

/**
 * Character budgets: the HTML spec is a condensed version of the official
 * agent block (about 15.5 K characters); A2UI is the smaller catalog reference.
 * A change outside these ranges means the text was cut or bloat crept in.
 */
const HTML_GUIDE_MIN_CHARS = 8192;
const HTML_GUIDE_MAX_CHARS = 16384;
const A2UI_GUIDE_MIN_CHARS = 4096;
const A2UI_GUIDE_MAX_CHARS = 12000;

/** A2UI primitives the compiler rejects; the spec lists each with a workaround. */
const A2UI_REJECTED_NAMES = [
    'TextField',
    'CheckBox',
    'Slider',
    'DateTimeInput',
    'ChoicePicker',
    'Image',
    'Video',
    'AudioPlayer',
    'Modal',
    'Tabs',
];

const expectIncludes = (text: string, needles: readonly string[]): void => {
    for (const needle of needles) expect(text.includes(needle), `mentions "${needle}"`);
};

const skillOf = (name: 'widget-a2ui' | 'widget-html'): SkillEntry => {
    const entry = getSkillRegistry().find((skill) => skill.name === name);
    if (entry === undefined) throw new Error(`missing built-in skill ${name}`);
    return entry;
};

const loadViaTool = async (name: 'widget-a2ui' | 'widget-html'): Promise<string> => {
    const tool = createLoadSkillTool({
        state: createSkillToolState(),
        availableSkills: getSkillRegistry(),
    });
    const result = await tool.execute({ names: [name] }, new AbortController().signal);
    expect(!result.isError, `load_skill(['${name}']) succeeds`);
    return result.content;
};

const cases: CaseResult[] = [];

cases.push(
    await runCase('the widget-html skill is present, well-formed, gated, and inside its size budget', async () => {
        const entry = skillOf('widget-html');
        expect(entry.version === String(WIDGET_GUIDE_VERSION), 'version matches WIDGET_GUIDE_VERSION');
        expect(entry.version === '4', 'version is 4');
        expect(entry.requiredTools.join(',') === 'send_widget', 'gated on send_widget');
        expect(entry.requiredFlags.join(',') === WIDGET_ALLOW_HTML_FLAG, 'gated on widget-allow-html flag');
        expect(entry.body.trim().length > 0, 'body is non-empty');
        expect(entry.body.length >= HTML_GUIDE_MIN_CHARS, `body is at least ${HTML_GUIDE_MIN_CHARS} chars`);
        expect(entry.body.length <= HTML_GUIDE_MAX_CHARS, `body is at most ${HTML_GUIDE_MAX_CHARS} chars`);
        expect(Array.from(entry.body).length <= SKILL_MAX_BODY_CHARS, `within ${SKILL_MAX_BODY_CHARS} code points`);
        expect(entry.body.split('\n').length <= SKILL_MAX_BODY_LINES, `within ${SKILL_MAX_BODY_LINES} lines`);
        expect(!entry.body.includes('\r'), 'body has no carriage returns');
        expect(!entry.body.includes('${'), 'body has no unresolved template holes');
        expect(!entry.body.includes('get_ui_guide'), 'no stale get_ui_guide reference');
        expect(!entry.body.includes('workspace_preview'), 'no stale workspace_preview reference');
        expect(entry.body.includes('workspace(action="preview")') || entry.body.includes('workspace(action='), 'uses merged workspace action wording');

        const loaded = await loadViaTool('widget-html');
        expect(loaded.includes('HTML 模式规范'), 'load_skill returns the HTML specification');
    })
);

cases.push(
    await runCase('the widget-html skill states the Telegram widget hard limits', async () => {
        const { body } = skillOf('widget-html');
        expectIncludes(body, [
            '32768',
            '4096',
            'zlib',
            'INPUT_MEDIA_WIDGET_TOO_LARGE',
            '200–600',
            '600 px',
            '没有滚动',
            'overflow:auto/scroll',
            'position:sticky',
            'vh',
            'env(safe-area-inset-bottom)',
        ]);
    })
);

cases.push(
    await runCase('the widget-html skill covers the profile allow and deny lists', async () => {
        const { body } = skillOf('widget-html');
        expectIncludes(body, [
            '--tg-theme-',
            '--tg-color-scheme',
            'system-ui',
            'details',
            'summary',
            'table',
            'svg',
            'button',
            'canvas',
            'data:',
            'user-select:text',
            'input',
            '没有键盘',
            '没有 touchstart',
            'text-shadow',
            '@font-face',
            'flex',
            'grid',
        ]);
    })
);

cases.push(
    await runCase('the widget-html skill states zero network, no external resources and the Phase 0 scope', async () => {
        const { body } = skillOf('widget-html');
        expectIncludes(body, [
            '零网络',
            'NetworkDisabledError',
            '外链',
            '<script src>',
            "send_widget(mode='html'",
            'Phase 0',
            'TelegramMessenger/widget-sandbox',
            '快照',
        ]);
    })
);

cases.push(
    await runCase('the widget-html skill splits bot roundtrip from local interaction (issue #6)', async () => {
        const { body } = skillOf('widget-html');
        // The v1 text said "JS and taps work" in the profile list and "output zero
        // JS, clicks do nothing" in the Phase 0 notes; the model burned minutes
        // between the two. v2 states the boundary explicitly.
        expectIncludes(body, [
            '本地交互',
            '不经过 bot',
            '纯客户端本地交互',
            'request()',
            'chatData',
            'click',
            'localStorage',
            'touch-action:none',
        ]);
        expect(!body.includes('输出零 JS、零交互'), 'the blanket zero-JS conclusion is gone');
        expect(!body.includes('点击不会发生任何事'), 'clicks are no longer described as dead');
    })
);

cases.push(
    await runCase('the widget-html skill carries a complete self-contained example with the common patterns', async () => {
        const { body } = skillOf('widget-html');
        expectIncludes(body, [
            '最小完整示例',
            '<style>',
            '</style>',
            'var(--tg-theme-',
            'class="card"',
            '<details><summary>',
        ]);
        // The example is validated with the official widget-sandbox harness; its
        // measured size is quoted so the model can calibrate its own output.
        expect(body.includes('zlib9 761 B'), 'example states its measured zlib9 size');
    })
);

cases.push(
    await runCase('the widget-a2ui skill is present, well-formed, gated, and inside its size budget', async () => {
        const entry = skillOf('widget-a2ui');
        expect(entry.version === String(WIDGET_GUIDE_VERSION), 'version matches WIDGET_GUIDE_VERSION');
        expect(entry.version === '4', 'version is 4');
        expect(entry.requiredTools.join(',') === 'send_widget', 'gated on send_widget');
        expect(entry.requiredFlags.length === 0, 'no extra flag gate for A2UI');
        expect(entry.body.trim().length > 0, 'body is non-empty');
        expect(entry.body.length >= A2UI_GUIDE_MIN_CHARS, `body is at least ${A2UI_GUIDE_MIN_CHARS} chars`);
        expect(entry.body.length <= A2UI_GUIDE_MAX_CHARS, `body is at most ${A2UI_GUIDE_MAX_CHARS} chars`);
        expect(Array.from(entry.body).length <= SKILL_MAX_BODY_CHARS, `within ${SKILL_MAX_BODY_CHARS} code points`);
        expect(entry.body.split('\n').length <= SKILL_MAX_BODY_LINES, `within ${SKILL_MAX_BODY_LINES} lines`);
        expect(!entry.body.includes('\r'), 'body has no carriage returns');
        expect(!entry.body.includes('${'), 'body has no unresolved template holes');
        expect(!entry.body.includes('get_ui_guide'), 'no stale get_ui_guide reference');
        expect(!entry.body.includes('workspace_preview'), 'no stale workspace_preview reference');
        // The tool-argument example must show a JSON string with escaped inner
        // quotes; a template literal renders `\"` as `"`, which made v2's
        // example invalid JSON (the model then copied the broken form).
        const escapedQuote = String.fromCharCode(92) + '"';
        expect(entry.body.includes(`${escapedQuote}components${escapedQuote}`), 'the JSON-string example escapes its inner quotes');
        expect(!entry.body.includes('"{"components"'), 'the broken unescaped example is gone');

        const loaded = await loadViaTool('widget-a2ui');
        expect(loaded.includes('tg-card-v1'), 'load_skill returns the A2UI specification');
    })
);

cases.push(
    await runCase('the widget-a2ui skill matches the compiler catalog tg-card-v1', async () => {
        const { body } = skillOf('widget-a2ui');
        expectIncludes(body, ['tg-card-v1', "send_widget(mode='a2ui'", 'createSurface', 'components', 'dataModel', '@path']);
        for (const component of A2UI_COMPONENT_NAMES) {
            expect(body.includes(component), `lists supported component ${component}`);
        }
        for (const rejected of A2UI_REJECTED_NAMES) {
            expect(body.includes(rejected), `lists rejected component ${rejected}`);
        }
    })
);

cases.push(
    await runCase('the widget-a2ui skill states the binding rules, size budget and error codes', async () => {
        const { body } = skillOf('widget-a2ui');
        expectIncludes(body, [
            '"version":"1.0"',
            'invalid-input',
            'invalid-json',
            'invalid-surface',
            'unsupported-component',
            'invalid-binding',
            'too-large',
            '32768',
            '4096',
            'zlib9',
            'Phase 0',
            'TelegramMessenger/widget-sandbox',
        ]);
    })
);

cases.push(
    await runCase('the A2UI examples pass the real compiler', async () => {
        const { body } = skillOf('widget-a2ui');
        // The two full examples are minified JSON objects in the skill text.
        const jsonBlocks = [...body.matchAll(/```json\n(\{.*?\})\n```/gs)]
            .map((match) => match[1] ?? '')
            .filter((block) => block.includes('"components"'));
        expect(jsonBlocks.length >= 2, 'at least two full surface examples are fenced');
        const { compileA2uiSurface } = await import('../../src/ai/widget/a2ui/compile.js');
        for (const block of jsonBlocks) {
            const result = compileA2uiSurface(block);
            expect(result.ok, `example compiles (${result.ok ? 'ok' : result.code})`);
            if (result.ok) expect(result.size.zlibBytes <= 4096, `example fits the 4096 B zlib9 limit`);
        }
    })
);

cases.push(
    await runCase('both widget skills are distinct documents that share the version constant', async () => {
        const html = skillOf('widget-html');
        const a2ui = skillOf('widget-a2ui');
        expect(html.body !== a2ui.body, 'the two texts differ');
        expect(html.name !== a2ui.name, 'the names differ');
        expect(html.version === a2ui.version, 'both skills share one version');
        expect(html.version === String(WIDGET_GUIDE_VERSION) && WIDGET_GUIDE_VERSION === 4, 'the shared version is 4');
    })
);

reportResults(cases);
