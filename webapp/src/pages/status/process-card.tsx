import { useMemo } from 'react';
import type { ProcessStatus } from '../../api';
import { formatDateTime } from '../../format';
import { formatMs } from '../../format-metrics';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const uptimeOf = (seconds: number): string => {
    if (seconds < SECONDS_PER_MINUTE) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    if (minutes < MINUTES_PER_HOUR) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    if (hours < HOURS_PER_DAY) return `${hours} 小时 ${minutes % MINUTES_PER_HOUR} 分`;
    return `${Math.floor(hours / HOURS_PER_DAY)} 天 ${hours % HOURS_PER_DAY} 小时`;
};

const sourceLabelOf = (source: 'panel' | 'env'): string => (source === 'panel' ? '面板设置' : '环境变量');

interface ProcessCardProps {
    process: ProcessStatus;
}

/** Owner only: process facts of the bot (design §6.8) */
export const ProcessCard = ({ process }: ProcessCardProps) => {
    const mcpText = useMemo(() => {
        if (process.mcpServers.length === 0) return '没有已连接的 MCP 服务器';
        const tools = process.mcpServers.reduce((total, server) => total + server.toolCount, 0);
        const names = process.mcpServers.map((server) => `${server.name}（${server.toolCount}）`).join(' · ');
        return `${process.mcpServers.length} 个 / ${tools} 个工具：${names}`;
    }, [process.mcpServers]);

    const cleanupText = useMemo(() => {
        const cleanup = process.lastCleanup;
        if (cleanup === null) return '这次启动后还没跑过';
        return `${formatDateTime(cleanup.finishedAt)} · ${cleanup.summary} · ${formatMs(cleanup.elapsedMs)}`;
    }, [process.lastCleanup]);

    return (
        <section className="section">
            <h2 className="section-title">进程</h2>
            <p className="badges">
                <span className="badge success">在线</span>
                <span className="badge">{process.version ?? '版本未知'}</span>
                {process.testInstance && <span className="badge warning">测试实例</span>}
            </p>
            <dl className="facts">
                <dt>启动于</dt>
                <dd>
                    {formatDateTime(process.startedAt)}（已运行 {uptimeOf(process.uptimeSeconds)}）
                </dd>
                <dt>全局默认模型</dt>
                <dd>
                    {process.globalDefaultModel}（{sourceLabelOf(process.globalDefaultModelSource)}）
                </dd>
                <dt>MCP</dt>
                <dd>{mcpText}</dd>
                <dt>上次清理</dt>
                <dd>{cleanupText}</dd>
            </dl>
        </section>
    );
};
