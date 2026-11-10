import type { ReplyTarget } from '../../../api';

const labelOf = (target: ReplyTarget): string =>
    target.authorName ?? (target.number === null ? '一条消息' : `#${target.number}`);

const snippetOf = (target: ReplyTarget): string | null =>
    target.snippet ?? (target.mediaHint === null ? null : `[${target.mediaHint}]`);

/** The message a bubble answers: `↳ 回复 黑猫：…` */
export const ReplyTargetBlock = ({ target }: { target: ReplyTarget }) => {
    const snippet = snippetOf(target);
    return (
        <p className="flat-reply-to">
            ↳ 回复 {labelOf(target)}
            {snippet === null ? '' : `：${snippet}`}
        </p>
    );
};
