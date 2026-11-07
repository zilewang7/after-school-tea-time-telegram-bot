import type { IssueKind, IssueListQuery, IssueSource } from '../../../api';

export interface IssueFilters {
    // 未关闭 (status open) or 全部
    openOnly: boolean;
    kind: IssueKind | null;
    // Home list only
    source: IssueSource | null;
    // Home list only; a chat's tab is pinned to its chat
    chatId: number | null;
}

export const DEFAULT_ISSUE_FILTERS: IssueFilters = { openOnly: true, kind: null, source: null, chatId: null };

/** The API query for one page: `scopeChatId` (a chat's tab) wins over the chosen chat filter */
export const issueListQueryOf = (scopeChatId: number | null, filters: IssueFilters, offset: number): IssueListQuery => ({
    status: filters.openOnly ? 'open' : null,
    kind: filters.kind,
    source: filters.source,
    chatId: scopeChatId ?? filters.chatId,
    offset,
});
