# Gemini 全线回归自有 Vertex，Argon 升为默认模型

- 时间：2026-10-16 01:21 CST（2026-10-15 17:21 UTC）
- 代码提交：`0c8f925`（`src/config/models.ts`、`src/ai/platform-factory.ts`、`src/ai/platforms/gemini-platform.ts`）
- 配置：`.env` / `.env.test`（均不入 git）
- 上一阶段文档：[2026-1015-1310-设计-Argon走OpenCodeGo订阅分流.md](2026-1015-1310-设计-Argon走OpenCodeGo订阅分流.md)

## 1. 设计目标（用户视角）

群里 @K-ON 的每一次回答——文本、看图、生图、看 >20MB 的大视频——都重新跑在**我们自己的 Vertex 项目**（`ddc-gcp-main`）上，不再经过 hub 额度市场；同时 `gemini-4-argon` 成为默认模型、也占据 `/model` 菜单里的 Gemini 文本条目，而它照旧消耗 **OpenCode Go 订阅**额度而不是 GCP 账单。

用户侧的直接收益：回答质量不再取决于"这次落在哪个市场渠道"，且 hub 时代被削弱或必须单独绕路的三项能力（Google 搜索来源块、生图、gs:// 大文件）全部回到默认路径。代价是把账单从"按量付费"换成"$300 赠金"，以及 Argon 作为默认模型时不再有搜索来源块（Go 路由不返回 grounding 元数据）。

## 2. 背景

### 2.1 之前为什么绕
自有项目一直按量付费。2026-10-15 查 Sub2API `usage_logs` 确认，所有 Gemini 流量最终都落在 account 69 / project `ddc-gcp-main` 上按原价计费——这正是 2026-10-10 起把文本+图片推到 hub 市场（花 hub 额度）、大文件用 hub 的 Vertex 专用 key、生图钉 ephone 的唯一理由。

### 2.2 hub 路线的代价（这次一并收回）
- **可用性**：渠道声明预算耗尽即整段 403 `All candidate channels have exhausted their declared marketplace budget`（10–25 分钟自愈），`gemini-3.1-pro-preview` 实际只有 #22127 一个候选，窗口一关全量失败。
- **质量**：非 Vertex 渠道输出不稳（群里"降智"反馈），`onlyOfficial` 也挡不住 Copilot 系渠道。
- **特性**：hub 只注册 `/models/*action`，请求体 `cachedContent` 是死代码；中继可能裁掉 grounding 字段。
- **复杂度**：生图必须另钉 ephone（hub 端点记在自家项目账上），大文件必须另配 Vertex-bound key（gs:// 只有 Vertex 渠道读得到）。
- **可观测性**：每次排查都要先确认"这次落到哪个渠道"。

### 2.3 变化点
2026-10-15 用户新建结算账号、把 `ddc-gcp-main` 移过去，该账号带 $300 Free Trial 赠金（控制台"赠金"页：状态可用 / 剩余 100% / 原始值 $300）。费用痛点消失，自有项目成为"最便宜且零特性损失"的来源。

## 3. 方案

### 3.1 唯一开关：`.env`
把 `GEMINI_API_URL` / `GEMINI_API_KEY` 置空（hub、AxonHub 两代配置与 `GEMINI_LARGE_MEDIA_*` 全部注释保留为**整链回滚**）。`GeminiPlatform` 构造随即走 `else` 分支：

```ts
new GoogleGenAI({ vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION || 'global' })
```

即 `GOOGLE_CLOUD_PROJECT=ddc-gcp-main` + `GOOGLE_CLOUD_LOCATION=global` + 挂载的 `gcp-sa.json`（`vertex-express@ddc-gcp-main`）。

`GEMINI_IMAGE_*` 与 `GEMINI_LARGE_MEDIA_*` 只在"存在 `GEMINI_API_URL`"的分支里被读取，因此自动失效：**生图与 gs:// 大文件一起落到 Vertex**，无需改代码。

`DEFAULT_MODEL=gemini-4-argon`；`.env.test` 同步同样的处理（含 `OPENCODE_GO_*`），让 e2e 跑在生产同一条路上。

### 3.2 代码（本次唯一实质改动）
1. `src/config/models.ts`：菜单条目 `gemini-3.1-pro-preview` → `gemini-4-argon`。手打 `/model gemini-3.1-pro-preview` 仍可用（`/model` 是无校验自由文本）。
2. `src/ai/platform-factory.ts`：`getDefaultModel('gemini')` → `gemini-4-argon`。
3. `src/ai/platforms/gemini-platform.ts`：
   - **大文件必须先选到能读桶的客户端**：`const largeMediaClient = hasLargeMedia ? this.largeMediaClient ?? this.genAI : null;`
     旧链 `largeMediaClient ?? opencodeGoClient ?? imageClient ?? genAI` 在 hub 撤退后会出现一个真炸点：**Argon 是默认模型 + 群里发 >20MB 视频 → 请求带着 `gs://` URI 落到 OpenCode Go 路由，而那条路读不到我们的桶**。现在带 gs:// 的请求恒定走 bucket-capable 客户端（有专用 key 用专用 key，否则用主客户端＝Vertex）。
   - **非流式生图判据收紧**：从"是不是图片模型"改为"选中的客户端是不是专用图片端点"（`usesImageEndpoint`）。原先只要配了 `GEMINI_IMAGE_*`，图片模型就走非流式；大文件抢占客户端后会变成"用 Vertex 的客户端发非流式"，语义错位。
   - **usage 行新增路由标签**：`routedLane` 让 `via=` 能区分 `opencode-go` / `large-media` / 直连 Vertex（`-`）。

