# Gemini 全线回归自有 Vertex，Argon 升为默认模型

- 时间：2026-10-16 01:21 CST（2026-10-15 17:21 UTC）
- 代码提交：`0c8f925`（`src/config/models.ts`、`src/ai/platform-factory.ts`、`src/ai/platforms/gemini-platform.ts`）
- 配置：`.env` / `.env.test`（均不入 git）
- 上一阶段文档：[2026-1015-1310-设计-Argon走OpenCodeGo订阅分流.md](2026-1015-1310-设计-Argon走OpenCodeGo订阅分流.md)

## 1. 设计目标（用户视角）

群里 @K-ON 的每一次回答——文本、看图、生图、看 >20MB 的大视频——**只跑在我们自己的 Vertex 项目**（`ddc-gcp-main`）上：不经过 hub 额度市场，也不经过 OpenCode Go 订阅。`gemini-4-argon` 成为默认模型、也占据 `/model` 菜单里的 Gemini 文本条目，它和别的模型走同一条路。

用户侧的直接收益：回答质量不再取决于"这次落在哪个渠道"，hub 时代被削弱或必须单独绕路的三项能力（Google 搜索来源块、生图、gs:// 大文件）全部回到默认路径，而账单从"按量付费"换成"$300 赠金"。口径就一句：**任何模型、任何输入，出口只有一个——自有 Vertex**。

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

`DEFAULT_MODEL=gemini-4-argon`；`.env.test` 同步同样的处理（`OPENCODE_GO_*` 一并注释掉），让 e2e 跑在生产同一条路上。**`OPENCODE_GO_*` 也已注释**（2026-10-16 修正）：Argon 不再有第二条路，`OPENCODE_GO_API_KEY` 为空时平台根本不会构造那个客户端。

### 3.2 代码（本次唯一实质改动）
1. `src/config/models.ts`：菜单条目 `gemini-3.1-pro-preview` → `gemini-4-argon`。手打 `/model gemini-3.1-pro-preview` 仍可用（`/model` 是无校验自由文本）。
2. `src/ai/platform-factory.ts`：`getDefaultModel('gemini')` → `gemini-4-argon`。
3. `src/ai/platforms/gemini-platform.ts`：
   - **大文件必须先选到能读桶的客户端**：`const largeMediaClient = hasLargeMedia ? this.largeMediaClient ?? this.genAI : null;`
     旧链 `largeMediaClient ?? opencodeGoClient ?? imageClient ?? genAI` 在 hub 撤退后会出现一个真炸点：**Argon 是默认模型 + 群里发 >20MB 视频 → 请求带着 `gs://` URI 落到 OpenCode Go 路由，而那条路读不到我们的桶**。现在带 gs:// 的请求恒定走 bucket-capable 客户端（有专用 key 用专用 key，否则用主客户端＝Vertex）。
   - **非流式生图判据收紧**：从"是不是图片模型"改为"选中的客户端是不是专用图片端点"（`usesImageEndpoint`）。原先只要配了 `GEMINI_IMAGE_*`，图片模型就走非流式；大文件抢占客户端后会变成"用 Vertex 的客户端发非流式"，语义错位。
   - **usage 行新增路由标签**：`routedLane` 让 `via=` 能区分 `-`（直连 Vertex）/ `large-media`（gs:// 请求）/ `opencode-go`（该路已关，仅代码保留）。

## 4. 关键取舍

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 文本/看图 | 走自有 Vertex（`GEMINI_API_URL` 置空） | 赠金覆盖成本；唯一零特性损失来源 |
| 生图 | 随主端点走 Vertex | 赠金下无需再避自家配额；实测流式调用也回 inlineData |
| gs:// 大文件 | 走自有 Vertex（不再用 hub 专用 key） | 同一个桶、同一个 SA，链路更短 |
| Argon | **走自有 Vertex**（`OPENCODE_GO_API_KEY` 置空） | 用户裁决"全走自有 vertex"；Vertex 直接提供 `gemini-4-argon`（实测 2–4s），少一条链路就少一处不确定性 |
| 3.1-pro 出菜单 | 是（用户指令） | 仍可手打 id 切换 |
| 回滚 | 取消注释 hub 两行 + `GEMINI_LARGE_MEDIA_*`（+ 可选 `OPENCODE_GO_*`） | 纯 `.env` 变更，代码零改动 |

Argon 走 Vertex 后，之前那两条代价都不存在了：
1. **搜索来源块**：grounding 由 Vertex 提供，不再被 Go 路由吞掉（同为 Vertex 的 `gemini-3.1-pro-preview` 实测 `grounding=1 sources=3`）。
2. **订阅额度上限**：不再占用 OpenCode Go 的 $60/mo，Argon 的花费和其他模型一样记在自有项目上。

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
| `gemini-4-argon` | `via=-`（Vertex） | 200 4.0s `text="OK"` |
| `gemini-3.1-pro-preview` | `via=-`（Vertex） | 200 3.0s |
| `gemini-3.8-flash` | `via=-` | 200 2.4s |
| `gemini-3-pro-image` | `via=-`，**流式**调用 | 200 16.4s，`imageBytes=2943774` |

补测 Argon 的多模态（`tmp/argon-media-probe.mts`——默认模型会吃到群里每一张图、每一个小视频；宿主上跑要先给 `GOOGLE_APPLICATION_CREDENTIALS=$PWD/gcp-sa.json`，否则 Vertex 客户端报 `Could not load the default credentials`）：
- `argon + inline image` → 200 5.3s，正确读出图内文字（`via=-`）；
- `argon + inline video`（1s mp4 + `videoMetadata.fps`）→ 200 4.2s，正确描述画面。

