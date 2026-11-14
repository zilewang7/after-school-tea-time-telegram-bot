/**
 * Offline cases for the Mini App side of the thinking level (design
 * 2026-1113-1742 §5): the closed-set labels, the chips the field shows for each
 * model shape (graded / graded+toggle / toggle-only / no thinking), the current
 * choice summary, the audit texts, and the settings form sending only the keys
 * that changed.
 *
 * Run: npx tsx scripts/offline/webapp-thinking-effort.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ChatSettings, ThinkingEffortView } from '../../webapp/src/api/types.ts';
import { auditKeyLabel, formatAuditValue } from '../../webapp/src/format.ts';
import { changedSettingsOf } from '../../webapp/src/pages/chat-settings/chat-settings-patch.ts';
import {
    THINKING_EFFORT_DEFAULT_LABEL,
    THINKING_EFFORT_LABEL,
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    THINKING_EFFORT_OFF_LABEL,
    THINKING_EFFORT_ORDER,
    THINKING_EFFORT_TRADEOFF_HINT,
    THINKING_EFFORT_UNSUPPORTED_HINT,
    thinkingEffortChipsOf,
    thinkingEffortDefaultLabelOf,
    thinkingEffortIssueOf,
    thinkingEffortLabel,
    thinkingEffortSummaryOf,
    thinkingEffortToggleSupported,
    thinkingEffortUnsupportedOf,
} from '../../webapp/src/thinking-effort.ts';

/** A view with every field, so each case only states what it is about */
const viewOf = (fields: Partial<ThinkingEffortView>): ThinkingEffortView => ({
    value: null,
    source: 'model-default',
    effectiveDefault: null,
    enabledDefault: null,
    toggle: false,
    options: [],
    supported: false,
    ...fields,
});

/** The graded options a model accepts, with the labels the server sends */
const optionsOf = (...values: string[]): { value: string; label: string }[] =>
    values.map((value) => ({ value, label: value.toUpperCase() }));

/** The same settings a chat without its own thinking level has */
const settingsWith = (thinkingEffort: string | null): ChatSettings => ({
    model: null,
    promptAddendum: null,
    paused: false,
    settingsLocked: false,
    toolOverrides: null,
    geminiPriority: null,
    thinkingEffort,
    richReplies: false,
    updatedAt: null,
    updatedBy: null,
});

/** The form's draft with every untouched choice, overridden where a case says so */
const draftWith = (thinkingEffort: string | null) => ({
    model: { ok: true as const, value: null },
    addendumValue: null,
    paused: false,
    settingsLocked: false,
    geminiPriority: null,
    thinkingEffort,
    richReplies: false,
});

const results: CaseResult[] = [];

results.push(
    await runCase('the labels cover the closed set, and an unknown value is shown as it is', () => {
        expect(
            THINKING_EFFORT_ORDER.join(',') === 'none,minimal,low,medium,high,xhigh,max,ultra',
            `closed set order (${THINKING_EFFORT_ORDER.join(',')})`
        );
        const expected: Readonly<Record<string, string>> = {
            none: '无',
            minimal: '极低',
            low: '低',
            medium: '中',
            high: '高',
            xhigh: '极高',
            max: '最大',
            ultra: '极限',
        };
        for (const [value, label] of Object.entries(expected)) {
            expect(thinkingEffortLabel(value) === label, `${value} reads ${label}`);
            expect(THINKING_EFFORT_LABELS[value] === label, `${value} is in the label table`);
        }
        expect(THINKING_EFFORT_LABEL === '思考等级', 'the field label');
        expect(THINKING_EFFORT_DEFAULT_LABEL === '模型默认', 'the null chip reads 模型默认');
        expect(THINKING_EFFORT_OFF_LABEL === '关闭思考', 'the off chip reads 关闭思考');
        expect(THINKING_EFFORT_UNSUPPORTED_HINT === '当前模型不支持思考档位', 'the unsupported hint');
        expect(THINKING_EFFORT_TRADEOFF_HINT.length > 0, 'the tradeoff hint exists');
        expect(thinkingEffortLabel('turbo') === 'turbo', 'an unknown value is not blanked');
    })
);

