import { match, P } from 'ts-pattern';
import type { ApiFailure } from './client';

export const REOPEN_PANEL_MESSAGE = '请关闭面板重新打开';

export interface WriteFailureView {
    message: string;
    // Whether to offer a refresh so the user can check what the server actually has
    suggestRefresh: boolean;
}

const httpFallback = (status: number, message: string | null): string => message ?? `出错了（HTTP ${status}）`;

/** User-facing text for a failed read */
export const describeReadFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'network' }, () => 'bot 不可达，请稍后再试')
        .with({ kind: 'unreachable' }, ({ serverMessage }) => serverMessage ?? 'bot 不可达，请稍后再试')
        .with({ kind: 'http', status: 401 }, () => REOPEN_PANEL_MESSAGE)
        .with({ kind: 'http', status: 403 }, ({ message }) => message ?? '没有权限查看')
        .with({ kind: 'http', status: 404 }, ({ message }) => message ?? '不存在或不可见')
        .with({ kind: 'http', status: 429 }, () => '操作太频繁，请稍后再试')
        .with({ kind: 'http' }, ({ status, message }) => httpFallback(status, message))
        .exhaustive();

/** User-facing text for a failed write; writes are never retried automatically */
export const describeWriteFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'network' }, { kind: 'unreachable', serverMessage: P.nullish }, () => ({
            message: '未确认是否已保存，请刷新后核对',
            suggestRefresh: true,
        }))
        // A JSON 503 is the bot itself refusing the write, so nothing was saved
        .with({ kind: 'unreachable', serverMessage: P.string }, ({ serverMessage }) => ({
            message: serverMessage,
            suggestRefresh: false,
        }))
        // The server stopped waiting (or Cloudflare did), not the write: it may still land
        .with({ kind: 'http', status: P.union(504, 524) }, { kind: 'http', code: 'timeout' }, () => ({
            message: '未确认是否已保存，请刷新后核对',
            suggestRefresh: true,
        }))
        .with({ kind: 'http', status: 401 }, () => ({ message: REOPEN_PANEL_MESSAGE, suggestRefresh: false }))
        .with({ kind: 'http', status: 409 }, () => ({ message: '设置已被别人修改，请刷新', suggestRefresh: true }))
        .with({ kind: 'http', code: 'locked' }, () => ({ message: '设置已被机主锁定', suggestRefresh: true }))
        // A trial user tried to change the model; the server's message names the way to apply
        .with({ kind: 'http', code: 'trial' }, ({ message }) => ({
            message: message ?? '体验用户不能修改模型，可在「准入」页申请完整功能',
            suggestRefresh: false,
        }))
        .with({ kind: 'http', status: 413 }, () => ({ message: '内容太长，未保存', suggestRefresh: false }))
        .with({ kind: 'http', status: 429 }, () => ({ message: '操作太频繁，请稍后再试', suggestRefresh: false }))
        .with({ kind: 'http' }, ({ status, message }) => ({
            message: httpFallback(status, message),
            suggestRefresh: false,
        }))
        .exhaustive();

/** A failed share create or revoke; the server's own wording wins (e.g. observers share replies only) */
export const describeShareFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: 403 }, ({ message }) => ({
            message: message ?? '没有权限分享',
            suggestRefresh: false,
        }))
        .with({ kind: 'http', status: 404 }, ({ message }) => ({
            message: message ?? '分享目标不存在或已被清理',
            suggestRefresh: true,
        }))
        .with({ kind: 'http', status: 400 }, ({ message }) => ({
            message: message ?? '分享参数不正确',
            suggestRefresh: false,
        }))
        .otherwise(describeWriteFailure);

const ISSUE_NOT_FOUND_MESSAGE = '找不到这个 issue，或你没有权限查看';

/** A failed public share read; unknown, revoked and malformed tokens all answer the same 404 */
export const describePublicShareFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => '分享不存在或已被撤销')
        .otherwise(describeReadFailure);

