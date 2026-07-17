# 引子：k-on-bot 回复链路迁移到 sendRichMessage / sendRichMessageDraft

> 2026-07-17 立项引子，未开工。前置：`2026-0717-0748-富文本消息接入与entities反向markdown技术设计.md` 全部落地（server 10.2 + grammy 1.45 + 包 0.3.0 反向 API）。

## 一句话

Bot API 10.1+ 允许 bot 免会员发送富文本消息：`sendRichMessage({ markdown })` 单条 32768 字符、原生表格/标题/公式/嵌套列表/行内媒体，`sendRichMessageDraft` 官方定位就是 LLM 流式输出。迁移后 k-on-bot 现有回复链路的大部分复杂度可以退役。

## 诱因（当前链路在解决的问题，rich message 原生消掉）

- 4096 字符上限 → smart-splitter 拆分器（双预算、切点策略、跨块实体拆分）
- ~100 实体上限 → maxEntities 预算与坍缩切点
- 表格无原生渲染 → 等宽字体 + East-Asian-Width 对齐 hack
- 标题无原生渲染 → bold 模拟
- 流式 = editMessageText 反复编辑 → edit-coordinator 限速排队（20 次/60s、burst 10）、'message is not modified' 处理、编辑竞态(edit-detected 按钮被终稿抹掉那类 bug 的温床)
- LaTeX 公式无法渲染 → 现在原生 mathematical_expression

## 迁移要点备忘（调研时已确认的事实）

- `InputRichMessage` 支持 `markdown` / `html` / `blocks` 三种输入；`media` 字段配 `tg://photo?id=` 链接声明行内媒体（Bot API 10.2）。
- 发送无会员要求；仅媒体块需要 bot 有该聊天发媒体权限。
- 约 8000 字符后客户端自动折叠 "Show More"。
- `sendRichMessageDraft`：流式部分消息（partial rich messages）——需实测其节流规则、与 editMessageText 的限速是否同池、终稿如何 finalize（draft → 正式消息的转换语义）。
- `editMessageText` 已支持 `rich_message` 参数,存量消息可编辑升级。
- grammy 1.45 已带全部类型（`/tmp` 验证过 @grammyjs/types 4.0.0）。

## 关键未知（开工前要实测）

1. draft 流式的编辑节流 vs 现有 edit-coordinator 的 20/60s——能否直接扔掉 coordinator。
2. markdown 输入的方言细节：Telegram 侧 parser 和 telegram-md-entities 输出方言的兼容性（尤其 spoiler、underline、expandable details）——可能需要包加 `dialect: 'telegram-rich'` 输出模式。
3. 客户端兼容性：老客户端看 rich message 是什么降级体验（会员编辑器 7/14 才全量,存量客户端表现未知）。
4. versions/重试/按钮体系是否照搬——rich message 的 message_id 语义与普通消息一致,理论上兼容,需验证 editMessageReplyMarkup 可用。
5. 与现有 entities 流式管线的共存策略:按模型/按开关灰度,还是一刀切。

## 预期退役清单（迁移完成后）

- `smart-splitter.ts` 大部分、实体预算逻辑
- 表格等宽对齐(包内保留,bot 侧不再用)
- edit-coordinator 可能整体退役(取决于未知 1)

## 不迁移的部分

- 落库/上下文构建(与发送无关)
- telegram-md-entities 包本身(渲染目标从 entities 变 markdown 直传,包反而更简单——LLM 输出已是 markdown,可能只需清洗)
