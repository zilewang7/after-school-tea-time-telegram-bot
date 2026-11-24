/**
 * The volatile tail of the trigger message: the skill catalog (when skills are
 * available), the workspace manifest, rich-reply LaTeX / inline-picture notes,
 * and the handoff note when this chat may read one. All ride after the runtime
 * block; none touches the byte-stable static prompt.
 *
 * One entry point for the three context builders (reply, retry, panel model
 * view) keeps the tail identical across them: a retry and the panel must show
 * the same volatile tail as the first answer.
 */
import type { UnifiedMessage } from '../../ai/types.js';
import { countCodePoints } from '../../shared/code-points.js';
import { buildSkillCatalogSection } from '../skills/skill-catalog-tail.js';
import type { SkillEntry } from '../skills/skill-types.js';
import type { AppendWorkspaceManifestInput } from './workspace-manifest.js';
import { appendWorkspaceManifestForReply } from './workspace-manifest.js';
import { appendWorkspaceHandoff, buildHandoffSection } from './workspace-handoff.js';
import { appendVolatileSection } from './volatile-section.js';
import { CURRENT_WORKSPACE_TOKEN } from './workspace-state.js';

export interface AppendWorkspaceTailForReplyInput extends AppendWorkspaceManifestInput {
    /** The handoff tool is offered this turn: inject the note too */
    readonly handoff: boolean;
    /** The reply goes out as rich text and may embed pictures: add the marker note */
    readonly richInlineImages?: boolean;
    /** The reply goes out as rich text: enable `$…$` / `$$…$$` LaTeX rendering */
    readonly richReplies?: boolean;
    /** Repository skills gated for this reply; empty/omitted = no catalog injected */
    readonly availableSkills?: readonly SkillEntry[];
}

export interface AppendWorkspaceTailResult {
    /** Code points of the injected L2 skill catalog section; 0 when omitted */
    readonly catalogChars: number;
}

/**
 * How the model uses LaTeX in rich replies. Volatile, not part of the
 * byte-stable static prompt: `richReplies` is a per-chat dynamic switch.
 */
export const RICH_LATEX_TAIL =
    '[system] 这条回复以富文本发出：支持 LaTeX 数学公式（行内 `$…$`、块级 `$$…$$`；不支持 `\\(…\\)` / `\\[…\\]`；行内 `$` 内侧勿留空格）。';

/**
 * How the model puts a picture inside the rich body. Volatile, not part of the
 * byte-stable static prompt: the reply's form is a per-chat setting, and a
 * reply that is not rich has no body to embed into. The ids are the ones the
 * tool results already taught it and the context numbering it already sees.
 */
export const RICH_INLINE_TAIL =
    '[system] 正文插图（这条回复以富文本发出，可以按位置插图）：\n' +
    '- 单独写一段 `![图注](引用)`（整行只有它，前后各空一行），图片就出现在这一段的位置；图注可省略，可写行内格式。\n' +
    '- 引用可以是本轮 generate_image 生成的 `g1`、fetch_image 读过的 `img1`、find_image 的 `s1`、' +
    '上下文消息里图片的 `#12`（第 2 张写 `#12:2`），或公开图片直链 `https://…`。\n' +
    '- 正文只内嵌静态图片：动图 GIF 写成内嵌标记不会显示（图注会留在正文），要发 GIF 请用 send_image。\n' +
    '- 每条回复最多 10 张图片（正文内嵌与 send_image 合计）。想把图附在回复末尾（相册）而不是正文某个位置时，仍用 send_image，可多次调用。';

/** Append the inline-picture note after the workspace manifest */
export const appendRichInlineTailForReply = (
    messages: UnifiedMessage[],
    triggerTurnIndex: number
): void => {
    appendVolatileSection(messages, triggerTurnIndex, RICH_INLINE_TAIL);
};

/**
 * Build and append the volatile tail. Each part fails closed: an injection
 * failure never breaks a reply.
 */
export const appendWorkspaceTailForReply = async (
    input: AppendWorkspaceTailForReplyInput
): Promise<AppendWorkspaceTailResult> => {
    let catalogChars = 0;
    if (input.availableSkills !== undefined && input.availableSkills.length > 0) {
        try {
            const section = buildSkillCatalogSection(input.availableSkills);
            if (section !== null) {
                appendVolatileSection(input.messages, input.triggerTurnIndex, section);
                catalogChars = countCodePoints(section);
            }
        } catch (error) {
            console.warn('[skills] catalog tail injection failed:', error);
        }
    }
    await appendWorkspaceManifestForReply(input);
    if (input.richReplies === true) {
        try {
            appendVolatileSection(input.messages, input.triggerTurnIndex, RICH_LATEX_TAIL);
        } catch (error) {
            console.warn('[workspace] rich-latex note injection failed:', error);
        }
    }
    if (input.richInlineImages === true) {
        try {
            appendRichInlineTailForReply(input.messages, input.triggerTurnIndex);
        } catch (error) {
            console.warn('[workspace] inline-picture note injection failed:', error);
        }
    }
    if (!input.handoff) return { catalogChars };
    try {
        const current = input.workspaceState.refs.get(CURRENT_WORKSPACE_TOKEN);
        if (current === undefined) return { catalogChars };
        const section = await buildHandoffSection({
            chatId: input.workspaceState.chatId,
            conversationRootId: current.rootId,
        });
        if (section !== null) appendWorkspaceHandoff(input.messages, input.triggerTurnIndex, section);
    } catch (error) {
        console.warn('[workspace] handoff injection failed:', error);
    }
    return { catalogChars };
};
