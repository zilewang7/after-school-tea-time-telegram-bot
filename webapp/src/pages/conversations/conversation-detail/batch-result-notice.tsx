/**
 * What a finished batch exclusion left out (design 2026-1119-2016 §4.6):
 * messages that no longer exist and album sub-images the write skipped. Shown
 * after the multi-select mode closed, over the refreshed tree.
 */
import type { ExclusionBatchResponse } from '../../../api';

const skippedLinesOf = (result: ExclusionBatchResponse): string[] => {
    const lines: string[] = [];
    if (result.missing.length > 0) lines.push(`有 ${result.missing.length} 条消息已不存在，已跳过`);
    if (result.albumItems.length > 0) lines.push(`有 ${result.albumItems.length} 条是相册子图，不能单独排除`);
    return lines;
};

export const BatchResultNotice = ({ result }: { result: ExclusionBatchResponse | null }) => {
    if (result === null) return null;
    const lines = skippedLinesOf(result);
    if (lines.length === 0) return null;
    return (
        <div className="notice warning">
            {lines.map((line) => (
                <p key={line}>{line}</p>
            ))}
        </div>
    );
};
