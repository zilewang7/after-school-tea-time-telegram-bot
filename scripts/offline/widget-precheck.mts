/**
 * Offline cases for the widget HTML precheck — the server-side gate that runs
 * before any Bot API call (no containers, no network).
 *
 * Telegram itself does not validate the HTML, so this is the only place a
 * widget that is too large or obviously outside the profile fails visibly.
 *
 * Run: npx tsx scripts/offline/widget-precheck.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { precheckWidgetHtml, widgetDeliveryOf } = await import(
    '../../src/telegram/widget-precheck.js'
);

const LIMITS = { allowHtml: false, maxHtmlBytes: 32768, maxGzipBytes: 4096 };

const results: CaseResult[] = [];

results.push(
    await runCase('a compiled A2UI fragment passes the precheck', async () => {
        const result = precheckWidgetHtml('a2ui', '<div class="tw-root">hello</div>', LIMITS);
        expect(result.ok, 'the fragment passes');
        if (result.ok) {
            expect(result.size.rawBytes > 0, 'raw bytes measured');
            expect(result.size.zlibBytes > 0, 'compressed bytes measured');
        }
    })
);

results.push(
    await runCase('HTML mode is refused while WIDGET_ALLOW_HTML is off', async () => {
        const result = precheckWidgetHtml('html', '<div>hi</div>', LIMITS);
        expect(!result.ok, 'the mode is refused');
        if (!result.ok) {
            expect(result.code === 'html-mode-disabled', 'the code names the disabled mode');
            expect(result.message.includes('A2UI'), 'the message points at the A2UI mode');
        }
    })
);

results.push(
    await runCase('an empty widget is refused', async () => {
        const result = precheckWidgetHtml('a2ui', '   \n  ', LIMITS);
        expect(!result.ok && result.code === 'empty-html', 'empty html is refused');
    })
);

results.push(
    await runCase('external resources, form controls and media are refused', async () => {
        const cases = [
            '<script src="https://example.com/x.js"></script>',
            '<input value="x">',
            '<video src="x"></video>',
            '<a href="javascript:alert(1)">x</a>',
            '<style>@import url(https://example.com/x.css);</style>',
        ];
        for (const html of cases) {
            const result = precheckWidgetHtml('html', html, {
                ...LIMITS,
                allowHtml: true,
            });
            expect(!result.ok && result.code === 'forbidden-markup', `refuses ${html.slice(0, 24)}`);
        }
    })
);

results.push(
    await runCase('a widget over the compressed budget is refused with the numbers', async () => {
        const html = `<div>${'内容'.repeat(400)}</div>`;
        const result = precheckWidgetHtml('a2ui', html, {
            allowHtml: false,
            maxHtmlBytes: 32768,
            maxGzipBytes: 1,
        });
        expect(!result.ok && result.code === 'too-large', 'the budget is enforced');
        if (!result.ok) {
            expect(result.message.includes('上限'), 'the message carries the limits');
        }
    })
);

results.push(
    await runCase('the delivery object carries the measured sizes and a usable caption', async () => {
        const delivery = widgetDeliveryOf('a2ui', '<div>hi</div>', '  日报  ', { components: [] });
        expect(delivery.mode === 'a2ui', 'mode kept');
        expect(delivery.caption === '日报', 'caption trimmed');
        expect(delivery.htmlBytes > 0 && delivery.zlibBytes > 0, 'sizes recorded');
        expect(delivery.surface !== undefined, 'surface kept for later turns');

        const noCaption = widgetDeliveryOf('html', '<div>hi</div>', '   ', undefined);
        expect(noCaption.caption === undefined, 'blank caption dropped');
        expect(noCaption.surface === undefined, 'no surface in html mode');
    })
);

reportResults(results);
