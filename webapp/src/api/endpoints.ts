import { createRequester } from './client';
import type {
    AddendumPreviewResponse,
    AuditResponse,
    ChatDetailResponse,
    ChatSettingsPatch,
    ChatSettingsResponse,
    GlobalSettingsResponse,
    HealthResponse,
    MeResponse,
} from './types';

export const AUDIT_PAGE_SIZE = 50;

export interface AuditQuery {
    // null = global view (owner only)
    chatId: number | null;
    beforeId: number | null;
}

const auditPath = ({ chatId, beforeId }: AuditQuery): string => {
    const params = new URLSearchParams();
    if (chatId !== null) params.set('chatId', String(chatId));
    params.set('limit', String(AUDIT_PAGE_SIZE));
    if (beforeId !== null) params.set('beforeId', String(beforeId));
    return `/api/audit?${params.toString()}`;
};

const chatPath = (chatId: number): string => `/api/chats/${chatId}`;

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
    };
};

export type PanelApi = ReturnType<typeof createApi>;
