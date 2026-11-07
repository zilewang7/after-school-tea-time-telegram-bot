import { Link } from 'react-router';
import type { StatusError } from '../../api';
import { formatDateTime } from '../../format';
import { errorKindLabel } from '../../format-metrics';
import { replyPath } from '../../routing/paths';

interface StatusErrorsProps {
    errors: readonly StatusError[];
}

/** The in-memory ring of recent errors (emptied by a restart); each row opens its reply */
export const StatusErrors = ({ errors }: StatusErrorsProps) => (
    <section className="section">
        <h2 className="section-title">最近错误（{errors.length}）</h2>
        {errors.length === 0 ? (
            <p className="hint">这次启动以来没有错误</p>
        ) : (
            <ul className="list">
                {errors.map((error) => (
                    <li key={`${error.chat.chatId}:${error.firstMessageId}:${error.at}`}>
                        <Link className="list-link" to={replyPath(error.chat.chatId, error.firstMessageId)}>
                            <span className="list-title">
                                <span className="error-text truncate">
                                    ⚠ {errorKindLabel(error.errorKind)} · {error.model}
                                </span>
                                <span className="chevron" aria-hidden="true">
                                    ›
                                </span>
                            </span>
                            <span className="hint">
                                {formatDateTime(error.at)} · {error.chat.title ?? `聊天 ${error.chat.chatId}`}
                            </span>
                            <span className="hint prewrap">{error.errorSummary}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        )}
    </section>
);
