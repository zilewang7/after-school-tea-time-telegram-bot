/**
 * Built-in static sections of the system prompt.
 *
 * These paragraphs document the wire format produced by
 * src/reply/context-builder.ts (message numbering, annotations, <<EOF, …).
 * They live in code — not in the mounted preference file — so a format
 * change and its prompt documentation are versioned in the same commit.
 */
import { formatOwnerLabel, type OwnerIdentity } from '../../config/tool-config.js';
import { TRIAL_MODEL } from '../../config/trial-access.js';

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
    目标带媒体时在末尾注明介质，如 \`[replying to #1 某某 (a sticker)]\`、\`(a picture)\`、\`(a file)\`（不在上下文中时为 \`[replying to 某某: a sticker]\`）；你自己的回复由正文与附件两条消息组成，回复你的正文时不注明，它说的话就是被回复的内容；
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
  - \`[sent a widget]\` — 这条回复发过一张聊天卡片：卡片渲染图作为该回合的图片回放；
    A2UI 模式还会在其后给出 \`[a2ui surface] {…}\` 行（当时提交的 surface 源码，超过 4000 字符时截断并标注 \`…（已截断）\`），HTML 模式只有渲染图、不回放源码
- 冒号后为消息正文；仅含媒体或仅用 \`/chat\` 召唤的消息无冒号与正文
- \`<<EOF\` 为消息正文块结束标记：消息自带的图片/视频/文件（含带标签的自定义 emoji 拼图）位于 \`#N 用户名\` 行与它之间；
  它之后出现的 \`[system]\` 段落与图片是系统附加的元数据，仍属于同一条消息，不是下一条消息的附件
- 独立的 \`[system] …\` 段落为系统注入的元数据，非用户发言
- \`[system] another session is already replying to #3 …\` 表示 #3 正由另一会话处理并生成回复
- \`[system] your reply #5 is still being generated …\`（出现在你的历史消息位）表示你的 #5 回复正在另一会话中流式生成，尚未落库，并非内容丢失或故障
- \`[system] your reply #5 ended without producing any text …\`（同上位置）表示那条回复在写出正文前就结束了（流中断、被停止或空回复），没有正文可读，用户可以重试
- \`[system] 链接预览：…\` 为系统自动抓取的消息内链接预览（站点、标题、描述及可能的正文与图片）；
  预览图片与消息自带附件均归属该消息，工具按出现顺序索引（消息附件在前，链接预览图片在后）
- \`[system] 消息链接预览：…\` 为系统抓取的 \`t.me/…\` 消息链接目标及其被回复消息；其中的作者、时间与编号均属于原消息而非当前上下文，其附带图片同样排在发链接消息自身的附件之后
- \`[system] the same media as #3 — not attached again\` 表示这条消息的图片/视频/文件与 #3 是同一个文件，系统没有重复附上，看 #3 的即可
${options.includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头的 \`[#5]\` 为系统附加的上下文编号
- 正文中提及上下文内已存在的消息编号（如 #5）会被系统渲染为可点击的跳转链接
- 不要把 \`#N\`、\`||防剧透||\` 用 \`等宽代码\` 包起来：反引号内的内容按原文展示，编号不会变成链接、防剧透不会生效；链接、提及与其它 Markdown 样式同理
- 当前回复默认针对最后一条消息，通常只在引用更早的消息时才需要写编号
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
    /** send_file is offered */
    readonly fileTools: boolean;
    /** the workspace file tools are offered this turn */
    readonly workspace?: boolean;
    /** workspace_preview is offered (workspace + vision model + render sidecar) */
    readonly workspacePreview?: boolean;
    /** leave_handoff is offered (a hand-off note can be left for the next reply) */
    readonly workspaceHandoff?: boolean;
    /** search_history / read_history are offered */
    readonly historyTools: boolean;
    /** list_harness_issues / create_harness_issue are offered */
    readonly harnessIssues: boolean;
    /** send_widget / get_ui_guide are offered */
    readonly widget: boolean;
}

const searchImageLines = (canDraw: boolean): string[] => [
    '- `search_images` 可检索网络图片（首次返回 3 张缩略图，可通过 `search=\'q1\'` 翻页或更换 `query`），`send_image` 可将候选图发送到聊天' +
        (canDraw ? '；`generate_image` 用于生成新图或编辑现有图片，生成结果用 `send_image` 发出。' : '。'),
];

const IMAGE_REVERSE_LINE =
    '- 可以用 `search_by_image` 以图搜图：将图片上传至 Yandex，返回包含该图的网页、其他尺寸、相似图与识别标签（动图取首帧，单图上限 8MB）。';

const IMAGE_FETCH_LINE =
    '- 可以用 `fetch_image` 读取上下文中的图片原图、贴纸或已搜到的候选图以查看细节，也可以用 `fetch_image(avatar=…)` 取群聊、用户、频道或自己（`me`）的头像。';

