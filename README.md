<p align="center">
  <img src="web/public/icons/logo-1024.png" alt="HappyClaw Logo" width="120" />
</p>

<h1 align="center">HappyClaw</h1>

<p align="center">
  自托管的多用户本地 AI Agent 系统 — Powered By Claude Code.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-teal.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/riba2534/happyclaw/stargazers"><img src="https://img.shields.io/github/stars/riba2534/happyclaw?style=for-the-badge&color=f5a623" alt="GitHub Stars" /></a>
</p>

<p align="center">
  <a href="#happyclaw-是什么">介绍</a> · <a href="#核心能力">核心能力</a> · <a href="#快速开始">快速开始</a> · <a href="#技术架构">技术架构</a> · <a href="#贡献">贡献</a>
</p>

---

| 聊天界面 — 工具调用追踪 | 聊天界面 — Markdown 渲染 | 聊天界面 — 图片生成 + 文件管理 |
|:--------------------:|:-------------------:|:----------------------:|
| <img src="docs/screenshots/chat-tool-tracking.png" width="280" /> | <img src="docs/screenshots/chat-markdown.png" width="280" /> | <img src="docs/screenshots/chat-image-gen.png" width="280" /> |

<details>
<summary>更多截图</summary>
<br/>

**设置向导**

| 创建管理员 | 配置接入（飞书 + Claude） |
|:--------:|:---------------------:|
| <img src="docs/screenshots/setup-wizard.png" width="400" /> | <img src="docs/screenshots/setup-providers.png" width="400" /> |

**移动端 PWA**

| 登录 | 工作区 | 系统监控 | 设置 |
|:---:|:-----:|:------:|:---:|
| <img src="docs/screenshots/mobile-login.png" width="180" /> | <img src="docs/screenshots/mobile-groups.png" width="180" /> | <img src="docs/screenshots/mobile-monitor.png" width="180" /> | <img src="docs/screenshots/mobile-settings.png" width="180" /> |

**飞书集成**

| Bot 聊天 | 富文本卡片回复 |
|:-------:|:----------:|
| <img src="docs/screenshots/feishu-chat.png" width="280" /> | <img src="docs/screenshots/feishu-card-reply.png" width="280" /> |

</details>

## HappyClaw 是什么

HappyClaw 是一个基于 [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) 构建的自托管多用户 AI Agent 系统。它将完整的 Claude Code 运行时封装为可通过飞书、Telegram、QQ、钉钉、微信和 Web 界面访问的服务，支持文件读写、终端操作、浏览器自动化、多轮推理及 MCP 工具生态。

核心设计原则：**不重新实现 Agent 能力，直接复用 Claude Code**。底层调用的是完整的 Claude Code CLI 运行时，而非 API Wrapper 或 Prompt Chain。Claude Code 的每次升级——新工具、更强的推理、更多的 MCP 支持——HappyClaw 零适配自动受益。

### 关键特性

- **原生 Claude Code 驱动** — 基于 Claude Agent SDK，底层为完整的 Claude Code CLI 运行时，继承其全部能力
- **多用户隔离** — Per-user 工作区、Per-user IM 通道、RBAC 权限体系、邀请码注册、审计日志，每个用户拥有独立的执行环境
- **六端消息统一路由** — 飞书 WebSocket 长连接（流式卡片 + Reaction）、Telegram Bot API、QQ Bot API v2、钉钉 Stream 协议、微信 iLink Bot API、Web 界面，六端消息统一路由
- **多提供商负载均衡** — 支持多个 Claude API 提供商，三种负载均衡策略（round-robin / weighted / failover），自动健康检测与恢复
- **计费与用量统计** — 完整的计费系统（订阅计划、钱包余额、兑换码），Per-model Token 用量追踪与图表可视化
- **移动端 PWA** — 针对移动端深度优化，支持一键安装到桌面，iOS / Android 均已适配

