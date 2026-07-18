# 调研报告：回复链路迁移到 sendRichMessage（五个未知的答案）

> 2026-07-17 完成。前置引子：`2026-0717-0810-引子-回复迁移到sendRichMessage的评估.md`。
> 方法：官方文档逐字核对（core.telegram.org/bots/api，2026-07-17 版）+ 本地 10.2 server 用 @WatchFirstBot 实弹实测（测试群 + 私聊）+ 现有发送链路全量盘点。

## 最终裁决（2026-07-17 用户真机实测后）：**搁置，不迁移**

真机体验发现客户端侧硬伤，当前版本不可接受：

- **富文本消息无法 quote 回复、复制时不能选择部分文本**——这是搁置的直接原因，交互降级比渲染收益更致命。
- 剧透两种输入都渲染异常：HTML `<span class="tg-spoiler">` 被吞（API 层就丢了，见未知 2 实测 F）、宽松剧透不认。
- 长消息**确实有 "Show More" 折叠**（引子里的传闻属实，官方文档只是没写）。
- 裸链接和 `#标签` 实测**不会自动成实体**（与普通消息行为不同）。
- splitter 即使迁移也**不能退役**：复杂任务下 CoT 几乎无限增长，32768 仍是会撞到的上限。
- 渲染效果本身很好（原生客户端支持）——待 Telegram 客户端补齐 quote/部分选择后可重启此计划，届时以下调研结论仍然有效。

---

## 结论速览（调研结论，供未来重启时参考）

迁移在 API 层可行，但有一个此前没预料到的硬约束改变了架构：

**`sendRichMessageDraft` 仅限私聊**（文档明说 "target private chat"，群里实测返回 `TEXTDRAFT_PEER_INVALID`）。k-on-bot 主战场是群聊 → 群里的流式载体仍然是 `editMessageText`，只是参数从 `text+entities` 换成 `rich_message: { markdown }`（实测可用，15 连发编辑全过）。因此 **edit-coordinator 不能退役**，它的 20/60s 配额、429 退避、desired-state 合帧全部照用，只换 flush 时调的 API 参数。

## 未知 1：draft 节流 vs edit-coordinator

- draft 生命周期（文档逐字）：临时 30 秒预览，同 `draft_id`（必填、非零）重复调用即更新且"变化带动画"，**没有 finalize 方法**——终稿就是普通 `sendRichMessage`，草稿自行消失。每帧传全量内容，无增量 API。
- 实测节流：150ms 间隔连发 30 帧，第 20 帧撞 `429 retry_after=3`；单次调用均值 91ms。≈1 帧/秒安全，与普通消息的通用限额同量级。**文档对 draft 专属限额沉默**。
- 帧丢弃无害（下一帧带全量），所以 draft 路径的"协调器"可以极简：定时器 + 最新帧覆盖即可。但这只服务私聊。
- `<tg-thinking>` 块实测可用（仅 draft），空 markdown 非法（占位用 tg-thinking）。
- **结论：coordinator 保留（群聊流式仍走 edit）；私聊可选升级为 draft 流（体验更好：带动画、不产生编辑记录）。**

## 未知 2：markdown 方言兼容性（实测 + 文档）

官方方言 = **"compatible with GitHub Flavored Markdown where possible and can contain arbitrary HTML"**（非 MarkdownV2）。与 telegram-md-entities 输出方言逐项实测：

| 特性 | 包输出 | Telegram 解析结果 |
|---|---|---|
| `#`~`######` 标题 | ✅ | 原生 heading 块 |
| `**bold**` `*italic*` `~~strike~~` | ✅ | ✅ |
| `||spoiler||` 紧贴 | ✅ | ✅ |
| **`|| 带空格 ||` 宽松剧透** | 包 loose 模式认 | ❌ **Telegram 不认，原样字面量** |
| **`__underline__`** | 包 → underline | ❌ **Telegram 按 GFM → bold** |
| `` `code` `` / ```` ```lang ```` | ✅ | 原生 code / pre+language |
| GFM 表格 + 对齐 | ✅ | 原生 table（对齐保留，is_bordered/is_striped） |
| `- [x]` 任务列表 | ✅ | 原生 list item `has_checkbox`/`is_checked` |
| 嵌套列表 | ✅ | 原生嵌套 |
| `> ` 引用 | ✅ | 原生 blockquote |
| `<details><summary>` | ✅ | 原生 details 块（summary 保留） |
| `---` 分割线 | ✅ | 原生 divider |
| `$E=mc^2$` / `$$…$$` | 包不产生 | 原生 mathematical_expression（LLM 直出可用！） |
| `<u>下划线</u>`（HTML 混写） | — | ✅ underline（markdown 里可嵌任意 HTML） |
| 链接 / 自动实体 | ✅ | ✅；`skip_entity_detection: true` 实测有效 |

**迁移动作**：只需两处适配——① underline 输出 `<u>…</u>` 而非 `__…__`；② spoiler 输出紧贴形式（或 `<tg-spoiler>`）。即包加一个 `dialect: 'telegram-rich'` 输出微调即可，主体方言天然兼容。LLM 原始输出里的 LaTeX、任务列表反而**不再需要包处理**，直传更保真。

其他文档要点：`InputRichMessage` 三选一（html/markdown/blocks 恰好一个）；媒体走 `media` 字段 + `tg://photo?id=` 链接（仅独立块，不能行内）；表格单元格仅限行内格式；限额 = 32768 UTF-8 字符 / 500 块 / 16 层嵌套 / 50 媒体 / 表格 20 列。