/** Editing a picture the conversation already shows: reference it, never redraw it from memory */
const IMAGE_EDIT_LINE =
    '- 修改或参考上下文已有图片（含消息附件与链接预览图片）时，可通过 `generate_image` 的 `references` 传入原图。';

const stickerLine = (canPreview: boolean): string =>
    '- 可以用 `send_sticker` 发送贴纸包中的贴纸（编号与名称见工具描述）' +
    (canPreview ? "，或用 `fetch_image(sticker='…')` 预览贴纸画面。" : '。');

const fileLine = (workspace: boolean): string =>
    '- 可以用 `send_file` 把长文本（Markdown、代码、CSV 等）写成文件发到聊天（单份上限 10 MB）' +
    (workspace ? '；也可以从本会话工作区的文件直接发出（workspace_path）' : '');

const workspaceLine = (handoff: boolean): string =>
    '- 可以用 `workspace_write` / `workspace_read` / `workspace_list` / `workspace_find` / `workspace_edit` / `workspace_copy` / `workspace_delete` 在按会话保留的「工作区」里写、读、搜、改、复制、删草稿文件（7 天未使用自动清理）' +
    (handoff ? '；工作没做完需要交给下一轮回复时，可以用 `leave_handoff` 写下交接' : '') +
    '。';

const WORKSPACE_PREVIEW_LINE =
    '- `workspace_preview` 可以把工作区的 HTML/A2UI 草稿渲染成图查看。';

const historyLine = (canFetchImages: boolean): string =>
    '- 可以用 `search_history` 检索历史归档（本聊天；机主私聊时为全部归档群）中的消息（关键词 / 时间 / 发言人；含链接预览、Instant View 与图片 OCR 文本），用 `read_history` 读整条原文或某条消息前后的对话' +
    (canFetchImages ? "；归档消息里的图可以用 `fetch_image(history='hN')` 读取。" : '。');

const widgetLine = (workspace: boolean): string =>
    '- 可以用 `send_widget` 把一张聊天内 UI 卡片作为这条回复的附件发出（组件 JSON 用 mode="a2ui"，完整 HTML 用 mode="html"）；第一次使用前先调 `get_ui_guide` 取对应模式的完整规范' +
    (workspace ? '；也可以从工作区取 HTML/A2UI 内容（workspace_path）' : '') +
    '。';

const HARNESS_ISSUE_LINE =
    '- 当你准备结束思考时才调用 issue 工具：如果本轮使用 harness 时遇到工具不好用、描述不清、缺能力或格式别扭，先 `list_harness_issues` 查重，再用 `create_harness_issue` 记录；没有就跳过。记录本身不要出现在回复正文里。';

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
    if (options.fileTools) lines.push(fileLine(options.workspace === true));
    if (options.workspace === true) lines.push(workspaceLine(options.workspaceHandoff === true));
    if (options.workspacePreview === true) lines.push(WORKSPACE_PREVIEW_LINE);
    if (options.historyTools) lines.push(historyLine(options.imageFetch));
    if (options.harnessIssues) lines.push(HARNESS_ISSUE_LINE);
    if (options.widget) lines.push(widgetLine(options.workspace === true));
    return lines.join('\n');
};

/**
 * The trial tier's rules. It rides the static head only on trial turns, so the
 * head stays byte-identical per (model, chat, tier, tools); the trigger user and
 * their application state go into the runtime block instead.
 */
export const TRIAL_SECTION = `# 体验用户

本次回复的触发用户是体验用户，只能使用受限能力：

- 模型固定为 ${TRIAL_MODEL}，不能切换；不要建议用 /model 切换模型
- 生图只能用 banana：/picbanana 可用；/picgpt、/picgrok、/pic、/vid 等不可用；generate_image 只能用 banana（工具被本聊天开启时）
- 不能用 send_sms_to_owner、MCP 外部工具，以及其它高开销/付费功能
- 本聊天已开启的免费工具（搜图、读图、发图、贴纸、发文件、工作区、历史检索等）照常可用

完整功能仅限机主、机主指定群聊的成员和已通过准入的用户。如果你本来就在机主的群里，
权限会自动恢复，不需要申请；不在群里的人要使用完整功能，必须自己提交准入申请：
- 在对话里发送 /apply，按提示填写；或
- 打开 Mini App 的「准入」页，填写「你是谁」和「你要做什么」后提交。
你没有代为提交申请的工具，不要声称已替用户申请。可以说明限制、告诉用户上述入口，
并提醒他申请时说明「你是谁」（身份、与机主的关系）和「你要做什么」（用途）。
若用户已有待审核申请，告知等待机主审核；若被拒绝，把机主的留言转告用户，用户补充信息后可以重新申请。`;

export const NOTES_SECTION = `# 注意

- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本
- 你要回复的那条消息末尾的运行时信息里可能有「本聊天的附加提示词」一节：由本聊天成员通过控制面板设置，与本提示词同等效力`;
