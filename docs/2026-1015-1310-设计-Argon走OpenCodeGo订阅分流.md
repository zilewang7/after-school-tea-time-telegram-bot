# Argon 走 OpenCode Go 订阅：按模型分流（技术设计）

> 状态：已批准，实施中（2026-10-15 13:10 起草，13:40 按用户裁决定稿）
> 用户裁决：① 非 Argon 的 Gemini 走 hub 省钱（GEMINI_API_URL 回到 hub.wanai.de）；② 接受 §5 的代价；③ argon-watch 改探 Go 端点。
> 日期：2026-10-15 13:10 (+08)
> 一句话结论：Argon 能直连 OpenCode Go 的 Google 原生端点，走你的订阅；靠 hub/Sub2API 的模型名映射或调 Vertex 优先级都不可能做到，那两条路是协议族不匹配，不是排序问题。

## 0. 设计目标（用户视角）

我在群里 `/model gemini-4-argon` 时，这个模型消耗的是我的 **OpenCode Go 订阅额度**，而不是我自己 GCP（Vertex）的按量账单。除此之外一切照旧：`gemini-3.1-pro-preview` / `gemini-3.8-flash`、`/pic*` 生图、>20MB 大文件都不变。并且我关掉 Sub2API 里那个 GCP 账号时，Argon 仍然能用。

## 1. 现状与取证

文本 Gemini 现在的链路：

```
k-on-bot --GEMINI_API_URL=https://axonhub.heimaois.me--> 自有 AxonHub channel#4(sub2api-gemini)
        --> Sub2API --> group gemini-default --> 账号11(AIStudio，模型列表哨兵/不可调度)
                                                账号69(GCP SA, project ddc-gcp-main)  ← 实际服务者
        --> 我自己的 Vertex 按量账单
```

证据：

- Sub2API `usage_logs` 近 14 天所有 gemini 记录 `account_id=69`（含 `gemini-4-argon` 与 `gemini-3.8-flash`），`actual_cost` 非零 → 确实记在我的 GCP 上。
- 关掉该 GCP 账号后，channel#4 对**任何** Gemini 模型都回 `503 No available Gemini accounts`：组里没有第二个可调度账号（11 号是 models-list-only 哨兵）。
- bot 日志 `[gemini-usage] ... via=-`：主端点已不是 hub，`x-axonhub-routed-via` 为空；之前出现 `via=22127` 的时段才是 hub Vertex 渠道。

Argon 为什么没走订阅（两层原因，都不是优先级问题）：

1. Argon 在 OpenCode 是 **Go 专属 + Google 原生协议族**，可用端点只有：
   `https://opencode.ai/inference/go/v1/models/gemini-4-argon-contributor:generateContent`（`:streamGenerateContent` 为流式），鉴权 `Authorization: Bearer <key>`，并要求客户端带稳定的 `x-opencode-session`。
2. 之前试的两条替代路都走不通：
   - Sub2API / AxonHub 的"模型名映射"只能改 id，**不能把 Gemini 协议转成 OpenAI/Anthropic 协议** → 上游稳定 400 `Model does not support this protocol`；
   - hub 上那个 `gemini-4-argon-contributor`（渠道 #10365，你自己的 opencode go 订阅挂的）同样只提供 OpenAI 形态 → 同一个 400；
   - 把 Vertex 渠道优先级 1→3 只影响 hub 内部排序，不可能把请求"转"到 OpenCode。

已实测可用（本方案要接的形状）：

| 用例 | 结果 |
|---|---|
| 显式 `role:user` 的 Google 原生 body | 200，返回 `OK` |
| `systemInstruction` + 5 条 `safetySettings(OFF)` + `maxOutputTokens` | 200，正常短答 |
| `thinkingConfig`（budget 或 level） | 200，思考以 `thought:true` 分片返回（现有 `processStream` 已把它归到 thinking 折叠区，不会漏进正文） |
| `tools:[googleSearch, urlContext]` | 200，但**不返回 groundingMetadata** |
| `@google/genai` SDK + 自定义 fetch 改写路径与请求头 | 200，流式正常（§3.2） |

