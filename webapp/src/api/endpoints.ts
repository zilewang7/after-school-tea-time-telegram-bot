import { createPublicRequester, createRequester, createTextRequester } from './client';
import type {
    AddendumPreviewResponse,
    AuditResponse,
    ChatDetailResponse,
    ChatSettingsPatch,
    ChatSettingsResponse,
    ConversationListResponse,
    ConversationTreeResponse,
    ExcludedMessageResponse,
    GlobalSettingsResponse,
    HealthResponse,
    IncludedMessageResponse,
    IssueCreateRequest,
    IssueKind,
    IssueListResponse,
    IssuePatch,
    IssueResponse,
    IssueSource,
    IssueStatus,
    LinkSpliceResponse,
    MeResponse,
    ModelView,
    PublicShareResponse,
    ReplyDetail,
    ShareCreateRequest,
    ShareKind,
    ShareLookupResponse,
    ShareResponse,
    ShareRevokeResponse,
    StatsRangeKey,
    StatsResponse,
    StatusResponse,
} from './types';

export const AUDIT_PAGE_SIZE = 50;
const ISSUE_PAGE_SIZE = 20;
/** Conversations per page, like the server's default */
export const CONVERSATION_PAGE_SIZE = 20;

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

/** GET …/model-view query; null leaves the default (the chat's model, the newest user message) */
export interface ModelViewQuery {
    at: number | null;
    asModel: string | null;
}

/** GET /api/shares query: exactly the target a share belongs to; null leaves a field out */
export interface ShareQuery {
    kind: ShareKind;
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
}

export type ExportFormat = 'md' | 'json';

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

const conversationListPath = (chatId: number, before: string | null): string => {
    const params = new URLSearchParams();
    params.set('limit', String(CONVERSATION_PAGE_SIZE));
    if (before !== null) params.set('before', before);
    return `${chatPath(chatId)}/conversations?${params.toString()}`;
};

const conversationPath = (chatId: number, rootId: number): string =>
    `${chatPath(chatId)}/conversations/${rootId}`;

const modelViewPath = (chatId: number, rootId: number, { at, asModel }: ModelViewQuery): string => {
    const params = new URLSearchParams();
    if (at !== null) params.set('at', String(at));
    if (asModel !== null) params.set('asModel', asModel);
    const query = params.toString();
    return `${conversationPath(chatId, rootId)}/model-view${query === '' ? '' : `?${query}`}`;
};

const replyPath = (chatId: number, firstMessageId: number): string =>
    `${chatPath(chatId)}/replies/${firstMessageId}`;

const exclusionPath = (chatId: number, messageId: number): string =>
    `${chatPath(chatId)}/messages/${messageId}/exclusion`;

const exportPath = (chatId: number, rootId: number, format: ExportFormat): string =>
    `${conversationPath(chatId, rootId)}/export?format=${format}`;

const statsPath = (chatId: number | null, range: StatsRangeKey): string => {
    const params = new URLSearchParams();
    if (chatId !== null) params.set('chatId', String(chatId));
    params.set('range', range);
    return `/api/stats?${params.toString()}`;
};

const shareQueryPath = ({ kind, chatId, firstMessageId, rootId, versionId }: ShareQuery): string => {
    const params = new URLSearchParams();
    params.set('kind', kind);
    params.set('chatId', String(chatId));
    if (firstMessageId !== null) params.set('firstMessageId', String(firstMessageId));
    if (rootId !== null) params.set('rootId', String(rootId));
    if (versionId !== null) params.set('versionId', String(versionId));
    return `/api/shares?${params.toString()}`;
};

const shareRevokePath = (token: string): string => `/api/shares/${encodeURIComponent(token)}/revoke`;

/** The public JSON of one share; the token is the whole permission */
const publicSharePath = (token: string): string => `/api/public/shares/${encodeURIComponent(token)}`;

export const createApi = (initData: string) => {
    const request = createRequester(initData);
    const requestText = createTextRequester(initData);
    // No initData: the public share API must answer anyone holding the link
    const requestPublic = createPublicRequester();
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

        // Conversations (phase 2)
        getConversations: (chatId: number, before: string | null, signal?: AbortSignal) =>
            request<ConversationListResponse>({
                method: 'GET',
                path: conversationListPath(chatId, before),
                signal,
            }),
        getConversationTree: (chatId: number, rootId: number, signal?: AbortSignal) =>
            request<ConversationTreeResponse>({
                method: 'GET',
                path: conversationPath(chatId, rootId),
                signal,
            }),
        // The conversation tab's statistics: the tree's whole life, no range picker
        getConversationStats: (chatId: number, rootId: number, signal?: AbortSignal) =>
            request<StatsResponse>({
                method: 'GET',
                path: `${conversationPath(chatId, rootId)}/stats`,
                signal,
            }),
        // Members only; 403 for observers
        getModelView: (chatId: number, rootId: number, query: ModelViewQuery, signal?: AbortSignal) =>
            request<ModelView>({ method: 'GET', path: modelViewPath(chatId, rootId, query), signal }),
        getReply: (chatId: number, firstMessageId: number, signal?: AbortSignal) =>
            request<ReplyDetail>({ method: 'GET', path: replyPath(chatId, firstMessageId), signal }),
        // Members only; idempotent, so a repeat answers 200 too
        setExclusion: (chatId: number, messageId: number, excluded: boolean) =>
            excluded
                ? request<ExcludedMessageResponse>({
                      method: 'PUT',
                      path: exclusionPath(chatId, messageId),
                  })
                : request<IncludedMessageResponse>({
                      method: 'DELETE',
                      path: exclusionPath(chatId, messageId),
                  }),
        // Members only; 1–20 links, a rootId that is not a root is 404
        spliceConversation: (chatId: number, rootId: number, links: readonly string[]) =>
            request<LinkSpliceResponse>({
                method: 'POST',
                path: `${conversationPath(chatId, rootId)}/links`,
                body: { links },
            }),
        // Members only; the body is the exported file (5 MB cap)
        exportConversation: (chatId: number, rootId: number, format: ExportFormat) =>
            requestText({ method: 'GET', path: exportPath(chatId, rootId, format) }),

        // Statistics and live status (phase 3)
        // chatId null = every chat (owner only)
        getStats: (chatId: number | null, range: StatsRangeKey, signal?: AbortSignal) =>
            request<StatsResponse>({ method: 'GET', path: statsPath(chatId, range), signal }),
        getStatus: (signal?: AbortSignal) =>
            request<StatusResponse>({ method: 'GET', path: '/api/status', signal }),

        // Shares (phase 5): public pages for one reply or one conversation
        // Idempotent: an active link for the same target is returned as is
        createShare: (input: ShareCreateRequest) =>
            request<ShareResponse>({ method: 'POST', path: '/api/shares', body: input }),
        getShare: (query: ShareQuery, signal?: AbortSignal) =>
            request<ShareLookupResponse>({ method: 'GET', path: shareQueryPath(query), signal }),
        // The creator or the owner only
        revokeShare: (token: string) =>
            request<ShareRevokeResponse>({ method: 'POST', path: shareRevokePath(token) }),

        // Public shares (phase 5 increment): the read-only Mini App page's content
        getPublicShare: (token: string, signal?: AbortSignal) =>
            requestPublic<PublicShareResponse>({ method: 'GET', path: publicSharePath(token), signal }),
    };
};

export type PanelApi = ReturnType<typeof createApi>;
