import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import { match } from 'ts-pattern';
import { clipboardHtmlToMarkdown } from '../../../tools/entity-convert';
import type { ChannelPlan, ClipboardConversion } from '../../../tools/types';
import { ChannelStatus } from './channel-status';
import { ParsedSummary, parsedSummaryOf } from './parsed-summary';
import { PasteZone } from './paste-zone';
import { useCopyActions } from './use-copy-actions';

type PasteState =
    | { kind: 'idle' }
    | { kind: 'rich'; conversion: ClipboardConversion }
    | { kind: 'plain'; text: string }
    | { kind: 'error'; message: string };

const EMPTY_MESSAGE = '剪贴板里没有可识别的文本内容。';
const READ_FAILED_MESSAGE = '读取剪贴板失败，请改用粘贴。';
const PARSE_FAILED_MESSAGE = '富文本解析失败，请尝试用纯文本粘贴。';

interface ReversePanelProps {
    plan: ChannelPlan;
    /** navigator.clipboard.read() exists; the host may still refuse it */
    readSupported: boolean;
}

/** Direction 2: a Telegram message pasted from the clipboard -> markdown */
export const ReversePanel = ({ plan, readSupported }: ReversePanelProps) => {
    const [state, setState] = useState<PasteState>({ kind: 'idle' });
    const [markdown, setMarkdown] = useState('');
    const [reading, setReading] = useState(false);
    const { status, copyPlainText } = useCopyActions();

    const applyRich = useCallback((html: string) => {
        try {
            const conversion = clipboardHtmlToMarkdown(html);
            setState({ kind: 'rich', conversion });
            setMarkdown(conversion.markdown);
        } catch {
            setState({ kind: 'error', message: PARSE_FAILED_MESSAGE });
        }
    }, []);

    const applyPlain = useCallback((text: string) => {
        setState({ kind: 'plain', text });
        setMarkdown('');
    }, []);

    const handlePaste = useCallback(
        (event: ClipboardEvent<HTMLTextAreaElement>) => {
            event.preventDefault();
            const data = event.clipboardData;
            const html = data.getData('text/html');
            const plain = data.getData('text/plain');
            event.currentTarget.value = '';
            if (html.trim() !== '') {
                applyRich(html);
                return;
            }
            if (plain.trim() !== '') {
                applyPlain(plain);
                return;
            }
            setState({ kind: 'error', message: EMPTY_MESSAGE });
        },
        [applyRich, applyPlain]
    );

    const handleReadClipboard = useCallback(() => {
        setReading(true);
        void (async () => {
            try {
                const items = await navigator.clipboard.read();
                const [item] = items;
                if (item === undefined) {
                    setState({ kind: 'error', message: EMPTY_MESSAGE });
                    return;
                }
                if (item.types.includes('text/html')) {
                    applyRich(await (await item.getType('text/html')).text());
                    return;
                }
                if (item.types.includes('text/plain')) {
                    applyPlain(await (await item.getType('text/plain')).text());
                    return;
                }
                setState({ kind: 'error', message: EMPTY_MESSAGE });
            } catch {
                setState({ kind: 'error', message: READ_FAILED_MESSAGE });
            } finally {
                setReading(false);
            }
        })();
    }, [applyRich, applyPlain]);

    const handleUsePlainAsMarkdown = useCallback(() => {
        if (state.kind !== 'plain') return;
        setMarkdown(state.text);
    }, [state]);

    const handleMarkdownChange = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => setMarkdown(event.target.value),
        []
    );

    const handleCopyMarkdown = useCallback(() => {
        if (markdown.trim() === '') return;
        copyPlainText(markdown, 'Markdown 文本');
    }, [markdown, copyPlainText]);

    const summary = useMemo(() => (state.kind === 'rich' ? parsedSummaryOf(state.conversion) : null), [state]);

    return (
        <>
            <section className="section">
                <h2 className="section-title">粘贴 Telegram 消息</h2>
                <PasteZone
                    onPaste={handlePaste}
                    onReadClipboard={readSupported ? handleReadClipboard : null}
                    reading={reading}
                />
                <p className="hint">{plan.note}</p>
                {match(state)
                    .with({ kind: 'idle' }, () => (
                        <p className="hint">在 Telegram 里复制一条带格式的消息，再粘贴到这里；富文本会还原成 Markdown。</p>
                    ))
                    .with({ kind: 'error' }, ({ message }) => <p className="error-text">{message}</p>)
                    .with({ kind: 'plain' }, ({ text }) => (
                        <>
                            <p className="notice warning">
                                剪贴板里没有富文本（HTML），只拿到了纯文本；部分客户端（如 iOS/macOS）复制消息本身就不带
                                HTML。
                            </p>
                            <pre className="code-block prewrap tools-plain-text">{text}</pre>
                            {markdown === '' && (
                                <button type="button" className="button secondary" onClick={handleUsePlainAsMarkdown}>
                                    按纯文本输出 Markdown
                                </button>
                            )}
                        </>
                    ))
                    .with({ kind: 'rich' }, () => null)
                    .exhaustive()}
            </section>
            {summary !== null && (
                <section className="section">
                    <h2 className="section-title">解析结果</h2>
                    <ParsedSummary summary={summary} />
                </section>
            )}
            {markdown !== '' && (
                <section className="section">
                    <div className="field-label-row">
                        <label className="field-label" htmlFor="tools-markdown-result">
                            Markdown
                        </label>
                        <span className="hint">{markdown.length} 字符</span>
                    </div>
                    <textarea
                        id="tools-markdown-result"
                        className="field tools-textarea"
                        rows={8}
                        spellCheck={false}
                        value={markdown}
                        onChange={handleMarkdownChange}
                    />
                    <button type="button" className="button primary" onClick={handleCopyMarkdown}>
                        复制 Markdown
                    </button>
                    <ChannelStatus status={status} />
                </section>
            )}
        </>
    );
};
