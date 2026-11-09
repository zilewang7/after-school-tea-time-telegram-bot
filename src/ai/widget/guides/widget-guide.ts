/**
 * HTML-mode widget authoring guide, returned on demand by get_ui_guide('html').
 *
 * Condensed from the widget-sandbox documentation snapshot
 * (TelegramMessenger/widget-sandbox: widget-runtime-profile.md v0.2.3,
 * widget profile 1, SDK v1; snapshot 2026-11-08). The widget hard limits,
 * the profile allow/deny lists and the Phase 0 static-only behaviour come
 * from that snapshot, not from this repository.
 * Bump WIDGET_GUIDE_VERSION in registry.ts when this text changes.
 */
export const WIDGET_GUIDE_HTML_TITLE = "Telegram Widget · HTML 模式规范";

export const WIDGET_GUIDE_HTML_TEXT = `Telegram Widget · HTML 模式规范
guide=html · version 2 · 来源：TelegramMessenger/widget-sandbox 官方文档内部快照（widget profile 1 / SDK v1 / widget-sandbox 0.6.1，快照 2026-11-08）

## 0. 这份文本是什么、产出什么

- 模型调用 get_ui_guide(kind='html') 得到本文；读完按本文写出**一份自包含 HTML**，用 send_widget(mode='html', html=…) 提交，bot 用 Bot API 10.4 的 sendWidget 以「widget 消息」发出，客户端在聊天气泡里渲染。
- widget = 一个自包含 HTML（inline \`<style>\` 与 inline \`<script>\`），零网络、零外部资源、无输入控件。每个客户端渲染前按 profile 1 白名单剔除超范围特性（剔除不报错，剩下的照常渲染），按白名单写即可跨客户端一致。
- Phase 0 的边界是「有没有 bot 参与」：发送后 HTML 永不改变，bot 侧不接点击、不改状态、不回答 request；但 widget 自己的 inline \`<script>\` 照常运行，**纯客户端本地交互（点击改 DOM、\`<details>\` 折叠、本地小游戏）可用**（见 §7.1）。写不写脚本由你按需求判断：轻量点击彩蛋、展开收起、本地小游戏都可以（§7.1），日常展示卡片不加 JS 也完全正常。
- 发送参数（width / height / caption 等）由 bot 侧控制；模型只负责 HTML 内容本身的布局与体积预算。
- A2UI 模式（get_ui_guide(kind='a2ui')）只输出 tg-card-v1 的 A2UI JSON、由 bot 侧固定编译器转成 widget；需要自由布局、精确样式、自绘 SVG 时用本文的 HTML 模式。HTML 模式由服务端开关控制（WIDGET_ALLOW_HTML）；被关闭时 send_widget 返回可行动错误，按错误提示改成 A2UI surface。

## 1. 硬限制

1. **体积**：HTML ≤ 32768 字节（UTF-8 计），zlib level 9 压缩后 ≤ 4096 字节。服务端按 PHP \`gzcompress($html,9)\` 口径计数，超限返回 \`INPUT_MEDIA_WIDGET_TOO_LARGE\`；bot 侧 send_widget 在发送前会先量这两项并报错，写的时候留余量。
2. **气泡**：宽 200–600 px（手机约 320–430，**按 320 设计**），高由内容决定、最大 600 px 且被硬裁。**widget 内没有滚动**：\`overflow:auto/scroll\` 被改成 \`hidden\`，\`position:sticky\` 变成 \`relative\`。长内容用分页、折叠（\`<details>\`）、精选条目表达。
3. **布局单位**：用 \`%\`、flex、grid、\`vw/vmin\`；\`vh/dvh/svh\` 被移除（写底部的 \`env(safe-area-inset-bottom)\` 是允许的例外）。
4. **背景**：\`html\` 没有背景，气泡底色（\`--tg-theme-bg-color\`）透出来；在 html/body 上设背景会涂满整个气泡。\`body\` 的 margin 是客户端文字内边距（约 8px 12px），\`body{margin:0}\` 贴边后自己给 padding。
5. **默认样式**：客户端消息字体（system-ui、\`--tg-text-font-size\` 约 15px、\`--tg-text-line-height\`）、颜色 \`--tg-theme-text-color\`；标题/段落/列表/表格/pre 有原生外边距；未加样式的 \`<button>\` 就是客户端自己的按钮外观。任何自定义 CSS 覆盖默认。
6. **时间角标**：没有下方 caption 时客户端在气泡底角画消息时间并压住一条安全区；底部给 \`env(safe-area-inset-bottom)\` 留空间（若自行给 body padding，同时设 \`body{padding:0}\` 避免双倍留白）。

## 2. 主题、字体、文字

主题变量挂在根节点，值是 \`#rrggbb\`，随聊天主题实时变化（\`--tg-color-scheme\` 为 \`light\` / \`dark\`）：

\`\`\`
--tg-theme-bg-color            --tg-theme-secondary-bg-color
--tg-theme-text-color          --tg-theme-hint-color          --tg-theme-subtitle-text-color
--tg-theme-link-color          --tg-theme-accent-text-color
--tg-theme-button-color        --tg-theme-button-text-color
--tg-theme-destructive-text-color
--tg-theme-section-bg-color    --tg-theme-section-header-text-color
--tg-theme-section-separator-color
\`\`\`

- \`prefers-color-scheme\`、\`color-scheme: light dark\`、\`light-dark()\` 跟随聊天主题实时切换。深色/浅色都靠主题变量着色，不要写死白底黑字。
- 字体只允许系统族：\`system-ui\`、\`sans-serif\`、\`serif\`、\`monospace\`、\`ui-sans-serif\`、\`ui-serif\`、\`ui-monospace\`、\`ui-rounded\`；具名字体与 \`@font-face\` 被移除。
- 文本默认不可选中；需要用户复制的内容加 \`user-select:text\`（及 \`-webkit-user-select:text\`）。
- 可用的文字修饰：\`font-size/font-weight/font-style/line-height\`、\`letter-spacing\`、\`text-align\`、\`text-decoration\`、\`text-transform\`、\`white-space\`、\`overflow-wrap/word-break\`、单行 \`text-overflow:ellipsis\`、\`font-variant-numeric:tabular-nums\`、\`vertical-align\`。

## 3. 可用清单（白名单）

**HTML**：div、span、p、br、hr、wbr、h1–h6、ul/ol/li、dl/dt/dd、menu、table/thead/tbody/tfoot/tr/td/th/caption（支持 colspan/rowspan）、details/summary（点击开合）、figure/figcaption、blockquote、header/footer/main/nav/section/article/aside、b/i/u/s/em/strong/small/mark/code/kbd/samp/var/abbr/cite/q/del/ins/dfn/time/data、sub/sup、pre、a、img、canvas、button。全局属性：class、id、title、hidden、lang、dir、style、data-*、aria-*。

**Inline SVG**：svg、g、path、rect、circle、ellipse、line、polyline、polygon、text、tspan、defs、symbol、use、linearGradient、radialGradient、stop；可用 fill/stroke 等表现属性与 CSS 着色。

**CSS**：flex、grid、\`display:table/table-row/table-cell\`、relative/absolute/fixed 定位（fixed 相对气泡）、盒模型、border/圆角、box-shadow、outline、opacity、linear/radial/conic 渐变（含 repeating）、2D transform（rotate/scale/translate/skew）、transition、\`@keyframes\`、CSS 变量与 \`var()\`、\`calc()/min()/max()/clamp()\`、rgb()/hsl()/hex/\`light-dark()\`、\`::before/::after\`、\`:hover\`（仅鼠标）、\`:active\`、\`:not/:is/:where\`、结构伪类（\`:first-child\`、\`:nth-child()\` 等）、\`[disabled]/:disabled\`、\`@media\` 的 width/aspect-ratio/orientation/prefers-color-scheme/prefers-reduced-motion、\`@supports\`、单行 ellipsis、\`touch-action\`、\`pointer-events\`、\`user-select\`、\`env(safe-area-inset-*)\`、\`aspect-ratio\`、\`overflow:hidden\`、\`visibility\`、z-index、\`filter/backdrop-filter\` 的 \`blur()/brightness()/drop-shadow()\`、SVG 上的 CSS 动画。

**JS**（本地交互可用，静态卡片可省略）：ES2023 解释器（无 JIT）、Promise/async、setTimeout/setInterval、requestAnimationFrame、DOM 查询与构建、MutationObserver/ResizeObserver、布局读取（getBoundingClientRect/getComputedStyle/offsetWidth 等是到渲染层的往返，循环里要缓存）、matchMedia、canvas 2D、\`new Image()\`+data:、Web Animations、Intl、crypto.getRandomValues、TextEncoder、URL、structuredClone、localStorage/sessionStorage、CSS.supports。元素 id 不是全局变量，用 \`document.getElementById('x')\`。

## 4. 禁用清单（profile 1 之外，移除后不报错）

**表单与输入**：input（所有类型）、select、option、optgroup、textarea、datalist、fieldset、progress、meter 连同子树被删除；form 变成 div，label/legend/output 变成 span。\`contenteditable/spellcheck/inputmode/enterkeyhint/autocapitalize\` 属性、\`tabindex/autofocus/accesskey\`、\`draggable\` 被删。键盘不存在：keydown/keyup、focus/blur、Enter/Space 激活按钮、文本输入都没有，\`focus()\` 是空操作。

**媒体与嵌入**：audio、video、source、track、iframe、frame、object、embed 连同子树被删除；dialog 渲染成 div（showModal/show 等方法被删）、popover 属性被删；\`<img src="data:image/svg+xml">\`、AVIF/BMP/ICO 的 data: 图片被拒；SVG 的 clipPath、mask、pattern、marker、fe* 滤镜元素、SMIL（animate/animateTransform/animateMotion）、foreignObject、SVG 内 \`<image>\`；\`<meta>\`、\`<title>\`、\`<template>\`、\`<slot>\`、\`<link>\`、\`<base>\` 被丢弃（编码由服务端按 UTF-8 处理）。

**CSS**：\`display:flow-root/contents/list-item\`；逻辑属性（margin-inline、padding-block、inset-inline、inline-size 等）；多栏布局；\`position:sticky\`；\`overflow:auto/scroll\`；hwb()/lab()/lch()/oklab()/oklch()/color()；\`color-mix()\`；\`background-clip:text\`；一切非 data: 的 \`url()\`/\`image-set()\`；具名字体与 \`@font-face\`；\`-webkit-line-clamp\`；\`text-shadow\`；writing-mode/text-orientation；3D transform（rotateX/Y、translateZ、perspective…）；grayscale/sepia/saturate/contrast/hue-rotate/invert/opacity 这些 filter 函数；\`filter:url(#…)\`;mix-blend-mode/isolation/background-blend-mode；clip-path；mask；vh/dvh/svh/vb；\`:has()\`；\`::first-letter/::first-line/::marker\`；\`:focus/:focus-visible/:focus-within\`；\`:checked/:valid/:invalid/::placeholder\`；\`:target\`；\`@media (hover)\`、\`@media (pointer)\`、\`@media print\`、\`@container\`、\`@layer\`、\`@property\`、\`@scope\`、\`@page\`、CSS 嵌套。

**JS**：\`element.focus()/blur()/select()\`、\`document.activeElement\`；CDN 打包库（Chart.js、D3 等没有内置，\`<script src>\` 不加载）；fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / Worker / BroadcastChannel（网络一律禁用）；location 赋值、history、\`window.open\`、表单提交；alert / confirm / prompt / print（非阻塞存根）；clipboard / share / vibrate / geolocation / mediaDevices / Notification；attachShadow / customElements.define；Blob / FileReader / URL.createObjectURL；requestFullscreen；\`TelegramWidget.sendMessage\`（SDK 未提供）；touch 事件；wheel/scroll 事件。

## 5. 零网络与外部资源

- widget 没有任何网络能力：fetch 等 API 抛 \`NetworkDisabledError\`；外部 \`<script src>\`、外链样式表、外链字体、外链图片都不会加载，且不会请求。
- 唯二允许的 URL 形态是 \`data:\` 图片，以及 \`<a href="https://…">\` / \`openLink(url)\`：点 \`<a>\` 标签由客户端用内置浏览器打开（先显示完整 URL 让用户确认，不经过 bot）；它不是资源加载，widget 本身仍为零网络。
- 图片只接受 \`data:\` 的 PNG / JPEG / GIF / WebP，单张最多 1024×1024 像素（更大显示占位图）；data: 图片几乎压不动，会直接吃掉 4096 B 预算，静态展示优先用 inline SVG、CSS 渐变或字符（emoji）绘制。
- \`data:image/svg+xml\` 形式的 \`<img>\` 被拒绝；需要 SVG 就内联写 \`<svg>\`。

## 6. 输入与手势（点击可用，但没有键盘与纵向拖动）

- 到达 widget 的只有 tap（click）与 pointer 事件（down/move/up/cancel、enter/leave）以及鼠标兼容事件；没有 touchstart/touchend、没有键盘、没有滚轮与滚动事件。双击归 widget（两次 click 后 dblclick）。
- **垂直拖动永远是聊天的**（气泡在 widget 上滚动）；长按与横向拖动按元素用 \`touch-action\` 认领：\`auto\`（默认）长按归聊天菜单、横滑归聊天回复；\`pan-y\` 横拖归 widget；\`none\` 横拖与长按都归 widget。左侧前 20 px 永不认领（系统返回手势）。
- 交互控件按 \`touch-action\` 认领：\`none\` 给按钮/画布（长按与横拖都归 widget）、\`pan-y\` 给横向滑杆；纯展示的按钮不挂事件。**本地点击是真实发生的**（\`click\` 里改 DOM 立即生效，见 §7.1）；只有需要 bot 应答的 \`request()\` 不可用（见 §7）。动作挂 \`click\`，不要挂 \`pointerdown\`（它可能变成聊天的滚动）。

## 7. state 与 request 的现状（Phase 0）

- 发送后 HTML 不可变。唯一的可变量是状态：\`chatData\`（本聊天内该消息的状态）与 \`publicData\`（共享状态，转发件共享），各 ≤1024 字节 UTF-8 字符串，由 bot 用 \`editMessageWidgetData\` 写入；变化触发 \`chatDataChanged\` / \`publicDataChanged\`，widget 自行从状态重绘。
- **Phase 0 bot 不写状态**：没有状态写入流程，不要把内容设计成「等状态变化后重绘」，也不要写 JSON.parse(TW.chatData) 之类的状态读取。
- \`TelegramWidget.request(data)\`（1–64 字节，点击触发，bot 用 \`answerWidgetQuery\` ≤1024 字节应答，15 秒超时，每用户 5 次/5 秒，同时只能一个请求在飞）依赖入站 \`widget_query\` update：k-on-bot 当前用自托管 Bot API 10.2，收不到该 update；Phase 0 不接交互。因此不要写 \`request()\`、不要写 onclick 依赖点击结果、不要用定时器轮询。
- 结论：需要 bot 应答的交互（\`request()\`、\`chatData\`/\`publicData\` 回写、等 bot 改状态再重绘）在 Phase 0 全部不可用；**纯本地交互不受这条限制**，见 §7.1。

### 7.1 本地交互（不经过 bot，可用）

- 什么时候写：由你判断。轻量点击彩蛋、展开收起、本地小游戏都可以；加 JS 的代价是体积（算进 4096 预算）与静态预览只看到首帧，觉得值得就加。
- 能力：inline \`<script>\` 在客户端沙盒里运行，\`click\`/\`pointer\` 事件、DOM 改写、canvas 2D、\`localStorage\`/\`sessionStorage\`、\`setTimeout\`/\`requestAnimationFrame\`、Web Animations 都可用。
- 首帧必须可读：分享预览与 bot 上下文里的渲染图只看到第一帧，关键信息不要等点击或动画才出现；首帧同步画出来。
- 游戏边界：没有键盘、没有纵向拖动（做不了纵向滑杆/摇杆/画板），用点击按钮或横向拖动；高度 ≤600 px 且不能滚动；单任务 ≤500 ms、每秒 CPU 预算 300 ms、单任务最多 128 次布局读取（循环里缓存）、节点 ≤2000、同时运行的脚本动画 ≤64。
- 状态：widget 可能被销毁重建，本地状态（最高分、已翻开的格子）存 \`localStorage\` 并在加载时恢复；\`localStorage\` 每条消息每设备 4 KB，\`setItem\` 包 \`try/catch\`（预览环境里可能直接抛 SecurityError），转发件为空。
- 体积：JS 也算进 32768/4096 预算，小游戏控制在 raw ≤8 KB。
- 投递：私聊直接渲染成 widget；群聊暂不支持 widget 消息，bot 改发带预览的分享链接，点开在 Mini App 里同样能交互。

## 8. 常用模式

### 8.1 卡片（最常见的容器）

\`\`\`html
<div class="card">
  <div class="hd">本周数据</div>
  <div class="hint">11-02 至 11-08 · 中国标准时间</div>
  <div class="row"><span>消息</span><b>1,284</b></div>
</div>
<style>
.card{border:1px solid var(--tg-theme-section-separator-color);border-radius:12px;padding:12px}
.hd{font-weight:600;font-size:16px}
.hint{color:var(--tg-theme-hint-color);font-size:13px;margin-top:2px}
.row{display:flex;justify-content:space-between;margin-top:8px}
</style>
\`\`\`

\`<style>\` 可以放在任何位置；样式集中成少量类，重复结构用同类名（压缩率高）。

### 8.2 表格

表格是 widget 里做「多行多列数据」最省字节的方式（原生 table 布局可用）：

\`\`\`html
<table>
  <tr><th>项目</th><th>本周</th><th>上周</th></tr>
  <tr><td>消息</td><td>1,284</td><td>1,102</td></tr>
  <tr><td>回复</td><td>96</td><td>88</td></tr>
</table>
<style>
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:5px 0;border-bottom:1px solid var(--tg-theme-section-separator-color);text-align:left}
th:not(:first-child),td:not(:first-child){text-align:right}
th{color:var(--tg-theme-hint-color);font-weight:500}
</style>
\`\`\`

行数多时只保留最重要的 5–8 行；超出 600 px 的行会被裁掉。

### 8.3 统计图（CSS 柱状 / inline SVG）

柱状图用 flex + 内联高度百分比最省字节，数值在写 HTML 时算好（没有 JS 运行时计算）：

\`\`\`html
<div class="bars"><i style="height:36%"></i><i style="height:58%"></i><i style="height:100%"></i></div>
<style>
.bars{display:flex;align-items:flex-end;gap:4px;height:56px}
.bars i{flex:1;min-height:2px;border-radius:3px 3px 0 0;background:var(--tg-theme-button-color)}
</style>
\`\`\`

\`<canvas>\` 元素也在白名单里，但画东西需要 JS，静态展示用 SVG/CSS 就够。折线/迷你趋势图（sparkline）用 inline SVG，坐标同样写字时算好：

\`\`\`html
<svg width="100%" height="40" viewBox="0 0 100 40" preserveAspectRatio="none">
  <polyline points="0,30 20,22 40,26 60,12 80,16 100,4" fill="none"
            stroke="var(--tg-theme-button-color)" stroke-width="2"/>
</svg>
\`\`\`

### 8.4 折叠详情（原生 details）

\`<details>/<summary>\` 点击开合是客户端原生行为，不依赖 JS，是「长内容放进 600 px」的首选：

\`\`\`html
<details><summary>口径说明</summary>
  <div class="hint">统计来自本群归档，按天汇总，晚一天更新。</div>
</details>
\`\`\`

### 8.5 按钮：纯展示 vs 本地交互

未加样式的 \`<button>\` 就是客户端原生按钮外观；要视觉统一也可以用 div 画：

\`\`\`html
<button>查看详情</button>
<div class="btn">查看详情</div>
<style>
.btn{display:block;margin-top:12px;padding:8px;border-radius:8px;text-align:center;
     background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-weight:600}
button{border:0;border-radius:8px;padding:8px 14px;background:var(--tg-theme-button-color);
       color:var(--tg-theme-button-text-color);font:inherit}
</style>
\`\`\`

纯展示卡片用 \`<div class="btn">\` 之类视觉块即可；想加点点击彩蛋就挂事件（真 \`<button>\` + \`click\` + \`touch-action:none\`），不挂也没有问题：

\`\`\`html
<button id="b" style="touch-action:none">翻开 🎁</button> <span id="o" class="hint">点一下试试</span>
<script>
var n = 0, b = document.getElementById('b'), o = document.getElementById('o');
b.addEventListener('click', function () { o.textContent = ++n % 2 ? '🍓 +10' : '🍵 +5'; });
</script>
\`\`\`

### 8.6 状态徽标 / 高亮

\`\`\`html
<span class="tag">进行中</span> <mark>峰值 21:00</mark> <code>v1.2.3</code>
<style>
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;
     background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color)}
mark{border-radius:3px;padding:0 3px}
</style>
\`\`\`

## 9. 最小完整示例（已用官方 sandbox harness 验证）

下面是「一张数据卡片」，含标题、副标题、柱状图、表格、折叠详情与按钮视觉，零 JS、只依赖主题变量。实测：raw 1.6 KB / zlib9 761 B，width 360 px 时内容高 341 px（<600），validator 无剔除项。可直接作为模板改写：

\`\`\`html
<style>
body{margin:0;padding:12px 14px;font:15px/1.4 system-ui,sans-serif;color:var(--tg-theme-text-color)}
.card{border:1px solid var(--tg-theme-section-separator-color);border-radius:12px;padding:12px}
.hd{font-weight:600;font-size:16px}
.hint{color:var(--tg-theme-hint-color);font-size:13px;margin-top:2px}
.bars{display:flex;align-items:flex-end;gap:4px;height:56px;margin-top:12px}
.bars i{flex:1;min-height:2px;border-radius:3px 3px 0 0;background:var(--tg-theme-button-color)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-variant-numeric:tabular-nums}
td{padding:4px 0;border-bottom:1px solid var(--tg-theme-section-separator-color)}
td+td{text-align:right;font-weight:600}
details{margin-top:10px}
summary{color:var(--tg-theme-link-color)}
.btn{display:block;margin-top:12px;padding:8px;border-radius:8px;text-align:center;
     background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-weight:600}
</style>
<div class="card">
  <div class="hd">本周数据</div>
  <div class="hint">11-02 至 11-08 · 中国标准时间</div>
  <div class="bars"><i style="height:36%"></i><i style="height:58%"></i><i style="height:29%"></i><i style="height:77%"></i><i style="height:100%"></i><i style="height:71%"></i><i style="height:86%"></i></div>
  <table>
    <tr><td>消息</td><td>1,284</td></tr>
    <tr><td>回复</td><td>96</td></tr>
    <tr><td>峰值</td><td>周六 21:00</td></tr>
  </table>
  <details><summary>口径说明</summary><div class="hint">统计来自本群归档，按天汇总，晚一天更新。</div></details>
  <div class="btn">查看完整周报</div>
</div>
\`\`\`

写完整文档（\`<!doctype html><html><head>…<body>…\`）或裸片段都可以；\`<script>\`、\`<style>\` 必须内联，不能有 src/href 外链。

## 10. 体积预算与压缩

- 服务端口径：zlib level 9 压缩后 ≤4096 B；budget 检查在 bot 侧发送前做，超限会拒绝并报错。原始 ≤32768 B。
- 压缩率的决定因素：**重复的 CSS、重复的结构、短类名**压缩最好；**data: 图片与各不相同的长文本**几乎压不动；中文正文 UTF-8 每字 3 字节，压缩收益有限。省字节的写法：样式集中成几条类而非逐个元素 style；重复块用同一类名；不写注释与死代码；长文案压成短句、细节放 \`<details>\`；图片用 SVG/渐变/emoji 而非 data:。
- 经验参考（官方 harness 实测）：§9 的示例约 30 个元素、1.6 KB raw → 761 B zlib9（约 47%）；20 行左右的列表 zlib9 约 1.1 KB。
- 实操：raw ≤8 KB 的卡片/列表基本安全；10 KB 以上先按「去注释、合并重复类、删未用规则」砍一遍再交给 send_widget —— bot 侧会量 raw 与 zlib9 两个真实数字，超 4096 会拒发并报出差距，按差距删内容即可。
- 运行时限额（超了 widget 停在最后一帧显示 "Widget stopped"，或抛异常）：文档节点（元素/文本/注释）≤2000、单个文本值 ≤32K 字符、全文档文本 ≤48K 字符、单个属性/内联样式 ≤8K、CSS 规则 ≤400、@keyframes ≤32、同时运行的脚本动画 ≤64。静态展示或小游戏只要不堆几千行就不会碰到。

## 11. 常见失败形态（都是客户端静默处理，不会报错）

- \`vh\` → 高度声明被删，元素塌陷或按内容自适应；改用 \`%\`/px/\`vmin\`。
- 内容超过 600 px → 底部被裁，没有滚动条；拆卡片或放 \`<details>\`。
- 外链图片/字体/脚本 → 被丢弃或占位图，其余部分照常渲染；只能 data: 图片或 inline SVG。
- 写死白底黑字 → 深色主题下不可读；用 \`--tg-theme-*\` 变量。
- form/input → 控件连同子树被删除；需要输入就回落到普通文字消息提问。
- \`position:sticky\`、\`text-shadow\`、\`:has()\`、\`clip-path\`、3D transform → 声明被删，无效果。
- 依赖 \`request()\` / \`chatData\` / \`publicData\` → Phase 0 没有入站通道，请求一律失败；本地 \`onclick\` 改 DOM 不受影响（§7.1）。
- 主题变量名写错（如 \`--tg-theme-link-key\`）→ 被忽略，颜色回退到继承值。
`;