隐私开关：OpenCode 控制台的 "Allow paid endpoints that train on request data" 已开启（截图确认），contributor 模型可调用。

## 2. 方案总览

在 `GeminiPlatform` 增加**第三条专用客户端**，只服务 Argon 系模型。`sendMessage` 内分流优先级：

1. 带 `gs://` 大文件 → `largeMediaClient`（hub Vertex key，不变：只有 Vertex 读得到我们的桶）
2. `gemini-4-argon*` 且配置了 `OPENCODE_GO_API_KEY` → **新增** `opencodeGoClient`
3. 生图模型 → `imageClient`（ephone，不变）
4. 其他 → `genAI`（自有 AxonHub，不变）

## 3. 实现要点

### 3.1 客户端

```
new GoogleGenAI({
  apiKey: process.env.OPENCODE_GO_API_KEY,
  vertexai: false,
  httpOptions: { baseUrl: process.env.OPENCODE_GO_API_URL ?? 'https://opencode.ai', fetch: rewriteOpenCodeGoRequest },
})
```

用 SDK 而不是自己写 fetch：流式解析、`thought` 分片、usage 统计全部复用现有 `processStream`，不新增解析代码。

为什么直连而不是继续经 AxonHub：Go 的 Argon 只在 Google 原生端点提供，任何中继都得自己做协议转换；直连最少一跳、最少一处故障点。

### 3.2 自定义 fetch（新文件 `src/ai/platforms/opencode-go-fetch.ts`）

- 路径改写：`/v1beta/models/<id>` → `/inference/go/v1/models/<id>`（保留 `alt=sse` 等 query）
- 模型名改写：`gemini-4-argon` → `gemini-4-argon-contributor`（已是 `*-contributor` 的不重复改；映射表来自 `OPENCODE_GO_MODEL_MAP`，缺省内置上述一条）
- 请求头：删除 `x-goog-api-key` / `x-goog-api-client`；写入 `authorization: Bearer <key>`、`x-opencode-session: <会话id>`、`user-agent: k-on-bot/1.0`（官方明确要求客户端用自己的 UA，而不是通用 SDK 名）
- body 原样透传（实测该 body 被接受）

### 3.3 会话 id（`x-opencode-session`）

- 复用 `resolveContextRoot(chatId, userMessageId)`：同一条回复树 = 同一个 session，符合官方"每次对话一个稳定 id"的要求，也有利于上游 prefix cache。
- `PlatformConfig` 新增可选字段 `sessionId?: string`；在 `chat-handler` 与 `retry-handler` 两处填 `k-on-bot:<chatId>:<rootMessageId>`；未提供时回落 `k-on-bot:unknown`（不影响正确性）。
- 该头只在 Argon 路径注入，其他平台零影响。

### 3.4 请求体

- **保持**：`systemInstruction`、`safetySettings`、`generationConfig.maxOutputTokens`、`thinkingConfig`（`^gemini-4` 仍用 `thinkingLevel: HIGH`）——实测全部被接受。
- `tools` 照发（不报错），但不再期望 Argon 出现 GoogleSearch 块（§4）。

### 3.5 配置（`.env`，不入 git）

```
OPENCODE_GO_API_URL=https://opencode.ai
OPENCODE_GO_API_KEY=<你的 OpenCode key（与 Sub2API 账号 85 用的同一个）>
OPENCODE_GO_MODEL_MAP=gemini-4-argon=gemini-4-argon-contributor
```

未配置 `OPENCODE_GO_API_KEY` ⇒ 分支自动关闭，Argon 回落到当前主端点（零风险默认）。

### 3.6 观测

- 启动：`[gemini] gemini-4-argon rides the OpenCode Go subscription at https://opencode.ai`
- 每轮：`[gemini] argon → OpenCode Go (session=<id>, upstream=gemini-4-argon-contributor)`
- `[gemini-usage]` 增记 `via=opencode-go`（该端点没有 `x-axonhub-routed-via`，用响应 `modelVersion` 佐证）

## 4. 不变的部分与已知差异

