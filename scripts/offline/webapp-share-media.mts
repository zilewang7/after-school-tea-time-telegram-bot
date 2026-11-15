/**
 * Offline cases for the Mini App side of v5 multi-picture replies: the page's
 * view types must accept what the server sends (a list of pictures, each with
 * its own position), and the share media URL must name that position.
 *
 * The type assertions are compile-time facts: the `Assignable` values below
 * fail `pnpm typecheck scripts-dom` when a server view stops fitting the page
 * type (for example a page still expecting one attachment object).
 *
 * Run: npx tsx scripts/offline/webapp-share-media.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type {
    PublicShareBubbleView,
    PublicShareMediaItemView,
    PublicShareReplyView,
} from '../../src/panel/share/public-api.js';
import type { ReplySummaryView, ReplyVersionView } from '../../src/panel/views/reply-view.js';
import type { MediaAttachment, PublicShareBubble, PublicShareMediaItem, PublicShareReply, ReplySummary, ReplyVersion } from '../../webapp/src/api/types.ts';
import { shareMediaUrlOf } from '../../webapp/src/share/share-asset-urls.ts';

/** Compile-time only: is every server view field acceptable to the page? */
type Assignable<From, To> = [From] extends [To] ? true : false;

/**
 * `true` only when the page can take the server's shape unchanged. A page that
 * still expects `media: MediaAttachment | null` makes the matching value fail
 * the typecheck, which is the point.
 */
const SERVER_VIEWS_FIT_PAGE_TYPES: {
    summary: Assignable<ReplySummaryView, ReplySummary>;
    /** The version view's other fields differ in older ways; its media list is the v5 contract */
    versionMedia: Assignable<ReplyVersionView['media'], ReplyVersion['media']>;
    replyShare: Assignable<PublicShareReplyView, PublicShareReply>;
    bubble: Assignable<PublicShareBubbleView, PublicShareBubble>;
    mediaItem: Assignable<PublicShareMediaItemView, PublicShareMediaItem>;
} = {
    summary: true,
    versionMedia: true,
    replyShare: true,
    bubble: true,
    mediaItem: true,
};

const results: CaseResult[] = [];

results.push(
    await runCase('the page types accept every server view of a reply and a share', () => {
        expect(SERVER_VIEWS_FIT_PAGE_TYPES.summary, 'the tree summary view fits the page');
        expect(SERVER_VIEWS_FIT_PAGE_TYPES.versionMedia, "the reply version's media list fits the page");
        expect(SERVER_VIEWS_FIT_PAGE_TYPES.replyShare, 'the reply share view fits the page');
        expect(SERVER_VIEWS_FIT_PAGE_TYPES.bubble, 'a share bubble view fits the page');
        expect(SERVER_VIEWS_FIT_PAGE_TYPES.mediaItem, 'a share attachment view fits the page');
    })
);

results.push(
    await runCase('a share media URL names a picture position only when it has one', () => {
        expect(shareMediaUrlOf('tok', 7, 'image') === '/s/tok/media/7/image', 'no index points at the first picture');
        expect(shareMediaUrlOf('tok', 7, 'image', 2) === '/s/tok/media/7/image?i=2', 'a later picture carries its index');
        expect(shareMediaUrlOf('tok', 7, 'file', 1) === '/s/tok/media/7/file?i=1', 'the index applies to every slot');
        expect(shareMediaUrlOf('tok', 7, 'preview', 1) === '/s/tok/media/7/preview?i=1', 'a preview names its position');
        expect(shareMediaUrlOf('a/b tok', 7, 'image') === '/s/a%2Fb%20tok/media/7/image', 'the token is URL-encoded');
    })
);

results.push(
    await runCase('the page builds one URL per picture of a bubble', () => {
        const items: PublicShareMediaItem[] = [
            { messageId: 9, kind: 'image', mimeType: 'image/png', sizeBytes: 3, fileName: null },
            { messageId: 9, kind: 'image', mimeType: 'image/png', sizeBytes: 3, fileName: null, index: 1 },
        ];
        const urls = items.map((item) =>
            shareMediaUrlOf('tok', item.messageId, item.kind === 'file' ? 'file' : 'image', item.index)
        );
        expect(urls[0] === '/s/tok/media/9/image', `the first picture (got ${urls[0] ?? ''})`);
        expect(urls[1] === '/s/tok/media/9/image?i=1', `the second picture (got ${urls[1] ?? ''})`);
        expect(items.every((item) => item.messageId === 9), 'both pictures belong to the reply message');
    })
);

results.push(
    await runCase('the page renders a list of attachments, not one', () => {
        const attachments: MediaAttachment[] = [
            { kind: 'image', mimeType: 'image/png', sizeBytes: 10, fileName: null, url: '/m/one' },
            { kind: 'image', mimeType: 'image/png', sizeBytes: 20, fileName: null, url: '/m/two' },
        ];
        expect(attachments.length === 2, 'two pictures in one version');
        expect(new Set(attachments.map((attachment) => attachment.url)).size === 2, 'each has its own URL');
    })
);

reportResults(results);