results.push(
    await runCase('the audit names the key and spells every value', () => {
        expect(auditKeyLabel('thinkingEffort') === '思考等级', "the key reads 思考等级");
        expect(formatAuditValue('thinkingEffort', null) === '模型默认', 'null = the model default');
        expect(formatAuditValue('thinkingEffort', THINKING_EFFORT_OFF) === '关闭思考', 'off = thinking off');
        expect(formatAuditValue('thinkingEffort', 'high') === '高', 'a graded value uses its label');
        expect(formatAuditValue('thinkingEffort', 'xhigh') === '极高', 'xhigh is 极高');
        expect(formatAuditValue('thinkingEffort', 'turbo') === 'turbo', 'an unknown value is shown raw');
        expect(formatAuditValue('model', null) === '跟随全局默认', 'other keys keep their own null text');
    })
);

results.push(
    await runCase('a graded model: the model default then its own efforts, no off chip', () => {
        const view = viewOf({
            effectiveDefault: 'high',
            options: optionsOf('low', 'medium', 'high', 'xhigh'),
            supported: true,
        });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.length === 5, `one chip per effort plus the default (got ${chips.length})`);
        expect(chips[0]?.value === null && chips[0].label === '模型默认（高）', 'the default chip first');
        expect(
            chips.slice(1).map((chip) => chip.value).join(',') === 'low,medium,high,xhigh',
            `the server order is kept (${chips.slice(1).map((chip) => chip.value).join(',')})`
        );
        expect(
            chips.slice(1).map((chip) => chip.label).join(',') === '低,中,高,极高',
            'the page labels, not the server labels'
        );
        expect(chips.every((chip) => !chip.disabled), 'every chip is selectable while the model supports them');
        expect(!thinkingEffortToggleSupported(view), 'a graded-only model has no off chip');
        expect(!thinkingEffortUnsupportedOf(view), 'the model is not unsupported');
        expect(thinkingEffortIssueOf(view) === null, 'nothing is wrong with an unset choice');
        expect(thinkingEffortSummaryOf(view) === '模型默认（高）', 'the summary names the vendor default');
    })
);

results.push(
    await runCase('a graded model with a toggle: the off chip comes last', () => {
        const view = viewOf({
            effectiveDefault: 'high',
            enabledDefault: true,
            toggle: true,
            options: optionsOf('low', 'high', 'max'),
            supported: true,
        });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.length === 5, `three efforts, the default and off (got ${chips.length})`);
        expect(chips.at(-1)?.value === THINKING_EFFORT_OFF, 'off is the last chip');
        expect(chips.at(-1)?.label === '关闭思考' && chips.at(-1)?.disabled === false, 'off is selectable');
        expect(thinkingEffortToggleSupported(view), 'the toggle is offered');
        expect(thinkingEffortIssueOf(viewOf({ ...view, value: 'off', source: 'chat' })) === null, 'off applies');
        expect(
            thinkingEffortSummaryOf(viewOf({ ...view, value: 'off', source: 'chat' })) === '关闭思考（本聊天设置）',
            'the summary says where off comes from'
        );
        expect(
            thinkingEffortSummaryOf(viewOf({ ...view, value: 'high', source: 'chat' })) === '高（本聊天设置）',
            'the summary says where a graded choice comes from'
        );
    })
);

