/**
 * The access application API (design §7):
 * - POST   /api/access-applications             a trial user files an application
 * - GET    /api/access-applications             owner: the pending/all list + stats
 * - GET    /api/access-applications/:id         owner: one application + the applicant's history
 * - PATCH  /api/access-applications/:id         owner: approve or reject
 * - POST   /api/access-applications/:id/resend  owner: deliver the decision again
 * - DELETE /api/user-access/:userId             owner: revoke the grant
 *
 * The owner's list/detail/review routes are owner-only; the create route is for
 * the applicant. Notices go out after the response (setImmediate), so a slow or
 * failed Telegram call never delays or fails the request.
 */
import type { Api } from 'grammy';
import type { Hono } from 'hono';
import { accessTiersEnabled } from '../../config/trial-access.js';
import {
    notifyApplicantOfDecision,
    notifyApplicantOfRevoke,
    notifyOwnerOfApplication,
} from '../../services/access-application-notify.js';
import { resolveAccessTier } from '../../services/access-tier.js';
import { isUserAdmitted } from '../../services/user-access-cache.js';
import {
    AccessApplicationError,
    createAccessApplication,
    findAccessApplication,
    listAccessApplications,
    listAccessApplicationsByUser,
    reviewAccessApplication,
    revokeUserAccess,
    type AccessApplicationErrorCode,
} from '../../services/user-access-service.js';
import { requireAuth, requireOwner, type PanelEnv } from '../context.js';
import { PanelError, type PanelErrorCode } from '../errors.js';
import { readJsonObject } from '../request.js';
import { toAccessApplicationView, toAccessApplicationViews } from '../views/access-application-view.js';
import {
    parseAccessCreateBody,
    parseAccessListQuery,
    parseAccessReviewBody,
    parsePositiveId,
} from './access-params.js';

export interface AccessRouteDeps {
    /** The bot's own Api (autoRetry attached) for the notices; null = no notice */
    botApi: Api | null;
}

const applicationNotFound = (): PanelError => new PanelError('not_found', '这条申请不存在');

/** The offset of the next page; null when this page reaches the end */
const nextOffsetOf = (offset: number, pageSize: number, matched: number): number | null =>
    pageSize > 0 && offset + pageSize < matched ? offset + pageSize : null;

/** Runs after the current request has been answered; resolves on its own and never rejects */
const afterResponse = (task: () => Promise<void>): void => {
    setImmediate(() => {
        void task();
    });
};

/**
 * A service refusal as the panel's error. Each route lists the codes it reports
 * (the panel's vocabulary is narrower than the service's); anything else is
 * rethrown as the unexpected error it would be.
 */
const rethrowAccessError = (
    error: unknown,
    codes: Partial<Record<AccessApplicationErrorCode, PanelErrorCode>>
): never => {
    if (error instanceof AccessApplicationError) {
        const code = codes[error.code];
        if (code !== undefined) throw new PanelError(code, error.message);
    }
    throw error;
};

export const registerAccessApplicationRoutes = (app: Hono<PanelEnv>, deps: AccessRouteDeps): void => {
    app.post('/api/access-applications', async (context) => {
        const auth = requireAuth(context);
        const body = await readJsonObject(context);
        const fields = parseAccessCreateBody(body);
        if (!accessTiersEnabled()) throw new PanelError('conflict', '体验用户分级未启用');
        if (resolveAccessTier(auth.user.id) !== 'trial') {
            throw new PanelError('conflict', '你已拥有完整权限，无需申请');
        }
        // The Mini App has no chat scope: the applicant's private chat is the
        // delivery target (chatId = userId) and there is no message to reply to
        const record = await createAccessApplication({
            userId: auth.user.id,
            chatId: auth.user.id,
            messageId: null,
            identity: fields.identity,
            purpose: fields.purpose,
            source: 'miniapp',
        }).catch((error: unknown) =>
            rethrowAccessError(error, { invalid: 'invalid', pending: 'conflict', already_full: 'conflict' })
        );
        const response = context.json({ application: await toAccessApplicationView(record) }, 201);
        const api = deps.botApi;
        if (api !== null) afterResponse(() => notifyOwnerOfApplication(api, record));
        return response;
    });

    app.get('/api/access-applications', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const request = parseAccessListQuery(context);
        const page = await listAccessApplications({
            status: request.status,
            limit: request.limit,
            offset: request.offset,
        });
        return context.json({
            applications: await toAccessApplicationViews(page.records),
            matched: page.matched,
            nextOffset: nextOffsetOf(request.offset, page.records.length, page.matched),
            stats: { pending: page.pending },
        });
    });

    app.get('/api/access-applications/:id', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const applicationId = parsePositiveId(context.req.param('id'), 'id');
        const record = await findAccessApplication(applicationId);
        if (record === null) throw applicationNotFound();
        // The applicant's other applications, newest first (the service's order)
        const history = (await listAccessApplicationsByUser(record.userId)).filter(
            (entry) => entry.id !== record.id
        );
        return context.json({
            application: await toAccessApplicationView(record),
            history: await toAccessApplicationViews(history),
            // The grant can be gone while the application still reads approved
            // (a revoked user keeps the row): the owner UI hides 取消准入 then
            accessActive: isUserAdmitted(record.userId),
        });
    });

    app.patch('/api/access-applications/:id', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const applicationId = parsePositiveId(context.req.param('id'), 'id');
        const request = parseAccessReviewBody(await readJsonObject(context));
        const record = await reviewAccessApplication({
            applicationId,
            action: request.action,
            comment: request.comment,
            actorId: auth.user.id,
        }).catch((error: unknown) =>
            rethrowAccessError(error, { invalid: 'invalid', not_found: 'not_found', decided: 'conflict' })
        );
        const response = context.json({ application: await toAccessApplicationView(record) });
        const api = deps.botApi;
        if (api !== null) afterResponse(() => notifyApplicantOfDecision(api, record));
        return response;
    });

    app.post('/api/access-applications/:id/resend', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const applicationId = parsePositiveId(context.req.param('id'), 'id');
        const record = await findAccessApplication(applicationId);
        if (record === null) throw applicationNotFound();
        if (record.status === 'pending') {
            throw new PanelError('conflict', '这条申请还没有审核结果，不能重发');
        }
        const api = deps.botApi;
        if (api === null) throw new PanelError('internal', '投递通道不可用', { status: 503 });
        await notifyApplicantOfDecision(api, record);
        // Re-read: the send records its outcome on the row
        const delivered = await findAccessApplication(applicationId);
        if (delivered === null) throw applicationNotFound();
        return context.json({ application: await toAccessApplicationView(delivered) });
    });

    app.delete('/api/user-access/:userId', async (context) => {
        const auth = requireAuth(context);
        requireOwner(auth);
        const userId = parsePositiveId(context.req.param('userId'), 'userId');
        const result = await revokeUserAccess({ userId, actorId: auth.user.id }).catch((error: unknown) =>
            rethrowAccessError(error, { not_admitted: 'not_found' })
        );
        const response = context.json({ userId: result.userId, revoked: true });
        const api = deps.botApi;
        if (api !== null) afterResponse(() => notifyApplicantOfRevoke(api, userId, result.lastApproved));
        return response;
    });
};
