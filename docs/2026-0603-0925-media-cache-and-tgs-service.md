# 媒体缓存 + .tgs 转换服务 + 大文件容错 — 技术设计 (2026-0603-0925)

## 设计目标（终端用户视角）

群里发的**动画贴纸**（.tgs）和**视频贴纸**（.webm），bot 现在能真正"看懂动起来的样子"，而不是只看到一张静态缩略图、还把"系统限制看不到"这种内部提示复述给用户。同一张贴纸/图片被反复发送时（动画贴纸尤其如此），bot **只下载和渲染一次**，之后秒级命中缓存，不再重复消耗带宽和算力。当用户发了一个**超大视频**（超过 Telegram 20MB 下载上限）时，bot 不再整条消息保存失败导致丢失上下文，而是正常记住"用户发了一个太大无法处理的视频"，并据此礼貌回应。

## Context（为什么做这个改动）

三个相互关联的问题，在前一轮多模态改造后浮现：

1. **动画/视频贴纸只发缩略图**：`autoSave.ts` 对 `is_video || is_animated` 贴纸硬编码注入 `'a video sticker ([system] can not get video sticker, only thumbnail image)'`，模型忠实复述这段内部提示（见用户截图 image.png）。实际上：
   - **视频贴纸 (.webm, VP9)** 是标准视频，Gemini 能直接处理 —— 用户已确认要下载原文件发给 Gemini。
   - **动画贴纸 (.tgs)** 是 gzip 压缩的 Lottie 矢量 JSON，Gemini 无法解析，需渲染成视频。用户已确认自建轻量 HTTP 转换服务（rlottie+ffmpeg）。

2. **完全没有缓存/去重**：代码审计确认 —— 无任何 hash/dedup/`file_unique_id` 使用。每个文件都经 `getBlob`→`fetch` 重新下载并按消息存一份 BLOB。同一贴纸发 100 次 = 下载 100 次、存 100 份。`.tgs` 渲染昂贵，缓存是刚需；图片/视频也同样受益。Telegram 在每个文件上提供 **`file_unique_id`**（跨重发稳定），是天然缓存键，目前完全未用。

3. **大文件 getFile 失败会吞掉整条消息**（见 image2.png 报错）：`getFile` 对 >20MB 文件返回 `400 file is too big`，异常抛出后 `autoSave` 的 try/catch 直接 `console.error("保存消息失败")` 且**不落库**。结果：用户"@bot 能看到视频吗"这条消息既没媒体、也没文字、连消息本身都没存进上下文。需要：getFile 失败不阻断保存，仍存文字 + 注入诚实提示。

### 用户已确认的决策
- 视频贴纸 (.webm)：下载原文件发 Gemini，去掉误导提示。
- 动画贴纸 (.tgs)：自建轻量 HTTP 包装服务（rlottie+ffmpeg），同 compose 网络按服务名调用。
- 转换调用：复用 `autoSave` 现有 `addAsyncFileSaveMsgId` 异步下载框架；**做好缓存**（多数动画贴纸是重复发送）。
- 现成镜像 `edasriyan/lottie-to-webm` 是目录批处理 CLI、无 HTTP，故自建。

---

## 架构总览

```
Telegram ──update──> bot(autoSave)
                        │  1. resolveCapturedMedia → {fileId, fileUniqueId, mime, kind}
                        │  2. 查 MediaCache[fileUniqueId] 命中? ──是──> 直接复用 bytes，0 下载
                        │  3. 未命中: getFile 下载原文件
                        │       ├─ 普通图片/视频/音频: 直接得 bytes
                        │       ├─ 视频贴纸(.webm): 直接得 bytes (video/webm)
                        │       └─ 动画贴纸(.tgs): 下载 .tgs ──HTTP POST──> tgs-converter ──webm──> bytes
                        │  4. 写 MediaCache[fileUniqueId] = {bytes, mime}
                        │  5. Message.fileUniqueId = key (不再每条存大 BLOB，见下)
                        └─ getFile 失败/文件过大: 仍存消息文字 + 注入诚实提示，不抛出

tgs-converter (新 docker 服务, 同 traefik-net):
   POST /convert  body=.tgs bytes  ->  200 webm bytes  (内部 rlottie+ffmpeg, 自带 LRU 缓存)
```

---

## 一、媒体缓存层（基础，优先做）

### 1.1 缓存键：Telegram `file_unique_id`
grammy 每个文件对象都带 `file_unique_id`（与 `file_id` 不同，前者跨重发/跨用户稳定，后者每次不同）。用它做内容寻址键。`resolveCapturedMedia` 的 `CapturedMedia` 增加 `fileUniqueId: string` 字段（从 `photo.file_unique_id` / `sticker.file_unique_id` / `voice.file_unique_id` … 取）。

