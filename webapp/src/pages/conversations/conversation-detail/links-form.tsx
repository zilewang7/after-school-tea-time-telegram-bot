import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { describeSpliceFailure } from '../../../api';
import type { LinkSpliceResponse, WriteFailureView } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';
import { useVerticalSwipeLock } from '../../../hooks/use-telegram-guards';

const MAX_LINKS = 20;

const linksOf = (text: string): string[] =>
    text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(0, MAX_LINKS);

const resultTextOf = (result: LinkSpliceResponse): string => {
    const lines = [`已拼接 ${result.attachedRoots} 个会话`];
    if (result.alreadyInTree.length > 0) lines.push(`${result.alreadyInTree.length} 条已在当前会话里`);
    if (result.missing.length > 0) lines.push(`${result.missing.length} 条找不到目标消息`);
    if (result.foreign.length > 0) lines.push(`${result.foreign.length} 条不属于本聊天`);
    if (result.invalid.length > 0) lines.push(`${result.invalid.length} 条不是有效的消息链接`);
    return lines.join('；');
};

interface LinksFormProps {
    chatId: number;
    rootId: number;
    // Something was spliced in: the tree must be re-read
    onAttached: () => void;
    onClose: () => void;
}

/** 「拼接对话」: message links of this chat, spliced in like /chat <link> does */
export const LinksForm = ({ chatId, rootId, onAttached, onClose }: LinksFormProps) => {
    const api = useApi();
    const notifySuccess = useSuccessHaptic();
    // A long paste in a textarea must not swipe the panel closed
    useVerticalSwipeLock(true);
    const [text, setText] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<LinkSpliceResponse | null>(null);
    const [failure, setFailure] = useState<WriteFailureView | null>(null);

    const links = useMemo(() => linksOf(text), [text]);
    const canSubmit = links.length > 0 && !submitting;
    const handleInput = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value), []);

    const submit = useCallback(() => {
        if (!canSubmit) return;
        setSubmitting(true);
        setFailure(null);
        void api.spliceConversation(chatId, rootId, links).then((response) => {
            setSubmitting(false);
            if (!response.ok) {
                setFailure(describeSpliceFailure(response.failure));
                return;
            }
            setResult(response.data);
            notifySuccess();
            if (response.data.attachedRoots > 0) onAttached();
        });
    }, [canSubmit, api, chatId, rootId, links, notifySuccess, onAttached]);

    return (
        <section className="section">
            <h2 className="section-title">拼接对话</h2>
            <p className="hint">
                每行一个本聊天的消息链接（t.me/…），等价于在群里发 /chat 链接。最多 {MAX_LINKS} 条，拼接后不能撤销。
            </p>
            <textarea
                className="field issue-text-input"
                value={text}
                rows={5}
                disabled={submitting}
                placeholder={'https://t.me/…/123\nhttps://t.me/…/456'}
                aria-label="消息链接"
                onChange={handleInput}
            />
            <div className="filter-row">
                <button type="button" className="button primary" disabled={!canSubmit} onClick={submit}>
                    {submitting ? '拼接中…' : '拼接'}
                </button>
                <button type="button" className="button secondary" onClick={onClose}>
                    关闭
                </button>
            </div>
            {failure !== null && <p className="error-text">{failure.message}</p>}
            {result !== null && (
                <div className="notice">
                    <p>{resultTextOf(result)}</p>
                    {result.notice !== null && <p className="hint prewrap">{result.notice}</p>}
                </div>
            )}
        </section>
    );
};
