/**
 * Offline cases for the on-demand widget guides returned by get_ui_guide.
 *
 * The guides are part of the model-facing contract: they must stay non-empty,
 * inside their size budget, cover the hard Telegram widget constraints, and
 * (for A2UI) match the compiler's tg-card-v1 catalog. No DB, no network.
 *
 * Run: npx tsx scripts/offline/widget-guides.mts
 */
import { A2UI_COMPONENT_NAMES } from '../../src/ai/widget/a2ui/catalog.js';
import { getWidgetGuide, WIDGET_GUIDE_VERSION } from '../../src/ai/widget/guides/index.js';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

/**
 * Character budgets: the HTML guide is a condensed version of the official
 * agent block (about 19 K characters); A2UI is the smaller catalog reference.
 * A change outside these ranges means the text was cut or bloat crept in.
 */
const HTML_GUIDE_MIN_CHARS = 8192;
const HTML_GUIDE_MAX_CHARS = 16384;
const A2UI_GUIDE_MIN_CHARS = 4096;
const A2UI_GUIDE_MAX_CHARS = 12000;

/** A2UI primitives the compiler rejects; the guide lists each with a workaround. */
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

const cases: CaseResult[] = [];

cases.push(
    await runCase('the html guide is present, well-formed and inside its size budget', async () => {
        const guide = getWidgetGuide('html');
        expect(guide.kind === 'html', 'kind is html');
        expect(guide.version === 3, 'version is 3');
        expect(guide.version === WIDGET_GUIDE_VERSION, 'version matches WIDGET_GUIDE_VERSION');
        expect(guide.title.trim().length > 0, 'title is non-empty');
        expect(guide.title.includes('HTML'), 'title names the HTML mode');
        expect(guide.text.trim().length > 0, 'text is non-empty');
        expect(guide.text.length >= HTML_GUIDE_MIN_CHARS, `text is at least ${HTML_GUIDE_MIN_CHARS} chars`);
        expect(guide.text.length <= HTML_GUIDE_MAX_CHARS, `text is at most ${HTML_GUIDE_MAX_CHARS} chars`);
        expect(!guide.text.includes('\r'), 'text has no carriage returns');
        expect(!guide.text.includes('${'), 'text has no unresolved template holes');
        expect(Object.isFrozen(guide), 'guide is frozen (version-fixed read-only snapshot)');
    })
);

