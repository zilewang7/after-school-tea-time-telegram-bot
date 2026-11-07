import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ReplyDetail, ReplyVersion } from '../../../api';
import { CollapsibleSection } from '../../../components/collapsible-section';
import { FoldableText } from '../../../components/foldable-text';
import { formatDateTime } from '../../../format';
import { formatBytes } from '../../../format-metrics';
import { conversationPath } from '../../../routing/paths';
import { ReplyMetricsPanel } from './reply-metrics-panel';
import { ReplyToolsPanel } from './reply-tools-panel';
import { ReplyVersionPicker } from './reply-version-picker';

const THINKING_SUMMARY_CHARS = 10000;

const attachmentsTextOf = (version: ReplyVersion): string | null => {
    if (version.attachments.length === 0) return null;
    return version.attachments
        .map((attachment) => {
            const kind = attachment.kind === 'image' ? '图片' : attachment.kind === 'sticker' ? '贴纸' : '文件';
            const mime = attachment.mimeType ?? '类型未知';
            return `${kind} · ${mime} · ${formatBytes(attachment.sizeBytes)}`;
        })
        .join('\n');
};

interface ReplyBodyProps {
    version: ReplyVersion;
}

const ReplyBody = ({ version }: ReplyBodyProps) => {
    const attachments = useMemo(() => attachmentsTextOf(version), [version]);
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

            {attachments !== null && (
                <CollapsibleSection title="附件" summary={`${version.attachments.length} 个`}>
                    <p className="prewrap hint">{attachments}</p>
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
    reply: ReplyDetail;
}

/** One bot reply: version chips, metrics and the full version body */
export const ReplyDetailView = ({ chatId, reply }: ReplyDetailViewProps) => {
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
                    <ReplyBody version={version} />
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
