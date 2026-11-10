import type { PublicThinkingStatus } from '../../api';
import type { PublicThinking } from './use-public-thinking';

const STATUS_LABELS: Record<PublicThinkingStatus, string> = {
    generating: '生成中…',
    done: '已完成',
    interrupted: '已中断',
    unavailable: '不可用',
};

export const thinkingStatusLabel = (status: PublicThinkingStatus): string => STATUS_LABELS[status];

/** The state's CSS class: generating and done read differently from a stopped CoT */
export const thinkingStatusClass = (status: PublicThinkingStatus): string => `thinking-status is-${status}`;

/** The one line under the header: why the CoT stopped, or null when there is nothing to say */
export const thinkingNoteOf = (thinking: PublicThinking): string | null => {
    if (thinking.status === 'unavailable') return '这次思考不可用（生成被中断，或内容已过期）。';
    if (thinking.errorMessage !== null) return thinking.errorMessage;
    if (thinking.status === 'interrupted') return '这次思考在生成中被中断。';
    return null;
};
