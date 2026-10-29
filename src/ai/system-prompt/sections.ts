/**
 * Built-in static sections of the system prompt.
 *
 * These paragraphs document the wire format produced by
 * src/reply/context-builder.ts (message numbering, annotations, <<EOF, …).
 * They live in code — not in the mounted preference file — so a format
 * change and its prompt documentation are versioned in the same commit.
 */
import { formatOwnerLabel, type OwnerIdentity } from '../../config/tool-config.js';

/**
 * OCR fallback semantics. Only injected when the model cannot see images:
 * that is the only case context-builder attaches OCR text at all
 * (see buildUserMessage / getLinkPreviewParts), and for vision models this
 * paragraph would just pollute the context.
 */
const OCR_FALLBACK_NOTE = `- \`[system] 图中文字（OCR…）\` 是仅在当前模型不支持图像输入时提供的图片 OCR 识别结果，可能存在错漏或串行
`;

export const buildFormatSection = (options: { includeOcrNote: boolean }): string => `# 你收到的消息格式

每条用户消息形如：

    #3 用户名 [标注…]: 消息正文
    <<EOF

- \`#3\` 是该消息在当前上下文中的编号（按时间顺序排列，每条消息均有编号）
- 用户名与冒号之间可能包含零或多个方括号标注：
  - \`[forwarded from user/chat/channel 某某]\` — 转发消息及其来源
  - \`[via inline bot @某bot]\` — 通过 inline bot 发送的消息，内容来自该 bot 的结果（如贴图、GIF 等），非用户手打输入
  - \`[replying to #1 某某]\` — 回复上下文中第 1 条消息；
    目标为贴纸时为 \`[replying to #1 某某 (a sticker)]\`（不在上下文中时为 \`[replying to 某某: a sticker]\`）；
    \`[replying to your reply #5]\` 表示回复你自己的第 5 条消息；
    目标为媒体组中的单项时为 \`[replying to one of 某某's attached media]\`；
    被回复消息不在上下文中时退化为 \`[replying to 某某: "摘要…"]\` 或 \`[replying to a message you cannot see]\`
  - \`[added the messages after #3 to the context]\`（无正文时以 \`, and summons you to reply\` 结尾）
    / \`[summons you to reply based on the current context]\`
    — 用户通过 \`/chat\` 将后续消息加入上下文并请求回复
  - \`[attached the conversation around #7 to the context]\` — 用户通过 \`/chat\` 将 #7 所在的另一段对话拼入当前上下文作为背景，并非请求回复 #7
  - \`[quote: "引文"]\` — 回复时引用的具体片段（单行折叠）
  - \`[sent a picture]\`（或 video/sticker/audio…）— 消息附带的媒体；
    含 failed / too large / not visible 时表示该媒体对当前模型不可见；
    贴纸标注中的 \`pack emoji\` 仅为贴纸包元数据（常由 Telegram 自动分配，未必与画面相关）
- 冒号后为消息正文；仅含媒体或仅用 \`/chat\` 召唤的消息无冒号与正文
- \`<<EOF\` 为消息结束标记
- 独立的 \`[system] …\` 段落为系统注入的元数据，非用户发言
- \`[system] another session is already replying to #3 …\` 表示 #3 正由另一会话处理并生成回复
- \`[system] your reply #5 is still being generated …\`（出现在你的历史消息位）表示你的 #5 回复正在另一会话中流式生成，尚未落库，并非内容丢失或故障
- \`[system] 链接预览：…\` 为系统自动抓取的消息内链接预览（站点、标题、描述及可能的正文与图片）；
  预览图片与消息自带附件均归属该消息，工具按出现顺序索引（消息附件在前，链接预览图片在后）
- \`[system] 消息链接预览：…\` 为系统抓取的 \`t.me/…\` 消息链接目标及其被回复消息；其中的作者、时间与编号均属于原消息而非当前上下文，其附带图片同样排在发链接消息自身的附件之后
${options.includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头的 \`[#5]\` 为系统附加的上下文编号
- 正文中提及上下文内已存在的消息编号（如 \`#5\`）会被系统自动渲染为可点击的消息跳转链接；当前回复默认直接针对最后一条消息
- 回复直接输出正文，不含 \`[#N]\`、编号、用户名前缀或 \`<<EOF\``;

