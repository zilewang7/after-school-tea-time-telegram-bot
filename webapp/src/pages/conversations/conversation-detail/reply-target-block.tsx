import type { ReplyTarget } from '../../../api';

// The panel numbers every message (`#N`), so name the target by both when known
const labelOf = (target: ReplyTarget): string => {
    const number = target.number === null ? null : `#${target.number}`;
    if (number !== null && target.authorName !== null) return `${number} ${target.authorName}`;
    return number ?? target.authorName ?? '一条消息';
};

const snippetOf = (target: ReplyTarget): string | null =>
    target.snippet ?? (target.mediaHint === null ? null : `[${target.mediaHint}]`);

/** The message a bubble answers: `↳ 回复 #2 黑猫：…` */
export const ReplyTargetBlock = ({ target }: { target: ReplyTarget }) => {
    const snippet = snippetOf(target);
    return (
        <p className="flat-reply-to">
            ↳ 回复 {labelOf(target)}
            {snippet === null ? '' : `：${snippet}`}
        </p>
    );
};