## 未知 3：老客户端降级

**文档完全沉默**（无 fallback text、无 "Show More" 折叠、无占位符说明——引子里 ~8000 字符折叠的说法在官方文档找不到出处）。服务端无法实测。残余风险：低（TG 客户端自动更新，富文本编辑器 7/14 已全量）。建议：灰度期间观察群友反馈即可，不做前置阻塞。

## 未知 4：versions/重试/按钮体系兼容性 —— 全绿（实测）

- `sendRichMessage` 支持 `reply_markup`（含 inline keyboard）+ `reply_parameters` ✅
- `editMessageReplyMarkup` 对 rich message 可用 ✅
- `editMessageText + rich_message`：rich→rich ✅、**普通消息→rich 升级 ✅**、rich→普通降级 ✅（text 与 rich_message 二选一）
- 编辑后 reply_markup 照旧丢失需重传（与普通消息行为一致）；相同内容编辑照旧报 "message is not modified"（coordinator 已处理）✅
- 返回的 Message 带 `rich_message` 无 `text` → **versions 落库需存 markdown 源**（本来就有），message_id 语义完全一致。
- 12500 字符单条发送 ✅（140 块）——smart-splitter 与实体预算在正常回复长度下彻底失业。

## 未知 5：共存/灰度策略（结合链路盘点）

链路盘点结论（详见盘点，要点）：

- **可退役**：`final-message-builder` 的 renderMarkdown+splitMessage 组装、`smart-splitter.ts` 整个、`api-entities.ts`、response-handler 的长度/实体双预算与 continuation 分支、grounding/agent-stats 的手工 blockquote 拼装（可换原生表格/标题）、coordinator 里 entities 400 降级死开关。
- **必须保留**：edit-coordinator 全部节流机制（换参数不换机器）、streaming-editor 骨架、versions/buttons/messageIds 三处追踪与 DB 层、图片作为独立末条消息带按钮的路径（rich message 行内媒体仅独立块且需发媒体权限，图片路径不动）、continuation registry 自愈逻辑。
- **灰度宿主**：`src/config/instance.ts` 已有 `isChatAllowed` 按 chat 门控，加一个 `RICH_SEND_CHAT_IDS`（或布尔 `RICH_SEND=1` 先只开测试实例）即可按群灰度；全局运行时开关放 `AppState` 与 `currentModel` 同款。
- 建议路线：**一个开关、两条代码路径共存**，测试实例先全开 → 主群灰度 → 稳定后删旧路径（旧路径删除才是退役收益兑现点）。

## 迁移后的流式形态（推荐架构）

```
群聊: sendRichMessage(首帧) → editMessageText{rich_message}(增量帧, 走现有 coordinator)
      → 终帧 editMessageText{rich_message} + editMessageReplyMarkup(按钮)
私聊: sendRichMessageDraft(draft_id 固定, ~1帧/s) → sendRichMessage(终稿+按钮)   [可选二期]
```

单条 32768 上限意味着正常回复永远单消息：continuation、按钮挂最后一条、多 message_id 追踪都坍缩成单元素情形（结构保留、复杂度自然消失）。

## 实测现场说明

测试消息发在测试群（msg 836~843 一带：全方言消息、按钮消息、长消息、流式编辑演示）和你与 @WatchFirstBot 的私聊（流式草稿演示 + 一条"终稿完成"消息，草稿已自动消失）。可翻手机直观看渲染效果，尤其值得看：原生表格、details 折叠、$E=mc^2$ 公式、群里那条 12500 字的长消息（看客户端是否有折叠行为——顺手验证未知 3 的 Show More 传闻）。
