import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { match } from 'ts-pattern';
import {
    MESSAGE_ENTITY_LIMIT,
    entityBudgetOf,
    markdownToRendered,
    renderedToClipboardPayload,
    withQuoteStyle,
} from '../../../tools/entity-convert';
import { renderedToIosMarkdown, renderedToTelegramMarkdown } from '../../../tools/telegram-markdown';
import type { ChannelPlan, RenderedMarkdown } from '../../../tools/types';
import { ChannelActions } from './channel-actions';
import type { ChannelAction } from './channel-actions';
import { ChannelStatus } from './channel-status';
import { EntityJson } from './entity-json';
import { MarkdownEditor, TELEGRAM_MAX_LENGTH } from './markdown-editor';
import { PreviewBubble } from './preview-bubble';
import { useCopyActions } from './use-copy-actions';
import { useForwardPreview } from './use-entity-conversion';

const SAMPLE_MARKDOWN = [
    '**粗体**、*斜体*、__下划线__、~~删除线~~、`行内代码`、[链接](https://example.com)',
    '',
    '> 引用一行',
    '',
    '```ts',
    'const answer = 42;',
    '```',
].join('\n');

const dialectLabelOf = (plan: ChannelPlan): string => (plan.markdownDialect === 'ios' ? 'iOS 方言' : 'Telegram 方言');

/** The toggle forces every quote collapsible; unchecked keeps the source styles */
const withQuoteChoice = (rendered: RenderedMarkdown, collapsedQuotes: boolean): RenderedMarkdown =>
    collapsedQuotes ? withQuoteStyle(rendered, true) : rendered;

interface ForwardPanelProps {
    plan: ChannelPlan;
}