results.push(
    await runCase('a toggle-only model: the default and off, nothing to grade', () => {
        const view = viewOf({ enabledDefault: true, toggle: true });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.length === 2, `the default and off (got ${chips.length})`);
        expect(chips[0]?.label === '模型默认（思考开）', `the default shows the vendor on (${chips[0]?.label})`);
        expect(chips[1]?.value === THINKING_EFFORT_OFF && !chips[1].disabled, 'off is offered');
        expect(!thinkingEffortUnsupportedOf(view), 'a toggle-only model is not unsupported');
        expect(thinkingEffortIssueOf(view) === null, 'the default is fine');
        expect(thinkingEffortIssueOf(viewOf({ ...view, value: 'off', source: 'chat' })) === null, 'off applies');
        // A graded value from a previous model does not apply, and stays visible to be cleared
        const stored = thinkingEffortChipsOf(viewOf({ ...view, value: 'high', source: 'chat' }));
        expect(stored.length === 3, 'the stored graded value gets a chip too');
        expect(
            stored[2]?.value === 'high' && stored[2].label === '高（当前模型不支持）' && stored[2].disabled,
            `the stored value is shown but not selectable (${stored[2]?.label})`
        );
        expect(
            thinkingEffortIssueOf(viewOf({ ...view, value: 'high', source: 'chat' })) === '当前模型不支持「高」',
            'the warning names the value'
        );
        expect(
            thinkingEffortDefaultLabelOf(viewOf({ enabledDefault: false, toggle: true })) === '模型默认（思考关）',
            'a toggle model defaulting off says so'
        );
    })
);

results.push(
    await runCase('a toggle model with an unknown vendor default still offers off', () => {
        // reasoning.toggle = true, reasoning.defaultEnabled = null: the switch exists, its default is unknown
        const view = viewOf({ toggle: true });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.length === 2, `the default and off (got ${chips.length})`);
        expect(
            chips[0]?.label === '模型默认（由模型决定）',
            `the default says the model decides (${chips[0]?.label})`
        );
        expect(chips[1]?.value === THINKING_EFFORT_OFF && !chips[1].disabled, 'off is offered and selectable');
        expect(thinkingEffortToggleSupported(view), 'the toggle is offered');
        expect(!thinkingEffortUnsupportedOf(view), 'a toggle model is not unsupported');
        expect(thinkingEffortIssueOf(view) === null, 'the default never warns');
    })
);

results.push(
    await runCase('the toggle flag, not enabledDefault, decides whether off is offered', () => {
        // A vendor default without a toggle is not a switch the model lets the chat move
        const view = viewOf({ enabledDefault: true });
        expect(!thinkingEffortToggleSupported(view), 'no toggle');
        expect(
            thinkingEffortChipsOf(view).every((chip) => chip.value !== THINKING_EFFORT_OFF),
            'no off chip despite a vendor default'
        );
        expect(thinkingEffortDefaultLabelOf(view) === '模型默认', 'the vendor default is not read without a toggle');
        expect(thinkingEffortUnsupportedOf(view), 'a graded-less model without a toggle is unsupported');
        expect(
            thinkingEffortIssueOf(viewOf({ ...view, value: 'off', source: 'chat' })) === '当前模型不支持关闭思考',
            'a stored off warns'
        );
    })
);

results.push(
    await runCase('a stored off is selected and summarised where the model can switch thinking off', () => {
        const view = viewOf({ toggle: true, enabledDefault: false, value: 'off', source: 'chat' });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.some((chip) => chip.value === THINKING_EFFORT_OFF), 'the off chip is shown');
        expect(
            chips.filter((chip) => chip.value === THINKING_EFFORT_OFF).length === 1,
            'exactly one off chip, not a second stored-value chip'
        );
        expect(
            thinkingEffortSummaryOf(view) === '关闭思考（本聊天设置）',
            `the summary says where off comes from (${thinkingEffortSummaryOf(view)})`
        );
        expect(thinkingEffortIssueOf(view) === null, 'off applies');
        expect(thinkingEffortDefaultLabelOf(view) === '模型默认（思考关）', 'the model default is the vendor off');
    })
);

