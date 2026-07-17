# 富文本消息接入 + entities→markdown 反向管线 技术设计

> 2026-07-17 · k-on-bot + telegram-md-entities

## 设计目标（最终用户视角）

群友（Premium 用户）用 Telegram 新上线的富文本编辑器发的消息（标题、表格、列表、引用、代码块、公式、段落间嵌图），bot 要能正常收到、落库、进上下文——LLM 看到的是保真的 markdown，能针对表格里的数据、代码块里的代码正常回答，而不是像现在这样整条消息凭空消失。同时，普通用户发的带格式消息（加粗、斜体、剧透、行内链接等）落库时也不再丢格式——数据库里和喂给 LLM 的所有用户消息统一为 markdown 表示，bot 引用、复述、改写用户消息时格式不再丢失。

## 一、调研结论

### 1.1 Telegram 侧时间线

- **6/11 Bot API 10.1**：新增 `Message.rich_message` 字段（bot 接收富文本消息）、完整的 `RichMessage`/`RichBlock`/`RichText` 类型体系、`sendRichMessage`/`sendRichMessageDraft` 发送方法。
- **7/14 Bot API 10.2**：`InputRichMessage` 补充 `blocks` 与 `media` 字段。
- **7/14 客户端更新**：富文本编辑器对 Premium 用户开放（发送需会员），单条最长 32768 字符。

### 1.2 落库失败根因

本地 `telegram-bot-api` server 镜像（`aiogram/telegram-bot-api:latest`）是 **6/8 构建的，早于 Bot API 10.1**。老版本 tdlib 不认识富文本消息这种新内容类型，送达 bot 的 update 里既没有 `text` 也没有 `rich_message`（视为 unsupported message），`autoSave` 里 `baseText` 拼出来是空串，等于什么都没存。**不是 k-on-bot 代码 bug，是基建版本滞后。**

配套事实：

- aiogram 镜像已有 `10.2` tag（7/16 更新），升级即可。
- grammy `1.44.0`（当前使用）已支持 Bot API 10.1 的 `rich_message` 接收类型；`1.45.0`（7/16 发布）支持 10.2。建议顺手升到 `^1.45.0`。

### 1.3 关键结构（@grammyjs/types 4.0.0 实测）

**接收侧不是 `{text, entities}`，是一棵树：**

```ts
Message.rich_message?: RichMessage
RichMessage = { blocks: RichBlock[]; is_rtl?: boolean }

RichBlock = paragraph | heading(size 1-6) | pre(language?) | footer
          | divider | mathematical_expression(LaTeX) | anchor | list(items)
          | blockquote(blocks, credit?) | pullquote | collage | slideshow
          | table(cells[][], caption?) | details(summary, blocks, is_open?)
          | map | animation | audio | photo | video | voice_note | thinking

RichText = string | RichText[] | bold | italic | underline | strikethrough
         | spoiler | code | url(url) | text_mention(user) | custom_emoji
         | subscript | superscript | marked | mathematical_expression
         | mention | hashtag | ... （均为 { type, text: RichText } 递归嵌套）
```

树形结构对转 markdown 是**利好**：天然嵌套良好，不存在 flat entities 重叠拆并问题，直接递归 walk 即可。

**发送侧彩蛋**：`InputRichMessage` 直接支持 `markdown: string` 字段（还有 `html`/`blocks`），即 bot 未来可以用 `sendRichMessage({ markdown })` 原生发表格/标题/公式，不再受 4096 字符与实体上限约束（32768 字符，约 8000 字后自动折叠 Show More）。本轮不做，列为后续方向。

## 二、方案总览（三个部分）

```
Part A  基建升级          → 修落库 bug 的前提（server + grammy）
Part B  telegram-md-entities 新增两个反向 API
        B1 richBlocksToMarkdown(blocks)      RichBlock 树 → markdown
        B2 entitiesToMarkdown({text,entities}) flat 实体 → markdown
Part C  k-on-bot 落库接入  → 富文本消息与普通消息统一 markdown 落库
```

Part A + B1 + C 的富文本部分是本次 bug 的修复闭环；B2 + C 的普通消息部分是"落库统一 markdown"的增量改进，可分批上线。