/** Direction 1: markdown -> Telegram entities, live preview and clipboard channels */
export const ForwardPanel = ({ plan }: ForwardPanelProps) => {
    const [markdown, setMarkdown] = useState(SAMPLE_MARKDOWN);
    const [collapsedQuotes, setCollapsedQuotes] = useState(false);
    const preview = useForwardPreview(markdown, collapsedQuotes);
    const { status, copyRich, copyPlainText, reportFailure, clearStatus } = useCopyActions();
    const hasContent = markdown.trim() !== '';
    const macosUnavailable = plan.platform === 'macos';

    // The outcome line describes a copy of content that no longer exists
    useEffect(() => {
        clearStatus();
    }, [clearStatus, markdown, plan.platform, collapsedQuotes]);

    // Telegram counts the sent text, not the markdown source: a long link URL must not inflate it
    const previewMeta = useMemo(() => {
        if (preview.kind !== 'ready') return null;
        const textLength = preview.rendered.text.length;
        const entities = preview.rendered.entities.length;
        const budget = entityBudgetOf(preview.rendered);
        const over = budget.parts > 1;
        return {
            label: over
                ? `${textLength} 字符 · 约 ${budget.parts} 条`
                : `${textLength} 字符 · ${entities} 个实体`,
            over,
            parts: budget.parts,
            entities,
            maxEntitiesPerPart: budget.maxEntitiesPerPart,
            entityRisk: budget.risk,
            entityOver: budget.over,
        };
    }, [preview]);

    const handleQuoteToggle = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => setCollapsedQuotes(event.target.checked),
        []
    );

    const handleCopyRich = useCallback(() => {
        if (markdown.trim() === '') return;
        try {
            const payload = renderedToClipboardPayload(
                withQuoteChoice(markdownToRendered(markdown), collapsedQuotes),
                plan.target
            );
            copyRich(payload.html, payload.plainText);
        } catch {
            reportFailure('转换失败：这段 Markdown 无法生成富文本。');
        }
    }, [markdown, plan.target, collapsedQuotes, copyRich, reportFailure]);

    const handleCopyMarkdown = useCallback(() => {
        if (markdown.trim() === '') return;
        try {
            const rendered = withQuoteChoice(markdownToRendered(markdown), collapsedQuotes);
            const text =
                plan.markdownDialect === 'ios' ? renderedToIosMarkdown(rendered) : renderedToTelegramMarkdown(rendered);
            copyPlainText(text, `Markdown 文本（${dialectLabelOf(plan)}）`);
        } catch {
            reportFailure('转换失败：这段 Markdown 无法生成 Markdown 文本。');
        }
    }, [markdown, plan, collapsedQuotes, copyPlainText, reportFailure]);

    const handleCopyPlain = useCallback(() => {
        if (markdown.trim() === '') return;
        try {
            copyPlainText(markdownToRendered(markdown).text, '纯文本');
        } catch {
            reportFailure('转换失败：这段 Markdown 无法生成纯文本。');
        }
    }, [markdown, copyPlainText, reportFailure]);

    const actions = useMemo<ChannelAction[]>(
        () => [
            {
                id: 'rich-html',
                label: '复制富文本',
                hint: macosUnavailable
                    ? 'macOS 原生客户端不读 HTML 剪贴板'
                    : '到 Telegram 输入框粘贴，格式会保留',
                recommended: plan.recommended === 'rich-html',
                disabled: !hasContent,
                onSelect: handleCopyRich,
            },
            {
                id: 'markdown',
                label: '复制 Markdown 文本',
                hint: macosUnavailable
                    ? 'macOS 原生客户端不会转换 Markdown'
                    : `粘贴后由客户端按 ${dialectLabelOf(plan)} 转换`,
                recommended: plan.recommended === 'markdown',
                disabled: !hasContent,
                onSelect: handleCopyMarkdown,
            },
            {
                id: 'plain',
                label: '复制纯文本',
                hint: '不带格式，最保险的兜底',
                recommended: plan.recommended === 'plain',
                disabled: !hasContent,
                onSelect: handleCopyPlain,
            },
        ],
        [hasContent, macosUnavailable, plan, handleCopyRich, handleCopyMarkdown, handleCopyPlain]
    );

    return (
        <>
            <section className="section">
                <MarkdownEditor value={markdown} onChange={setMarkdown} />
            </section>
            <section className="section">
                <div className="tools-preview-head">
                    <h2 className="section-title">Telegram 预览</h2>
                    {previewMeta !== null && (
                        <span className={previewMeta.over ? 'tools-preview-meta over' : 'tools-preview-meta'}>
                            {previewMeta.label}
                        </span>
                    )}
                </div>
                {match(preview)
                    .with({ kind: 'empty' }, () => <p className="hint">输入 Markdown 后，这里会显示 Telegram 风格的预览。</p>)
                    .with({ kind: 'failed' }, () => <p className="error-text">这段 Markdown 无法渲染，请检查内容。</p>)
                    .with({ kind: 'ready' }, ({ rendered, previewHtml }) => (
                        <>
                            <PreviewBubble html={previewHtml} />
                            <EntityJson rendered={rendered} />
                        </>
                    ))
                    .exhaustive()}
                {preview.kind === 'ready' && preview.hasQuote && (
                    <label className="tools-quote-toggle">
                        <input type="checkbox" checked={collapsedQuotes} onChange={handleQuoteToggle} />
                        <span className="tools-quote-toggle-label">折叠引用</span>
                        <span className="hint">
                            把所有引用统一成可折叠引用；Desktop 粘贴时会按普通引用导入，粘贴后可在输入框里手动把引用切换成折叠样式。
                        </span>
                    </label>
                )}
                {previewMeta !== null && previewMeta.over && (
                    <p className="hint">
                        超过 {TELEGRAM_MAX_LENGTH} 字符，发送时客户端会自动拆成约 {previewMeta.parts} 条消息，不用手动分条；
                        拆分点处的格式会在每条消息里各自重新开始。
                    </p>
                )}
                {previewMeta !== null && previewMeta.entityRisk && (
                    <p className="notice warning">
                        {previewMeta.over
                            ? `实体 ${previewMeta.entities} 个；拆成约 ${previewMeta.parts} 条后，其中一条最多约 ${previewMeta.maxEntitiesPerPart} 个，${previewMeta.entityOver ? '超出' : '接近'}单条上限（约 ${MESSAGE_ENTITY_LIMIT} 个）；${previewMeta.entityOver ? '超出的部分发送时会被静默丢掉。' : '继续增加格式就可能被丢弃。'}`
                            : `实体 ${previewMeta.entities} 个，${previewMeta.entityOver ? '超出' : '接近'} Telegram 单条消息的实体上限（约 ${MESSAGE_ENTITY_LIMIT} 个）；超出的部分发送时可能被静默丢掉。`}
                    </p>
                )}
                <ChannelActions actions={actions} />
                <p className="hint">{plan.note}</p>
                <ChannelStatus status={status} />
            </section>
        </>
    );
};
