/**
 * The issue panel (design §6.7):
 * - GET /api/issues?status=&kind=&severity=&source=&chatId=&q=&limit=&offset=
 *   → `{ issues, matched, nextOffset, stats }`, only the issues the requester
 *   may see, open first then newest first; `stats` counts the same scope.
 * - GET /api/issues/:id → `{ issue }`; not visible reads as missing (404).
 * - PATCH /api/issues/:id `{ status?, note? }` → `{ issue }`, owner only;
 *   every change is audited, unchanged values write nothing.
 * - POST /api/issues, see issue-create.ts.
 */
import type { Hono } from 'hono';
import { findChat } from '../../db/queries/panel-registry.js';
import {
    findHarnessIssue,
    updateHarnessIssue,
    type HarnessIssueRecord,
} from '../../services/harness-issue-service.js';
import { requireAuth, requireOwner, type PanelEnv } from '../context.js';
import { listHarnessIssuesForPanel } from '../queries/harness-issues.js';
import { readJsonObject } from '../request.js';
import {
    toIssueDetailView,
    toIssueSummaryViews,
    type IssueChatAccess,
    type IssueDetailView,
} from '../views/issue-view.js';
import { registerIssueCreateRoute, type IssueCreateDeps } from './issue-create.js';
import { parseIssueId, parseIssueListQuery, parseIssuePatch } from './issue-params.js';
import { issueListScopeOf, issueNotFound, requireIssueVisible } from './issue-scope.js';

export type IssueRouteDeps = IssueCreateDeps;

const detailViewOf = async (record: HarnessIssueRecord, chatAccess: IssueChatAccess | null): Promise<IssueDetailView> => {
    const chat = record.chatId === null ? null : await findChat(record.chatId);
    return toIssueDetailView(record, chat, chatAccess);
};

/** The offset of the next page; null when this page reaches the end */
const nextOffsetOf = (offset: number, pageSize: number, matched: number): number | null =>
    pageSize > 0 && offset + pageSize < matched ? offset + pageSize : null;

export const registerIssueRoutes = (app: Hono<PanelEnv>, deps: IssueRouteDeps): void => {
    app.get('/api/issues', async (context) => {
        const auth = requireAuth(context);
        const request = parseIssueListQuery(context);
        const scope = await issueListScopeOf(auth);
        const page = await listHarnessIssuesForPanel({ visibleChatIds: scope.visibleChatIds, ...request });
        return context.json({
            issues: await toIssueSummaryViews(page.records, scope.chats),
            matched: page.matched,
            nextOffset: nextOffsetOf(request.offset, page.records.length, page.matched),
            stats: page.stats,
        });
    });

    app.get('/api/issues/:id', async (context) => {
        const auth = requireAuth(context);
        const issueId = parseIssueId(context.req.param('id'));
        const record = await findHarnessIssue(issueId);
        if (record === null) throw issueNotFound();
        const chatAccess = await requireIssueVisible(auth, record);
        return context.json({ issue: await detailViewOf(record, chatAccess) });
    });

    app.patch('/api/issues/:id', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const issueId = parseIssueId(context.req.param('id'));
        const patch = parseIssuePatch(await readJsonObject(context));
        const record = await updateHarnessIssue({ issueId, patch, actorId: auth.user.id });
        if (record === null) throw issueNotFound();
        // The owner sees every issue: this only resolves whether its chat opens
        const chatAccess = await requireIssueVisible(auth, record);
        return context.json({ issue: await detailViewOf(record, chatAccess) });
    });

    registerIssueCreateRoute(app, deps);
};
