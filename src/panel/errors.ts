/**
 * The panel's error vocabulary: every failure the API reports is one of these
 * codes, rendered as `{ error: { code, message } }`. Messages are shown to the
 * user as-is, so they are Chinese and never echo request data.
 */
import { match } from 'ts-pattern';

export type PanelErrorCode =
    | 'invalid'
    | 'unauthorized'
    | 'forbidden'
    | 'locked'
    | 'not_found'
    | 'conflict'
    | 'too_large'
    | 'rate_limited'
    | 'internal'
    | 'timeout';

export type PanelErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503 | 504;

export interface PanelErrorBody {
    error: { code: PanelErrorCode; message: string };
}

/** The usual HTTP status of a code; `internal` is 500 unless a 503 is asked for */
export const statusOfCode = (code: PanelErrorCode): PanelErrorStatus =>
    match(code)
        .returnType<PanelErrorStatus>()
        .with('invalid', () => 400)
        .with('unauthorized', () => 401)
        .with('forbidden', 'locked', () => 403)
        .with('not_found', () => 404)
        .with('conflict', () => 409)
        .with('too_large', () => 413)
        .with('rate_limited', () => 429)
        .with('internal', () => 500)
        .with('timeout', () => 504)
        .exhaustive();

/** Thrown anywhere below a route; the app's error handler renders it */
export class PanelError extends Error {
    readonly code: PanelErrorCode;
    readonly status: PanelErrorStatus;
    /** Seconds, sent as Retry-After (429) */
    readonly retryAfterSeconds: number | null;

    constructor(
        code: PanelErrorCode,
        message: string,
        options: { status?: PanelErrorStatus; retryAfterSeconds?: number } = {}
    ) {
        super(message);
        this.name = 'PanelError';
        this.code = code;
        this.status = options.status ?? statusOfCode(code);
        this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    }
}

export const errorBody = (code: PanelErrorCode, message: string): PanelErrorBody => ({
    error: { code, message },
});

/** Shared messages, so the same situation always reads the same */
export const PANEL_MESSAGES = {
    unauthorized: '身份校验失败，请关闭面板后重新打开',
    forbidden: '你没有权限访问该聊天',
    ownerOnly: '只有机主可以执行此操作',
    notFound: '接口不存在',
    membershipUnavailable: '成员资格暂时无法确认，稍后再试',
    tooLarge: '请求体过大',
    rateLimited: '请求过于频繁，请稍后再试',
    timeout: '服务器处理超时',
    internal: '服务器内部错误',
    invalidJson: '请求体必须是 JSON 对象',
    invalidChatId: 'chatId 不合法',
    conflict: '设置已被他人修改，请刷新后重试',
} as const;