即默认模型在 Vertex 上照样收图片与视频，不会因为媒体输入而失效。

### 5.3 容器内（生产 env + patched undici fetch）
`docker compose up -d k-on-bot` 后（容器 HEAD = `0c8f925`），启动日志：

```
Initial model: gemini-4-argon
```

启动日志**只有这一行**：既没有 `[gemini] Using Gemini API at …`（中继分支），也没有 `gemini-4-argon rides the OpenCode Go subscription`（Go 路由）→ 纯 Vertex 分支、没有任何第二出口。随后 `docker exec -i k-on-bot node --input-type=module < tmp/container-platform-verify.mjs`（真实 dist + 真实 env + 补丁 fetch）：

| 用例 | 结果 |
| --- | --- |
| `gemini-4-argon` | `via=-` 200 2.6s |
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
| hub Vertex 渠道（**对照组**，现已不再使用） | 200 @40s，**`thoughts=0`** `total=8396`，描述正确 |

排查与结论：
- **不是 location 选错**：`gemini-3.8-flash` 在本项目**只有 `global` 端点发布**（`us-central1`、`asia-northeast1` 都返回 404 `Publisher model … was not found`），所以没法靠换区域提速。
- **hub 那 40s 不是"同条件更快"**：它 `thoughts=0`、`total` 约为一半，说明那一侧既没思考也没搜索（很可能上游没开 thinking），而自有 Vertex 这两次都开了 `thinkingBudget: -1` 且真的联网搜了（`sources=3`）。两者不能直接比快慢。
- **自有 Vertex 的可用性**：3 次尝试里 1 次 `500 INTERNAL`（399s 像服务端内部超时）、2 次成功（252s / 169s），且**把采样降到 0.5 fps 能明显省时间**（252s → 169s）。
- 影响面：平台 `LARGE_MEDIA_TIMEOUT_MS=600000`。91s 视频在 169–252s 之内，安全；更长/更大的视频（0.5 fps 也是同量级帧数）会逼近或超过 600s，并且仍可能吃 500 后走"错误行 + 重试按钮"。
- **本次唯一未收敛的点**，唯一的缓解手段（未实施）：gs:// 媒体统一降到 0.5 fps（`samplingFpsForVideo` 对 `hasFileUri` 强制 0.5）——实测省约三分之一时间（252s → 169s），代价是长视频采样更疏。既然不再用 hub，"拿 hub 兜底"这条路已排除。

## 6. 回滚

1. `.env`：取消注释 hub 两行（`GEMINI_API_URL` / `GEMINI_API_KEY`）**以及** `GEMINI_IMAGE_*` 与 `GEMINI_LARGE_MEDIA_*`（relay 路径上 gs:// 需要 Vertex-bound key）；想让 Argon 也回 Go 订阅的话再取消 `OPENCODE_GO_*`；
2. `docker compose up -d k-on-bot`（改 `.env` 必须重建，`restart` 不重读 env_file）。

代码无需任何改动。

## 7. 遗留与后续

- **守护脚本已按"无 hub"改造**：`k-on-bot-argon-watch.timer` 已停用（它的存在意义是盯 hub 上有没有 argon 渠道）；`k-on-bot-gcs-guard.service` 现在只跑 `gcs-egress-guard.mjs`（账单 tripwire），探 hub 分享的 `gcs-share-watch.mjs` 已从 unit 移除，外部服务代理不再自动补授桶读权限。
- **大文件采样是唯一的性能旋钮**：见 5.5，gs:// 统一降到 0.5 fps 可省约 1/3 时间（未实施，要动说一声）。
- **hub 两个 key**（84635 日常 / 84697 大文件）只作历史记录，bot 不再使用；`.env` 里 hub / AxonHub / ephone / Go 四组配置全部躺在注释块里。
- **Argon 的花费现在记在自有项目上**（不再走 $60/mo 订阅额度），赠金消耗速度会比之前略快。

## 8. 修正记录（2026-10-16）

初版（本文档 01:21 那版）把 Argon 留在 OpenCode Go 订阅、并在 5.5 里把"保留 hub 大文件 key 做兜底"列为候选方案。用户当场纠正原话：**"我不是说了全走自有 vertex 吗，还关 go 和 hub 啥事"** —— 口径是"全部"，不留第二出口。据此当天整改：

| 项 | 初版 | 修正后 |
| --- | --- | --- |
| Argon | 走 OpenCode Go（`OPENCODE_GO_*` 生效） | 走自有 Vertex（`OPENCODE_GO_*` 注释掉） |
| hub | 大文件 key 保留为候选兜底 | 全线不再使用，`HUB_GEMINI_*` 注释 |
| 生图 | 走 Vertex（但 `GEMINI_IMAGE_*` 仍留在 env 里） | 同上，`GEMINI_IMAGE_*` 一并注释 |
| 守护 | argon-watch 盯 hub；share-watch 探 hub 分享并自动补授 | argon-watch 停用；share-watch 从 unit 移除 |
| 验证 | argon `via=opencode-go` | argon `via=-`（Vertex）容器内 2.6s；图片 5.3s / 视频 4.2s 均正确 |

整改后的三个可核对事实：
1. 容器启动日志只有 `Initial model: gemini-4-argon` 一行（无中继行、无 Go 路由行）；
2. 容器内 `tmp/container-platform-verify.mjs` 里每个模型的 `via=` 都是 `-`；
3. `systemctl --user list-timers` 里不再出现 argon-watch。
