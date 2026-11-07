import { useMemo } from 'react';
import type { ToolAvailability } from '../../api';
import { NavListItem } from '../../components/nav-list-item';
import { chatSettingsToolsPath } from '../../routing/paths';

interface ToolSummaryRowProps {
    chatId: number;
    tools: readonly ToolAvailability[];
}

/** 「工具 · N/M 已启用 ›」, opening the full tool list */
export const ToolSummaryRow = ({ chatId, tools }: ToolSummaryRowProps) => {
    const enabledCount = useMemo(() => tools.filter((tool) => tool.enabled).length, [tools]);

    return (
        <section className="section">
            <ul className="list">
                <NavListItem to={chatSettingsToolsPath(chatId)} label={`工具 · ${enabledCount}/${tools.length} 已启用`} />
            </ul>
        </section>
    );
};
