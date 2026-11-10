import { useCallback, useMemo, useState } from 'react';
import { match } from 'ts-pattern';
import { markdownToRendered, renderedToClipboardPayload } from '../../../tools/entity-convert';
import { renderedToIosMarkdown, renderedToTelegramMarkdown } from '../../../tools/telegram-markdown';
import type { ChannelPlan } from '../../../tools/types';
import { ChannelActions } from './channel-actions';
import type { ChannelAction } from './channel-actions';
import { ChannelStatus } from './channel-status';
import { EntityJson } from './entity-json';
import { MarkdownEditor } from './markdown-editor';
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

interface ForwardPanelProps {
    plan: ChannelPlan;
}

/** Direction 1: markdown -> Telegram entities, live preview and clipboard channels */
export const ForwardPanel = ({ plan }: ForwardPanelProps) => {
    const [markdown, setMarkdown] = useState(SAMPLE_MARKDOWN);
    const preview = useForwardPreview(markdown);
    const { status, copyRich, copyPlainText, reportFailure } = useCopyActions();
    const hasContent = markdown.trim() !== '';

    const handleCopyRich = useCallback(() => {
        if (markdown.trim() === '') return;
        try {
            const payload = renderedToClipboardPayload(markdownToRendered(markdown), plan.target);
            copyRich(payload.html, payload.plainText);
        } catch {
            reportFailure('转换失败：这段 Markdown 无法生成富文本。');
        }
    }, [markdown, plan.target, copyRich, reportFailure]);

    const handleCopyMarkdown = useCallback(() => {
        if (markdown.trim() === '') return;
        try {
            const rendered = markdownToRendered(markdown);
            const text =
                plan.markdownDialect === 'ios' ? renderedToIosMarkdown(rendered) : renderedToTelegramMarkdown(rendered);
            copyPlainText(text, `Markdown 文本（${dialectLabelOf(plan)}）`);
        } catch {
            reportFailure('转换失败：这段 Markdown 无法生成 Markdown 文本。');
        }
    }, [markdown, plan, copyPlainText, reportFailure]);

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
                hint: '到 Telegram 输入框粘贴，格式会保留',
                recommended: plan.recommended === 'rich-html',
                disabled: !hasContent,
                onSelect: handleCopyRich,
            },
            {
                id: 'markdown',
                label: '复制 Markdown 文本',
                hint: `粘贴后由客户端按 ${dialectLabelOf(plan)} 转换`,
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
        [hasContent, plan, handleCopyRich, handleCopyMarkdown, handleCopyPlain]
    );

    return (
        <>
            <section className="section">
                <MarkdownEditor value={markdown} onChange={setMarkdown} />
            </section>
            <section className="section">
                <h2 className="section-title">Telegram 预览</h2>
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
                <ChannelActions actions={actions} />
                <p className="hint">{plan.note}</p>
                <ChannelStatus status={status} />
            </section>
        </>
    );
};
