import { useCallback, useMemo, useState } from 'react';
import { match } from 'ts-pattern';
import type { ShareLink } from '../api';
import { copyText } from '../clipboard';
import { useWebApp } from '../context/panel-context';
import { useConfirm, useSuccessHaptic } from '../hooks/use-telegram-feedback';
import { openShareSheet } from '../telegram-features';
import type { ShareOpenResult } from '../telegram-features';
import { shareTextOf, telegramShareUrlOf } from './share-link';
import type { ShareTarget } from './share-link';
import { useShare } from './use-share';

interface ShareBarProps {
    target: ShareTarget;
    // The chat's name for the share text 「来自 <群名> 的 …」
    chatName: string;
    // 1-based reply version the link pins; null for a conversation
    versionLabel: number | null;
    // Asked before creating (e.g. 「链接公开…」); null = create straight away
    confirmMessage: string | null;
}

const createLabelOf = (target: ShareTarget): string =>
    match(target.kind)
        .with('reply', () => '分享这条回复')
        .with('conversation', () => '分享整个会话')
        .exhaustive();

const createHintOf = (target: ShareTarget, versionLabel: number | null): string =>
    match(target.kind)
        .with('reply', () =>
            versionLabel === null
                ? '链接公开，拿到链接的人都能查看这条回复'
                : `分享第 ${versionLabel} 版；链接公开，拿到链接的人都能查看`
        )
        .with('conversation', () => '链接公开，拿到链接的人都能查看这段对话')
        .exhaustive();

const createdHintOf = (share: ShareLink): string => {
    const views = share.viewCount > 0 ? ` · 已查看 ${share.viewCount} 次` : '';
    const source = share.source === 'system' ? ' · 由 bot 自动创建' : '';
    return `链接公开，拿到链接的人都能查看${views}${source}`;
};

/** One target's share link: create it (then open the share sheet), copy it, revoke it */
export const ShareBar = ({ target, chatName, versionLabel, confirmMessage }: ShareBarProps) => {
    const webApp = useWebApp();
    const confirm = useConfirm();
    const notifySuccess = useSuccessHaptic();
    const { share, loading, busy, error, create, revoke } = useShare(target);
    const [copied, setCopied] = useState(false);
    const [openedAs, setOpenedAs] = useState<ShareOpenResult | null>(null);

    const shareText = useMemo(() => shareTextOf(chatName, target.kind), [chatName, target.kind]);
    const createLabel = useMemo(() => createLabelOf(target), [target]);
    const createHint = useMemo(() => createHintOf(target, versionLabel), [target, versionLabel]);
    const createdHint = useMemo(() => (share === null ? null : createdHintOf(share)), [share]);

    const openShare = useCallback(
        (link: ShareLink) => {
            setOpenedAs(openShareSheet(webApp, telegramShareUrlOf(link.url, shareText)));
        },
        [webApp, shareText]
    );

    const handleCreate = useCallback(() => {
        void (async () => {
            if (confirmMessage !== null && !(await confirm(confirmMessage))) return;
            const created = await create();
            if (created === null) return;
            notifySuccess();
            openShare(created);
        })();
    }, [confirmMessage, confirm, create, notifySuccess, openShare]);

    const handleOpen = useCallback(() => {
        if (share !== null) openShare(share);
    }, [openShare, share]);

    const handleCopy = useCallback(() => {
        if (share === null) return;
        void copyText(share.url).then(setCopied);
    }, [share]);

    const handleRevoke = useCallback(() => {
        setCopied(false);
        setOpenedAs(null);
        void revoke();
    }, [revoke]);

    if (loading) return <p className="hint">正在读取分享状态…</p>;

    if (share === null) {
        return (
            <div className="share-bar">
                <button type="button" className="button primary" disabled={busy} onClick={handleCreate}>
                    {busy ? '创建中…' : createLabel}
                </button>
                <p className="hint">{createHint}</p>
                {error !== null && <p className="error-text">{error}</p>}
            </div>
        );
    }

    return (
        <div className="share-bar">
            <p className="share-url">{share.url}</p>
            {createdHint !== null && <p className="hint">{createdHint}</p>}
            <div className="filter-row">
                <button type="button" className="button primary" disabled={busy} onClick={handleOpen}>
                    在 Telegram 分享
                </button>
                <button type="button" className="button secondary" onClick={handleCopy}>
                    {copied ? '已复制' : '复制链接'}
                </button>
                {share.canRevoke && (
                    <button type="button" className="button secondary danger" disabled={busy} onClick={handleRevoke}>
                        {busy ? '处理中…' : '取消分享'}
                    </button>
                )}
            </div>
            {openedAs === 'window' && (
                <p className="hint">当前客户端没有 Telegram 分享面板，可以复制上面的链接发给别人。</p>
            )}
            {error !== null && <p className="error-text">{error}</p>}
        </div>
    );
};
