import { useMemo } from 'react';
import type { ToolAvailability } from '../../api';

interface ToolMatrixProps {
    tools: readonly ToolAvailability[];
}

/** Read-only: which tools the current model can use in this chat, and why not */
export const ToolMatrix = ({ tools }: ToolMatrixProps) => {
    const enabledCount = useMemo(() => tools.filter((tool) => tool.enabled).length, [tools]);

    return (
        <section className="section">
            <details className="tool-matrix">
                <summary className="section-title">
                    工具 {enabledCount}/{tools.length} 可用
                </summary>
                {tools.length === 0 ? (
                    <p className="placeholder">没有工具</p>
                ) : (
                    <ul className="list">
                        {tools.map((tool) => (
                            <li key={tool.name} className="tool-row">
                                <span className="tool-name">{tool.name}</span>
                                <span className={tool.enabled ? 'badge success' : 'badge'}>{tool.enabled ? '开' : '关'}</span>
                                {tool.reason !== null && <span className="hint tool-reason">{tool.reason}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </details>
        </section>
    );
};
