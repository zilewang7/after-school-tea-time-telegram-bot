// Mirrors the panel HTTP API contract (phase 1). Paths live under /api.

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel';
export type ChatAccess = 'member' | 'observer';
/** `unavailable`: Telegram rate-limited the membership lookup; the chat's own page retries */
export type StartTargetAccess = ChatAccess | 'none' | 'unavailable';

export type ApiErrorCode =
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

export interface ApiErrorBody {
    error: { code: string; message: string };
}

export interface HealthResponse {
    ok: boolean;
    startedAt: string;
    version: string | null;
    settingsLoaded: boolean;
}

export interface PanelUser {
    id: number;
    firstName: string;
    lastName: string | null;
    username: string | null;
}

export interface ChatSummary {
    chatId: number;
    type: ChatType;
    // Group title, or the private chat user's full name; null until the bot learns it
    title: string | null;
    // Public username of the group or user, without the @
    username: string | null;
    access: ChatAccess;
    model: string | null;
    modelSource: 'chat' | 'global';
    paused: boolean;
    settingsLocked: boolean;
    openIssues: number;
    lastActivityAt: string | null;
}

export type StartTarget =
    | { kind: 'chat'; chatId: number; access: StartTargetAccess }
    | { kind: 'issue'; issueId: number; chatId: number | null; access: StartTargetAccess };

export interface MeResponse {
    user: PanelUser;
    isOwner: boolean;
    globalDefaultModel: string;
    models: string[];
    chats: ChatSummary[];
    startTarget: StartTarget | null;
}

export interface ChatSettings {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    updatedAt: string | null;
    updatedBy: number | null;
}

export interface ToolAvailability {
    name: string;
    enabled: boolean;
    reason: string | null;
}

export interface ChatAuditEntry {
    id: number;
    actorId: number;
    actorName: string;
    key: string;
    oldValue: string | null;
    newValue: string | null;
    createdAt: string;
}

export interface ChatDetailResponse {
    chat: { chatId: number; type: ChatType; title: string | null; username: string | null; access: ChatAccess };
    settings: ChatSettings;
    effectiveModel: string;
    globalDefaultModel: string;
    tools: ToolAvailability[];
    // Always null in phase 1; the 7-day summary block stays hidden
    summary: null;
    recentAudit: ChatAuditEntry[];
}

export interface ChatSettingsPatch {
    model?: string | null;
    promptAddendum?: string | null;
    paused?: boolean;
    settingsLocked?: boolean;
    expectedUpdatedAt?: string;
}

export interface ChatSettingsResponse {
    settings: ChatSettings;
}

export interface AddendumPreviewResponse {
    runtimeBlock: string;
    injected: boolean;
    estimatedTokens: number;
}

export interface GlobalSettingsResponse {
    defaultModel: string;
    source: 'panel' | 'env';
}

export interface AuditEntry extends ChatAuditEntry {
    scope: string;
}

export interface AuditResponse {
    entries: AuditEntry[];
}
