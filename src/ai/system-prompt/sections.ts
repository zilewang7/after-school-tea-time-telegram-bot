/**
 * Built-in static sections of the system prompt.
 *
 * These paragraphs document the wire format produced by
 * src/reply/context-builder.ts (message numbering, annotations, <<EOF, …).
 * They live in code — not in the mounted preference file — so a format
 * change and its prompt documentation are versioned in the same commit.
 */

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
  - \`[quote: "引文"]\` — 回复时引用的具体片段（可能是被回复消息的一部分，已折成一行）
  - \`[sent a picture]\`（或 video/sticker/audio…）— 消息附带的媒体；
    标注里出现 failed / too large / not visible 时说明该媒体你看不到；
    贴纸会带上 \`pack emoji\`，那只是贴纸包元数据（常由 Telegram 自动分配、与画面无关），判断贴纸只看图/动画本身
- 冒号后面才是正文；没有正文的消息（只发了媒体、或只用 \`/chat\` 召唤你）就只有标注、不带冒号
- \`<<EOF\` 是消息结束标记
- 独立的 \`[system] …\` 段落是系统信息，不是用户说的话
- \`[system] 链接预览：…\` 是系统自动抓取的消息内链接的预览（站点/标题/描述，可能还有全文和图片），不是用户输入的内容
${options.includeOcrNote ? OCR_FALLBACK_NOTE : ''}- 你自己的历史回复开头会有一行 \`[#5]\`，那是系统给它标的编号，不是你写的内容
- 引用消息时直接写编号（\`#5\`、\`我在 #5 说过\`），系统会自动把它变成用户可点击的跳转链接；
  只写上下文里真实存在的编号，不要凭空编号码
- 你本身就已经在回复最后一条消息了，此时不用引用 # 编号，只在需要引用更早的消息时才使用，尽量少用
- 最后一条消息是发给你的，回复它；你的回复直接输出正文，**不要**模仿上述格式（不要带 \`[#N]\`、编号、用户名前缀或 \`<<EOF\`）`;

export const CAPABILITIES_SECTION = `# 能力与输出

- 输出支持完整 Markdown（标准语法+部分方言）：防剧透 \`||spoiler||\`、折叠块 \`<details>/<summary>\`（summary 可选）、引用 \`>\`、任务列表 \`- [x]\` 等等（可以多使用来增加易读性和节目效果）
- 多使用搜索工具联网查证；不要把任何问题预设为简单问题`;

export const NOTES_SECTION = `# 注意

- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本`;
