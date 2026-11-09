import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { match, P } from 'ts-pattern';
import { describePublicShareFailure } from '../../api';
import type { PublicShare } from '../../api';
import { ConnectivityBanner } from '../../components/connectivity-banner';
import { ErrorView, LoadingView } from '../../components/status-views';
import { usePublicShare } from '../../hooks/use-public-share';
import { useViewerChats } from '../../hooks/use-viewer-chats';
import type { ViewerChatsState } from '../../hooks/use-viewer-chats';
import { ShareConversationContent } from './share-conversation-content';
import { ShareHeader } from './share-header';
import { shareRedirectPathOf } from './share-redirect';
import { ShareReplyContent } from './share-reply-content';

interface SharePageFrameProps {
    children: ReactNode;
}

/** The standalone page shell: no tab layers, no panel header, no actions */
const SharePageFrame = ({ children }: SharePageFrameProps) => (
    <div className="app share-app">
        <ConnectivityBanner />
        <main className="page">{children}</main>
    </div>
);

/** The shared content itself; a payload missing for its kind renders as empty rather than crashing */
const shareContentOf = (token: string, share: PublicShare): ReactNode =>
    match(share)
        .with({ kind: 'reply', reply: P.nonNullable }, ({ reply }) => (
            <ShareReplyContent token={token} reply={reply} />
        ))
        .with({ kind: 'conversation', conversation: P.nonNullable }, ({ conversation }) => (
            <ShareConversationContent token={token} conversation={conversation} />
        ))
        .otherwise(() => <p className="placeholder">分享内容为空</p>);

interface LoadedSharePageProps {
    token: string;
    share: PublicShare;
    viewer: ViewerChatsState;
}

/**
 * The loaded share: a viewer who may open the chat is sent on to the panel's
 * own reply / conversation page (same actions as before); everyone else reads
 * the content here. Access is decided before the content shows, so a member
 * never sees the read-only view flash.
 */
const LoadedSharePage = ({ token, share, viewer }: LoadedSharePageProps) => {
    const redirectPath = useMemo(
        () =>
            viewer.status !== 'done' || viewer.chats === null ? null : shareRedirectPathOf(share, viewer.chats),
        [share, viewer]
    );

    if (redirectPath !== null) return <Navigate replace to={redirectPath} />;

    if (viewer.status === 'loading') {
        return (
            <SharePageFrame>
                <LoadingView />
            </SharePageFrame>
        );
    }

    return (
        <SharePageFrame>
            <ShareHeader chatTitle={share.chatTitle} createdAt={share.createdAt} />
            {shareContentOf(token, share)}
            <p className="hint share-footer">由 k-on-bot 分享 · 公开只读</p>
        </SharePageFrame>
    );
};

interface SharePageProps {
    token: string;
}

/**
 * One share, read-only: the token is the permission. /api/me only decides the
 * redirect; failing it never hides the content.
 */
export const SharePage = ({ token }: SharePageProps) => {
    const { state, reload } = usePublicShare(token);
    const viewer = useViewerChats();

    return match(state)
        .with({ status: 'loading' }, () => (
            <SharePageFrame>
                <LoadingView />
            </SharePageFrame>
        ))
        .with({ status: 'error' }, ({ failure }) => (
            <SharePageFrame>
                <ErrorView failure={failure} onRetry={reload} message={describePublicShareFailure(failure)} />
            </SharePageFrame>
        ))
        .with({ status: 'success' }, ({ data }) => (
            <LoadedSharePage token={token} share={data.share} viewer={viewer} />
        ))
        .exhaustive();
};