### 1.2 新表 `MediaCache`（content-addressed 存储）
新建 `src/db/mediaCacheDTO.ts`：
```ts
class MediaCache extends Model {
  declare fileUniqueId: string;   // PK
  declare mime: string;           // 最终 MIME（.tgs→video/webm）
  declare data: Buffer;           // 渲染/下载后的字节
  declare kind: string;           // photo/video/voice/.../animated_sticker
  declare createdAt: Date;
  declare lastUsedAt: Date;       // 用于 LRU/过期清理
}
```
- `fileUniqueId` 唯一索引。
- **去重收益**：N 条消息引用同一贴纸 → 1 份 bytes。

### 1.3 Message 表改为引用缓存键（不再每条存大 BLOB）
现状 `Message.file: Buffer` 每条存全量字节。改为：
- 保留 `Message.file`/`fileMime` 以兼容已有数据和"找不到缓存时的回退"，但**新写入走缓存**：`Message` 增加 `fileUniqueId: string | null`。
- `getFileContentsOfMessage` 读取顺序：优先 `Message.fileUniqueId` → 查 `MediaCache` 取 bytes+mime；回退到旧的 `Message.file`/`fileMime`（向后兼容存量数据）。

> 说明：保留 `Message.file` 回退是为平滑迁移；新逻辑主路径走 `MediaCache`，避免大 BLOB 重复。

### 1.4 缓存写入与命中（autoSave 内）
- 命中：`MediaCache.findByPk(fileUniqueId)` 存在 → 跳过 getFile/下载/渲染，更新 `lastUsedAt`，`Message.fileUniqueId = key`。
- 未命中：下载（或渲染）后 `MediaCache.upsert({...})`，再 `Message.fileUniqueId = key`。

### 1.5 缓存清理
- `autoClear()` 内新增：删除 `MediaCache` 中 `lastUsedAt` 超过 N 天（建议 7 天，比单条媒体的 1 天更长，因为缓存是共享的、命中即续期）的行。
- 现有"超 1 天清空 `Message.file` 字节"逻辑保留（针对回退路径的存量 BLOB）；缓存路径的字节由 `MediaCache` 的 LRU 统一管理。

### 1.6 现有图片下载缓存收益
此层对**所有**媒体生效：现在同一图片/视频重发也会命中缓存、0 重复下载。回答了"之前的文件/图片下载是否做了缓存" —— **之前没有，本设计补上**。

---

## 二、.tgs 转换微服务

### 2.1 服务镜像（新目录 `tgs-converter/`）
轻量 HTTP 服务，单一职责：收 `.tgs` 字节 → 返回 `.webm` 字节。
- 基础镜像：含 `ffmpeg` 的轻量 Linux（如 `node:20-bookworm-slim` + `apt install ffmpeg`，或 `alpine` + `ffmpeg`）。
- 渲染：复用 `ed-asriyan/lottie-converter` 的 rlottie+ffmpeg 方案（其 `lottie_to_webm.sh` 已验证、驱动 ezgif）。两种集成：
  - **(推荐)** 直接在我们镜像里装 rlottie + ffmpeg，HTTP server 调 `lottie_to_webm.sh`（或等价命令）把临时 .tgs 转 .webm 再读回返回。
  - 或 `FROM edasriyan/lottie-to-webm` 之上加一层 HTTP server 包装其 CLI。
- HTTP server（极简，~50 行，Node 或 Python）：
  - `POST /convert` body=raw .tgs → 写临时文件 → 调转换 → 读 .webm → `200 image/webm`（或 `video/webm`）字节；失败 `500`。
  - `GET /health` → `200`。
- **服务内 LRU 缓存**：以 .tgs 内容 sha256 为键缓存渲染结果（即使 bot 侧 file_unique_id 缓存未覆盖的边角情况也省算力）。bot 侧已有 file_unique_id 缓存是主缓存，这是二级防御。

### 2.2 docker-compose 接入
在 `docker-compose.yaml` 增加：
```yaml
  tgs-converter:
    container_name: tgs-converter
    restart: always
    build: ./tgs-converter
    networks:
      - traefik-net      # 与 bot 同网，bot 用 http://tgs-converter:PORT 调用
```
bot 侧新增 env `TGS_CONVERTER_URL=http://tgs-converter:8080`。

### 2.3 bot 侧调用（autoSave 异步下载路径内）
- 视频贴纸 (`is_video`)：`resolveCapturedMedia` 返回 `fileId=sticker.file_id`, `mime='video/webm'`, `kind='video_sticker'`，按普通媒体下载 .webm 即可，**不调转换服务**。
- 动画贴纸 (`is_animated`)：返回 `kind='animated_sticker'`, 临时 `mime='application/x-tgs'`。下载 .tgs bytes 后 `POST {TGS_CONVERTER_URL}/convert` → 得 .webm bytes，最终以 `mime='video/webm'` 存入 `MediaCache`。
- 缓存优先：命中 `file_unique_id` 时连 .tgs 都不下载、不调服务。
- 转换失败/服务不可用：回退 —— 存缩略图 + 诚实提示（见三的提示策略），不抛出。

