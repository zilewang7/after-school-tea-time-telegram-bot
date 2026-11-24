---
name: harness-reporting
description: >
  harness_issue 查重（action="list"）、提单门槛与高质量提单字段（action="create"），
  以及「不把提单写进回复」边界规范。准备记录工具或提示词缺陷时加载本规范。
license: MIT
compatibility: 需要本聊天开启 harness_issue
metadata:
  bot.required-tools: "harness_issue"
  bot.any-tools: ""
  bot.scope: "all"
  bot.owner-only: "false"
  bot.version: "1"
  bot.updated-at: "2026-11-24"
---
# Harness Issue 查重与提单规范

## 1. 定位与回复隔离边界

- `harness_issue` 用于向维护者记录模型在使用本 bot harness（工具声明、参数校验、报错信息、上下文格式、提示词一致性）时遇到的真实摩擦与缺陷，**不是面向用户的反馈渠道**。
- **严禁把提单行为写进回复正文**：不要在回复里向用户提及「我记录了一个 issue」「已提交 #X 号问题」或类似内部排查/提单过程；只向用户输出任务本身的真实答复。

## 2. 何时不提单（避免噪音）

- 以下情况**不要提单**：
  - 用户输入有误、缺少必要信息，或当前聊天未开启对应工具/权限导致的正常拒绝；
  - 外部网络服务偶发超时、限流（429）或第三方站点临时不可达；
  - 任务目标本身超出客观能力，而非 harness 工具文档/schema/行为设计的问题；
  - `action="list"` 已能看到相同未关闭（`open`）issue。
- **数量节制**：单条回复最多新建 **3** 条 issue；多个相关联的小摩擦应合并成一条聚焦的 issue。

## 3. `harness_issue(action="list")` 查重流程

- 准备提新 issue 前，先用 `harness_issue(action="list", ...)` 检索已有条目：
  - `status`：`'open'`（默认，待处理）、`'closed'`（已处理/已驳回/重复）、`'all'`（全部）。
  - `query`：按关键词过滤标题与正文（建议用核心工具名或错误关键词检索）。
  - `limit`：返回条数上限（默认 20，最大 50）。
- 每次结果末尾都会附带全量状态计数（如 `全部 N 条：open X · triaged Y · …`）。若返回 0 条且全量总数为 0，即已确认库内无记录，无需换过滤条件反复查询。
- 列表中标有 `[user]` 的条目是当前聊天成员从控制面板提交的问题，只读参考，同样用于避免重复。

## 4. `harness_issue(action="create")` 高质量提单字段

- `title`（必填，≤ 200 字符）：一句话说清「哪个工具/环节 + 什么具体问题」，例如「`workspace` 在 batch 编辑失败时未指明第几项参数有误」。
- `kind`（必填）：
  - `bug`：实际行为与工具描述、错误提示或预期明显不符；
  - `improvement`：功能可用但描述不清、字段别扭、错误信息缺乏可操作性或文档自相矛盾；
  - `feature`：完成常见合理需求时明确缺少的工具能力或参数。
- `tool_name`（强烈建议填写，≤ 64 字符）：精确写出相关内置工具名（如 `send_widget`、`workspace`、`find_image`、`history`），便于维护者按工具归类排查。
- `severity`（可选）：`low` / `medium` / `high`，按对完成任务的阻碍程度选择。
- `body`（必填，≤ 4,000 字符）：按四点写清，确保维护者无需追问即可定位：
  1. **复现上下文**：触发场景与调用的工具参数形态（抽象化描述，不带真实聊天细节）；
  2. **工具名与现象**：具体工具、参数组合与返回的报错原文或异常表现；
  3. **期望 vs 实际差异**：按工具说明期望发生什么，实际发生了什么以及对后续步骤的影响；
  4. **改进建议**：具体到文档措辞、schema 字段或错误提示应如何调整。
- **隐私与脱敏底线**：`title` 和 `body` 中**严禁粘贴用户消息原文、Telegram ID / 用户名 / 群名等个人信息或一次性任务内容**。