## 三、Part A：基建升级

1. `docker-compose.yaml`：`aiogram/telegram-bot-api:latest` → **`aiogram/telegram-bot-api:10.2`**（pin 版本，不再用 latest——这次的事故正是 latest 实际内容陈旧且不可控）。
2. `package.json`：`grammy ^1.44.0` → `^1.45.0`。
3. 升级 server 会重启容器,bot 的 webhook/polling 无状态,重启即恢复;`telegram-bot-api-data` 卷保留,已下载文件不受影响。

风险：server 大版本升级后登录态需重新鉴权（首次启动会向 Telegram DC 重新注册），预计分钟级；选择低峰期操作。

## 四、Part B1：richBlocksToMarkdown（放 telegram-md-entities 包）

**为什么放包里**：纯格式转换、零运行时依赖（类型用结构化定义，不依赖 grammy），与包的定位（Telegram 格式 ↔ markdown）一致，且能复用包的测试基建做往返验证：

```
renderMarkdown(richBlocksToMarkdown(blocks)) 的显示效果 ≅ 原富文本
```

**映射表**（目标方言 = 本包自己的输入方言，保证再渲染回 entities 不失真）：

| RichBlock | markdown |
|---|---|
| paragraph | 正文段落（inline 走 RichText 映射） |
| heading size 1-6 | `#`~`######` |
| pre(language) | ` ```lang ` fenced block（内容含 ``` 时加长 fence） |
| list（含嵌套/checkbox/有序 value+type） | `- ` / `1. ` / `- [x] `，嵌套缩进 |
| blockquote / pullquote（credit） | `> `，credit 作末行 `> — credit` |
| table | GFM 管道表；colspan/rowspan 降级为空单元格补位 |
| details(summary, is_open) | `<details><summary>`（正好是本包正向已支持的语法） |
| divider | `---` |
| mathematical_expression | ` ```latex ` 块 |
| footer | 正文 + 前置 `—` 弱化（有损，可接受） |
| photo/video/audio/voice/animation | 占位文本 `[图片]`/`[视频: caption]`（v1 不下载字节，见 §六） |
| map / collage / slideshow / thinking / anchor | 占位文本或跳过 |

**RichText inline 映射**：bold→`**`、italic→`*`、underline→`__`、strikethrough→`~~`、spoiler→`||`、code→`` ` ``、url→`[text](url)`、text_mention→`[name](tg://user?id=)`、custom_emoji→alternative_text、mathematical_expression→`$expr$` 原文、subscript/superscript/marked→纯文本透传（正向没有对应语法，有损）、mention/hashtag/cashtag/bot_command/email/phone/bank_card→纯文本透传（重发时服务端自动重新识别）。

**转义**：inline 文本中的 markdown 元字符按本包 parser 的规则转义；验收即"再 parse 回来显示等价"，用现有 fixture 基建机械化验证。

**API 形状**：

```ts
richBlocksToMarkdown(blocks: RichBlock[], options?: {
  mediaPlaceholder?: (block: RichMediaBlock) => string;
}): string
```

`RichBlock` 类型在包内按 Bot API 结构自定义（structural typing，与 grammy 的类型天然兼容，包不引入依赖）。

## 五、Part B2：entitiesToMarkdown（flat 实体反向）

沿用先前调研结论（可行性已确认），要点复述 + 增量决策：

1. **第一个 commit**：把 `styleSegments()` 从 `test/e2e/helpers/normalize.ts` 提升进 `src/`——逐字符样式 run 序列就是反向管线的中间表示，重叠/拆并实体在这一步归一化掉。
2. **pass 2**：style-run 序列 → 区间树重建（相邻 run 共同样式最大化共享包裹层），块边界（空行）处 close & reopen。
3. **目标方言 = 自家输入方言**，往返不变量机械化验收：
   `styleSegments(renderMarkdown(entitiesToMarkdown(msg))) ≅ styleSegments(msg)`
   （fast-check 全语料 + 现有 17 个 fixture 直接复用。）
