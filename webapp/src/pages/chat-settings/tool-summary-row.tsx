import { useMemo } from 'react';
import type { ToolGroupEntry } from '../../api';
import { NavListItem } from '../../components/nav-list-item';
import { chatSettingsToolsPath } from '../../routing/paths';

interface ToolSummaryRowProps {
    chatId: number;
    tools: readonly ToolGroupEntry[];
}

/** 「工具 · N/M 组可用 ›」, opening the tool groups and their switches */
export const ToolSummaryRow = ({ chatId, tools }: ToolSummaryRowProps) => {
    const enabledCount = useMemo(() => tools.filter((tool) => tool.enabled).length, [tools]);

    return (
        <section className="section">
            <ul className="list">
                <NavListItem to={chatSettingsToolsPath(chatId)} label={`工具 · ${enabledCount}/${tools.length} 组可用`} />
            </ul>
        </section>
    );
};
