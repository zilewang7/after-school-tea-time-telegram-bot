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

const buildLegacyFormatSection = (includeOcrNote: boolean): string => `# 你收到的消息格式

每条用户消息形如：

    #3 用户名 [标注…]: 消息正文
    <<EOF

- \`#3\` 是该消息在当前上下文中的编号（按时间顺序排列，每条消息均有编号）
- 用户名与冒号之间可能包含零或多个方括号标注：
  - \`[forwarded from user/chat/channel 某某]\` — 转发消息及其来源
  - \`[via inline bot @某bot]\` — 通过 inline bot 发送的消息，内容来自该 bot 的结果（如贴图、GIF 等），非用户手打输入
  - \`[replying to #1 某某]\` — 回复上下文中第 1 条消息；
    目标带媒体时在末尾注明介质，如 \`[replying to #1 某某 (a sticker)]\`、\`(a picture)\`、\`(a file)\`（不在上下文中时为 \`[replying to 某某: a sticker]\`）；目标没有正文时改为类型，如 \`(a poll)\`、\`(a group event)\`；你自己的回复由正文与附件两条消息组成，回复你的正文时不注明，它说的话就是被回复的内容；
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
  - \`[sent a poll: "问题" — 3 options: 是 / 对的 / yes]\`（quiz / dice roll / location / venue / contact /
    checklist / game / invoice / paid media / story / HTML widget 同形）— 消息附带的非文本内容，
    冒号后是系统在收到时对该内容的英文转述（投票只保留创建时快照，票数与是否关闭不会更新；
    清单勾选的后续变化会以新的 \`[service: …]\` 消息出现）。这些内容不是用户打的字，
    但它们是用户发送的内容，可以据此回答
  - \`[service: …]\` — 群里发生的系统事件（踢人/入群/改群名或群头像/置顶/话题/视频聊天/投票选项变化/礼物等），
    冒号后是系统对该事件的英文转述（谁做了什么）。这是群里的动作，不是用户说的话：
    不要当作正文引用，也不要当成用户在对你说这些词
  - \`[unsupported Telegram message type — content was not stored]\`（或带 \`: …\` 的变体）—
    这条消息的类型当前读不到，正文没有存下来；不要向用户追问「你说了什么」，也不要把这条消息当作用户正文
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
  没有拿到预览时会改给一行 \`[system] 链接预览：…\` 状态说明，表示「Telegram 没有为该链接生成网页预览」或「抓取失败（可重试或换用网页读取工具）」
- \`[system] 消息链接预览：…\` 为系统抓取的 \`t.me/…\` 消息链接目标及其被回复消息；其中的作者、时间与编号均属于原消息而非当前上下文，其附带图片同样排在发链接消息自身的附件之后
- \`[system] the same media as #3 — not attached again\` 表示这条消息的图片/视频/文件与 #3 是同一个文件，系统没有重复附上，看 #3 的即可
${includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头的 \`[#5]\` 为系统附加的上下文编号
- 正文中提及上下文内已存在的消息编号（如 #5）会被系统渲染为可点击的跳转链接
- 不要把 \`#N\`、\`||防剧透||\` 用 \`等宽代码\` 包起来：反引号内的内容按原文展示，编号不会变成链接、防剧透不会生效；链接、提及与其它 Markdown 样式同理
- 当前回复默认针对最后一条消息，通常只在引用更早的消息时才需要写编号
- 回复直接输出正文，不含 \`[#N]\`、编号、用户名前缀或 \`<<EOF\`；也不要模仿输出 \`[service: …]\`、\`[sent …]\`、\`[replying to …]\` 等方括号标注`;

/**
 * Slim L0 format section: retains high-frequency markers and wire invariants,
 * while low-frequency annotations are injected conditionally in runtime-context.ts.
 */
