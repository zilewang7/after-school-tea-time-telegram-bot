import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';
import type { ReplyAttachment, ReplyDetail, ReplyVersion } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { MediaAttachmentView } from '../../../components/media-attachment-view';
import { FoldableText } from '../../../components/foldable-text';
import { formatDateTime } from '../../../format';
import { formatBytes } from '../../../format-metrics';
import { conversationPath } from '../../../routing/paths';
import { ShareBar } from '../../../share/share-bar';
import type { ShareTarget } from '../../../share/share-link';
import { ReplyMetricsPanel } from './reply-metrics-panel';
import { ReplyToolsPanel } from './reply-tools-panel';
import { ReplyVersionPicker } from './reply-version-picker';
import { WidgetView } from './widget-view';

const THINKING_SUMMARY_CHARS = 10000;

const attachmentLabelOf = (kind: ReplyAttachment['kind']): string =>
    match(kind)
        .with('image', () => '图片')
        .with('sticker', () => '贴纸')
        .with('file', () => '文件')
        .with('widget', () => '组件')
        .exhaustive();

/** Attachments listed as text; the widget itself renders as a card below the body */
const listedAttachmentsOf = (version: ReplyVersion): ReplyAttachment[] =>
    version.attachments.filter((attachment) => attachment.kind !== 'widget');

const attachmentsTextOf = (attachments: readonly ReplyAttachment[]): string =>
    attachments
        .map(
            (attachment) =>
                `${attachmentLabelOf(attachment.kind)} · ${attachment.mimeType ?? '类型未知'} · ${formatBytes(attachment.sizeBytes)}`
        )
        .join('\n');

interface ReplyBodyProps {
    version: ReplyVersion;
    // A share opened this reply: land on the widget card
    focusWidget: boolean;
}

const ReplyBody = ({ version, focusWidget }: ReplyBodyProps) => {
    const attachments = useMemo(() => listedAttachmentsOf(version), [version]);
    const attachmentsText = useMemo(() => attachmentsTextOf(attachments), [attachments]);
    // The rendered PNG is what a failed iframe falls back to
    const widgetHasImage = useMemo(
        () => version.attachments.some((attachment) => attachment.kind === 'widget' && attachment.hasImage === true),
        [version.attachments]
    );
    const thinkingLength = useMemo(
        () => (version.thinkingText === null ? 0 : Array.from(version.thinkingText).length),
        [version.thinkingText]
    );
    return (
        <>
            {version.text === '' ? (
                <p className="placeholder">这一版没有正文</p>
            ) : (
                <FoldableText text={version.text} foldLines={12} foldChars={900} />
            )}

            {version.media !== null && <MediaAttachmentView media={version.media} />}

            {version.thinkingText !== null && version.thinkingText !== '' && (
                <CollapsibleSection
                    title="思考"
                    summary={thinkingLength >= THINKING_SUMMARY_CHARS ? '已截断' : `${thinkingLength} 字`}
                >
                    <FoldableText text={version.thinkingText} foldLines={20} foldChars={2000} />
                </CollapsibleSection>
            )}

            {(version.tools.toolUsage.length > 0 ||
                version.tools.calls.length > 0 ||
                version.tools.sources.length > 0 ||
                version.tools.searches.length > 0 ||
                version.tools.codeInterpreter.length > 0) && (
                <CollapsibleSection
                    title="工具"
                    summary={`${version.tools.toolUsage.reduce((total, tool) => total + tool.count, 0)} 次调用`}
                >
                    <ReplyToolsPanel tools={version.tools} />
                </CollapsibleSection>
            )}

            {version.widget !== undefined && (
                <WidgetView widget={version.widget} hasImage={widgetHasImage} autoFocus={focusWidget} />
            )}

            {version.media === null && attachments.length > 0 && (
                <CollapsibleSection title="附件" summary={`${attachments.length} 个`}>
                    <p className="prewrap hint">{attachmentsText}</p>
                </CollapsibleSection>
            )}

            {version.errorMessage !== null && <p className="error-text prewrap">⚠ {version.errorMessage}</p>}
            {version.wasStoppedByUser && <p className="hint">这一版被用户停止</p>}
            {version.hasModelParts && <p className="hint">含模型签名 part（不回放）</p>}
        </>
    );
};

interface ReplyDetailViewProps {
    chatId: number;
    // The chat's name, for the share text
    chatName: string;
    reply: ReplyDetail;
    // A share opened this reply: land on the widget card
    focusWidget: boolean;
}

/** One bot reply: version chips, metrics and the full version body */
export const ReplyDetailView = ({ chatId, chatName, reply, focusWidget }: ReplyDetailViewProps) => {
    const defaultVersion = reply.currentVersion ?? reply.versionCount;
    const [selected, setSelected] = useState<number | null>(defaultVersion >= 1 ? defaultVersion : null);

    const versionNumbers = useMemo(
        () => reply.versions.map((_, index) => index + 1),
        [reply.versions]
    );
    const version = useMemo(
        () => (selected === null ? null : (reply.versions[selected - 1] ?? null)),
        [reply.versions, selected]
    );
    const conversationLink = useMemo(
        () => (reply.rootId === null ? null : conversationPath(chatId, reply.rootId)),
        [chatId, reply.rootId]
    );
    // A reply share pins the selected version
    const shareTarget = useMemo<ShareTarget | null>(
        () =>
            version === null
                ? null
                : { kind: 'reply', chatId, firstMessageId: reply.firstMessageId, versionId: version.versionId },
        [chatId, reply.firstMessageId, version]
    );

    if (reply.versions.length === 0) {
        return (
            <section className="section">
                <p className="placeholder">
                    {reply.generating ? '正在生成，还没有可看的版本' : '这条回复没有留下版本'}
                </p>
            </section>
        );
    }

    return (
        <>
            <section className="section">
                <ReplyVersionPicker
                    versionNumbers={versionNumbers}
                    selected={selected}
                    current={reply.currentVersion}
                    onSelect={setSelected}
                />
                {version !== null && selected !== null && shareTarget !== null && (
                    // Keyed by version: each version has its own share link and state
                    <ShareBar
                        key={version.versionId}
                        target={shareTarget}
                        chatName={chatName}
                        versionLabel={selected}
                        confirmMessage={null}
                    />
                )}
                {version === null ? (
                    <p className="placeholder">选择一个版本</p>
                ) : (
                    <>
                        <p className="badges">
                            <span className="badge accent">{version.model ?? '模型未知'}</span>
                            <span className="badge">{formatDateTime(version.createdAt)}</span>
                            {reply.commandType !== null && <span className="badge">{reply.commandType}</span>}
                            {reply.generating && <span className="badge warning">生成中</span>}
                        </p>
                        {version.metrics === null ? (
                            <p className="hint">这一版没有指标（生成于指标上线之前，或指标写入失败）</p>
                        ) : (
                            <ReplyMetricsPanel metrics={version.metrics} />
                        )}
                    </>
                )}
            </section>

            {version !== null && (
                <section className="section">
                    <h2 className="section-title">正文</h2>
                    <ReplyBody version={version} focusWidget={focusWidget} />
                </section>
            )}

            {conversationLink !== null && (
                <section className="section">
                    <ul className="list">
                        <li>
                            <Link className="list-link" to={conversationLink}>
                                <span className="list-title">
                                    <span>所在会话</span>
                                    <span className="chevron" aria-hidden="true">
                                        ›
                                    </span>
                                </span>
                            </Link>
                        </li>
                    </ul>
                </section>
            )}
        </>
    );
};
