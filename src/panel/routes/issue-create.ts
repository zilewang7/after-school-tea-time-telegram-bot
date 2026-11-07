/**
 * POST /api/issues `{ chatId, kind, severity?, title, body }` → 201 `{ issue }`.
 *
 * Order (design §7): the per-user issue quota (429, a slot handed back when
 * nothing gets filed) → the body's keys and chatId (400; the chat has to be
 * known before its access can be) → the chat's access, member or observer
 * (403 / 503) → the issue fields, through the check the model's tool uses
 * (400) → the row and its `create` audit entry. Not gated by HARNESS_ISSUES,
 * which only switches the model's tools.
 *
 * Once the 201 is built, the group notice goes out in the background: only
 * for a group or supergroup, never as a private message, and a failure only
 * reaches the log.
 */
import type { Hono } from 'hono';
import type { Api } from 'grammy';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import { notifyGroupOfUserIssue } from '../../services/harness-issue-notify.js';
import { createUserHarnessIssue, type HarnessIssueRecord } from '../../services/harness-issue-service.js';
import { requireChatAccess } from '../access/require-access.js';
import { requireAuth, type PanelContext, type PanelEnv, type RequestAuth } from '../context.js';
import type { IssueQuota } from '../middleware/issue-quota.js';
import { readJsonObject } from '../request.js';
import type { PanelUser, VisibleAccess } from '../types.js';
import { toIssueDetailView } from '../views/issue-view.js';
import { parseIssueCreateInput, parseIssueCreateTarget } from './issue-params.js';

export interface IssueCreateDeps {
    /** The bot's own Api (autoRetry attached) for the group notice; null = no notice */
    botApi: Api | null;
    quota: IssueQuota;
}

interface FiledIssue {
    record: HarnessIssueRecord;
    chat: ChatRow;
    access: VisibleAccess;
}

const fileIssue = async (context: PanelContext, auth: RequestAuth): Promise<FiledIssue> => {
    const body = await readJsonObject(context);
    const chatId = parseIssueCreateTarget(body);
    const { chat, access } = await requireChatAccess(auth, chatId);
    const input = parseIssueCreateInput(body);
    const record = await createUserHarnessIssue({ ...input, chatId, userId: auth.user.id });
    return { record, chat, access };
};

/** Runs after the current request has been answered; resolves on its own and never rejects */
const noticeAfterResponse = (api: Api, record: HarnessIssueRecord, user: PanelUser): void => {
    setImmediate(() => {
        void notifyGroupOfUserIssue(api, record, user);
    });
};

export const registerIssueCreateRoute = (app: Hono<PanelEnv>, deps: IssueCreateDeps): void => {
    app.post('/api/issues', async (context) => {
        const auth = requireAuth(context);
        const slot = deps.quota.take(auth.user.id);
        let filed: FiledIssue;
        try {
            filed = await fileIssue(context, auth);
        } catch (error) {
            slot.release();
            throw error;
        }
        // The issue exists from here on, so its slot stays taken
        const issue = await toIssueDetailView(filed.record, filed.chat, filed.access);
        const response = context.json({ issue }, 201);
        if (deps.botApi !== null) noticeAfterResponse(deps.botApi, filed.record, auth.user);
        return response;
    });
};