const buildConciseFormatSection = (includeOcrNote: boolean): string => `# 你收到的消息格式

每条用户消息形如：

    #3 用户名 [标注…]: 消息正文
    <<EOF

- \`#3\` 是该消息在当前上下文中的编号（按时间顺序排列，每条消息均有编号）
- 用户名与冒号之间可能包含零或多个方括号标注：
  - \`[deleted]\` — 该消息已被删除（仅作上下文参考）
  - \`[forwarded from user/chat/channel 某某]\` — 转发消息及其来源
  - \`[via inline bot @某bot]\` — 通过 inline bot 发送的消息，内容来自该 bot 的结果（如贴图、GIF 等），非用户手打输入
  - \`[replying to #1 某某]\` — 回复上下文中第 1 条消息；
    目标带媒体时在末尾注明介质，如 \`[replying to #1 某某 (a sticker)]\`、\`(a picture)\`、\`(a file)\`（不在上下文中时为 \`[replying to 某某: a sticker]\`）；目标没有正文时改为类型，如 \`(a poll)\`、\`(a group event)\`；你自己的回复由正文与附件两条消息组成，回复你的正文时不注明，它说的话就是被回复的内容；
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
- \`<<EOF\` 为消息正文块结束标记：消息自带的图片/视频/文件（含带标签的自定义 emoji 拼图）位于 \`#N 用户名\` 行与它之间；
  它之后出现的 \`[system]\` 段落与图片是系统附加的元数据，仍属于同一条消息，不是下一条消息的附件
- 方括号标注与独立的 \`[system] …\` 段是系统附加的说明，不是用户发言；含义不确定时不要猜测，按字面理解并优先回答正文
- \`[system] 链接预览：…\` 为系统自动抓取的消息内链接预览（站点、标题、描述及可能的正文与图片）；
  预览图片与消息自带附件均归属该消息，工具按出现顺序索引（消息附件在前，链接预览图片在后）
${includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头的 \`[#5]\` 为系统附加的上下文编号
- 正文中提及上下文内已存在的消息编号（如 #5）会被系统渲染为可点击的跳转链接
- 不要把 \`#N\`、\`||防剧透||\` 用 \`等宽代码\` 包起来：反引号内的内容按原文展示，编号不会变成链接、防剧透不会生效；链接、提及与其它 Markdown 样式同理
- 当前回复默认针对最后一条消息，通常只在引用更早的消息时才需要写编号
- 回复直接输出正文，不含 \`[#N]\`、编号、用户名前缀或 \`<<EOF\`；也不要模仿输出 \`[service: …]\`、\`[sent …]\`、\`[replying to …]\` 等方括号标注`;

export const buildFormatSection = (options: {
    includeOcrNote: boolean;
    formatLegend?: boolean;
}): string =>
    options.formatLegend === false
        ? buildLegacyFormatSection(options.includeOcrNote)
        : buildConciseFormatSection(options.includeOcrNote);

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
- 普通模式不支持 LaTeX 数学公式渲染（请用纯文本与 Unicode 符号如 √ ≤ × ² ° 或代码块表示）；仅当本条消息末尾出现富文本模式说明时才可用 \`$…$\`（行内 \`$\` 内侧勿留空格）或 \`$$…$$\` 渲染公式，不支持 \`\\(…\\)\` / \`\\[…\\]\`
- 可调用联网搜索工具查证信息`;

/**
 * The capabilities section, plus one line per optional tool group that is on
 * this turn. Each line and its tools always come together, which is what keeps
 * the prompt honest about what the model can actually call.
 */
export interface CapabilityOptions {
    readonly smsOwner: OwnerIdentity | null;
    /** find_image(web) + send_image are offered */
    readonly imageTools: boolean;
    /** fetch_image is offered (the model can see what it reads) */
    readonly imageFetch: boolean;
    /** crop_image is offered (a magnified region comes back to the model) */
    readonly imageCrop?: boolean;
    /** extract_frames is offered (stills of a video/animation message) */
    readonly imageFrames?: boolean;
    /** find_image(reverse) is offered */
    readonly imageReverseSearch: boolean;
    /** generate_image is offered; the drawing fallback is only named when it exists */
    readonly imageGenerate: boolean;
    /** send_sticker is offered */
    readonly stickerTools: boolean;
    /** send_file is offered */
    readonly fileTools: boolean;
    /** the workspace tool is offered this turn */
    readonly workspace?: boolean;
    /** workspace(action="preview") is offered (workspace + vision model + render sidecar) */
    readonly workspacePreview?: boolean;
    /** leave_handoff is offered (a hand-off note can be left for the next reply) */
    readonly workspaceHandoff?: boolean;
    /** history is offered */
    readonly historyTools: boolean;
    /** harness_issue is offered */
    readonly harnessIssues: boolean;
    /** send_widget is offered */
    readonly widget: boolean;
    /** react_to_message is offered (a free per-chat tool, on by default) */
    readonly reactionTools?: boolean;
}

const searchImageLine = (canDraw: boolean): string =>
    '- `find_image`（`mode="web"`）搜网图；`send_image` 是发图唯一出口（每回复 ≤10 张，多张成相册）' +
    (canDraw ? '；`generate_image` 生图，改上下文图用 `references`。' : '。');

const GENERATE_ONLY_LINE =
    '- `generate_image` 生图（改上下文图用 `references`），由 `send_image` 发出（每回复 ≤10 张，多张成相册）。';