results.push(
    await runCase('a model without thinking: the default only, with the unsupported hint', () => {
        const view = viewOf({});
        expect(thinkingEffortChipsOf(view).length === 1, 'only the model default is offered');
        expect(thinkingEffortChipsOf(view)[0]?.label === '模型默认', 'the default has no vendor value to name');
        expect(thinkingEffortUnsupportedOf(view), 'the page says the model does not support levels');
        expect(thinkingEffortToggleSupported(view) === false, 'there is no toggle');
        expect(thinkingEffortIssueOf(view) === null, 'the default never warns');
        const storedOff = thinkingEffortChipsOf(viewOf({ value: 'off', source: 'chat' }));
        expect(
            storedOff.at(-1)?.value === THINKING_EFFORT_OFF && storedOff.at(-1)?.disabled === true,
            'a stored off is shown, not selectable'
        );
        expect(
            thinkingEffortIssueOf(viewOf({ value: 'off', source: 'chat' })) === '当前模型不支持关闭思考',
            'the warning for a stored off'
        );
        expect(
            thinkingEffortIssueOf(viewOf({ value: 'xhigh', source: 'chat' })) === '当前模型不支持「极高」',
            'the warning for a stored grade'
        );
    })
);

results.push(
    await runCase('a stored effort the current model dropped stays visible and warns', () => {
        // hydrogen at xhigh, then the chat switched to argon
        const view = viewOf({
            value: 'xhigh',
            source: 'chat',
            effectiveDefault: 'medium',
            options: optionsOf('low', 'medium', 'high'),
            supported: true,
        });
        const chips = thinkingEffortChipsOf(view);
        expect(chips.length === 5, `default, three efforts and the stored value (got ${chips.length})`);
        expect(chips[0]?.label === '模型默认（中）', 'the default names the new vendor default');
        expect(
            chips.at(-1)?.value === 'xhigh' && chips.at(-1)?.label === '极高（当前模型不支持）',
            `the stored value is last and marked (${chips.at(-1)?.label})`
        );
        expect(chips.at(-1)?.disabled === true, 'the dropped value cannot be re-picked');
        expect(thinkingEffortIssueOf(view) === '当前模型不支持「极高」', 'the warning names the stored value');
        expect(thinkingEffortSummaryOf(view) === '极高（本聊天设置）', 'the summary still shows the stored value');
    })
);

results.push(
    await runCase('a server label never overrides the page label', () => {
        const view = viewOf({ options: [{ value: 'medium', label: 'MEDIUM' }], supported: true });
        const chip = thinkingEffortChipsOf(view)[1];
        expect(chip?.label === '中', `the page's own label wins (${chip?.label})`);
    })
);

results.push(
    await runCase('the form sends only the changed keys, an explicit null included', () => {
        const settings = settingsWith('high');
        expect(
            JSON.stringify(changedSettingsOf(settings, draftWith('high'))) === '{}',
            'an untouched level sends nothing'
        );
        const backToDefault = changedSettingsOf(settings, draftWith(null));
        expect(
            'thinkingEffort' in backToDefault && backToDefault.thinkingEffort === null,
            'back to the model default sends an explicit null'
        );
        expect(
            JSON.stringify(backToDefault) === '{"thinkingEffort":null}',
            `nothing else rides along (${JSON.stringify(backToDefault)})`
        );
        expect(changedSettingsOf(settingsWith(null), draftWith('off')).thinkingEffort === 'off', 'off is sent as off');
        const otherKey = changedSettingsOf(settings, { ...draftWith('high'), paused: true });
        expect(
            JSON.stringify(otherKey) === '{"paused":true}',
            `another key changed: the level stays out (${JSON.stringify(otherKey)})`
        );
        const unset = changedSettingsOf(settingsWith(null), draftWith('xhigh'));
        expect(unset.thinkingEffort === 'xhigh', 'a level picked from the model default is sent');
    })
);

reportResults(results);