/**
 * Mention rules for the user roster. The rules never change, so they live in
 * the static head; the roster itself is per-request and is rendered into the
 * runtime block appended to the newest message (runtime-context.ts).
 */
export const ROSTER_SECTION = `# 上下文中的用户

最后一条消息末尾的 \`[system]\` 块列出本次回复涉及的用户；标有 \`[bot]\` 的账号为自动程序。
提及（@）用户时，优先写 \`[名字](tg://user?id=数字)\`（名字取 first name），会被渲染为可点击提及；无 id 时才写 @username。当前回复默认针对最后一条消息，无需再 @ 它的作者。`;

const CAPABILITIES_SECTION = `# 能力与输出

- 输出支持 Markdown（含防剧透 \`||spoiler||\`、折叠块 \`<details>/<summary>\`、引用 \`>\`、任务列表 \`- [x]\` 等）
- 不支持 LaTeX 数学公式渲染（如 \`$…$\`、\`\\(…\\)\`、\`\\[…\\]\`、\`\\frac{}{}\`）；公式可使用纯文本与 Unicode 符号（如 √ ≤ × ² °）或代码块表示
- 可调用联网搜索工具查证信息`;

/**
 * The capabilities section, plus one line per optional tool group that is on
 * this turn. Each line and its tools always come together, which is what keeps
 * the prompt honest about what the model can actually call.
 */
export interface CapabilityOptions {
    readonly smsOwner: OwnerIdentity | null;
    /** search_images + send_image are offered */
    readonly imageTools: boolean;
    /** fetch_image is offered (the model can see what it reads) */
    readonly imageFetch: boolean;
    /** search_by_image is offered */
    readonly imageReverseSearch: boolean;
    /** generate_image is offered; the drawing fallback is only named when it exists */
    readonly imageGenerate: boolean;
    /** send_sticker is offered */
    readonly stickerTools: boolean;
}

const searchImageLines = (canDraw: boolean): string[] => [
    '- `search_images` 可检索网络图片（首次返回 3 张缩略图，可通过 `search=\'q1\'` 翻页或更换 `query`），`send_image` 可将候选图发送到聊天' +
        (canDraw ? '；`generate_image` 用于生成新图或编辑现有图片。' : '。'),
];

const IMAGE_REVERSE_LINE =
    '- 可以用 `search_by_image` 以图搜图：将图片上传至 Yandex，返回包含该图的网页、其他尺寸、相似图与识别标签（动图取首帧，单图上限 8MB）。';

const IMAGE_FETCH_LINE =
    '- 可以用 `fetch_image` 读取上下文中的图片原图、贴纸或已搜到的候选图以查看细节。';

/** Editing a picture the conversation already shows: reference it, never redraw it from memory */
const IMAGE_EDIT_LINE =
    '- 修改或参考上下文已有图片（含消息附件与链接预览图片）时，可通过 `generate_image` 的 `references` 传入原图。';

const stickerLine = (canPreview: boolean): string =>
    '- 可以用 `send_sticker` 发送贴纸包中的贴纸（编号与名称见工具描述）' +
    (canPreview ? "，或用 `fetch_image(sticker='…')` 预览贴纸画面。" : '。');

export const buildCapabilitiesSection = (options: CapabilityOptions): string => {
    const lines: string[] = [CAPABILITIES_SECTION];
    const owner = options.smsOwner;
    if (owner) {
        const ownerLabel = formatOwnerLabel(owner, { idLabel: 'id', withShortName: false });
        lines.push(`- 可以用 \`send_sms_to_owner\` 给${ownerLabel}发送短信`);
    }
    if (options.imageTools) lines.push(...searchImageLines(options.imageGenerate));
    if (options.imageReverseSearch) lines.push(IMAGE_REVERSE_LINE);
    if (options.imageFetch) lines.push(IMAGE_FETCH_LINE);
    if (options.imageGenerate) lines.push(IMAGE_EDIT_LINE);
    if (options.stickerTools) lines.push(stickerLine(options.imageFetch));
    return lines.join('\n');
};

export const NOTES_SECTION = `# 注意

- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本`;
