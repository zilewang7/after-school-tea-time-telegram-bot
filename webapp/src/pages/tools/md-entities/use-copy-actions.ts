import { useCallback, useState } from 'react';
import { match } from 'ts-pattern';
import { copyRichText, copyText } from '../../../clipboard';
import type { CopyRichResult } from '../../../clipboard';
import { useSuccessHaptic } from '../../../hooks/use-telegram-feedback';
import type { CopyStatus } from './channel-status';

const successStatus = (message: string): CopyStatus => ({ tone: 'success', message });

const errorStatus = (message: string): CopyStatus => ({ tone: 'error', message });

const COPY_FAILED_MESSAGE = '复制失败：请手动全选文本复制';

/** Message for the channel that actually worked; a silent plain-text fallback is called out */
const richStatusOf = (result: CopyRichResult): CopyStatus =>
    match(result.channel)
        .with('clipboard-item', () => successStatus('已复制富文本（HTML），到 Telegram 输入框粘贴即可'))
        .with('copy-event', () => successStatus('已复制富文本（兼容模式），到 Telegram 输入框粘贴即可'))
        .with('plain-text', () => successStatus('当前客户端不支持富文本剪贴板，已复制纯文本'))
        .with('failed', () => errorStatus(COPY_FAILED_MESSAGE))
        .exhaustive();

export interface CopyActions {
    status: CopyStatus | null;
    copyRich: (html: string, plainText: string) => void;
    copyPlainText: (text: string, label: string) => void;
    reportFailure: (message: string) => void;
}

/** Clipboard actions plus the outcome line both panels show under their buttons */
export const useCopyActions = (): CopyActions => {
    const [status, setStatus] = useState<CopyStatus | null>(null);
    const notifySuccess = useSuccessHaptic();

    const copyRich = useCallback(
        (html: string, plainText: string) => {
            void copyRichText(html, plainText).then((result) => {
                if (result.ok) notifySuccess();
                setStatus(richStatusOf(result));
            });
        },
        [notifySuccess]
    );

    const copyPlainText = useCallback(
        (text: string, label: string) => {
            void copyText(text).then((ok) => {
                if (ok) notifySuccess();
                setStatus(ok ? successStatus(`已复制${label}`) : errorStatus(COPY_FAILED_MESSAGE));
            });
        },
        [notifySuccess]
    );

    const reportFailure = useCallback((message: string) => setStatus(errorStatus(message)), []);

    return { status, copyRich, copyPlainText, reportFailure };
};
