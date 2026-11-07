import { useMemo } from 'react';
import { Link } from 'react-router';
import type { ErrorKindCount, RecentErrorRow } from '../../api';
import { formatDateTime } from '../../format';
import { errorKindLabel, formatCount } from '../../format-metrics';
import { replyPath } from '../../routing/paths';
import { RankBars } from './charts/rank-bars';
import type { RankRow } from './charts/rank-bars';

interface StatsErrorsProps {
    errorKinds: readonly ErrorKindCount[];
    recentErrors: readonly RecentErrorRow[];
    // The all-chats view names the chat of each error
    showChat: boolean;
}

const ERROR_PREVIEW_CHARS = 120;

const previewOf = (summary: string | null): string => {
    if (summary === null || summary === '') return '（没有错误摘要）';
    const characters = Array.from(summary);
    return characters.length <= ERROR_PREVIEW_CHARS
        ? summary
        : `${characters.slice(0, ERROR_PREVIEW_CHARS).join('')}…`;
};

/** Error kinds as a ranking, then the newest errors with a way into each reply */
export const StatsErrors = ({ errorKinds, recentErrors, showChat }: StatsErrorsProps) => {
    const rows = useMemo<RankRow[]>(
        () =>
            errorKinds.map((entry) => ({
                key: entry.kind,
                label: errorKindLabel(entry.kind),
                value: entry.count,
                detail: null,
            })),
        [errorKinds]
    );

    return (
        <>
            <RankBars
                title="错误类型"
                hint="同一个范围里各错误类型的次数"
                rows={rows}
                formatValue={formatCount}
                valueLabel="次数"
                ariaLabel="错误类型分布"
            />
            <section className="section">
                <h2 className="section-title">最近错误</h2>
                {recentErrors.length === 0 ? (
                    <p className="hint">这个范围里没有错误</p>
                ) : (
                    <ul className="list">
                        {recentErrors.map((error) => (
                            <li key={`${error.versionId}:${error.firstMessageId}`}>
                                <Link className="list-link" to={replyPath(error.chatId, error.firstMessageId)}>
                                    <span className="list-title">
                                        <span className="error-text truncate">
                                            ⚠ {errorKindLabel(error.errorKind)} · {error.model}
                                        </span>
                                        <span className="chevron" aria-hidden="true">
                                            ›
                                        </span>
                                    </span>
                                    <span className="hint">
                                        {formatDateTime(error.at)}
                                        {showChat && error.chatTitle !== null ? ` · ${error.chatTitle}` : ''}
                                    </span>
                                    <span className="hint prewrap">{previewOf(error.errorSummary)}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
};