## 4. 关键取舍

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 文本/看图 | 走自有 Vertex（`GEMINI_API_URL` 置空） | 赠金覆盖成本；唯一零特性损失来源 |
| 生图 | 随主端点走 Vertex | 赠金下无需再避自家配额；实测流式调用也回 inlineData |
| gs:// 大文件 | 走自有 Vertex（不再用 hub 专用 key） | 同一个桶、同一个 SA，链路更短 |
| Argon | **仍走 OpenCode Go 订阅** | 用户既定路由；订阅是预付的，不占 GCP 额度 |
| 3.1-pro 出菜单 | 是（用户指令） | 仍可手打 id 切换 |
| 回滚 | 取消注释 hub 两行 + `GEMINI_LARGE_MEDIA_*` | 纯 `.env` 变更，代码零改动 |

Argon 做默认模型的已知代价（用户已接受）：
1. **没有 Google 搜索来源块**——Go 路由收 `tools` 但不回 `groundingMetadata`。需要搜索来源时用 `/model gemini-3.8-flash`（Vertex，实测 `grounding=1 sources=3`）。
2. **$60/mo 订阅额度**——Argon 走 Go 的月度上限（$4/$20 每 1M）。额度耗尽后 Argon 会失败；按既有原则**不做跨端点自动兜底**，由群友点重试或手动换模型。

## 5. 验证

### 5.1 直连 Vertex 原始探针（SA 自签 JWT → AiPlatform REST）
`tmp/vertex-direct-probe.mjs`，host 与容器内各跑一遍（容器内那遍才算数，见 2026-10-15 事故）：

| 用例 | host | 容器内 |
| --- | --- | --- |
| `gemini-3.1-pro-preview`（tools + thinkingBudget -1） | 200 6.2s | 200 5.4s |
| `gemini-3.8-flash`（同上） | 200 2.9s | 200 3.6s |
| `gemini-4-argon`（thinkingLevel HIGH） | 200 4.2s | 200 2.0s |
| `3.1-pro` + 强制搜索 | 200 16.7s，`grounding=1`，3 个来源 | 200 58.2s，3 个来源 |
| `gemini-3-pro-image`（generateContent，IMAGE+TEXT） | 200 15.4s，`image/png` ~1.0MB | 200 16.2s，~1.1MB |

结论：自有项目对新账单下的四个模型 + Google 搜索工具全部可用，`tools: [googleSearch, urlContext]` 不再被拒。

### 5.2 走真实 `GeminiPlatform`（宿主，模拟新 `.env`）
`tmp/vertex-platform-verify.mts`（该脚本先把 `GEMINI_API_URL`、`GEMINI_IMAGE_*`、`GEMINI_LARGE_MEDIA_*` 从 env 里删掉，再构造平台）：

| 模型 | lanes | 结果 |
| --- | --- | --- |
| `gemini-4-argon` | `via=opencode-go`（带 `sessionId`） | 200 4.0s `text="OK"` |
| `gemini-3.1-pro-preview` | `via=-`（Vertex） | 200 3.0s |
| `gemini-3.8-flash` | `via=-` | 200 2.4s |
| `gemini-3-pro-image` | `via=-`，**流式**调用 | 200 16.4s，`imageBytes=2943774` |

补测 Argon 的多模态（`tmp/argon-media-probe.mts`，因为它是新的默认模型，群里每张图/每个小视频都会走它）：
- `argon + inline image` → 200 7.5s，正确读出图内文字（`via=opencode-go`）；
- `argon + inline video`（1s mp4 + `videoMetadata.fps`）→ 200 5.7s，正确描述画面。

即 Go 路由接受内联图片与视频，默认模型不会因为媒体输入而失效。

### 5.3 容器内（生产 env + patched undici fetch）
`docker compose up -d k-on-bot` 后（容器 HEAD = `0c8f925`），启动日志：

```
[gemini] gemini-4-argon rides the OpenCode Go subscription at https://opencode.ai
Initial model: gemini-4-argon
```

无 `[gemini] Using Gemini API at …`、无 image-endpoint 行 → 确认走 Vertex 分支。随后 `docker exec -i k-on-bot node --input-type=module < tmp/container-platform-verify.mjs`（真实 dist + 真实 env + 补丁 fetch）：