4. **flanking 安全**：包裹前把实体边缘 trim 到非空白（服务端本就不渲染边缘空白样式）；CJK 相邻由 cjk-friendly 扩展兜住。
5. **有损边界**：heading/表格/列表等正向单向糖不逆推；`inferHeadings`/`inferDetails` 启发式默认关闭。
6. **输入类型放宽**：接受服务端实体类型（mention/hashtag/url/custom_emoji 等），策略为文本透传、custom_emoji 落 fallback emoji。
7. **API 形状**：

```ts
entitiesToMarkdown({ text, entities }, {
  dialect?: 'self' | 'markdownv2',   // 默认 self
  inferHeadings?: boolean,           // 默认 false
  inferDetails?: boolean,
}): string
```

估算 400–600 行 src；B1 树 walk 约 250–350 行。两者共用 inline 转义模块。发版节奏：B1+B2 一起出 **0.3.0**。

## 六、Part C：k-on-bot 落库接入

### C1 富文本消息（修 bug 主线）

`autoSave` / `autoUpdate` 中：

```
msg.rich_message 存在
  → text = richBlocksToMarkdown(msg.rich_message.blocks)
  → 走既有 saveMessage 流程（<<EOF 约定不变）
```

- **媒体块 v1 决策**：富文本消息可含多个嵌入媒体，现有管线是"一消息一媒体"。v1 只落占位文本（`[图片]` 等），不下载字节；"取第一个媒体块进 media_cache"列为 v1.5 增量（复用 `resolveCapturedMedia` 的下载管线，photo 块结构与 `msg.photo` 相同）。
- 长度防线：32768 字符远超普通消息，落库照存（SQLite TEXT 无压力），进上下文时受现有 token 预算裁剪机制约束，无需新增逻辑。
- 富文本消息的**编辑**同样带 `rich_message`，`autoUpdate` 同步支持。

### C2 普通消息统一 markdown（增量）

`renderTextWithEntities`（现在只还原 text_link）替换为 `entitiesToMarkdown`：

- 落库的用户消息从"纯文本 + 内联 [label](url)"升级为完整 markdown（加粗/斜体/剧透/代码等全保留）。
- `/chat` 命令正则、链接预览 `extractFirstUrl`、luoxu 匹配等下游消费者都吃纯文本习惯了，markdown 元字符（`**`、`` ` ``）混入的影响面要过一遍——目前判断均为子串/正则匹配，兼容；上线前用近一周真实 DB 语料回放确认。
- quote（引用片段）字段同样走 entitiesToMarkdown。

### C3 测试

- 包内：B1/B2 各带 fixture + 往返不变量（离线，`npm test`）。
- k-on-bot：富文本消息 e2e 无法真实模拟（测试账号无会员，bot 收不到自己 `sendRichMessage` 的消息），改为**单测式注入**：手工构造带 `rich_message` 的 update JSON 喂 `bot.handleUpdate()`，断言落库文本；普通消息格式落库用现有 e2e 加一例带格式消息断言。

## 七、实施顺序与分期

| 阶段 | 内容 | 交付 |
|---|---|---|
| 1 | Part A 基建升级 + 临时兜底（rich_message 存在但包未就绪时，先递归抽纯文本落库，保证不再丢消息） | 当天可上线，bug 止血 |
| 2 | Part B1 richBlocksToMarkdown → 包 0.3.0-rc | 富文本保真落库 |
| 3 | Part C1 接入 + 注入式测试 | 修复闭环 |
| 4 | Part B2 entitiesToMarkdown（styleSegments 提升开始） | 包 0.3.0 |
| 5 | Part C2 普通消息统一 markdown + DB 语料回放验证 | 全量 markdown 化 |

阶段 1 独立可发；2-3 一组；4-5 一组。每组独立部署、独立可回滚。

## 八、风险备忘

1. `aiogram:10.2` 镜像升级后 server 首次鉴权耗时不确定 → 低峰操作，验证 getMe 通过再切流量（实际同容器,重启即验证）。
2. `thinking` 块（AI 生成消息的思考过程）出现在用户消息中的概率极低，v1 直接跳过。
3. B2 的转义回归风险由往返不变量兜住,失败模式是测试红,不会炸生产。
4. C2 改变落库格式,旧消息(纯文本)与新消息(markdown)在同一上下文窗口共存——LLM 对混合格式不敏感,不做迁移。
