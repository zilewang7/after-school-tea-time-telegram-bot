/**
 * Offline cases for the conversation tree's edge labels: a /chat link and a
 * reply target are not replies, and the row head must say so instead of
 * letting the indentation imply a reply (docs 2026-1119-2016 §13).
 *
 * Run: npx tsx scripts/offline/webapp-tree-edge-labels.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { treeEdgeLabelOf } from '../../webapp/src/pages/conversations/conversation-detail/tree-edge-label.ts';

const results: CaseResult[] = [];

results.push(
    await runCase('a reply keeps the reply hint and has no badge', async () => {
        const label = treeEdgeLabelOf('reply', 12);
        expect(label.hint === '↳ 回复 #12', `the reply hint (got ${JSON.stringify(label.hint)})`);
        expect(label.badge === null, `no badge for the default edge (got ${JSON.stringify(label.badge)})`);
    })
);

results.push(
    await runCase('a /chat link says it was spliced in', async () => {
        const label = treeEdgeLabelOf('link', 7);
        expect(label.hint === '↳ 拼接自 #7', `the splice hint (got ${JSON.stringify(label.hint)})`);
        expect(label.badge === '拼接', `the splice badge (got ${JSON.stringify(label.badge)})`);
    })
);

results.push(
    await runCase('a reply target says it is replied to, not replying', async () => {
        const label = treeEdgeLabelOf('reply-target', 7);
        expect(label.hint === '↳ 被 #7 回复', `the reply-target hint (got ${JSON.stringify(label.hint)})`);
        expect(label.badge === '被回复', `the reply-target badge (got ${JSON.stringify(label.badge)})`);
    })
);

results.push(
    await runCase('a root row has neither hint nor badge', async () => {
        const label = treeEdgeLabelOf(null, null);
        expect(label.hint === null && label.badge === null, `nothing on a root (got ${JSON.stringify(label)})`);
    })
);

results.push(
    await runCase('a shallow non-reply row still carries its badge', async () => {
        // No parent number at shallow depth: the badge alone tells the edge apart
        const link = treeEdgeLabelOf('link', null);
        expect(link.hint === null && link.badge === '拼接', `the shallow link badge (got ${JSON.stringify(link)})`);
        const target = treeEdgeLabelOf('reply-target', null);
        expect(
            target.hint === null && target.badge === '被回复',
            `the shallow reply-target badge (got ${JSON.stringify(target)})`
        );
    })
);

results.push(
    await runCase('a row without an edge keeps the reply wording of the deep hint', async () => {
        const label = treeEdgeLabelOf(null, 3);
        expect(label.hint === '↳ 回复 #3' && label.badge === null, `the fallback (got ${JSON.stringify(label)})`);
    })
);

reportResults(results);