### 2.4 提示文字（去掉误导）
- 视频贴纸：` (I send a video sticker)`（真发了 webm，模型能看）。
- 动画贴纸成功转换：` (I send an animated sticker)`。
- 动画贴纸转换失败回退缩略图：` (I send an animated sticker, showing a static thumbnail)`。

---

## 三、大文件 / getFile 失败容错（bug 修复）

### 3.1 问题根因
`autoSave.ts:~281` `await bot.api.getFile(media.fileId)` 对 >20MB 文件抛 `GrammyError 400 file is too big`，被外层 try/catch 捕获 → `console.error("保存消息失败")` 且**整条消息未落库**。

### 3.2 修复
将"getFile/下载"与"消息落库"**解耦**：
- `resolveCapturedMedia` 已知 `sizeBytes` 时，对 > `MAX_GETFILE_BYTES`(=20MB，Telegram 硬限) 的媒体**直接不下载**，只注入提示（现有 200MB 逻辑改为 20MB 真实下载上限；200MB 那个保护无意义，因 Telegram 先卡 20MB）。
- `sizeBytes` 缺失或下载阶段才发现过大：把 `getFile`+下载用 try/catch 单独包住，失败时仅记日志、`fileLink=undefined`、`fileMime=undefined`，**继续走 saveMessage 存文字 + 提示**，绝不让整条消息丢失。
- 提示文字：` (I send a video, [system] too large to process)` 之类，让模型知道用户发了视频但无法读取，能据此回应（用户截图里"能看到视频吗"应得到"文件太大我看不了"而非空白）。

### 3.3 验证点
重发 image2.png 里的大视频：消息文字正常入库、上下文含"用户发了一个太大的视频"提示、bot 礼貌回应；不再 `保存消息失败` 丢消息。

---

## 关键文件

**新增**
- `tgs-converter/Dockerfile` — rlottie+ffmpeg+HTTP server 镜像
- `tgs-converter/server.(mjs|py)` — `/convert` + `/health`，含 sha256 LRU 缓存
- `src/db/mediaCacheDTO.ts` — `MediaCache` 模型
- `src/services/media-cache-service.ts` — 缓存读写/命中逻辑（供 autoSave 调用）
- `src/services/tgs-client.ts` — 调 `TGS_CONVERTER_URL/convert` 的客户端（含超时/失败回退）

**修改**
- `src/db/autoSave.ts` — `CapturedMedia` 加 `fileUniqueId`；视频贴纸→webm、动画贴纸→转换服务；缓存命中短路；getFile 失败容错不丢消息；提示文案
- `src/db/messageDTO.ts` — `Message` 加 `fileUniqueId: string | null`
- `src/db/index.ts` — `saveMessage` 接收 `fileUniqueId`；落库走缓存键
- `src/db/queries/context-queries.ts` — `getFileContentsOfMessage` 优先读 `MediaCache`，回退旧 `file`/`fileMime`
- `src/db/index.ts` 的 `sequelize.sync({alter:true})` 自动建 `MediaCache` 表 + 加列
- `docker-compose.yaml` — 加 `tgs-converter` 服务 + bot 的 `TGS_CONVERTER_URL` env
- `.env.example` — 加 `TGS_CONVERTER_URL`

---

## 验证（端到端）
1. **编译**：`pnpm build` 通过。
2. **缓存命中**：同一图片/贴纸连发两次，日志确认第二次"cache hit, skip download"，`MediaCache` 只一行，两条 `Message` 共享 `fileUniqueId`。
3. **视频贴纸**：发 .webm 视频贴纸，Gemini(gemini-3.5-flash) 收到 `{type:'media', mime:'video/webm'}`，回答引用动画内容（不再说"只看到缩略图"）。
4. **动画贴纸**：发 .tgs 动画贴纸，bot 调 tgs-converter 得 webm，Gemini 能看；服务停掉时回退缩略图 + 诚实提示，消息不丢。
5. **大文件容错**：发 >20MB 视频，消息文字正常入库 + "too large to process"提示，bot 正常回应，无"保存消息失败"。
6. **清理**：`MediaCache` 超 7 天未用的行被清；存量 `Message.file` 超 1 天置空逻辑不受影响。

---

## 风险与取舍
1. **rlottie 原生依赖**：隔离在独立 `tgs-converter` 容器，不污染 bot 镜像；bot 仅 HTTP 调用，服务挂了有回退（缩略图），不影响主流程。
2. **Message.file → MediaCache 迁移**：保留旧 `file` 字段回退读，存量数据不丢；新写入走缓存，逐步收敛。
3. **缓存键信任**：`file_unique_id` 由 Telegram 保证跨重发稳定；极端情况下不同内容碰撞概率可忽略。
4. **转换延迟**：.tgs→webm 1-3s，走异步下载框架（已有 `addAsyncFileSaveMsgId`），并发命中缓存后基本 0 延迟。
5. **服务镜像体积**：ffmpeg+rlottie 镜像约 100-200MB，独立服务可接受。