const IMAGE_REVERSE_LINE = '- `find_image(mode="reverse")` 以图搜图（≤8MB）。';

const IMAGE_FETCH_LINE = '- `fetch_image` 读原图、贴纸、候选图或 `avatar` 头像。';

const IMAGE_CROP_LINE = '- `crop_image` 裁图得 `imgN`（每回复 ≤4 次）。';

const IMAGE_FRAMES_LINE = '- `extract_frames` 从视频/动图抽静帧得 `imgN`（每回复 ≤6 帧）。';

const stickerLine = (canPreview: boolean): string =>
    '- `send_sticker` 发贴纸' +
    (canPreview ? '（可用 `fetch_image(sticker=…)` 预览）。' : '。');

const fileLine = (workspace: boolean): string =>
    `- \`send_file\` 发文本文件（≤10 MB${workspace ? '，支持 `workspace_path`' : ''}）。`;

const workspaceLine = (preview: boolean, handoff: boolean): string =>
    `- \`workspace\` 读写改查复制删除搜索${preview ? '与预览' : ''}草稿（7 天清理` +
    (handoff ? '；`leave_handoff` 交接' : '') +
    "），规范先 `load_skill(['workspace-usage'])`。";

const historyLine = (canFetchImages: boolean): string =>
    '- `history`（`search`/`read`）检索并读归档原文（OCR 会标出非正文' +
    (canFetchImages ? "；图片用 `fetch_image(history='hN')`" : '') +
    '）。';

const widgetLine = (workspace: boolean): string =>
    `- \`send_widget\` 发 UI 卡片（${workspace ? '支持 `workspace_path`，' : ''}首次先 \`load_skill(['widget-a2ui'])\` 或 \`widget-html\`）。`;

const HARNESS_ISSUE_LINE =
    '- 结束思考前遇到工具/harness 问题可用 `harness_issue`（`list`/`create`，规范见 `harness-reporting` 技能，勿写进正文）。';

const REACTION_LINE = '- `react_to_message` 轻量加/改/删 reaction（≤6 条，不代替正文）。';

export const buildCapabilitiesSection = (options: CapabilityOptions): string => {
    const lines: string[] = [CAPABILITIES_SECTION];
    const owner = options.smsOwner;
    if (owner) {
        const ownerLabel = formatOwnerLabel(owner, { idLabel: 'id', withShortName: false });
        lines.push(`- \`send_sms_to_owner\` 仅紧急时给${ownerLabel}发短信。`);
    }
    if (options.imageTools) {
        lines.push(searchImageLine(options.imageGenerate));
    } else if (options.imageGenerate) {
        lines.push(GENERATE_ONLY_LINE);
    }
    if (options.imageReverseSearch) lines.push(IMAGE_REVERSE_LINE);
    if (options.imageFetch) lines.push(IMAGE_FETCH_LINE);
    if (options.imageCrop === true) lines.push(IMAGE_CROP_LINE);
    if (options.imageFrames === true) lines.push(IMAGE_FRAMES_LINE);
    if (options.stickerTools) lines.push(stickerLine(options.imageFetch));
    if (options.fileTools) lines.push(fileLine(options.workspace === true));
    if (options.workspace === true) {
        lines.push(workspaceLine(options.workspacePreview === true, options.workspaceHandoff === true));
    }
    if (options.historyTools) lines.push(historyLine(options.imageFetch));
    if (options.harnessIssues) lines.push(HARNESS_ISSUE_LINE);
    if (options.widget) lines.push(widgetLine(options.workspace === true));
    if (options.reactionTools === true) lines.push(REACTION_LINE);
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
- 本聊天已开启的免费工具（搜图、读图、发图、贴纸、发文件、工作区、历史检索、reaction 等）照常可用

完整功能仅限机主、机主指定群聊的成员和已通过准入的用户。如果你本来就在机主的群里，
权限会自动恢复，不需要申请；不在群里的人要使用完整功能，必须自己提交准入申请：
- 在对话里发送 /apply，按提示填写；或
- 打开 Mini App 的「准入」页，填写「你是谁」和「你要做什么」后提交。
你没有代为提交申请的工具，不要声称已替用户申请。可以说明限制、告诉用户上述入口，
并提醒他申请时说明「你是谁」（身份、与机主的关系）和「你要做什么」（用途）。
若用户已有待审核申请，告知等待机主审核；若被拒绝，把机主的留言转告用户，用户补充信息后可以重新申请。`;

export const NOTES_SECTION: string = `# 注意

- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本（上下文显示的是最新版本）`;
