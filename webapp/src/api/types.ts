// Mirrors the panel HTTP API contract (phases 1–4). Paths live under /api.

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
    // The panel's per-chat tool switches; null = every group follows the env
    toolOverrides: ToolOverrides | null;
    updatedAt: string | null;
    updatedBy: number | null;
}

/** A panel tool switch group, the same nine keys the server uses */
export type ToolGroupKey =
    | 'sms'
    | 'image'
    | 'imageSearch'
    | 'imageFetch'
    | 'imageReverseSearch'
    | 'sticker'
    | 'file'
    | 'history'
    | 'harnessIssues'
    | 'widget';

/** Per-chat tool switches: true = on, false = off, missing key = follow the env whitelist */
export type ToolOverrides = Partial<Record<ToolGroupKey, boolean>>;

export interface ToolGroupEntry {
    key: ToolGroupKey;
    // The tool names this group registers
    tools: string[];
    // Offered to a plain turn with the chat's current settings
    enabled: boolean;
    // Offered if every switch followed the env again
    defaultEnabled: boolean;
    // The panel's switch; null = follow the env whitelist
    override: boolean | null;
    // Why it is off; null when enabled
    reason: string | null;
    // Off for a reason a switch cannot fix (env switch, URL, model capability)
    blocked: boolean;
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
    tools: ToolGroupEntry[];
    // Last 7 days; null when the chat had no reply in the window (shown in the 统计 tab)
    summary: ChatSummaryView | null;
    recentAudit: ChatAuditEntry[];
}

