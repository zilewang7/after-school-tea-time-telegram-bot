import { useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { ChatSummary } from '../../../api';
import { chatLabelOf } from '../../../format';
import { ISSUE_SOURCE_OPTIONS, parseIssueSource } from '../../../issues/issue-labels';
import type { IssueFilters } from './issue-filters';

// Option value meaning "no filter"; never a source or a chat id
const ALL_OPTION = 'all';

interface IssueScopeFiltersProps {
    filters: IssueFilters;
    // Chats the user can open, from /api/me
    chats: readonly ChatSummary[];
    onChange: (filters: IssueFilters) => void;
}

/** The home list's extra filters: who filed it, and which chat */
export const IssueScopeFilters = ({ filters, chats, onChange }: IssueScopeFiltersProps) => {
    const handleSourceChange = useCallback(
        (event: ChangeEvent<HTMLSelectElement>) => onChange({ ...filters, source: parseIssueSource(event.target.value) }),
        [filters, onChange]
    );
    const handleChatChange = useCallback(
        (event: ChangeEvent<HTMLSelectElement>) => {
            const optionValue = event.target.value;
            const chat = chats.find((candidate) => String(candidate.chatId) === optionValue);
            onChange({ ...filters, chatId: chat === undefined ? null : chat.chatId });
        },
        [filters, chats, onChange]
    );

    return (
        <div className="filter-row">
            <select
                className="field"
                aria-label="来源"
                value={filters.source ?? ALL_OPTION}
                onChange={handleSourceChange}
            >
                <option value={ALL_OPTION}>全部来源</option>
                {ISSUE_SOURCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            <select
                className="field"
                aria-label="聊天"
                value={filters.chatId === null ? ALL_OPTION : String(filters.chatId)}
                onChange={handleChatChange}
            >
                <option value={ALL_OPTION}>全部聊天</option>
                {chats.map((chat) => (
                    <option key={chat.chatId} value={String(chat.chatId)}>
                        {chatLabelOf(chat)}
                    </option>
                ))}
            </select>
        </div>
    );
};