| 用例 | 结果 |
| --- | --- |
| `gemini-4-argon` | `via=opencode-go` 200 3.6s |
| `gemini-3.1-pro-preview` | `via=-` 200 2.9s |
| `gemini-3.8-flash` | `via=-` 200 17.1s（同期有别的探针在跑） |
| `gemini-3-pro-image` | `via=-` 200 17.4s，`image=3263276` 字节 |
| `gs://` 短视频 | 日志 `request carries gs:// media → primary client`，`via=large-media` 200 128s，描述正确 |

### 5.4 本地校验
`npx tsc --noEmit` 干净；`pnpm test:offline` 57 PASS / 0 FAIL。

### 5.5 大文件回归对照（91s / 30MB mp4）

用真实素材做 A/B：`gs://tg-bot-large-files/media/AgADZCYAApSJQVY`（30.2MB，`media_cache.durationSeconds=91`，2026-10-14 17:20 由群友发在 -1001415974153）。查库确认该消息**没有产生过 `bot_responses` 行**（不是触发消息），即这是它第一次真正被模型处理。三次请求体一致（fileData + 文本 + `googleSearch/urlContext` + `thinkingBudget: -1`，91s ≤ 120s → 不带 `videoMetadata`，即 Gemini 默认 1 fps）：

| 路径 | 结果 |
| --- | --- |
| 自有 Vertex（走平台代码路径，1 fps） | **500 INTERNAL @399s** `{"error":{"code":500,"message":"Internal error encountered."}}` |
| 自有 Vertex（raw REST 重试，1 fps） | 200 @252s，`thoughts=999 total=17540`，描述正确 |
| 自有 Vertex（raw REST，0.5 fps） | 200 @169s，`thoughts=930 sources=3 total=11324`，描述正确 |
| hub Vertex 渠道（回滚用的大文件 key，1 fps） | 200 @40s，**`thoughts=0`** `total=8396`，描述正确 |

排查与结论：
- **不是 location 选错**：`gemini-3.8-flash` 在本项目**只有 `global` 端点发布**（`us-central1`、`asia-northeast1` 都返回 404 `Publisher model … was not found`），所以没法靠换区域提速。
- **hub 那 40s 不是"同条件更快"**：它 `thoughts=0`、`total` 约为一半，说明那一侧既没思考也没搜索（很可能上游没开 thinking），而自有 Vertex 这两次都开了 `thinkingBudget: -1` 且真的联网搜了（`sources=3`）。两者不能直接比快慢。
- **自有 Vertex 的可用性**：3 次尝试里 1 次 `500 INTERNAL`（399s 像服务端内部超时）、2 次成功（252s / 169s），且**把采样降到 0.5 fps 能明显省时间**（252s → 169s）。
- 影响面：平台 `LARGE_MEDIA_TIMEOUT_MS=600000`。91s 视频在 169–252s 之内，安全；更长/更大的视频（0.5 fps 也是同量级帧数）会逼近或超过 600s，并且仍可能吃 500 后走"错误行 + 重试按钮"。
- **本次唯一未收敛的点**，两个候选缓解（都未实施，等用户裁决）：
  1. gs:// 媒体统一降到 0.5 fps（`samplingFpsForVideo` 对 `hasFileUri` 强制 0.5）——实测省三分之一时间，代价是长视频采样更疏；
  2. 把 hub 的 Vertex-bound key 保留为**大文件专用兜底**（需要把 `GEMINI_LARGE_MEDIA_*` 的构造从 `if (GEMINI_API_URL)` 分支里挪出来），其余仍走自有 Vertex。

## 6. 回滚

1. `.env`：取消注释 hub 两行（`GEMINI_API_URL` / `GEMINI_API_KEY`）**以及** `GEMINI_LARGE_MEDIA_*`（relay 路径上 gs:// 需要 Vertex-bound key）；
2. `docker compose up -d k-on-bot`（改 `.env` 必须重建，`restart` 不重读 env_file）。

`GEMINI_IMAGE_*` 一直留在 `.env` 里，随第 1 步自动生效（生图回到 ephone）。代码无需改动。

## 7. 遗留与后续

- **guard 仍按 hub 视角巡检**（`HUB_GEMINI_API_KEY` 未变）。既然不再有外部项目需要读我们的桶，`GUARD_AUTO_GRANT=1` 已无意义，可考虑改 0；egress 阈值告警继续保留。
- **Argon 想改走自有 Vertex** 时不需要改代码：清空 `OPENCODE_GO_API_KEY` + `docker compose up -d` 即回落到主客户端（Vertex 实测能出 argon，2–4s）。
- **Argon 额度**：Go 订阅月度上限用尽后 Argon 会失败且不自动兜底，届时手动 `/model` 或临时清空 `OPENCODE_GO_API_KEY`。
- **hub 两个 key**（84635 日常 / 84697 大文件）留作回滚，不再被 bot 使用。
