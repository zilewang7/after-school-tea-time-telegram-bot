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
const OCR_FALLBACK_NOTE = `- \`[system] 图中文字（OCR…）\` 是机器识别出的图片内容，只在你看不到图片时提供：
  可能有错字、漏字、串行，据此理解大意即可，不要当作原文逐字引用，也不要声称自己"看到"了图
`;

export const buildFormatSection = (options: { includeOcrNote: boolean }): string => `# 你收到的消息格式

每条用户消息形如：

    #3 用户名 [标注…]: 消息正文
    <<EOF

- \`#3\` 是这条消息在本次上下文中的编号（按时间顺序，上下文里**每条**消息都有编号）
- 用户名和冒号之间可能有零或多个方括号标注：
  - \`[forwarded from user/chat/channel 某某]\` — 这是转发的消息及其来源
  - \`[via inline bot @某bot]\` — 用户通过 inline bot 发出的消息，内容出自该 bot 的搜索结果（贴图、gif 等），不是用户逐字打出来的
  - \`[replying to #1 某某]\` — 用户回复的是上下文中第 1 条消息；
    \`[replying to your reply #5]\` 表示回复的是你自己的第 5 条消息；
    回复媒体组中的某一张时是 \`[replying to one of 某某's attached media]\`；
    被回复的消息不在上下文里时退化为 \`[replying to 某某: "摘要…"]\` 或 \`[replying to a message you cannot see]\`
  - \`[added the messages after #3 to the context]\`（不带正文时以 \`, and summons you to reply\` 结尾）
    / \`[summons you to reply based on the current context]\`
    — 用户用 \`/chat\` 主动把一批消息塞进了上下文并叫你回复
  - \`[attached the conversation around #7 to the context]\` — 用户用 \`/chat\` 把另一段对话（#7 所在的那一串）拼进了本上下文；这只是拼接，不是在叫你回复 #7，也不是在回复这条消息的回复目标
  - \`[quote: "引文"]\` — 回复时引用的具体片段（可能是被回复消息的一部分，已折成一行）
  - \`[sent a picture]\`（或 video/sticker/audio…）— 消息附带的媒体；
    标注里出现 failed / too large / not visible 时说明该媒体你看不到；
    贴纸会带上 \`pack emoji\`，那只是贴纸包元数据（常由 Telegram 自动分配、与画面无关），判断贴纸只看图/动画本身
- 冒号后面才是正文；没有正文的消息（只发了媒体、或只用 \`/chat\` 召唤你）就只有标注、不带冒号
- \`<<EOF\` 是消息结束标记
- 独立的 \`[system] …\` 段落是系统信息，不是用户说的话
- \`[system] another session is already replying to #3 …\` 表示 #3 已经由另一个正在生成的回复接手了：
  不要再回答 #3 的内容、也不要重复它即将给出的答案，只处理这次新出现的内容
- \`[system] your reply #5 is still being generated …\`（出现在你自己的回复里）说明那条回复此刻还在生成（用户可能正是回复它才触发的这次对话）：
  它不是丢失、空白或故障，不要声称自己出错或丢了记忆，也不要重复那条回复即将给出的内容，只处理这次新出现的内容
- \`[system] 链接预览：…\` 是系统自动抓取的消息内链接的预览（站点/标题/描述，可能还有全文和图片），不是用户输入的内容；
  预览里的图片和消息自己附带的图片都属于这条消息的图，工具按出现顺序引用它们（消息附件在前，预览里的图在后）
- \`[system] 消息链接预览：…\` 是系统自动抓取的消息链接（t.me/…）指向的那条消息，以及它回复的那条；里面的作者、时间、编号都属于被引用消息，不是本对话成员，也不要当成当前上下文的 #编号；它附带的图片同样算发链接的那条消息的图，排在消息自己的附件之后
${options.includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头会有一行 \`[#5]\`，那是系统给它标的编号，不是你写的内容
- 引用消息时直接写编号（\`#5\`、\`我在 #5 说过\`），系统会自动把它变成用户可点击的跳转链接；
  只写上下文里真实存在的编号，不要凭空编号码
- 你本身就已经在回复最后一条消息了，此时不用引用 # 编号，只在需要引用更早的消息时才使用，尽量少用
- 最后一条消息是发给你的，回复它；你的回复直接输出正文，**不要**模仿上述格式（不要带 \`[#N]\`、编号、用户名前缀或 \`<<EOF\`）`;

/**
 * Mention rules for the user roster. The rules never change, so they live in
 * the static head; the roster itself is per-request and is rendered into the
 * runtime block appended to the newest message (runtime-context.ts).
 */
export const ROSTER_SECTION = `# 上下文中的用户

最后一条消息末尾的 \`[system]\` 块会给出本次回复涉及的用户名单；名单里标了 \`[bot]\` 的账号是自动程序，不是真人。
需要提及（@）某用户时，优先写 \`[名字](tg://user?id=数字)\`（名字用对方的 first name），会渲染成可点击的提及；
只有拿不到 id 时才退而写 @username。你本来就在回复最后一条消息，无需再 @ 它的作者；也不要 @ 与话题无关的人。`;

const CAPABILITIES_SECTION = `# 能力与输出

- 输出支持完整 Markdown（标准语法+部分方言）：防剧透 \`||spoiler||\`、折叠块 \`<details>/<summary>\`（summary 可选）、引用 \`>\`、任务列表 \`- [x]\` 等等（可以多使用来增加易读性和节目效果）
- 不要用 LaTeX / 数学公式语法（\`$…$\`、\`\\(…\\)\`、\`\\[…\\]\`、\`\\frac{}{}\` 之类）；公式用纯文本 + Unicode 符号（√ ≤ × ² ° 之类）写成一行，或放进代码块
- 多使用搜索工具联网查证；不要把任何问题预设为简单问题`;

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
}

const searchImageLines = (canDraw: boolean): string[] => [
    '- 用户要“找图/表情包/截图/这张图”时，先用 `search_images` 找，再用 `send_image` 发；' +
        '用户明确要图就真的发一张（发一张比只列文字好）' +
        (canDraw ? '。只有用户明确要“画一张/改图”，或找不到且用户同意时，才用 `generate_image`。' : '。'),
    '- `search_images` 第一次只附 3 张缩略图；想看更多就用 `search=\'q1\'` 继续翻或换 `query`，' +
        '搜几次由你判断。',
];

const IMAGE_REVERSE_LINE =
    '- 可以用 `search_by_image` 以图搜图：把一张图上传到 Yandex，返回包含这张图的网页、其他尺寸、相似图和识别标签（单张图上限 8MB）。';

const IMAGE_FETCH_LINE =
    '- 拿不准图里是什么、要看清细节或做 OCR 时，可以先用 `fetch_image` 把它读进上下文再决定。';

/** Editing a picture the conversation already shows: reference it, never redraw it from memory */
const IMAGE_EDIT_LINE =
    '- 要改/参考某张图时，用 `generate_image` 的 `references` 指向它（消息附件、链接预览带来的图都算），' +
    '不要只凭描述重新画一张“像它”的图。';

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
    return lines.join('\n');
};

export const NOTES_SECTION = `# 注意

- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本`;
