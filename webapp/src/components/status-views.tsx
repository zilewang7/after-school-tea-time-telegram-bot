import { describeReadFailure } from '../api';
import type { ApiFailure } from '../api';

export const LoadingView = () => <p className="placeholder">加载中…</p>;

interface ErrorViewProps {
    failure: ApiFailure;
    onRetry: () => void;
    // Replaces the generic wording, e.g. for a 404 that has a page-specific meaning
    message?: string;
}

export const ErrorView = ({ failure, onRetry, message }: ErrorViewProps) => {
    // 401 = the credential is invalid or its initData is older than 24h; it never refreshes
    // while the panel stays open, so retrying cannot help
    const canRetry = !(failure.kind === 'http' && failure.status === 401);
    return (
        <div className="placeholder">
            <p className="error-text">{message ?? describeReadFailure(failure)}</p>
            {canRetry && (
                <button type="button" className="button secondary" onClick={onRetry}>
                    重试
                </button>
            )}
        </div>
    );
};
