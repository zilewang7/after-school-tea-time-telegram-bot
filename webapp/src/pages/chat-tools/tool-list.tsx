import type { ToolAvailability } from '../../api';

interface ToolListProps {
    tools: readonly ToolAvailability[];
}

/** Read-only: which tools the current model can use in this chat, and why not */
export const ToolList = ({ tools }: ToolListProps) => {
    if (tools.length === 0) return <p className="placeholder">没有工具</p>;
    return (
        <ul className="list">
            {tools.map((tool) => (
                <li key={tool.name} className="tool-row">
                    <span className="tool-name">{tool.name}</span>
                    <span className={tool.enabled ? 'badge success' : 'badge'}>{tool.enabled ? '开' : '关'}</span>
                    {tool.reason !== null && <span className="hint tool-reason">{tool.reason}</span>}
                </li>
            ))}
        </ul>
    );
};
