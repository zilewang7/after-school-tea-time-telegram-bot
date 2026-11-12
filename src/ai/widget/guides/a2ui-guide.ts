/**
 * A2UI-mode widget authoring guide, returned on demand by get_ui_guide('a2ui').
 *
 * Describes the fixed Telegram catalog 'tg-card-v1' (A2UI v1.0 subset, see
 * ../../widget/a2ui/catalog.ts) that the bot compiles to static widget HTML.
 * A2UI itself is Apache-2.0 (a2ui-project/a2ui); the widget constraints come
 * from the widget-sandbox docs snapshot (widget profile 1; snapshot 2026-11-08).
 * Bump WIDGET_GUIDE_VERSION in registry.ts when this text changes.
 */
export const WIDGET_GUIDE_A2UI_TITLE = "Telegram Widget · A2UI 模式规范（catalog: tg-card-v1）";

export const WIDGET_GUIDE_A2UI_TEXT = `Telegram Widget · A2UI 模式规范（自定义 catalog: tg-card-v1）
guide=a2ui · version 4 · 来源：A2UI v1.0（a2ui-project/a2ui，Apache-2.0）的 Telegram 子集 + TelegramMessenger/widget-sandbox 文档内部快照（widget profile 1，快照 2026-11-08）

## 0. 这份文本是什么、产出什么

- 模型调用 get_ui_guide(kind='a2ui') 得到本文；读完按本文写**一个 A2UI v1.0 surface JSON**，用 send_widget(mode='a2ui', surface=…) 提交。bot 侧固定编译器把它编译成一份自包含 widget HTML（零 JS、主题变量着色、模型文本全部 HTML 转义），再作为 Telegram widget 消息发出。
- 模型不写 HTML/CSS/JS，只组合下面白名单里的组件与 props；布局与样式由编译器固定。
- Phase 0 只做**纯静态展示**：HTML 发出后不可变、不接点击、不回写状态；Button 只渲染外观。
- A2UI 适合结构化展示：卡片、键值、列表、表格、柱状图、趋势线。需要自由布局、精确配色、自绘 SVG、动画，或**本地交互（点击改 DOM、小游戏）**时改用 HTML 模式（get_ui_guide(kind='html')）。

## 1. 输入形状

推荐完整信封（单个对象）：

\`\`\`json
{"version":"1.0","createSurface":{"surfaceId":"card1","components":[{"id":"root","component":"Card","child":"col"},{"id":"col","component":"Column","children":["t"]},{"id":"t","component":"Text","text":"你好"}]}}
\`\`\`

编译器实际接受的输入（任选一）：
- 上面的信封对象；\`version\` 不校验，\`surfaceId\` 与 \`catalogId\` 可省略（catalog 固定为 tg-card-v1）。
- 裸 surface：\`{"components":[…]}\`（可带 \`dataModel\`）。
- 上面两种的 minified JSON 字符串（工具参数是字符串时）。
- JSON 数组（JSONL 合并成数组的形式）：数组里只能有一条 \`createSurface\`，多条会报 invalid-surface。

工具参数形状：send_widget 的 \`surface\` 参数声明为**字符串**，把上面任一形状序列化成 minified JSON **字符串**传进去（如 \`"{\\"components\\":[…]}"\`）。不要传 JSON 对象：部分平台会把对象的嵌套字段剥成 null（harness issue #5）。编译器本身也接受对象，但工具 schema 只承诺字符串。

字段规则：
- \`components\` 必须是非空数组，元素是**扁平邻接表**：\`{"id":"…","component":"组件名", …props}\`；容器用 \`child\`（单个 id 字符串）或 \`children\`（id 数组）引用别的组件，两者只能二选一。
- 必须有且只有一个根组件，id 必须是 \`"root"\`；其他 id 自取（短 id 省 token 也省体积）。
- 组件 id 唯一且必须可达：没被任何 child/children 引用的组件只产生 warning，不会渲染。
- 组件数 ≤2000、嵌套深度 ≤32、引用必须是无环树。
- \`dataModel\` 必须是 JSON 对象（不能是数组/字符串）；没被 \`@path\` 读过只产生 warning。
- **不支持**增量/流式消息：\`updateComponents\`、\`updateDataModel\`、\`deleteSurface\`、\`callRendererFunction\`、\`agentFunctionResponse\` 出现即报错；一条输入只渲染一个 surface。
- 输出 **minified JSON**（无缩进换行）；pretty JSON 的 token 成本高 45–55%。

## 2. 组件白名单（catalog: tg-card-v1）

只认下列组件；其他名字报 unsupported-component，错误消息会给出完整支持列表。

### 布局（都可带 \`justify\` / \`align\`）

| 组件 | props |
|---|---|
| \`Card\` | \`child\` 或 \`children\`；\`justify\`、\`align\` | 外层卡片：secondary 背景、圆角、内边距 |
| \`Column\` | \`child\` 或 \`children\`；\`justify\`、\`align\` | 纵向排列 |
| \`Row\` | \`child\` 或 \`children\`；\`justify\`、\`align\` | 横向排列（默认垂直居中） |
| \`List\` | \`child\`/\`children\`（含模板写法）；\`direction\`：\`vertical\`（默认）或 \`horizontal\`；\`justify\`、\`align\` | 重复或顺序容器 |

- \`justify\`（主轴）：\`start\` \`center\` \`end\` \`spaceAround\` \`spaceBetween\` \`spaceEvenly\` \`stretch\`。
- \`align\`（交叉轴）：\`start\` \`center\` \`end\` \`stretch\`。
- 不在表里的 props 被静默忽略；写错枚举值会报 invalid-surface 并列出可用值。

### 内容

| 组件 | props |
|---|---|
| \`Text\` | \`text\`（字符串/数字/布尔或绑定）、\`variant\`：\`body\`（默认）\`caption\` \`h1\` \`h2\` \`h3\` \`h4\` |
| \`Divider\` | 无（\`axis\` 只支持 \`horizontal\`，其它值只给 warning 并按水平线画） |
| \`Icon\` | \`name\`：\`check\` \`star\` \`info\` \`warn\` \`arrow\` \`clock\` \`chat\` \`chart\` \`heart\` \`close\`（10 个，其他名字报错） |

\`Text\` 的 \`text\` 支持轻量 markdown（编译期转成 HTML）：\`**粗体**\`、反引号 \`\` \`code\` \`\`、换行转 \`<br>\`；当 \`variant\` 为 \`body\` 且整段文本是 \`#\`+空格开头的单行时，按标题渲染（最多 h4）。不建议同一段里混用太多格式。

### 交互（Phase 0 只有外观）

| 组件 | props |
|---|---|
| \`Button\` | \`child\` 必须指向一个 \`Text\` 组件（按钮文字）；\`variant\`：\`primary\` 或 \`default\`（默认） |

- 按钮只渲染外观、没有点击行为；\`action\` 字段被忽略并产生 warning。不要写 \`action\`。

### 自定义可视组件（tg-card-v1 扩展）

| 组件 | props |
|---|---|
| \`Table\` | \`columns\`: string[]（非空）、\`rows\`: string[][]（≤200 行；>20 行会 warning） |
| \`BarChart\` | \`values\`: number[]（非空）、\`labels?\`: string[] | 柱子高度按最大值归一化，负值按 0 画；>30 根 warning；labels 与 values 数量不一致 warning |
| \`Sparkline\` | \`values\`: number[]（≥2 个、≤500 个） | 归一化折线，自动缩放到自身 min/max |

### 会被拒绝的组件（错误消息带替代建议）

\`TextField\` \`CheckBox\` \`Slider\` \`DateTimeInput\` \`ChoicePicker\`（输入控件）、\`Image\` \`Video\` \`AudioPlayer\`（widget 无媒体元素/无网络）、\`Modal\` \`Tabs\`（需要交互）以及任何未知组件名。替代写法见 §6.2。

## 3. 绑定（dataModel）

- 任何字符串/数值 prop 都可以是字面量，或绑定对象 \`{"@path":"/user/name"}\`（JSON Pointer，从 dataModel 根解析；支持 \`~0\`/\`~1\` 转义）。
- 只支持 \`@path\`。\`@call\`（函数调用）报 invalid-binding；v0.9 的裸 \`"path"\` 写法也报 invalid-binding。
- 绑定路径必须真实存在：缺字段、路径中间不是对象、没有 dataModel 时用绝对路径 → invalid-binding（错误消息会提示检查层级与大小写）。
- **List 模板内**可用相对路径 \`{"@path":"label"}\`，读取当前列表项的同名字段；相对路径只能出现在 List 模板作用域里。
- 数组/矩阵 prop（\`columns\`、\`rows\`、\`values\`、\`labels\`）里的每一项也可以写成 \`{"@path":"/x"}\` 绑定。
- 静态内容直接写字面量：不需要复用的数据不要建 dataModel（多一层引用不省 token）。

## 4. List 模板（重复行）

\`List\` 的 children 写成模板对象时，编译器用 dataModel 的数组展开；模板内组件用相对路径绑定每行字段：

\`\`\`json
{"id":"list","component":"List","children":{"componentId":"item","path":"/items"}},
{"id":"item","component":"Row","children":["dot","lab"]},
{"id":"dot","component":"Icon","name":"check"},
{"id":"lab","component":"Text","text":{"@path":"label"}}
\`\`\`

规则：
- \`path\` 必须以 \`/\` 开头，指向 dataModel 里的**对象数组**；不是数组 → invalid-binding，空数组 → 渲染为空（warning）。
- \`componentId\` 是模板组件的 id，必须已在 components 里定义；模板内的子组件同样只定义一次。
- 行数建议 ≤20：widget 高 ≤600 px、没有内部滚动，超出会被裁。
- 不需要复用时可以直接给 \`children\` id 数组逐行写（静态）。

## 5. 完整示例

### 5.1 卡片（键值信息 + 分隔线）

\`\`\`json
{"version":"1.0","createSurface":{"surfaceId":"weather","components":[{"id":"root","component":"Card","child":"col"},{"id":"col","component":"Column","children":["title","sub","line","row","foot"]},{"id":"title","component":"Text","text":"上海 · 多云转晴","variant":"h3"},{"id":"sub","component":"Text","text":"体感 23°C · 湿度 61%","variant":"caption"},{"id":"line","component":"Divider"},{"id":"row","component":"Row","children":["hi","lo"],"justify":"spaceBetween"},{"id":"hi","component":"Text","text":"最高 27°C"},{"id":"lo","component":"Text","text":"最低 18°C"},{"id":"foot","component":"Text","text":"更新于 14:30 · 数据源：中央气象台","variant":"caption"}]}}
\`\`\`

编译产物 raw 1.9 KB / zlib9 791 B，远低于 4096 B 上限。

### 5.2 列表（List 模板 + dataModel + 按钮外观）—— raw 2.6 KB / zlib9 878 B

\`\`\`json
{"version":"1.0","createSurface":{"surfaceId":"todo","components":[{"id":"root","component":"Card","child":"col"},{"id":"col","component":"Column","children":["hd","list","btn"]},{"id":"hd","component":"Text","text":"今日待办","variant":"caption"},{"id":"list","component":"List","children":{"componentId":"item","path":"/items"}},{"id":"item","component":"Row","children":["dot","lab"]},{"id":"dot","component":"Icon","name":"check"},{"id":"lab","component":"Text","text":{"@path":"label"}},{"id":"btn","component":"Button","child":"bt","variant":"primary"},{"id":"bt","component":"Text","text":"刷新"}],"dataModel":{"items":[{"label":"回复 @alice 的问题"},{"label":"部署 10.4 测试实例"},{"label":"整理 A2UI 调研笔记"},{"label":"跑离线测试"}]}}}
\`\`\`

### 5.3 表格与图表片段

\`\`\`json
{"id":"t","component":"Table","columns":["项目","本周","上周"],"rows":[["消息","1,284","1,102"],["回复","96","88"]]}
\`\`\`

\`\`\`json
{"id":"bars","component":"BarChart","values":[12,18,9,24,31,22,27],"labels":["一","二","三","四","五","六","日"]}
\`\`\`

\`\`\`json
{"id":"spark","component":"Sparkline","values":[3,7,5,11,9,14,12,18]}
\`\`\`

图表数值直接写字面量；柱高与折线坐标由编译器算好，不需要手写刻度（需要单位时加一行 \`Text\`/\`variant:"caption"\`）。

## 6. 体积预算与错误处理

### 6.1 预算

- 编译产物硬上限：HTML ≤32768 字节、zlib9 ≤4096 字节（服务端口径）；编译器目标值：卡片 ≤800 B、列表 ≤1.5 KB、图表 ≤1.2 KB，给正文留余量。
- 省体积的事实：List 用模板而不是逐行展开；不要给每个组件写长 id；不重复 dataModel 里已有的文本；长文案截短或拆成多个 surface；不写无意义组件（不可达组件不渲染但会 warning）。
- 单 surface 建议：组件 ≤40、Text 总字数 ≤2000、List 行 ≤20、Table ≤8 行 × 6 列、图表点数 ≤20。
- 超预算返回 too-large，按错误消息删内容/拆卡片后重试。

### 6.2 错误码与改写方式

编译在 bot 侧同步完成，失败返回可行动的中文错误（含组件/id/prop）。按错误改写后重新调用 send_widget：

| 错误码 | 含义 | 改写方式 |
|---|---|---|
| \`invalid-input\` | 顶层不是对象/数组/字符串，或字符串为空 | 给 \`createSurface\` 信封或 \`{components,…}\` |
| \`invalid-json\` | 字符串不是合法 JSON | 输出严格 JSON：双引号、无尾逗号、无注释；多行 JSONL 合并成一个数组 |
| \`invalid-surface\` | 缺 root、id 重复/不存在、child 与 children 同给、有环、超 32 层、children 不是 id 数组、dataModel 不是对象、带增量消息 | 按错误指出的 id/字段修结构 |
| \`unsupported-component\` | 组件不在白名单 | 换白名单组件（见下），或改用 HTML 模式 |
| \`invalid-binding\` | \`@path\` 不存在、用了 \`@call\`/旧 \`path\`、数组 prop 里给了非字符串/非数字、List path 不是数组、Table 超 200 行 | 绑定只引真实字段；数组元素用正确类型 |
| \`too-large\` | 编译后超体积预算 | 删行、缩短文本、拆成多条 widget |

**不支持组件 → 白名单等价写法**：
- \`TextField\` / \`CheckBox\` / \`Slider\` / \`DateTimeInput\` / \`ChoicePicker\` → \`Text\`（当前值）+ \`Row\` 里的 \`Button\`（选项外观）；Phase 0 没有输入，只展示状态。
- \`Image\` / \`Video\` / \`AudioPlayer\` → \`Text\` 写说明或链接文字、\`Icon\` 占位；要真图改用 HTML 模式（\`data:\` 图片）。
- \`Modal\` / \`Tabs\` → \`Column\` + \`Divider\` 分段，或拆成多个 surface。
- 未知组件 → 从错误消息列出的支持列表里选最近的容器/文本组件。

warning 不阻断发送（未使用的 dataModel、不可达组件、空 children、行数 >20、labels 数量不匹配等），出现时按提示精简即可。

## 7. 渲染事实（编译产物）

- 输出是零 JS 的静态 HTML 片段：\`<meta charset=utf-8>\` + 固定 \`<style>\` + \`<div class="tw-root">…</div>\`；字体、间距、颜色由编译器固定。
- 颜色全部用 \`--tg-theme-*\`（浅色/深色主题都正确）：文字 \`text-color\`、次要文字 \`hint-color\`、卡片底 \`secondary-bg-color\`、按钮 \`button-color\`/\`button-text-color\`。
- 模型文本全部 HTML 转义（\`<\`、\`&\`、引号不会破坏结构）；只有 \`**粗体**\`、反引号 code、换行、行首 \`#\` 标题会被转成格式。
- widget 宽 200–600 px（按 320 设计），高 ≤600 px；内容超出被裁且没有内部滚动。
- 发送后 HTML 不可变；Phase 0 不接点击、不写状态（没有 \`action\`/\`request\` 通路）。
- 编译结果里的 \`components\`（实际用到的组件名）与 \`warnings\` 只用于诊断，不影响展示。
`;
