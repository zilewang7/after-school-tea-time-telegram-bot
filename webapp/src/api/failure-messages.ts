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
        .with({ kind: 'http', status: 413 }, () => ({ message: '内容太长，未保存', suggestRefresh: false }))
        .with({ kind: 'http', status: 429 }, () => ({ message: '操作太频繁，请稍后再试', suggestRefresh: false }))
        .with({ kind: 'http' }, ({ status, message }) => ({
            message: httpFallback(status, message),
            suggestRefresh: false,
        }))
        .exhaustive();

const ISSUE_NOT_FOUND_MESSAGE = '找不到这个 issue，或你没有权限查看';

/** A failed issue read; hidden and missing issues are the same 404 */
export const describeIssueReadFailure = (failure: ApiFailure): string =>
    match(failure)
        .with({ kind: 'http', status: 404 }, () => ISSUE_NOT_FOUND_MESSAGE)
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