| 项 | 变化 |
|---|---|
| `gemini-3.1-pro-preview` / `3.8-flash` 等普通文本 | **改走 hub 市场**（`GEMINI_API_URL=https://hub.wanai.de`，花 hub 额度，不再烧你的 GCP） |
| 自有 AxonHub / Sub2API 那条链 | 从 bot 的 Gemini 路径上摘除（仍留作你自己的其他用途；Sub2API 的 GCP 账号继续关着也不影响 bot） |
| `/pic*` `/vid*` 生图与视频 | 不变（ephone / comfy） |
| >20MB `gs://` 大文件 | 不变（hub Vertex key；Go 端点在协议上读不到 gs://，即使模型是 Argon 也照旧） |
| Argon 的 GoogleSearch 接地 | **会消失**：Go 端点接受 tools 但不产出 groundingMetadata → 底部不再有搜索来源块 |
| Argon 的思考 | 保持（`thought:true` 分片进 thinking 折叠区） |

## 5. 风险与代价（需要你明确接受）

1. **训练条款**：Go 的 Argon 属 contributor 档，官方隐私表写明 "Your prompts and completions may be used to train future Google models"。选了该模型时，**群里所有人的对话**都会进这条通道。你已开同意开关，但群聊场景需要你确认。
2. **额度**：Argon 在 Go 是 $4/$20 per 1M（活动期 2x），月度上限 $60，估算约 440 次典型请求/月。打满后按你控制台设置：要么请求失败，要么回落到 pay-as-you-go 余额。群聊长期挂在 Argon 上，几天就可能打满。
3. **上游波动**：实测出现过一次无信息的 400（同形状请求随后 200），依赖现有 3 次重试吸收；不额外加兜底。
4. **非 Argon 仍烧 GCP**：本方案只解决 Argon，"关掉 GCP 就全挂"的根因（组内没有第二个账号）依旧存在 → §7 决策点 1。
5. **全局模型开关**：`/model` 无校验且全局，任何人都能把整个 bot 切到 Argon，从而消耗你的订阅额度（现状即如此，本方案不改变）。

## 6. 验证方案

1. 离线：`npx tsc --noEmit` + `pnpm test:offline`；新增一个纯函数单测（路径 / 模型名 / 请求头改写，用假 fetch 断言 URL 与 header）。
2. 真实路径（复用 `tmp/` 现有 harness 风格脚本，走真实 platform）：
   - `gemini-4-argon` → 200、有正文、日志 `via=opencode-go`
   - `gemini-3.1-pro-preview` → 仍走 AxonHub（回归）
   - `gemini-3-pro-image` → 仍出图（回归）
3. 端到端：群里 `/model gemini-4-argon` 提问一次，回复正常、底部无搜索块、bot 日志出现 `via=opencode-go`。
4. 账单侧：该时间窗 Sub2API `usage_logs` **不应**新增 Argon 记录（证明没回到 GCP 通道）。
5. 回滚验证：清空 `OPENCODE_GO_API_KEY` 重建容器 → Argon 回落主端点。

## 7. 待你拍板的三个点

1. **非 Argon 的 Gemini 要不要也搬离 GCP？**（`3.1-pro` / `3.8-flash` 现在仍走你的 GCP 按量）
   - A. 不动：保持现状，GCP 账号别关（最省事）
   - B. **回滚到 hub 市场 key（已采纳）**：`.env` 的 `GEMINI_API_URL` 回到 `hub.wanai.de`，消耗 hub 额度
   - C. 你在 Sub2API 补一个非 GCP 账号
2. **接受 §5 的代价吗？**（训练条款 / $60 月额度 / Argon 无搜索接地）—— 已确认接受
3. **`scripts/guard/argon-watch.mjs` 要不要改探新路径？** —— 已改：只探 Go 端点，hub 上架扫描层随 Argon 一起下线（它本来就只产出 "Model does not support this protocol"）

## 8. 回滚

- 清空 `OPENCODE_GO_API_KEY` + `docker compose up -d k-on-bot` ⇒ Argon 立刻回到原主端点，代码零改动。
- 代码侧单独 commit，便于 revert。
