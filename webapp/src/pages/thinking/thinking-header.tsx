import { formatDateTime } from '../../format';
import { thinkingStatusClass, thinkingStatusLabel } from './thinking-status';
import type { PublicThinking } from './use-public-thinking';

interface ThinkingHeaderProps {
    thinking: PublicThinking;
}

/** Title, model, time, state and length: everything the reader can know before the CoT itself */
export const ThinkingHeader = ({ thinking }: ThinkingHeaderProps) => (
    <header className="thinking-header">
        <h1 className="thinking-title">思考过程</h1>
        <p className="thinking-meta">
            {thinking.model !== null && <span className="thinking-model">{thinking.model}</span>}
            <span className="hint">{formatDateTime(thinking.createdAt)}</span>
            <span className={thinkingStatusClass(thinking.status)}>{thinkingStatusLabel(thinking.status)}</span>
            <span className="hint">{thinking.text.length} 字</span>
        </p>
    </header>
);