export interface ChatSettingsPatch {
    model?: string | null;
    promptAddendum?: string | null;
    paused?: boolean;
    settingsLocked?: boolean;
    // Replaces the whole switch object; null clears every override
    toolOverrides?: ToolOverrides | null;
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

// Issues (phase 4)

export type IssueKind = 'bug' | 'improvement' | 'feature';
export type IssueSeverity = 'low' | 'medium' | 'high';
export type IssueStatus = 'open' | 'triaged' | 'fixed' | 'wontfix' | 'duplicate';
export type IssueSource = 'model' | 'user';
/**
 * The requester's access to an issue's chat, i.e. whether the chat opens:
 * `none` (the owner sees every issue, even where the chat stays closed) and
 * `unavailable` (Telegram rate-limited the membership lookup) do not open it.
 */
export type IssueChatAccess = ChatAccess | 'none' | 'unavailable';

export interface IssueChat {
    chatId: number;
    // null when the chat is not in the bot's registry
    type: ChatType | null;
    title: string | null;
    username: string | null;
}

export interface IssueCreator {
    userId: number;
    // First + last name, or 「用户 <id>」 when unknown
    name: string;
}

export interface IssueSummary {
    id: number;
    // Strings like the server stores them; the known values are IssueStatus / IssueKind / IssueSeverity
    status: string;
    kind: string;
    severity: string | null;
    title: string;
    source: IssueSource;
    toolName: string | null;
    // null when filed on no chat (only the owner sees those)
    chat: IssueChat | null;
    // The filing person; null for the model's issues
    createdBy: IssueCreator | null;
    hasNote: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface IssueDetail extends IssueSummary {
    body: string;
    // The owner's handling note
    note: string | null;
    // null without a chat
    chatAccess: IssueChatAccess | null;
}

export interface IssueStats {
    // Every status counted under every filter except the status filter
    total: number;
    byStatus: Record<IssueStatus, number>;
}

export interface IssueListResponse {
    issues: IssueSummary[];
    // Issues matching every filter: what the pages add up to
    matched: number;
    nextOffset: number | null;
    stats: IssueStats;
}

export interface IssueResponse {
    issue: IssueDetail;
}

export interface IssueCreateRequest {
    chatId: number;
    kind: IssueKind;
    severity?: IssueSeverity;
    title: string;
    body: string;
}

export interface IssuePatch {
    status?: IssueStatus;
    // null clears the note
    note?: string | null;
}

// Conversations (phase 2)

/** Where a message sits in the panel's tree: a reply, a /chat splice, or a pulled-in reply target */
export type TreeEdge = 'reply' | 'link' | 'reply-target';

export interface AuthorView {
    // null on rows stored before author ids were recorded; 0 on luoxu backfills
    userId: number | null;
    // The name the model reads (the stored first name)
    name: string;
    username: string | null;
}

interface TreeNodePosition {
    messageId: number;
    // `#N` in the model's context; null when excluded (or not in the context)
    number: number | null;
    date: string;
    parentId: number | null;
    edge: TreeEdge | null;
}

/** What an observer keeps of a user message: id, time, tree position and the excluded flag */
export interface ObserverUserNode extends TreeNodePosition {
    kind: 'user';
    redacted: true;
    excluded: boolean;
}

export interface MemberUserNode extends TreeNodePosition {
    kind: 'user';
    redacted: false;
    author: AuthorView;
    // Plain text, newlines kept
    text: string | null;
    quote: string | null;
    // Header annotations the model reads, e.g. `[replying to #2 Mio]`
    annotations: string[];
    mediaHint: string | null;
    linkPreview: string | null;
    ocrText: string | null;
    excluded: boolean;
    // Supergroups only: t.me/c/<internal id>/<message id>
    telegramLink: string | null;
}

export interface BotNode extends TreeNodePosition {
    kind: 'bot';
    excluded: boolean;
    reply: ReplySummary;
}

export type TreeNode = ObserverUserNode | MemberUserNode | BotNode;

export interface ConversationTreeResponse {
    access: ChatAccess;
    rootId: number;
    // The message the `#N` are computed for
    triggerId: number;
    generating: boolean;
    nodes: TreeNode[];
}

export interface ObserverUserRoot {
    messageId: number;
    date: string;
    kind: 'user';
    redacted: true;
    excluded: boolean;
}

export interface MemberUserRoot {
    messageId: number;
    date: string;
    kind: 'user';
    redacted: false;
    excluded: boolean;
    author: AuthorView;
    excerpt: string;
}

export interface BotRoot {
    messageId: number;
    date: string;
    kind: 'bot';
    excluded: boolean;
    excerpt: string;
}

export type ConversationRoot = ObserverUserRoot | MemberUserRoot | BotRoot;

export interface ConversationListItem {
    rootId: number;
    lastActivityAt: string;
    // Messages of the reply tree, excluded ones included
    messageCount: number;
    // Bot replies answering a message of this conversation
    replyCount: number;
    // Model of the most recently generated version
    lastModel: string | null;
    generating: boolean;
    // Some version of some reply ended with an error
    hasError: boolean;
    root: ConversationRoot;
}

export interface ConversationListResponse {
    conversations: ConversationListItem[];
    // Cursor of the next page; null on the last one
    nextBefore: string | null;
}

/** A reply version's tool and search records, merged like the Telegram rendering */
export interface ToolUsageView {
    name: string;
    // Calls made, failed ones included
    count: number;
    // Of those, how many the tool answered with an error
    failed: number;
}

export interface SourceView {
    uri: string;
    title: string | null;
}

/** One search-grounding step (Gemini's built-in search) */
export interface SearchGroundingView {
    queries: string[];
    imageQueries: string[];
    sources: SourceView[];
}

export interface ToolRecords {
    // Agent mode, when the platform reports one
    mode: string | null;
    toolUsage: ToolUsageView[];
    // One line per distinct tool call, e.g. `search_history: 关键词`, in call order
    calls: string[];
    // Sources cited by the tool steps, one per URL, first-seen order
    sources: SourceView[];
    // Code interpreter summaries, as reported
    codeInterpreter: string[];
    searches: SearchGroundingView[];
}

/** The stored agentStats, as far as the panel shows them */
export interface AgentStats {
    mode?: string;
    reasoningTokens?: number;
    toolUsage?: Array<{ name: string; count: number; failed?: number }>;
    codeInterpreterSummary?: string[];
}

/** The tree node's summary of a reply's current version */
export interface ReplySummary {
    firstMessageId: number;
    versionCount: number;
    // 1-based; null when no version is stored (still streaming, or no bot_responses row)
    currentVersion: number | null;
    model: string | null;
    text: string | null;
    thinkingText: string | null;
    toolSummary: ToolUsageView[];
    errorMessage: string | null;
    wasStoppedByUser: boolean;
}

export type ReplyOutcome = 'ok' | 'error' | 'stopped' | 'empty';

export type ErrorKind =
    | 'rate_limit'
    | 'timeout'
    | 'network'
    | 'upstream'
    | 'content_filter'
    | 'pre_request'
    | 'other';

/** How a cost estimate treated one row or group */
export type PricingFlag = 'priced' | 'subscription' | 'unpriced' | 'no_usage';
/** A model across its routes: `partial` when some routes have a cost and others none */
export type ModelPricingFlag = PricingFlag | 'partial';

/** One version's reply_metrics row, as the reply detail shows it */
export interface ReplyMetric {
    id: number;
    versionId: number;
    model: string;
    platform: string;
    route: string | null;
    commandType: string;
    isRetry: boolean;
    startedAt: string;
    requestStartedAt: string | null;
    firstChunkAt: string | null;
    finishedAt: string;
    // firstChunkAt - requestStartedAt
    firstChunkMs: number | null;
    // finishedAt - startedAt
    durationMs: number;
    outcome: ReplyOutcome;
    errorKind: ErrorKind | null;
    errorSummary: string | null;
    rounds: number | null;
    toolCalls: number;
    toolFailures: number;
    toolUsage: ToolUsageView[];
    promptTokens: number | null;
    cachedTokens: number | null;
    cacheWriteTokens: number | null;
    outputTokens: number | null;
    thoughtsTokens: number | null;
    imageOutputTokens: number | null;
    contextMessages: number | null;
    contextImages: number | null;
    textChars: number | null;
    thinkingChars: number | null;
    hasImage: boolean;
    imageCount: number;
    hasSticker: boolean;
    hasFile: boolean;
    // This attempt alone, priced like the statistics
    costUsd: number | null;
    pricing: PricingFlag;
    // Members only
    triggerUserId?: number | null;
}

/** An attachment described by kind and size only; no bytes reach the panel */
export interface ReplyAttachment {
    kind: 'image' | 'sticker' | 'file';
    mimeType: string | null;
    sizeBytes: number;
}

export interface ReplyVersion {
    versionId: number;
    createdAt: string;
    model: string | null;
    text: string;
    thinkingText: string | null;
    tools: ToolRecords;
    agentStats: AgentStats | null;
    errorMessage: string | null;
    wasStoppedByUser: boolean;
    attachments: ReplyAttachment[];
    hasModelParts: boolean;
    // reply_metrics of this version; null for versions without a row ("无指标")
    metrics: ReplyMetric | null;
}

export interface ReplyDetail {
    firstMessageId: number;
    userMessageId: number;
    // Root of the conversation the reply belongs to; null when its chain cannot be read
    rootId: number | null;
    commandType: string | null;
    generating: boolean;
    versionCount: number;
    // 1-based; null when no version is stored yet
    currentVersion: number | null;
    versions: ReplyVersion[];
    // Members only; never sent to observers
    triggerUserId?: number | null;
}

export interface ModelViewPart {
    type: 'text' | 'image' | 'media';
    // The text itself, or the placeholder of an image / media part
    text: string;
}

export interface ModelViewTurn {
    role: 'user' | 'assistant' | 'system';
    parts: ModelViewPart[];
}

/** What a retry would send right now; a recomputation, not a snapshot of the original request */
export interface ModelView {
    // The user message the retry answers (the runtime block rides it)
    at: number;
    // The reply a retry would replace, left out of the context
    excludedReplyId: number | null;
    model: string;
    // The model was chosen with `asModel` rather than the chat's setting
    asModel: boolean;
    computedAt: string;
    systemPrompt: string;
    // True for a Gemini image model: its generation instruction replaces the static head
    systemPromptReplaced: boolean;
    // Tool names declared this turn, in declaration order
    tools: string[];
    // The context carries gs:// media and this platform then sends no tools
    toolsDroppedForLargeMedia: boolean;
    turns: ModelViewTurn[];
    // `#N` → message id, as this context numbers them
    numbers: Array<{ number: number; messageId: number }>;
}

/** The links that did not go in, and why; null notice when all did */
export interface LinkSpliceResponse {
    attachedRoots: number;
    foreign: number[];
    missing: number[];
    alreadyInTree: number[];
    // Entries that are not message links, trimmed
    invalid: string[];
    notice: string | null;
}

export interface ExcludedMessageResponse {
    messageId: number;
    excluded: true;
    createdAt: string;
    createdBy: number;
}

export interface IncludedMessageResponse {
    messageId: number;
    excluded: false;
}

// Statistics and live status (phase 3)

export type StatsRangeKey = '24h' | '7d' | '30d' | '90d' | 'all';
export type StatsBucket = 'hour' | 'day';

export interface ChatSummaryView {
    days: number;
    replies: number;
    errorReplies: number;
    // 0..1
    errorRate: number | null;
    // firstChunkAt - requestStartedAt, ms
    firstChunkP50Ms: number | null;
    // USD at list price; null when nothing in the window is priced
    costUsd: number | null;
    // 0..1: replies the cost covers
    pricedReplyRatio: number | null;
}

export interface StatsKpis {
    replies: number;
    retries: number;
    retryRatio: number | null;
    // Distinct users who triggered a reply (a count only)
    triggerUsers: number;
    errorReplies: number;
    errorRate: number | null;
    firstChunkP50Ms: number | null;
    firstChunkP95Ms: number | null;
    durationP50Ms: number | null;
    durationP95Ms: number | null;
    toolCalls: number;
    toolFailures: number;
    toolFailureRate: number | null;
    avgRounds: number | null;
    avgToolCalls: number | null;
    repliesWithUsage: number;
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    imageOutputTokens: number;
    avgPromptTokens: number | null;
    avgOutputTokens: number | null;
    // cachedTokens / promptTokens
    cacheHitRate: number | null;
    avgContextMessages: number | null;
    avgContextImages: number | null;
    costUsd: number | null;
    pricedReplyRatio: number | null;
}

export type OutcomeCounts = Record<ReplyOutcome, number>;

/** One model across its routes */
export interface ModelStatsRow {
    model: string;
    platform: string;
    replies: number;
    retries: number;
    errorReplies: number;
    errorRate: number | null;
    stoppedReplies: number;
    emptyReplies: number;
    firstChunkP50Ms: number | null;
    firstChunkP95Ms: number | null;
    durationP50Ms: number | null;
    durationP95Ms: number | null;
    // Σ textChars / Σ (finishedAt - firstChunkAt) of replies that streamed text
    outputCharsPerSecond: number | null;
    avgRounds: number | null;
    toolCalls: number;
    toolFailures: number;
    repliesWithUsage: number;
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    imageOutputTokens: number;
    avgPromptTokens: number | null;
    avgOutputTokens: number | null;
    cacheHitRate: number | null;
    costUsd: number | null;
    pricing: ModelPricingFlag;
}

/** The token sums one cost group is priced from */
export interface CostGroupUsage {
    promptTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    imageOutputTokens: number;
    unsplitImageOutputTokens: number;
    imagesWithoutUsage: number;
    imageRowsWithoutUsage: number;
}

/** One (model, route) group */
export interface CostGroupView {
    model: string;
    route: string | null;
    replies: number;
    repliesWithUsage: number;
    usage: CostGroupUsage;
    costUsd: number | null;
    pricing: PricingFlag;
}

export interface ToolStatsRow {
    name: string;
    calls: number;
    failures: number;
    failureRate: number | null;
    // Replies that called the tool at least once
    replies: number;
}

export interface ErrorKindCount {
    kind: ErrorKind;
    count: number;
}

/** All-chats view only */
export interface ChatStatsRow {
    chatId: number;
    type: ChatType | null;
    title: string | null;
    username: string | null;
    replies: number;
    errorReplies: number;
}

/** One stacked line: a value per bucket of `series.buckets` */
export interface SeriesLine {
    key: string;
    // Display name when the key is an id (chat lines)
    label: string | null;
    values: number[];
}

export interface StatsSeries {
    // Local labels: `YYYY-MM-DD` (day) or `YYYY-MM-DD HH:00` (hour)
    buckets: string[];
    replies: number[];
    errors: number[];
    // Replies per model
    byModel: SeriesLine[];
    // Replies per chat; all-chats view only
    byChat: SeriesLine[] | null;
    // Errors per kind
    byErrorKind: SeriesLine[];
}

export interface RecentErrorRow {
    // When the failed attempt started
    at: string;
    chatId: number;
    // All-chats view only; null in a chat's own statistics
    chatTitle: string | null;
    model: string;
    errorKind: ErrorKind | null;
    errorSummary: string | null;
    // Opens the reply detail
    firstMessageId: number;
    versionId: number;
}

export interface StatsResponse {
    // null = every chat (owner only)
    chatId: number | null;
    range: StatsRangeKey;
    from: string;
    to: string;
    bucket: StatsBucket;
    timeZone: string;
    kpis: StatsKpis;
    outcomes: OutcomeCounts;
    // Most replies first
    models: ModelStatsRow[];
    costGroups: CostGroupView[];
    cost: { costUsd: number | null; pricedReplyRatio: number | null };
    // Most calls first
    tools: ToolStatsRow[];
    // Most frequent first
    errorKinds: ErrorKindCount[];
    chats: ChatStatsRow[] | null;
    series: StatsSeries;
    // Newest first, at most 20
    recentErrors: RecentErrorRow[];
}

export interface StatusChat {
    chatId: number;
    type: ChatType | null;
    // Group title or private chat user's name; null until known
    title: string | null;
    username: string | null;
}

export interface ProcessStatus {
    // Always true: an answer means the bot process is up
    online: true;
    startedAt: string;
    uptimeSeconds: number;
    // Short commit hash; null = unknown
    version: string | null;
    testInstance: boolean;
    globalDefaultModel: string;
    globalDefaultModelSource: 'panel' | 'env';
    // Connected MCP servers only
    mcpServers: Array<{ name: string; toolCount: number }>;
    lastCleanup: { finishedAt: string; elapsedMs: number; summary: string } | null;
}

/** preparing: waiting for media / building the context; waiting: request out, no chunk yet; streaming */
export type ReplyPhase = 'preparing' | 'waiting' | 'streaming';

export interface TriggerSummary {
    messageId: number;
    authorName: string;
    // The first 40 characters of the text, or the media placeholder
    text: string;
}

export interface ActiveReply {
    chat: StatusChat;
    access: ChatAccess;
    firstMessageId: number;
    userMessageId: number;
    model: string;
    platform: string;
    commandType: string;
    isRetry: boolean;
    startedAt: string;
    elapsedMs: number;
    phase: ReplyPhase;
    // The tool status the reply shows right now, e.g. 「🎨 正在画图…」
    statusLine: string | null;
    // Members only; always null for observers
    trigger: TriggerSummary | null;
}

export interface StatusError {
    at: string;
    chat: StatusChat;
    access: ChatAccess;
    model: string;
    errorKind: ErrorKind;
    errorSummary: string;
    firstMessageId: number;
}

export interface StatusResponse {
    serverTime: string;
    // Owner only; null for everyone else
    process: ProcessStatus | null;
    // Longest running first
    active: ActiveReply[];
    // Newest first, at most 50
    recentErrors: StatusError[];
}
