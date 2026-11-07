import { createRequester } from './client';
import type {
    AddendumPreviewResponse,
    AuditResponse,
    ChatDetailResponse,
    ChatSettingsPatch,
    ChatSettingsResponse,
    GlobalSettingsResponse,
    HealthResponse,
    IssueCreateRequest,
    IssueKind,
    IssueListResponse,
    IssuePatch,
    IssueResponse,
    IssueSource,
    IssueStatus,
    MeResponse,
} from './types';

export const AUDIT_PAGE_SIZE = 50;
const ISSUE_PAGE_SIZE = 20;

export interface AuditQuery {
    // null = global view (owner only)
    chatId: number | null;
    beforeId: number | null;
}

/** GET /api/issues filters; null leaves a filter out */
export interface IssueListQuery {
    status: IssueStatus | null;
    kind: IssueKind | null;
    source: IssueSource | null;
    chatId: number | null;
    offset: number;
}

const auditPath = ({ chatId, beforeId }: AuditQuery): string => {
    const params = new URLSearchParams();
    if (chatId !== null) params.set('chatId', String(chatId));
    params.set('limit', String(AUDIT_PAGE_SIZE));
    if (beforeId !== null) params.set('beforeId', String(beforeId));
    return `/api/audit?${params.toString()}`;
};

const issueListPath = ({ status, kind, source, chatId, offset }: IssueListQuery): string => {
    const params = new URLSearchParams();
    if (status !== null) params.set('status', status);
    if (kind !== null) params.set('kind', kind);
    if (source !== null) params.set('source', source);
    if (chatId !== null) params.set('chatId', String(chatId));
    params.set('limit', String(ISSUE_PAGE_SIZE));
    if (offset > 0) params.set('offset', String(offset));
    return `/api/issues?${params.toString()}`;
};

const chatPath = (chatId: number): string => `/api/chats/${chatId}`;

const issueApiPath = (issueId: number): string => `/api/issues/${issueId}`;

export const createApi = (initData: string) => {
    const request = createRequester(initData);
    return {
        getHealth: (signal?: AbortSignal) => request<HealthResponse>({ method: 'GET', path: '/api/health', signal }),
        getMe: (signal?: AbortSignal) => request<MeResponse>({ method: 'GET', path: '/api/me', signal }),
        getChat: (chatId: number, signal?: AbortSignal) =>
            request<ChatDetailResponse>({ method: 'GET', path: chatPath(chatId), signal }),
        patchChatSettings: (chatId: number, patch: ChatSettingsPatch) =>
            request<ChatSettingsResponse>({ method: 'PATCH', path: `${chatPath(chatId)}/settings`, body: patch }),
        previewAddendum: (chatId: number, promptAddendum: string) =>
            request<AddendumPreviewResponse>({
                method: 'POST',
                path: `${chatPath(chatId)}/settings/preview`,
                body: { promptAddendum },
            }),
        getGlobal: (signal?: AbortSignal) =>
            request<GlobalSettingsResponse>({ method: 'GET', path: '/api/global', signal }),
        patchGlobal: (defaultModel: string | null) =>
            request<GlobalSettingsResponse>({ method: 'PATCH', path: '/api/global', body: { defaultModel } }),
        getAudit: (query: AuditQuery, signal?: AbortSignal) =>
            request<AuditResponse>({ method: 'GET', path: auditPath(query), signal }),
        getIssues: (query: IssueListQuery, signal?: AbortSignal) =>
            request<IssueListResponse>({ method: 'GET', path: issueListPath(query), signal }),
        getIssue: (issueId: number, signal?: AbortSignal) =>
            request<IssueResponse>({ method: 'GET', path: issueApiPath(issueId), signal }),
        // 201 on success; 429 with Retry-After past 5 issues per user per hour
        createIssue: (input: IssueCreateRequest) =>
            request<IssueResponse>({ method: 'POST', path: '/api/issues', body: input }),
        // Owner only
        patchIssue: (issueId: number, patch: IssuePatch) =>
            request<IssueResponse>({ method: 'PATCH', path: issueApiPath(issueId), body: patch }),
    };
};

export type PanelApi = ReturnType<typeof createApi>;
