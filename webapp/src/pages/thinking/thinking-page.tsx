import type { ReactNode } from 'react';
import { match } from 'ts-pattern';
import type { ApiFailure } from '../../api';
import { ConnectivityBanner } from '../../components/connectivity-banner';
import { ErrorView, LoadingView } from '../../components/status-views';
import { thinkingFastPagePath } from '../../routing/paths';
import { ThinkingBody } from './thinking-body';
import { ThinkingHeader } from './thinking-header';
import { thinkingNoteOf } from './thinking-status';
import { usePublicThinking } from './use-public-thinking';
import type { PublicThinking } from './use-public-thinking';

interface ThinkingPageFrameProps {
    children: ReactNode;
}

/** The standalone page shell: no tab layers, no panel header, no actions */
const ThinkingPageFrame = ({ children }: ThinkingPageFrameProps) => (
    <div className="app thinking-app">
        <ConnectivityBanner />
        <main className="page">{children}</main>
    </div>
);

/** A 404 is the only failure the page can explain: the token is the permission */
const thinkingFailureMessageOf = (failure: ApiFailure): string | undefined =>
    failure.kind === 'http' && failure.status === 404 ? '这条思考链接不存在或已失效。' : undefined;

interface LoadedThinkingProps {
    thinking: PublicThinking;
}

/** One thinking link's content; the fast page link stays available as a plain-html fallback */
const LoadedThinking = ({ thinking }: LoadedThinkingProps) => {
    const note = thinkingNoteOf(thinking);
    return (
        <>
            <ThinkingHeader thinking={thinking} />
            {note !== null && <p className="notice thinking-note">{note}</p>}
            {thinking.status !== 'unavailable' && (
                <ThinkingBody text={thinking.text} streaming={thinking.status === 'generating'} />
            )}
            <footer className="thinking-footer">
                <a className="button secondary" href={thinkingFastPagePath(thinking.token)}>
                    打开网页版
                </a>
            </footer>
        </>
    );
};

interface ThinkingPageProps {
    token: string;
}

/**
 * One long CoT, read-only: the token is the permission. Polled while it is
 * still generating, then left as is once the stream ends.
 */
export const ThinkingPage = ({ token }: ThinkingPageProps) => {
    const { state, reload } = usePublicThinking(token);

    return match(state)
        .with({ status: 'loading' }, () => (
            <ThinkingPageFrame>
                <LoadingView />
            </ThinkingPageFrame>
        ))
        .with({ status: 'error' }, ({ failure }) => (
            <ThinkingPageFrame>
                <ErrorView failure={failure} onRetry={reload} message={thinkingFailureMessageOf(failure)} />
            </ThinkingPageFrame>
        ))
        .with({ status: 'ready' }, ({ thinking }) => (
            <ThinkingPageFrame>
                <LoadedThinking thinking={thinking} />
            </ThinkingPageFrame>
        ))
        .exhaustive();
};