/** A failed issue read; hidden and missing issues are the same 404 */
export const describeIssueReadFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ISSUE_NOT_FOUND_MESSAGE)
        .otherwise(describeReadFailure);

/** A failed POST …/links: the root may have been cleaned up, and bad links are reported by the server */
export const describeSpliceFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ({
            message: '这个会话的根消息不存在或已被清理',
            suggestRefresh: true,
        }))
        .with({ kind: 'http', status: 400 }, ({ message }) => ({
            message: message ?? '链接格式不正确',
            suggestRefresh: false,
        }))
        .otherwise(describeWriteFailure);

/** A failed exclude / restore: 400 is the album sub-image rule, 404 a message we no longer have */
export const describeExclusionFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: P.union(400, 404) }, ({ message }) => ({
            message: message ?? '这条消息不存在或不能这样处理',
            suggestRefresh: false,
        }))
        .otherwise(describeWriteFailure);

/** A failed export; 413 means the conversation is over the 5 MB cap */
export const describeExportFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'http', status: 413 }, () => '会话太大，导出超过 5 MB')
        .otherwise(describeReadFailure);

const SECONDS_PER_MINUTE = 60;

const issueQuotaMessage = (retryAfterSeconds: number | null): string =>
    retryAfterSeconds === null
        ? '提交过于频繁，请稍后再试'
        : `提交过于频繁，请 ${Math.max(1, Math.ceil(retryAfterSeconds / SECONDS_PER_MINUTE))} 分钟后再试`;

/** A failed POST /api/issues; there is nothing to refresh, so the outcome-unknown cases point to the list */
export const describeIssueCreateFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: 429 }, ({ retryAfterSeconds }) => ({
            message: issueQuotaMessage(retryAfterSeconds),
            suggestRefresh: false,
        }))
        .with(
            { kind: 'network' },
            { kind: 'unreachable', serverMessage: P.nullish },
            { kind: 'http', status: P.union(504, 524) },
            { kind: 'http', code: 'timeout' },
            () => ({ message: '未确认是否已提交，请到 Issue 列表核对', suggestRefresh: false })
        )
        .otherwise(describeWriteFailure);

const ACCESS_APPLICATION_NOT_FOUND_MESSAGE = '这条准入申请不存在';

/** A failed access application read; a missing application and a hidden one are the same 404 */
export const describeAccessApplicationReadFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ACCESS_APPLICATION_NOT_FOUND_MESSAGE)
        .otherwise(describeReadFailure);

/** A failed approve / reject / resend; an already decided application is the common conflict */
export const describeAccessReviewFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ({
            message: ACCESS_APPLICATION_NOT_FOUND_MESSAGE,
            suggestRefresh: true,
        }))
        .with({ kind: 'http', status: 409 }, ({ message }) => ({
            message: message ?? '这条申请已经处理过了，请刷新',
            suggestRefresh: true,
        }))
        .otherwise(describeWriteFailure);

/** A failed revoke: the user may have lost access already */
export const describeAccessRevokeFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ({
            message: '这个用户当前没有准入',
            suggestRefresh: true,
        }))
        .otherwise(describeWriteFailure);

/**
 * A failed application submit: 409 is the normal refusal (already pending, already
 * full, or tiering off), so its server wording wins over the generic settings one.
 */
export const describeAccessApplicationCreateFailure = (failure: ApiFailure): WriteFailureView =>
    match(failure)
        .with({ kind: 'http', status: P.union(403, 409) }, ({ message }) => ({
            message: message ?? '不能提交申请，请稍后再试',
            suggestRefresh: false,
        }))
        .with(
            { kind: 'network' },
            { kind: 'unreachable', serverMessage: P.nullish },
            { kind: 'http', status: P.union(504, 524) },
            { kind: 'http', code: 'timeout' },
            () => ({ message: '未确认是否已提交，请刷新后核对', suggestRefresh: true })
        )
        .otherwise(describeWriteFailure);