cases.push(
    await runCase('the html guide states the Telegram widget hard limits', async () => {
        const { text } = getWidgetGuide('html');
        expectIncludes(text, [
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
    await runCase('the html guide covers the profile allow and deny lists', async () => {
        const { text } = getWidgetGuide('html');
        expectIncludes(text, [
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
    await runCase('the html guide states zero network, no external resources and the Phase 0 scope', async () => {
        const { text } = getWidgetGuide('html');
        expectIncludes(text, [
            '零网络',
            'NetworkDisabledError',
            '外链',
            '<script src>',
            'send_widget(mode=\'html\'',
            'Phase 0',
            'TelegramMessenger/widget-sandbox',
            '快照',
        ]);
    })
);

cases.push(
    await runCase('the html guide splits bot roundtrip from local interaction (issue #6)', async () => {
        const { text } = getWidgetGuide('html');
        // The v1 text said "JS and taps work" in the profile list and "output zero
        // JS, clicks do nothing" in the Phase 0 notes; the model burned minutes
        // between the two. v2 states the boundary explicitly.
        expectIncludes(text, [
            '本地交互',
            '不经过 bot',
            '纯客户端本地交互',
            'request()',
            'chatData',
            'click',
            'localStorage',
            'touch-action:none',
        ]);
        expect(!text.includes('输出零 JS、零交互'), 'the blanket zero-JS conclusion is gone');
        expect(!text.includes('点击不会发生任何事'), 'clicks are no longer described as dead');
    })
);

cases.push(
    await runCase('the html guide carries a complete self-contained example with the common patterns', async () => {
        const { text } = getWidgetGuide('html');
        expectIncludes(text, [
            '最小完整示例',
            '<style>',
            '</style>',
            'var(--tg-theme-',
            'class="card"',
            '<details><summary>',
        ]);
        // The example is validated with the official widget-sandbox harness; its
        // measured size is quoted so the model can calibrate its own output.
        expect(text.includes('zlib9 761 B'), 'example states its measured zlib9 size');
    })
);

cases.push(
    await runCase('the a2ui guide is present, well-formed and inside its size budget', async () => {
        const guide = getWidgetGuide('a2ui');
        expect(guide.kind === 'a2ui', 'kind is a2ui');
        expect(guide.version === 3, 'version is 3');
        expect(guide.version === WIDGET_GUIDE_VERSION, 'version matches WIDGET_GUIDE_VERSION');
        expect(guide.title.trim().length > 0, 'title is non-empty');
        expect(guide.title.includes('A2UI'), 'title names the A2UI mode');
        expect(guide.text.trim().length > 0, 'text is non-empty');
        expect(guide.text.length >= A2UI_GUIDE_MIN_CHARS, `text is at least ${A2UI_GUIDE_MIN_CHARS} chars`);
        expect(guide.text.length <= A2UI_GUIDE_MAX_CHARS, `text is at most ${A2UI_GUIDE_MAX_CHARS} chars`);
        expect(!guide.text.includes('\r'), 'text has no carriage returns');
        expect(!guide.text.includes('${'), 'text has no unresolved template holes');
        // The tool-argument example must show a JSON string with escaped inner
        // quotes; a template literal renders `\"` as `"`, which made v2's
        // example invalid JSON (the model then copied the broken form).
        const escapedQuote = String.fromCharCode(92) + '"';
        expect(guide.text.includes(`${escapedQuote}components${escapedQuote}`), 'the JSON-string example escapes its inner quotes');
        expect(!guide.text.includes('"{"components"'), 'the broken unescaped example is gone');
        expect(Object.isFrozen(guide), 'guide is frozen (version-fixed read-only snapshot)');
    })
);

cases.push(
    await runCase('the a2ui guide matches the compiler catalog tg-card-v1', async () => {
        const { text } = getWidgetGuide('a2ui');
        expectIncludes(text, ['tg-card-v1', 'send_widget(mode=\'a2ui\'', 'createSurface', 'components', 'dataModel', '@path']);
        for (const component of A2UI_COMPONENT_NAMES) {
            expect(text.includes(component), `lists supported component ${component}`);
        }
        for (const rejected of A2UI_REJECTED_NAMES) {
            expect(text.includes(rejected), `lists rejected component ${rejected}`);
        }
    })
);

cases.push(
    await runCase('the a2ui guide states the binding rules, size budget and error codes', async () => {
        const { text } = getWidgetGuide('a2ui');
        expectIncludes(text, [
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
        const { text } = getWidgetGuide('a2ui');
        // The two full examples are minified JSON objects in the guide text.
        const jsonBlocks = [...text.matchAll(/```json\n(\{.*?\})\n```/gs)]
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
    await runCase('both guides are distinct documents that share the version constant', async () => {
        const html = getWidgetGuide('html');
        const a2ui = getWidgetGuide('a2ui');
        expect(html.text !== a2ui.text, 'the two texts differ');
        expect(html.kind !== a2ui.kind, 'the kinds differ');
        expect(html.version === a2ui.version, 'both guides share one version');
        expect(html.version === WIDGET_GUIDE_VERSION && WIDGET_GUIDE_VERSION === 3, 'the shared version is 3');
        expect(getWidgetGuide('html') === html, 'lookups are stable for html');
        expect(getWidgetGuide('a2ui') === a2ui, 'lookups are stable for a2ui');
    })
);

reportResults(cases);
