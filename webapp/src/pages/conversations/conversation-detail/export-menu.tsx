import { useCallback, useState } from 'react';
import { describeExportFailure } from '../../../api';
import type { ExportFormat } from '../../../api';
import { useApi } from '../../../context/panel-context';
import { copyText } from '../../../clipboard';
import { downloadTextFile } from '../../../download';

interface ExportedFile {
    format: ExportFormat;
    fileName: string;
    text: string;
}

interface ExportMenuProps {
    chatId: number;
    rootId: number;
}

/**
 * 「导出」: the server answers with the file, which is saved through a blob
 * download. WebViews that cannot save files keep the copy button, which is the
 * design's fallback C (§8).
 */
export const ExportMenu = ({ chatId, rootId }: ExportMenuProps) => {
    const api = useApi();
    const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);
    const [exported, setExported] = useState<ExportedFile | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const exportAs = useCallback(
        (format: ExportFormat) => {
            if (pendingFormat !== null) return;
            setPendingFormat(format);
            setFailure(null);
            setCopied(false);
            void api.exportConversation(chatId, rootId, format).then((result) => {
                setPendingFormat(null);
                if (!result.ok) {
                    setFailure(describeExportFailure(result.failure));
                    return;
                }
                const fileName = result.fileName ?? `conversation-${rootId}.${format}`;
                downloadTextFile(result.text, fileName, result.contentType);
                setExported({ format, fileName, text: result.text });
            });
        },
        [api, chatId, rootId, pendingFormat]
    );

    const handleCopy = useCallback(() => {
        if (exported === null) return;
        void copyText(exported.text).then((ok) => setCopied(ok));
    }, [exported]);

    return (
        <section className="section">
            <h2 className="section-title">导出</h2>
            <div className="filter-row">
                <button
                    type="button"
                    className="button secondary"
                    disabled={pendingFormat !== null}
                    onClick={() => exportAs('md')}
                >
                    {pendingFormat === 'md' ? '导出中…' : 'Markdown'}
                </button>
                <button
                    type="button"
                    className="button secondary"
                    disabled={pendingFormat !== null}
                    onClick={() => exportAs('json')}
                >
                    {pendingFormat === 'json' ? '导出中…' : 'JSON'}
                </button>
            </div>
            {failure !== null && <p className="error-text">{failure}</p>}
            {exported !== null && (
                <div className="notice">
                    <p>已生成 {exported.fileName}（{Math.round(exported.text.length / 1024)} KB）</p>
                    <p className="hint">没有弹出保存对话框的话，复制内容后自行保存。</p>
                    <button type="button" className="button secondary" onClick={handleCopy}>
                        {copied ? '已复制' : '复制内容'}
                    </button>
                </div>
            )}
        </section>
    );
};