> 项目借鉴了 [OpenClaw](https://github.com/nicepkg/OpenClaw) 的容器化架构，并融合了 Claude Code 官方 [Cowork](https://github.com/anthropics/claude-code/tree/main/packages/cowork) 的多会话协作思路：多个独立 Agent 会话并行工作，各自拥有隔离的工作空间和持久记忆，结果通过 IM 渠道送达。

## 核心能力

### 多渠道接入

| 渠道 | 连接方式 | 消息格式 | 特色 |
|------|---------|---------|------|
| **飞书** | WebSocket 长连接 | 流式卡片（打字机效果） | 原生流式渲染、多卡片自动拆分、图片/文件下载到工作区、Reaction 反馈、群聊 @mention 控制 |
| **Telegram** | Bot API (Long Polling) | Markdown → HTML | 长消息自动分片（3800 字符）、图片走 Vision（base64）、文档文件自动下载到工作区 |
| **QQ** | WebSocket (Bot API v2) | 纯文本 | 私聊 + 群聊 @Bot、图片消息（Vision）、配对码绑定 |
| **钉钉** | Stream 协议长连接 | Markdown 卡片 | AI Card 流式打字机、消息去重（LRU 1000/30min TTL）、图片下载（downloadCode/contentUrl）、群聊 @mention 过滤 |
| **微信** | iLink Bot API (Long Polling) | 纯文本（2000 字符） | QR 码扫码配对、CDN 图片下载 + AES 解密、Typing 指示器、自动重连 |
| **Web** | WebSocket 实时通信 | 流式 Markdown | 图片粘贴/拖拽上传、虚拟滚动、Mermaid 图表渲染、图片 Lightbox |

每个用户可独立配置自己的 IM 通道（飞书应用凭据、Telegram Bot Token、QQ Bot 凭据、钉钉 Client ID/Secret、微信 iLink Token），互不干扰。消息统一路由：各渠道来源回各自渠道，Web 来源回 Web。


### 多提供商与负载均衡

支持配置多个 Claude API 提供商（Anthropic 官方、各类中转服务、Coding Plan），实现高可用部署：

- **三种负载均衡策略** — Round-Robin（轮询）、Weighted（加权）、Failover（主备切换）
- **自动健康检测** — 连续错误追踪（默认 3 次标记不健康），5 分钟自动恢复探测
- **Per-group 提供商切换** — 在监控页面可为每个工作区指定使用哪个提供商
- **OAuth 凭据支持** — 支持 Claude Code OAuth Token，兼容各类认证方式
- **活跃会话计数** — 实时显示每个提供商的并发使用量


### Agent 执行引擎

基于 [Claude Agent SDK](https://github.com/anthropics/claude-code/tree/main/packages/claude-agent-sdk) 构建，SDK 底层调用完整的 Claude Code CLI。

- **Per-user 主工作区** — 每个用户拥有一个固定的主工作区（admin 使用宿主机模式，member 使用容器模式），IM 消息路由到各自的主工作区
- **宿主机模式** — Agent 直接在宿主机运行，访问本地文件系统，零 Docker 依赖（admin 主工作区默认模式）
- **容器模式** — Docker 隔离执行，非 root 用户，预装 40+ 工具（member 主工作区默认模式）
- **多会话并发** — 最多 20 个容器 + 5 个宿主机进程同时运行，会话级队列调度
- **脚本任务** — 定时任务支持 Agent 和 Script 两种执行类型，Script 模式直接执行 shell 命令
- **自定义工作目录** — 每个会话可配置 `customCwd` 指向不同项目
- **失败自动恢复** — 指数退避重试（5s → 80s，最多 5 次），上下文溢出自动压缩并归档历史


### 多对话与 Agent 定义

在同一个工作区内支持多个独立对话，每个对话拥有独立的上下文和会话：

- **对话标签页** — 可拖拽排序的标签栏，支持创建、重命名、删除对话
- **Per-conversation IM 绑定** — 每个对话可独立绑定 IM 渠道
- **自定义 Agent 定义** — 创建自定义 SubAgent（如 code-reviewer、web-researcher），复用 Claude Agent SDK 的 agents 选项
- **独立会话持久化** — 每个对话维护独立的 Claude session，互不影响


### 实时流式体验

Agent 的思考和执行过程实时推送到前端，而非等待最终结果：

- **思考过程** — 可折叠的 Extended Thinking 面板，逐字推送
- **工具调用追踪** — 工具名称、执行耗时、嵌套层级、输入参数摘要
- **调用轨迹时间线** — 最近 30 条工具调用记录，快速回溯
- **Hook 执行状态** — PreToolUse / PostToolUse Hook 的启动、进度、结果
- **流式 Markdown 渲染** — GFM 表格、代码高亮、Mermaid 图表、图片 Lightbox
- **分享为图片** — 将消息导出为图片分享
- **飞书流式卡片** — 原生打字机效果（70ms/字符），三级降级链（Streaming → CardKit v1 → Legacy），多卡片自动拆分（约 45 个元素时拆分），100K 字符单元素支持
- **钉钉 AI Card** — 钉钉原生流式卡片，打字机效果实时推送


### 计费系统

<details>
<summary>完整的订阅与用量计费系统（点击展开）</summary>
<br/>

面向多用户部署场景的计费系统，支持灵活的计费模式：

- **订阅计划管理** — 管理员创建计费计划，设置价格、Token 配额、有效期
- **用户钱包** — 每个用户拥有独立余额，支持充值和消费
- **兑换码系统** — 创建兑换码，支持最大使用次数和过期时间
- **Per-model Token 追踪** — 精确到模型级别的 Token 用量记录（input/output/cache）
- **费用计算** — 基于模型定价自动计算费用（USD）
- **管理后台** — 计划 CRUD、用户余额管理、兑换码管理、计费审计日志
- **配额检查** — 请求前自动检查用户配额和余额，超额时阻止执行

</details>


### 用量统计

- **Token 用量分解** — 输入 Token、输出 Token、缓存读取/创建 Token 独立统计
- **费用计算** — 按模型自动计算费用，支持 USD 格式化
- **多维度筛选** — 按用户、模型、时间段（7/14/30/90 天）灵活筛选
- **图表可视化** — 柱状图和饼图展示用量趋势和分布
- **管理员视图** — 管理员可查看所有用户的用量数据


### 12 个 MCP 工具

Agent 在运行时可通过内置 MCP Server 与主进程通信：

| 工具 | 说明 |
|------|------|
| `send_message` | 运行期间即时发送消息给用户/群组 |
| `schedule_task` | 创建定时/周期/一次性任务（cron / interval / once） |
| `list_tasks` | 列出定时任务 |
| `pause_task` / `resume_task` / `cancel_task` | 暂停、恢复、取消任务 |
| `register_group` | 注册新群组（仅 admin 主工作区） |
| `install_skill` | 安装 Skill 到工作区（仅主工作区） |
| `uninstall_skill` | 卸载已安装的 Skill（仅主工作区） |
| `memory_append` | 追加时效性记忆到 `memory/YYYY-MM-DD.md` |
| `memory_search` | 全文检索工作区记忆文件 |
| `memory_get` | 读取记忆文件内容 |


### 定时任务

- **三种调度模式** — Cron 表达式 / 固定间隔 / 一次性执行
- **两种执行类型** — Agent（启动完整 Claude Agent）/ Script（直接执行 shell 命令）
- **两种上下文模式** — `group`（在指定会话中执行）/ `isolated`（独立隔离环境）
- **通知渠道** — 任务完成后可通知到指定 IM 渠道（飞书/Telegram/QQ/钉钉/微信）
- **完整的执行日志** — 耗时、状态、结果，Web 界面管理


### 记忆系统

Agent 自主维护跨会话的持久记忆：

- **用户全局记忆** — `data/groups/user-global/{userId}/CLAUDE.md`，每个用户独立的全局记忆，所有会话可读
- **会话记忆** — `data/groups/{folder}/CLAUDE.md`，会话私有
- **日期记忆** — `memory/YYYY-MM-DD.md`，时效性信息
- **对话归档** — PreCompact Hook 在上下文压缩前自动归档到 `conversations/`
- **全文检索** — Web 界面在线编辑 + 搜索


### 工作区级配置

每个工作区可独立配置自己的运行环境：

- **Per-workspace MCP Servers** — 为工作区添加 stdio 或 HTTP 类型的 MCP Server，独立于全局配置
- **Per-workspace Skills** — 为工作区安装特定 Skills，按需启用
- **Per-workspace 环境变量** — 群组级环境变量覆盖，优先级高于全局配置
- **共享工作区成员** — 多个用户可加入同一个工作区协作


### IM 绑定系统

灵活的 IM 渠道与工作区绑定机制：

- **工作区级绑定** — 将 IM 群组/私聊绑定到指定工作区或特定对话
- **飞书话题群映射** — 绑定飞书话题群后，每个话题自动映射为独立会话，拥有独立上下文，工作区切换为竖向话题列表导航
- **斜杠命令管理** — `/bind <target>` 绑定、`/unbind` 解绑、`/where` 查看当前绑定、`/new <名称>` 创建新工作区并绑定
- **Web 设置管理** — 在设置页面查看和管理所有 IM 绑定关系


### Skills 系统

- **项目级 Skills** — 放在 `container/skills/`，所有容器自动挂载
- **用户级 Skills** — 放在 `~/.claude/skills/`，所有容器自动挂载
- **工作区级 Skills** — 通过 Web 界面为特定工作区安装 Skills
- 无需重建镜像，volume 挂载 + 符号链接自动发现

### Web 终端

基于 xterm.js + node-pty 的完整终端：WebSocket 连接，可拖拽调整面板，直接在 Web 界面中操作容器。


### Docker 构建 UI

在 Web 监控页面一键构建 Docker 镜像，构建日志通过 WebSocket 实时流式推送，无需手动在终端执行。


### 移动端 PWA

专为移动端优化的 Progressive Web App，手机浏览器一键安装到桌面：

- **原生体验** — 全屏模式运行，独立的应用图标，视觉上与原生 App 无异
- **响应式布局** — 移动端优先设计，聊天界面、设置页面、监控面板均适配小屏幕
- **iOS / Android 适配** — 安全区域适配、滚动优化、字体渲染、触摸交互
- **随时可用** — 任何时间、任何地点，掏出手机就能与 AI Agent 对话、查看执行状态、管理任务


### 文件管理

- **完整文件浏览器** — 树状目录结构、文件类型图标
- **文件操作** — 上传（50MB 限制，支持拖拽）/ 下载 / 删除 / 创建目录
- **文件预览** — 文本文件在线查看、图片预览 + Lightbox、Markdown 渲染
- **安全防护** — 路径遍历防护 + 系统路径保护

### 安全与多用户

| 能力 | 说明 |
|------|------|
| **用户隔离** | 每个用户拥有独立的主工作区（`home-{userId}`）、工作目录、IM 通道 |
| **个性化设置** | 用户可自定义 AI 名称、头像 emoji / 颜色 / 上传图片 |
| **RBAC** | 5 种权限，4 种角色模板（admin_full / member_basic / ops_manager / user_admin） |
| **注册控制** | 开放注册 / 邀请码注册 / 关闭注册 |
| **审计日志** | 18 种事件类型，完整操作追踪 |
| **加密存储** | API 密钥 AES-256-GCM 加密，Web API 仅返回掩码值 |
| **挂载安全** | 白名单校验 + 黑名单模式匹配（`.ssh`、`.gnupg` 等敏感路径） |
| **终端权限** | 用户可访问自己容器的 Web 终端（宿主机模式不支持） |
| **登录保护** | 5 次失败锁定 15 分钟，bcrypt 12 轮，HMAC Cookie，30 天会话有效期 |
| **会话管理** | 查看和删除活跃登录会话，支持多设备管理 |
| **PWA** | 一键安装到手机桌面，移动端深度优化，随时随地使用 AI Agent |

## 快速开始

### 前置要求

开始之前，请确保以下依赖已安装：

**必需**

- **[Node.js](https://nodejs.org) >= 20** — 运行主服务和前端构建
  - macOS: `brew install node`
  - Linux: 参考 [NodeSource](https://github.com/nodesource/distributions) 或使用 `nvm`
  - Windows: [官网下载](https://nodejs.org)

- **[Docker](https://www.docker.com/)** — 容器模式运行 Agent（member 用户需要；admin 仅宿主机模式可不装）
  - macOS: 推荐 [OrbStack](https://orbstack.dev)（更轻量），也可用 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - Linux: `curl -fsSL https://get.docker.com | sh`
  - Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop/)

- **Claude API 密钥** — Anthropic 官方或兼容的中转服务(各种 Coding Plan)，启动后在 Web 界面中配置

**可选**

- 飞书企业自建应用凭据 — 仅飞书集成需要，前往 [飞书开放平台](https://open.feishu.cn) 创建
- Telegram Bot Token — 仅 Telegram 集成需要，通过 [@BotFather](https://t.me/BotFather) 获取
- QQ Bot 凭据 — 仅 QQ 集成需要，前往 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/index.html) 创建
- 钉钉 Bot 凭据 — 仅钉钉集成需要，前往 [钉钉开放平台](https://open.dingtalk.com) 创建
- 微信 iLink Bot Token — 仅微信集成需要

> Claude Code CLI 无需手动安装——项目依赖的 Claude Agent SDK 已内置完整的 CLI 运行时，`make start` 首次启动时自动安装。

### 安装启动

```bash
# 1. 克隆仓库
git clone https://github.com/riba2534/happyclaw.git
cd happyclaw

# 2. 一键启动（首次自动安装依赖 + 编译）
make start

访问： http://localhost:3000

如需公网访问，可以自行使用 nginx/caddy 配置反向代理
```

按照设置向导完成初始化：

1. **创建管理员** — 自定义用户名和密码（无默认账号）
2. **配置 Claude API** — 填入 API 密钥和模型（支持中转服务，可配置多个提供商）
3. **配置 IM 通道**（可选）— 飞书 / Telegram / QQ / 钉钉 / 微信
4. **开始对话** — 在 Web 聊天页面直接发送消息

> 所有配置通过 Web 界面完成，不依赖任何配置文件。API 密钥 AES-256-GCM 加密存储。


### 启用容器模式

admin 用户默认使用宿主机模式（无需 Docker），开箱即用。如果需要容器模式（member 用户注册后自动使用）：

```bash
# 构建容器镜像
./container/build.sh
```

新用户注册后会自动创建容器模式的主工作区（`home-{userId}`），无需额外配置。

### 配置飞书集成

1. 前往 [飞书开放平台](https://open.feishu.cn)，创建企业自建应用
2. 在应用的「事件订阅」中添加：`im.message.receive_v1`（接收消息）
3. 在应用的「权限管理」中开通以下权限：
   - `cardkit:card:write`（创建和更新卡片）
   - `im:chat`（获取与更新群组信息）
   - `im:chat:read`（获取群组信息）
   - `im:chat:readonly`（以应用身份读取群组信息）
   - `im:message`（发送消息）
   - `im:message.group_at_msg:readonly`（接收群聊 @消息）
   - `im:message.group_msg`（接收群聊所有消息）— **敏感权限**，需管理员审批。如不开通，群聊中只有 @机器人 的消息才会被处理
   - `im:message.p2p_msg:readonly`（接收私聊消息）
   - `im:resource`（获取与上传图片或文件资源）

   <details>
   <summary>权限 JSON（可直接导入飞书开放平台）</summary>

   ```json
   {
     "scopes": {
       "tenant": [
         "cardkit:card:write",
         "im:chat",
         "im:chat:read",
         "im:chat:readonly",
         "im:message",
         "im:message.group_at_msg:readonly",
         "im:message.group_msg",
         "im:message.p2p_msg:readonly",
         "im:resource"
       ],
       "user": []
     }
   }
   ```

   </details>

4. 发布应用版本并等待审批通过
5. 在 HappyClaw Web 界面的「设置 → IM 通道 → 飞书」中填入 App ID 和 App Secret

每个用户可在个人设置中独立配置飞书应用凭据，实现 per-user 的飞书 Bot。

> **群聊 Mention 控制**：默认群聊中需要 @机器人 才会响应。可通过 `/require_mention false` 命令切换为全量响应（需要 `im:message.group_msg` 权限）。

> **飞书话题群**：将飞书话题群（`chat_mode=topic` 或 `group_message_type=thread`）绑定到工作区后，每个话题自动创建独立的会话 Agent，拥有独立上下文和消息历史。Web 界面会切换为竖向话题列表，支持搜索和删除。解绑时自动清理所有话题会话。


### 配置 Telegram 集成

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 创建 Bot
2. 记录返回的 Bot Token
3. 在 HappyClaw Web 界面的「设置 → IM 通道 → Telegram」中填入 Bot Token
4. **群聊使用**：如需在 Telegram 群中使用 Bot，需在 BotFather 中发送 `/mybots` → 选择 Bot → Bot Settings → Group Privacy → Turn off，否则 Bot 只能接收 `/` 命令消息


### 配置 QQ 集成

1. 前往 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/index.html)，使用手机 QQ 扫码注册登录
2. 创建机器人，设置名称和头像
3. 在机器人管理页面获取 **App ID** 和 **App Secret**
4. 在 HappyClaw Web 界面的「设置 → IM 通道 → QQ」中填入 App ID 和 App Secret
5. **配对绑定**：在设置页生成配对码，然后在 QQ 中向 Bot 发送 `/pair <配对码>` 完成绑定

> QQ Bot 使用官方 API v2 协议，支持 C2C 私聊和群聊 @Bot 消息。群聊中 Bot 仅接收 @Bot 的消息。


### 配置钉钉集成

1. 前往 [钉钉开放平台](https://open.dingtalk.com)，创建企业内部应用
2. 在应用管理 → 机器人与消息推送 中，开启「机器人配置」
3. 选择 **Stream 模式**（非 HTTP 回调模式）接收消息
4. 获取应用的 **Client ID**（AppKey）和 **Client Secret**（AppSecret）
5. 在 HappyClaw Web 界面的「设置 → IM 通道 → 钉钉」中填入 Client ID 和 Client Secret

> 钉钉 Bot 支持单聊和群聊。群聊中需要 @机器人 才会响应。支持 AI Card 流式打字机效果。


### 配置微信集成

1. 在 HappyClaw Web 界面的「设置 → IM 通道 → 微信」中开启微信通道
2. 填入 iLink Bot Token
3. 点击「扫码配对」生成 QR 码
4. 使用微信扫描 QR 码完成绑定

> 微信消息长度限制为 2000 字符，超出部分自动分片发送。


### IM 斜杠命令

飞书/Telegram/QQ/钉钉/微信 中以 `/` 开头的消息会被拦截为斜杠命令（未知命令继续作为普通消息处理）：

| 命令 | 缩写 | 用途 |
|------|------|------|
| `/list` | `/ls` | 查看所有工作区和对话列表 |
| `/status` | - | 查看当前工作区/对话状态 |
| `/where` | - | 查看当前绑定位置和回复策略 |
| `/bind <target>` | - | 绑定到指定工作区或 Agent（如 `/bind myws` 或 `/bind myws/a3b`） |
| `/unbind` | - | 解绑回默认工作区 |
| `/new <名称>` | - | 创建新工作区并绑定当前群组 |
| `/recall` | `/rc` | AI 总结最近对话记录 |
| `/clear` | - | 清除当前对话的会话上下文 |
| `/require_mention` | - | 切换群聊响应模式：`true`（需要 @）或 `false`（全量响应） |


### 执行模式

| 模式 | 说明 | 适用对象 | 前置要求 |
|------|------|---------|---------|
| **宿主机模式** | Agent 直接在宿主机运行，访问本地文件系统 | admin 主工作区（`folder=main`） | Claude Agent SDK（自动安装） |
| **容器模式** | Agent 在 Docker 容器中隔离运行，预装 40+ 工具 | member 主工作区（`folder=home-{userId}`） | Docker Desktop + 构建镜像 |

admin 主工作区默认使用宿主机模式，member 注册后自动创建容器模式的主工作区。也可在 Web 界面的会话管理中手动切换执行模式。

### 容器工具链

容器镜像基于 `node:22-slim`，预装以下工具：

| 类别 | 工具 |
|------|------|
| AI / Agent | Claude Code CLI、Claude Agent SDK、MCP SDK |
| 浏览器自动化 | Chromium、agent-browser |
| 编程语言 | Node.js 22、Python 3、uv / uvx |
| 编译构建 | build-essential、cmake、pkg-config |
| 文本搜索 | ripgrep (`rg`)、fd-find (`fd`) |
| 多媒体处理 | ffmpeg、ImageMagick、Ghostscript、Graphviz |
| 文档转换 | Pandoc、poppler-utils（PDF 工具） |
| 数据库客户端 | SQLite3、MySQL Client、PostgreSQL Client、Redis Tools |
| 网络工具 | curl、wget、openssh-client、dnsutils |
| 飞书 CLI | feishu-cli（预编译二进制 + Skills） |
| Shell | Zsh + Oh My Zsh（ys 主题） |
| 其他 | git、jq、tree、shellcheck、zip/unzip |

## 技术架构

### 架构图

```mermaid
flowchart TD
    subgraph 接入层
        Feishu("飞书<br/>(WebSocket 长连接)")
        Telegram("Telegram<br/>(Bot API)")
        QQ("QQ<br/>(Bot API v2)")
        DingTalk("钉钉<br/>(Stream 长连接)")
        WeChat("微信<br/>(iLink Bot API)")
        Web("Web 界面<br/>(React 19 SPA)")
    end

    subgraph 主进程["主进程 (Node.js + Hono)"]
        Router["消息路由<br/>(2s 轮询 + 去重)"]
        Queue["并发队列<br/>(20 容器 + 5 宿主机进程)"]
        Scheduler["定时调度器<br/>(Cron / 间隔 / 一次性)"]
        WS["WebSocket Server<br/>(流式推送 + 终端)"]
        Auth["认证 & RBAC<br/>(bcrypt + HMAC Cookie)"]
        Config["配置管理<br/>(AES-256-GCM 加密)"]
        ProviderPool["提供商池<br/>(Round-Robin / Weighted / Failover)"]
        Billing["计费引擎<br/>(Plan + Wallet + Quota)"]
    end

    subgraph 执行层
        Host["宿主机进程<br/>(Claude Code CLI)"]
        Container["Docker 容器<br/>(agent-runner)"]
    end

    subgraph Agent["Agent 运行时"]
        SDK["Claude Agent SDK<br/>(query 循环)"]
        MCP["MCP Server<br/>(12 个工具)"]
        Stream["流式事件<br/>(14 种类型)"]
    end

    DB[("SQLite<br/>(WAL 模式)")]
    IPC["IPC 文件通道<br/>(原子读写)"]
    Memory["记忆系统<br/>(CLAUDE.md + memory/)"]

    Feishu --> Router
    Telegram --> Router
    QQ --> Router
    DingTalk --> Router
    WeChat --> Router
    Web --> Router

    Router --> Queue
    Queue --> ProviderPool
    ProviderPool --> Host
    ProviderPool --> Container
    Scheduler --> Queue
    Billing --> Queue

    Host --> SDK
    Container --> SDK
    SDK --> MCP
    SDK --> Stream

    MCP --> IPC
    IPC --> Router

    Stream --> WS
    WS --> Web

    Router --> DB
    Auth --> DB
    Billing --> DB
    SDK --> Memory

    class Feishu,Telegram,QQ,DingTalk,WeChat,Web fe
    class Router,Queue,Scheduler,WS,Auth,Config,ProviderPool,Billing svc
    class DB db
    class Host,Container faas
    class SDK,MCP,Stream faas
    class IPC cfg
    class Memory cfg
```

**数据流**：消息从接入层（6 个渠道）进入主进程，经去重和路由后分发到并发队列。队列通过提供商池选择 API 密钥，启动宿主机进程或 Docker 容器。容器内的 agent-runner 调用 Claude Agent SDK 的 `query()` 函数。流式事件（思考、文本、工具调用等 14 种类型）通过 stdout 标记协议传回主进程，再经 WebSocket 广播到 Web 客户端或通过 IM API 回复到各渠道。MCP Server 通过基于文件的 IPC 通道提供 12 个工具，实现 Agent 与主进程的双向通信。计费引擎在请求前检查配额和余额。

### 技术栈

| 层次 | 技术 |
|------|------|
| **后端** | Node.js 22 · TypeScript 5.9 · Hono · better-sqlite3 (WAL) · ws · node-pty · Pino · Zod 4 |
| **前端** | React 19 · Vite 6 · Zustand 5 · Tailwind CSS 4 · shadcn/ui · Radix UI · Lucide Icons · react-markdown · mermaid · recharts · @dnd-kit · xterm.js · @tanstack/react-virtual · PWA |
| **Agent** | Claude Agent SDK · Claude Code CLI · MCP SDK · IPC 文件通道 |
| **容器** | Docker (node:22-slim) · Chromium · agent-browser · Python · 40+ 预装工具 |
| **安全** | bcrypt (12 轮) · AES-256-GCM · HMAC Cookie · RBAC · 路径遍历防护 · 挂载白名单 |
| **IM 集成** | @larksuiteoapi/node-sdk (飞书) · grammY (Telegram) · QQ Bot API v2 · dingtalk-stream (钉钉) · iLink Bot API (微信) |

### 目录结构

所有运行时数据统一在 `data/` 目录下，启动时自动创建，无需手动初始化。

```
happyclaw/
├── src/                          # 后端源码
│   ├── index.ts                  #   入口：消息轮询、IPC 监听、容器生命周期
│   ├── web.ts                    #   Hono 应用、WebSocket、静态文件
│   ├── routes/                   #   17 个路由模块（auth / groups / files / config / monitor /
│   │                             #   memory / tasks / skills / admin / browse / agents /
│   │                             #   mcp-servers / billing / bug-report / usage /
│   │                             #   workspace-config / agent-definitions）
│   ├── feishu.ts                 #   飞书连接工厂（WebSocket 长连接）
│   ├── feishu-streaming-card.ts  #   飞书流式卡片（打字机效果 + 三级降级）
│   ├── telegram.ts               #   Telegram 连接工厂（Bot API）
│   ├── qq.ts                     #   QQ 连接工厂（Bot API v2 WebSocket）
│   ├── dingtalk.ts               #   钉钉连接工厂（Stream 协议长连接）
│   ├── dingtalk-streaming-card.ts#   钉钉 AI Card 流式控制器
│   ├── wechat.ts                 #   微信连接工厂（iLink Bot API）
│   ├── im-manager.ts             #   IM 连接池（per-user 五渠道连接管理）
│   ├── im-downloader.ts          #   IM 文件下载工具（保存到工作区 downloads/）
│   ├── container-runner.ts       #   Docker / 宿主机进程管理
│   ├── group-queue.ts            #   并发控制队列
│   ├── provider-pool.ts          #   多提供商负载均衡
│   ├── billing.ts                #   计费引擎（计划、钱包、配额）
│   ├── runtime-config.ts         #   AES-256-GCM 加密配置
│   ├── task-scheduler.ts         #   定时任务调度
│   ├── script-runner.ts          #   脚本任务执行器
│   ├── file-manager.ts           #   文件安全（路径遍历防护）
│   ├── mount-security.ts         #   挂载白名单 / 黑名单
│   └── db.ts                     #   SQLite 数据层（Schema v1→v33）
│
├── web/                          # 前端 (React + Vite)
│   └── src/
│       ├── pages/                #   17 个页面
│       ├── components/           #   UI 组件（chat / settings / billing / monitor / ...）
│       ├── stores/               #   14 个 Zustand Store
│       └── api/client.ts         #   统一 API 客户端
│
├── container/                    # Agent 容器
│   ├── Dockerfile                #   容器镜像定义
│   ├── build.sh                  #   构建脚本
│   ├── agent-runner/             #   容器内执行引擎
│   │   └── src/
│   │       ├── index.ts          #     Agent 主循环 + 流式事件
│   │       └── mcp-tools.ts      #     12 个 MCP 工具
│   └── skills/                   #   项目级 Skills
│
├── shared/                       # 跨项目共享类型定义
│   ├── stream-event.ts           #   StreamEvent 类型单一真相源（14 种事件）
│   ├── channel-prefixes.ts       #   IM 渠道前缀映射（5 个渠道）
│   └── image-detector.ts         #   图片 MIME 检测
│
├── scripts/                      # 构建辅助脚本
│   ├── sync-stream-event.sh      #   同步 shared/ 类型到各子项目
│   └── check-stream-event-sync.sh#   校验类型副本一致性
│
├── config/                       # 项目配置
│   ├── default-groups.json       #   预注册群组
│   ├── mount-allowlist.json      #   容器挂载白名单
│   └── global-claude-md.template.md # 全局 CLAUDE.md 模板
│
├── data/                         # 运行时数据（启动时自动创建）
│   ├── db/messages.db            #   SQLite 数据库（WAL 模式）
│   ├── groups/{folder}/          #   会话工作目录（Agent 可读写）
│   │   ├── downloads/{channel}/  #     IM 文件下载（feishu/telegram/qq/dingtalk，按日期分子目录）
│   │   └── CLAUDE.md             #     会话私有记忆
│   ├── groups/user-global/{id}/  #   用户全局记忆目录
│   ├── sessions/{folder}/.claude/#   Claude 会话持久化
│   ├── ipc/{folder}/             #   IPC 通道（input / messages / tasks）
│   ├── env/{folder}/env          #   容器环境变量文件
│   ├── memory/{folder}/          #   日期记忆
│   └── config/                   #   加密配置文件
│
└── Makefile                      # 常用命令
```

### 开发指南

```bash
make dev              # 前后端并行启动（热更新）
make dev-backend      # 仅启动后端
make dev-web          # 仅启动前端
make build            # 编译全部（后端 + 前端 + agent-runner）
make start            # 一键启动生产环境
make typecheck        # TypeScript 全量类型检查
make test             # 运行约束测试（vitest）
make format           # 代码格式化（Prettier）
make sync-types       # 同步 shared/ 类型定义到各子项目
make update-sdk       # 更新 agent-runner 的 Claude Agent SDK 到最新版本
make clean            # 清理构建产物
make reset-init       # 重置为首装状态（清空数据库、配置、工作区、记忆、会话）
make backup           # 备份运行时数据到 happyclaw-backup-{date}.tar.gz
make restore          # 从备份恢复数据（make restore 或 make restore FILE=xxx.tar.gz）
```

| 服务 | 默认端口 | 说明 |
|------|---------|------|
| 后端 | 3000 | Hono + WebSocket |
| 前端开发服务器 | 5173 | Vite，代理 `/api` 和 `/ws` 到后端（仅开发模式） |

#### 自定义端口

**生产模式**（`make start`）：只有后端服务，前端作为静态文件由后端托管，通过 `WEB_PORT` 环境变量修改端口：

```bash
WEB_PORT=8080 make start
# 访问 http://localhost:8080
```

**开发模式**（`make dev`）：前端 Vite 开发服务器（`5173`）和后端（`3000`）分别运行，开发时访问 `5173`。

修改后端端口：

```bash
# 后端改为 8080（通过环境变量）
WEB_PORT=8080 make dev-backend

# 前端需同步修改代理目标，否则 API 请求会发到默认的 3000
VITE_API_PROXY_TARGET=http://127.0.0.1:8080 VITE_WS_PROXY_TARGET=ws://127.0.0.1:8080 make dev-web
```

修改前端端口：通过 Vite CLI 参数覆盖：

```bash
cd web && npx vite --port 3001
```

### 环境变量

以下为可选覆盖项。推荐使用 Web 设置向导配置 Claude API 和 IM 凭据（加密存储）。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WEB_PORT` | `3000` | Web 服务端口 |
| `ASSISTANT_NAME` | `HappyClaw` | 助手显示名称 |
| `CONTAINER_IMAGE` | `happyclaw-agent:latest` | Agent 容器镜像 |
| `CONTAINER_TIMEOUT` | `1800000`（30min） | 容器硬超时（可通过 Web 设置覆盖） |
| `IDLE_TIMEOUT` | `1800000`（30min） | 容器空闲保活时长（可通过 Web 设置覆盖） |
| `MAX_CONCURRENT_CONTAINERS` | `20` | 最大并发容器数（可通过 Web 设置覆盖） |
| `MAX_CONCURRENT_HOST_PROCESSES` | `5` | 宿主机进程并发上限（可通过 Web 设置覆盖） |
| `TRUST_PROXY` | `false` | 信任反向代理的 `X-Forwarded-For` 头 |
| `TZ` | 系统时区 | 定时任务时区 |

> 更多运行参数（容器超时、并发限制、登录保护、计费设置等）可在 Web 界面「设置 → 系统设置」中配置，无需设置环境变量。

### 管理员密码恢复

```bash
npm run reset:admin -- <用户名> <新密码>
```

### 数据重置

```bash
make reset-init

# 或手动：
rm -rf data store groups
```

## 贡献

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. Fork 仓库并克隆到本地
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 开发并测试：`make dev` 启动开发环境，`make typecheck` 检查类型
4. 提交代码并推送到 Fork
5. 创建 Pull Request 到 `main` 分支

### Commit 规范

Commit message 使用简体中文，格式：`类型: 描述`

```
修复: 侧边栏下拉菜单无法点击
新增: Telegram Bot 集成
重构: 统一消息路由逻辑
```

### 项目结构

项目包含三个独立的 Node.js 项目，各有独立的 `package.json` 和 `tsconfig.json`：

| 项目 | 目录 | 用途 |
|------|------|------|
| 主服务 | `/`（根目录） | 后端服务（17 个路由模块） |
| Web 前端 | `web/` | React SPA（17 个页面、14 个 Store） |
| Agent Runner | `container/agent-runner/` | 容器/宿主机内执行引擎 |

此外，`shared/` 目录存放跨项目共享类型定义（StreamEvent、Channel Prefixes、Image Detector），构建时通过 `make sync-types` 同步到各子项目。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=riba2534/happyclaw&type=date&legend=top-left)](https://www.star-history.com/#riba2534/happyclaw&type=date&legend=top-left)

## 许可证

[MIT](LICENSE)
