/**
 * Offline cases for the pure part of the conversation multi-select mode
 * (design 2026-1119-2016 §4.6): toggling the selected set, select all and
 * clear, splitting the selection into excludable / restorable by each node's
 * current state, one-line summaries cut at the limit, and the 100-id batch
 * limit the UI and the server share.
 *
 * Run: npx tsx scripts/offline/webapp-selection.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { BotNode, MemberUserNode, TreeNode } from '../../webapp/src/api/types.ts';
import {
    MAX_BATCH_MESSAGES,
    SUMMARY_CHARS,
    allSelectedOf,
    emptySelection,
    exceedsBatchLimit,
    selectedCountOf,
    selectionGroupsOf,
    selectionSummaryOf,
    toggleSelected,
} from '../../webapp/src/pages/conversations/conversation-detail/selection-mode.ts';

const DATE = '2026-11-19T10:00:00.000Z';

interface UserNodeFields {
    messageId: number;
    number?: number | null;
    excluded?: boolean;
    deleted?: boolean;
    text?: string | null;
    mediaHint?: string | null;
}

const userNode = (fields: UserNodeFields): MemberUserNode => ({
    kind: 'user',
    redacted: false,
    messageId: fields.messageId,
    number: fields.number ?? null,
    date: DATE,
    parentId: null,
    edge: null,
    author: { userId: 5001, name: 'Alice', username: null },
    text: fields.text ?? null,
    quote: null,
    annotations: [],
    mediaHint: fields.mediaHint ?? null,
    linkPreview: null,
    ocrText: null,
    excluded: fields.excluded ?? false,
    deleted: fields.deleted ?? false,
    replyTo: null,
    media: [],
    previewMedia: [],
    telegramLink: null,
});

interface BotNodeFields {
    messageId: number;
    number?: number | null;
    excluded?: boolean;
    text?: string | null;
}

const botNode = (fields: BotNodeFields): BotNode => ({
    kind: 'bot',
    messageId: fields.messageId,
    number: fields.number ?? null,
    date: DATE,
    parentId: null,
    edge: null,
    excluded: fields.excluded ?? false,
    deleted: false,
    replyTo: null,
    reply: {
        firstMessageId: fields.messageId,
        versionCount: 1,
        currentVersion: 1,
        model: 'gemini-4-argon',
        text: fields.text ?? null,
        thinkingText: null,
        toolSummary: [],
        errorMessage: null,
        wasStoppedByUser: false,
        media: [],
    },
});

const idsOf = (selected: ReadonlySet<number>): number[] => [...selected];

// ---- cases ----------------------------------------------------------------

const results: CaseResult[] = [];

results.push(
    await runCase('tapping a row adds it, tapping it again removes it, and the old set is kept', () => {
        let selected = emptySelection();
        expect(selected.size === 0, 'nothing is selected at first');

        selected = toggleSelected(selected, 11);
        expect(idsOf(selected).join(',') === '11', `one tap selects one row (got ${idsOf(selected).join(',')})`);

        selected = toggleSelected(selected, 12);
        expect(idsOf(selected).join(',') === '11,12', 'a second row adds, in tap order');

        const beforeSecondTap = selected;
        selected = toggleSelected(selected, 11);
        expect(idsOf(selected).join(',') === '12', 'tapping a selected row removes it');
        expect(beforeSecondTap.has(11), 'the set handed to the toggle is not mutated');

        selected = toggleSelected(selected, 12);
        expect(selected.size === 0, 'removing the last row leaves nothing selected');
    })
);

results.push(
    await runCase('select all takes every row of the list; clear empties it', () => {
        const nodes: TreeNode[] = [
            userNode({ messageId: 21 }),
            botNode({ messageId: 22 }),
            userNode({ messageId: 23, excluded: true }),
        ];
        const all = allSelectedOf(nodes);
        expect(all.size === 3, `every row is selected once (got ${all.size})`);
        expect(
            nodes.every((node) => all.has(node.messageId)),
            'a node outside the list is not invented'
        );
        expect(emptySelection().size === 0, 'clear gives an empty set');
    })
);

results.push(
    await runCase("the selection splits by each message's current excluded state, in tree order", () => {
        const nodes: TreeNode[] = [
            userNode({ messageId: 31 }),
            userNode({ messageId: 32, excluded: true }),
            botNode({ messageId: 33 }),
            botNode({ messageId: 34, excluded: true }),
            userNode({ messageId: 35, deleted: true }),
        ];
        const all = allSelectedOf(nodes);
        const groups = selectionGroupsOf(all, nodes);
        expect(
            groups.excludable.join(',') === '31,33,35',
            `not excluded (a deleted one included) can be excluded (got ${groups.excludable.join(',')})`
        );
        expect(groups.restorable.join(',') === '32,34', `already excluded can be restored (got ${groups.restorable.join(',')})`);
        expect(selectedCountOf(groups) === 5, 'the two groups add up to the selection');

        const partial = selectionGroupsOf(new Set([32, 35]), nodes);
        expect(
            partial.excludable.join(',') === '35' && partial.restorable.join(',') === '32',
            'a partial selection splits the same way'
        );
        expect(selectionGroupsOf(emptySelection(), nodes).excludable.length === 0, 'nothing selected: nothing to do');

        // A selected id that left the tree (a refresh) is not submitted
        const stale = selectionGroupsOf(new Set([31, 99]), nodes);
        expect(selectedCountOf(stale) === 1, `a row gone from the tree is dropped (got ${selectedCountOf(stale)})`);
    })
);

results.push(
    await runCase('a summary is one flat line, cut at the character limit', () => {
        expect(SUMMARY_CHARS === 80, `the compact list keeps ~80 characters (got ${SUMMARY_CHARS})`);

        const short = userNode({ messageId: 41, text: '短消息' });
        expect(selectionSummaryOf(short) === '短消息', 'a short text is shown as is');

        const multiline = userNode({ messageId: 42, text: '第一行\n第二行\t带缩进' });
        expect(
            selectionSummaryOf(multiline) === '第一行 第二行 带缩进',
            `newlines and runs of spaces flatten to one line (got ${JSON.stringify(selectionSummaryOf(multiline))})`
        );

        const longText = 'x'.repeat(200);
        const long = userNode({ messageId: 43, text: longText });
        const longSummary = selectionSummaryOf(long) ?? '';
        expect(Array.from(longSummary).length === SUMMARY_CHARS + 1, 'the cut keeps the limit plus the ellipsis');
        expect(longSummary.endsWith('…'), 'a cut summary ends with an ellipsis');
        expect(longSummary.startsWith('x'.repeat(SUMMARY_CHARS)), 'the first characters are kept');

        // Cutting counts code points, so a surrogate pair is never split
        const emoji = userNode({ messageId: 44, text: '😀'.repeat(100) });
        const emojiSummary = selectionSummaryOf(emoji) ?? '';
        expect(
            Array.from(emojiSummary).length === SUMMARY_CHARS + 1 && emojiSummary.startsWith('😀'),
            'an emoji-only text is cut between whole emoji'
        );

        const media = userNode({ messageId: 45, mediaHint: '[图片] 一张图' });
        expect(selectionSummaryOf(media) === '[图片] 一张图', 'a text-less message shows what media it carries');

        const bot = botNode({ messageId: 46, text: '机器人回答的正文' });
        expect(selectionSummaryOf(bot) === '机器人回答的正文', "a bot row shows its reply's text");

        expect(selectionSummaryOf(botNode({ messageId: 47 })) === null, 'a bot row without text has no summary');
        expect(selectionSummaryOf(userNode({ messageId: 48, text: '   ' })) === null, 'a blank text has no summary');
    })
);

results.push(
    await runCase('the batch limit is 100 ids, refused above it', () => {
        expect(MAX_BATCH_MESSAGES === 100, 'the UI and the server share the 100-id limit');
        expect(!exceedsBatchLimit(0), 'an empty selection is under the limit');
        expect(!exceedsBatchLimit(MAX_BATCH_MESSAGES), 'exactly 100 is allowed');
        expect(exceedsBatchLimit(MAX_BATCH_MESSAGES + 1), '101 is over the limit');
    })
);

reportResults(results);
