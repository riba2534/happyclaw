# HappyClaw — 工程协作指南

本文档描述当前代码的工程约束和导航入口，供人类与 AI 协作者共同使用。

## 1. 文档与代码真相源

- 产品介绍、安装和常用操作：`README.md`
- 路由族与主要 Web API：`docs/API.md`
- 权限边界：`docs/ACL-MATRIX.md`
- 生产部署与回滚：`DEPLOYMENT.md`
- 运行时 Prompt：`container/agent-runner/prompts/`
- 数据库 Schema：`src/db.ts` 中的 `CURRENT_SCHEMA_VERSION` 与建表/迁移代码
- Web 路由：`web/src/App.tsx`
- 系统设置及默认值：`src/runtime-config.ts`
- 渠道能力与会话路由：`src/im-channel-capabilities.ts`、`src/channel-mount-service.ts`
- StreamEvent：`shared/stream-event.ts`
- 模型连接预设、模型列表解析与上游错误分类：`shared/model-providers.ts`
- 第三方代码与许可：`THIRD_PARTY_NOTICES.md`

`docs/agent-first-architecture-plan.md` 和
`docs/claude-code-plugin-automation-design.md` 是历史设计记录，不作为当前接口或数据结构的真相源。

## 2. 产品模型

HappyClaw 是基于 Claude Agent SDK 的自托管、多用户 Agent 工作台，支持 Web 与飞书、
Telegram、QQ、钉钉、微信、企业微信、Discord、WhatsApp。

当前产品层级：

```text
Agent Profile（身份、四段 Prompt、能力策略）
└── Workspace（文件目录、执行模式、环境变量、话题群绑定）
    ├── Main Session（可绑定私聊或普通群）
    ├── Runtime Session（独立 Claude 上下文，可绑定私聊或普通群；Host 工作区可选独立 git worktree）
    ├── Native Context Session（飞书话题等原生线程）
    └── Automation（自动化：按计划把提示词作为真实的一轮发进会话）
```

重要命名边界：

- `agent_profiles` 是产品级 Agent。
- `registered_groups` 是当前兼容层中的工作区和渠道路由记录。
- `agents` 表及 `/api/groups/:jid/agents` 是历史命名，实际表示工作区内的运行会话，
  不是产品级 Agent Profile。
- 同一个 Workspace 内的会话共享工作区文件目录，但拥有独立 Claude Session；
  工作区文件隔离与对话上下文隔离是两件事。
- 自动化（Automation）属于 Workspace，每次运行都是某个真实会话里的一轮：绑定已有会话
  （Agent 在聊天里创建时默认绑定当前会话）、每次新建或持续会话。运行会话是普通
  `agents` 行（`source_kind='automation'`、`automation_id`），不是 `kind='task'`。
- 例外是独立 worktree 的 Runtime Session：Host 工作区的工作目录是 git 仓库时，新建会话
  可选它，宿主在 `data/worktrees/{folder}/{sessionId}` 建分支 `happyclaw/<短 id>`，该会话
  每轮以它为 cwd，文件面板、项目 Skills 和 Review 面板也以它为根。worktree 缺失或损坏时
  运行失败，不回退到主仓库；删除会话时移除 worktree、保留分支，有未提交改动或已初始化的
  子模块时须确认。同一目录上同时有别的会话在跑时，对话页提示但不阻塞。

## 3. 主要模块

### 3.1 主服务

| 文件/目录                          | 职责                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `src/index.ts`                     | 启动、消息消费、渠道路由、IPC、调度与 Agent 运行编排   |
| `src/web.ts`                       | Hono 应用、路由挂载、Cookie 认证、WebSocket 与静态资源 |
| `src/db.ts`                        | SQLite Schema、迁移和持久化访问器                      |
| `src/group-queue.ts`               | Session 串行、Runner 生命周期、重试与容量控制          |
| `src/container-runner.ts`          | Host/Container Runner、挂载、环境与能力快照            |
| `src/automation-runtime.ts`        | 自动化运行接入会话：注入输入、终态回写、Agent 工具 IPC |
| `src/channel-mount-service.ts`     | 工作区/会话绑定和原生线程路由                          |
| `src/channel-reliability-store.ts` | Inbox、Turn、Outbox、Streaming Card 的持久状态机       |
| `src/im-manager.ts`                | 多用户、多账号渠道连接池                               |
| `src/agent-capability-preview.ts`  | Agent 最终上下文和能力预览                             |
| `src/claude-context-resolver.ts`   | Claude 上下文、Skills 与来源解析                       |
| `src/session-worktree.ts`          | 会话 worktree、工作区项目根与清理                      |
| `src/git-review.ts`                | Review 面板的只读 git 状态与单文件 diff                |
| `src/usage-limit-wait.ts`          | 撞用量上限后的等待与自动继续                           |
| `src/automation-scheduler.ts`      | 自动化的到期触发、前置检查、错过与重启恢复             |
| `src/automation-service.ts`        | 自动化的校验、权限，REST 与 Agent 工具共用             |
| `src/memory-service.ts`            | Workspace Memory 召回、目录、提议与审计                |

渠道实现位于：

- `src/feishu.ts`
- `src/telegram.ts`
- `src/qq.ts`
- `src/dingtalk.ts`
- `src/wechat.ts`
- `src/wecom.ts`、`src/wecom-streaming.ts`
- `src/discord.ts`
- `src/whatsapp.ts`

HTTP 路由位于 `src/routes/`，完整模块索引见 `docs/API.md`。

### 3.2 Web

Web 位于 `web/`，使用 React 19、Vite、Tailwind CSS 4、React Router、Zustand 和
Radix UI。路由以 `web/src/App.tsx` 为准：

| 路径                      | 用途                                  |
| ------------------------- | ------------------------------------- |
| `/setup`                  | 首个管理员初始化                      |
| `/setup/providers`        | Provider 引导                         |
| `/setup/channels`         | 用户渠道引导                          |
| `/login`、`/register`     | 登录和注册                            |
| `/chat/:groupFolder?`     | 工作台与会话                          |
| `/agent-profiles`         | Agent 管理                            |
| `/capabilities/:section?` | Skills、MCP、Plugins                  |
| `/automations`            | 自动化                                |
| `/usage`、`/billing`      | 用量与计费                            |
| `/memory`                 | 记忆管理                              |
| `/settings`               | 账户和系统设置                        |
| `/monitor`                | 运行状态，需要 `manage_system_config` |
| `/users`                  | 用户、邀请和审计管理                  |

`/groups`、`/tasks`、`/skills`、`/mcp-servers` 和 `/plugins` 是兼容重定向，不应新增独立页面。

桌面端外壳是一条可拖宽、可折叠（⌘B）的侧栏加嵌入式页面画布；侧栏包含导航和
工作区 → 会话树，⌘K 打开命令面板。手机（`phone:`，触屏且窄于 1024px）由左上角
汉堡菜单打开左侧抽屉导航；首页是一级列表（工作区标题下直接列出会话，可折叠），右下角
按钮在默认工作区新建对话，`?sessions=1` 重定向到该列表并展开对应工作区。窄桌面窗口
仍使用底部导航和独立的工作区/会话列表。手机上其他页面在 AppLayout 的单行顶栏里用
`PhonePageHeader` 声明标题、一个主操作和 ⋯ 菜单；设置页是"分组列表 → 子页"
（`?tab=`）。

Web UI 约定：

- 三套配色（teal / orange / neutral）× 亮暗模式的色值只在 `globals.css` 的方案块中定义；
  层级色（`app-shell`、`surface-raised`、`surface-hover`、`surface-selected`、
  `surface-border`、`faint-foreground`）和阴影由这些色值派生，组件不得写死调色板颜色。
- 字号使用角色化 token（`text-micro`、`text-caption`、`text-label`、`text-body`、
  `text-body-lg`、`text-title*`、`text-display*`）；状态用 `Badge` 变体或语义色
  （`success`、`warning`、`error`）。
- 优先复用 `components/ui` 原语和 `components/common` 组合组件（`PageContainer`、
  `PageHeader`、`ListRow`、`DataTable`、`IconButton`、`SegmentedControl` 等），
  设置类页面使用 `components/settings/SettingsLayout`。
- 破坏性确认使用 `confirmDialog()`；未保存离开守卫保持同步的原生 `confirm()`。
- 手机端由原语统一处理：`Dialog` 渲染为底部 Sheet 且默认不自动聚焦（单字段用
  `autoFocusOnPhone`），`Sheet`/`Dialog` 和导航抽屉经 `useBackDismiss` 让系统返回先关
  浮层；行和页面的操作菜单用 `ResponsiveMenu`（手机为 ActionSheet），只在 Tooltip 里的
  信息用 `InfoTip`；按钮在手机上自带 44px 命中区，输入框不小于 16px（`variant="code"`
  关闭自动大写与纠错）。键盘遮挡只读 `--keyboard-inset` / `--vvh`（`useVisualViewport`）。
- 快捷键在 `lib/shortcuts.ts` 注册并用 `Shortcut` 渲染键帽；动画用 `motion` 的 `m.*`，
  经 `MotionProvider` 懒加载并遵循减少动态效果设置。流式回复的贴底跟随（每批一次的
  WAAPI 位移补偿）和逐词淡入（CSS keyframes）是逐帧、逐词的热路径，不走 `m.*`，
  同样在减少动态效果时关闭。
- 聊天输入框是 Tiptap 编辑器（`@tiptap/*` 全部精确锁同一版本）。编辑器内核（结构化列表、
  中文标点与选区修补、长粘贴折叠块、序列化）取自 cindy，位于
  `components/chat/composer/cindy/`，按 Apache-2.0 保留来源与修改声明；外层
  `MessageInput` 和 `components/chat/composer/` 是 HappyClaw 自己的，回车、排队、插话
  语义见 §4。`/` 面板插入 `/技能名`：HappyClaw 的消息信封让 CLI 不会直接展开斜杠命令，
  由模型调用 Skill 工具；`@` 选中的文件序列化为 `@"工作区相对路径"`，由 CLI 自动附带。
  为此消息正文在 `<message>` 内另起一行、不转义引号（属性值照常转义）。

### 3.3 Agent Runner

`container/agent-runner/` 同时服务 Host 和 Container 两种执行模式：

- stdin 接收 `ContainerInput`。
- stdout 使用 `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` 输出结构化结果。
- 后续消息、工具请求和关闭控制通过独立 IPC 目录传递。
- `container/agent-runner/prompts/` 中的 Prompt 在启动时加载。
- HappyClaw MCP 工具由 `container/agent-runner/src/mcp-tools.ts` 注册。
- `shared/stream-event.ts` 同步到主服务、Web 和 Runner。

不要在文档中维护固定的 MCP 工具数量或 StreamEvent 数量；它们会随能力演进变化，
应直接查看类型与注册代码。

## 4. 执行和并发

| 模式      | 行为                                                          | 容量边界                                             |
| --------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Host      | Runner 作为宿主机 Node 进程运行，`customCwd` 直接作为工作目录 | 同一 Session 串行；不同 Session 不设置应用层并发上限 |
| Container | Runner 在非 root Docker 容器运行，通过只读/读写挂载访问资源   | 受 `maxConcurrentContainers` 和用户计费配额限制      |

共同约束：

- 同一序列化键内的消息保持顺序。
- 不同飞书话题、不同 Runtime Session 使用不同序列化键，可以并发。
- Agent loop 运行期间到达的普通消息（Web 与全部 IM 渠道）逐条进入可见、可编辑和可排序的 durable 队列；
  当前 loop 自然结束后，调度器原子快照当时剩余的普通队列，并将其作为一个批次交给
  下一轮 Agent。Web 与飞书等渠道共用这套 Workspace/Session 级语义。
- 显式“发送”或 `steer` 是优先屏障：它中断当前 loop，与它之前已排队的普通消息按可见
  顺序一起进入下一轮；之后才到达的普通消息不会被吞并，留到再下一轮合批。
- 普通消息使用明确的队列状态；失败采用有界指数退避。
- 中断分两类。显式停止（`/break`、Web 与飞书卡片的停止按钮、飞书撤回）在 `_interrupt`
  之外再写 `_interrupt_reason`（`{"queryId","reason":"stop"}`，两个文件都以临时文件加
  rename 写入）；`/steer`、「发送」、没有原因的旧信号，以及撞额度、换模型、模型上限、子代理
  provider 错误、关停等内部中断只调用 `interrupt()`。CLI 的 `interrupt()` 本身就会停掉运行
  中的子 Agent；Runner 从不调用 `stopTask`，因为它会把停止通知排成新的隐藏计费轮次，并一直
  等后台 shell 退出。显式停止后（包括先 steer 再停止）3 秒仍有主 Agent 直接启动的子 Agent
  （任务类型 `local_agent`、`remote_agent`、`in_process_teammate`、`local_workflow`）未结清时
  `close()` 兜底；shell、监视器、MCP 任务、未知类型和嵌套子 Agent 不计入。CLI 里已排队后续
  输入时立即 `close()`。
- `CONTAINER_TIMEOUT` 是 Runner 的无输出看门狗：每次有输出都重新计时，超过它（再加 15 秒
  关闭宽限）仍没有任何输出才判定超时，不是单次运行的总时长上限；`IDLE_TIMEOUT` 控制暖
  Runner 的空闲保留时间。
- Container 名额只按执行中的 Runner 计：已达 `maxConcurrentContainers` 且有会话在等时，
  回收空闲最久、没有在途 IPC、后台任务、待续写和排队输入的暖容器。Host Runner 不受影响。
- 可用连接都撞了用量上限且上游给出重置时刻时，输入连同该会话已排队的输入放回 durable
  队列，在重置后 60 秒加 0–30 秒抖动自动继续（WS `usage_limit_wait`）；同一输入最多连续
  等待 3 次、单次不超过 7 天，超出按原逻辑失败。只看本轮绑定的那一个连接。新消息或「立即发送」结束等待并合批；`/break`、取消、`/clear`、
  `/fresh`、删除取消等待。等待期间不占 Runner 或容器名额。
- 自动化到期时，调度器在一个事务里写运行记录并推进下次触发，再把提示词作为合成输入
  （`source_kind='automation_prompt'`、`messages.automation_run_id`）写进目标会话的
  durable 队列：排在活跃轮次和已排队输入之后，不 steer，不与用户消息或别的运行合批；
  回复按这条输入的 `source_jid`（创建时冻结的来源路由，例如飞书话题）投递。Agent 看到的
  运行上下文（自动化 id、计划、停止条件、无人值守、安静模式）作为附件里的隐藏条目存在
  这条输入上，追加在用户消息之后，不进 system prompt；Web 只显示提示词本身。
- 同一自动化同时最多一个运行；到期时上一次还在排队或运行，本次记为 `skipped`。服务停机
  期间到期的周期运行不补跑，记一条 `missed` 并从现在起算下次；一次性的仍会补跑。
  `endAt` 到达或 Agent 调用 `automation_complete` 后状态为 `completed`。
- 前置检查和脚本只用于管理员的 Host 工作区：`/bin/sh -c`，环境变量白名单，默认超时
  60 秒；退出码 0 执行、2 跳过（不耗 token）、其他记失败。脚本与 Agent 轮次共用
  `CONTAINER_TIMEOUT` 无输出看门狗，不设置独立并发池。
- 撞用量上限时，自动化输入与其他输入一样留在 durable 队列里等待，运行保持 `queued`。
  安静模式（`silentWhenIdle`）下没有发现变化的成功运行生为已读、不向 IM 投递；失败
  总是通知，同一错误连续失败只通知一次，恢复成功后通知一次「已恢复」。
- 后台子代理未结清时 Runner 扣住本轮结果，游标不前进，重启后整轮重跑。子代理（Task）
  的启动、终态和最终答复按发起它的输入写入 `subagent_checkpoints`；重跑同一输入时
  这些断点作为上下文回注给主 Agent：已完成的直接汇总，未完成的标明中断，部署、迁移、
  推送等非幂等操作要求先核实实际状态。宿主不会自动重跑任何子任务。
- 主 Agent 已答复、只剩后台任务（子代理、shell、监视器）扣住本轮时，这一轮对调度器
  算作自然结束（Runner 结果带 `backgroundOnly`）：排队输入立即作为新一轮写进同一个 SDK
  流，不 steer、不 `interrupt()`/`close()`，后台任务继续跑，完成通知之后照常到达主 Agent。
  新输入在 CLI 里开始（`command_lifecycle` `started`）时，Runner 无新正文地结算被扣住的
  输入（`backgroundHandoff`，挂起卡定稿、游标前进），后台任务及其汇总转由新输入承接并
  继续扣住它；此后崩溃只重跑新输入，前一输入的子代理不再重跑。此期间宿主没有在途查询，
  显式停止（`/break`、停止按钮、飞书撤回）仍按该查询中断并停掉后台子代理；「发送」与
  `/steer` 不会中断它们。主 Agent 正忙时的 steer 仍会中断当前轮，CLI 照旧停掉子代理。
- 一轮成功结束、最后一次模型响应只有思考而没有正文（静默停止）时，Claude Code 会先在
  轮内自行补问一次；仍无正文时 Runner 在同一 SDK 流里再要一次答复，每条输入最多一次。
  主动模式、已有后续输入排队、后台任务未结清时不续写。
- Runner 的生产诊断日志以 `[agent-runner:info]` / `[agent-runner:warn]` 前缀写入主服务
  日志：每次 `query()` 的启动耗时 `[query-timing]`（info），空回复形态 `[reply-shape]`、
  静默停止 `[silent-stop]` 和疑似工具调用循环 `[tool-loop]`（warn，只记录不中断）。

Host 模式没有 `maxConcurrentHostProcesses`。旧客户端提交该字段时后端仅为兼容而忽略，
不得重新把它实现为全局 Host 并发池。

## 5. Agent Prompt 与能力

自定义 Agent 使用四段 Prompt：

- `IDENTITY`：身份、使命和边界。
- `SOUL`：稳定价值观、判断原则和表达风格，可为空。
- `AGENTS`：工作流、输入输出、默认值、分支和失败处理。
- `TOOLS`：Skill、MCP 和工具的选择方式与限制，可为空。

System prompt 是 Claude Code preset（`prompt_mode=append`，主动模式除外）加 HappyClaw
的 PromptPlan。PromptPlan 的第一块是引擎层：带 preset 时为 `runtime-adaptation`，说明
preset 里终端编程 CLI 的假设（身份、请求范围、渲染、篇幅、`/help`）在 HappyClaw 中怎么
改；不带 preset 时为 `runtime-baseline`，补上 preset 原本给的工作基础。Agent 提示词取代
preset 的身份和默认风格，只低于平台的安全、权限、工具和交付规则。preset 原文由
`tests/fixtures/claude-code-preset.txt` 固定。

运行时能力不是简单拼接文本：

1. `claude-context-resolver` 解析 managed 或 `host_claude` 上下文。
2. Effective Skill/MCP Resolver 生成精确清单与 hash。
3. Container 模式逐个只读挂载选中的 Skill。
4. Host 模式也使用同步后的 Session `.claude` 目录和相同能力清单。
5. Plugin 使用用户版本化 runtime snapshot，通过 SDK `options.plugins` 注入。
6. PromptPlan 和 ContextBudget 记录最终上下文来源与预算。

规则：

- Agent 工具权限保持开放；不要虚构只读或受限工具模式。唯一例外是 Claude Code
  内置、依赖 CLI 进程常驻或交互审批的会话级工具（`CronCreate`/`CronDelete`/`CronList`、
  `ScheduleWakeup`、`EnterWorktree`/`ExitWorktree`、`EnterPlanMode`/`ExitPlanMode`）：
  Runner 每轮结束会关闭 CLI，这些承诺会静默丢失，计划模式也等不到审批，因此默认禁用，
  并设置 `CLAUDE_CODE_DISABLE_CRON=1` 关闭 CLI 自带的定时调度；定时需求走 HappyClaw
  的自动化（`automation_*` 工具）。
- Runner 安装 `canUseTool`（`builtin-tool-policy.ts`），CLI 才会注册
  AskUserQuestion；普通调用仍由 `bypassPermissions` 直接放行，不经过它，其余请求人工
  确认的调用（如 Hook 返回 `ask`）与没有它时一样被拒绝。Runner 没有交互作答通道：
  AskUserQuestion 立即以「已向用户展示、下一条消息作答」的结果返回，模型在回复里复述
  问题和选项后结束本轮；Web 卡片和飞书按钮只是作答捷径，用户的回答作为下一条消息到达。
  只有主 Agent 能提问：子代理（`agentID` 非空）的 AskUserQuestion 被拒绝，要求它把
  问题交回主 Agent，Runner 也不把它的问题推给 Web 或飞书卡片；当前 CLI 本身就不给
  子代理这个工具。
- 一次运行绑定的模型配置按固定顺序解析（`container-runner.ts` 的
  `resolveModelBinding`）：会话手选 → 智能体自己的绑定 → 工作区自带的 Provider
  环境变量 → 所有者的主智能体（默认 profile）→ 系统主 HappyClaw（最早创建的 admin
  的默认 profile）。未设置的一步跳过；会话手选的连接失效时回到默认；智能体与主智能体
  的绑定一旦设置就是权威，连接已删除或没有凭据时本轮失败并提示，不改用别的连接；
  一步都没有时同样失败，不落到任意连接。没有全局默认、自动池和启用开关；Web 的选择器
  与这一顺序共用同一个函数。
- 推理等级按会话手选 → 智能体显式档位 → 模型默认档位解析，只取该模型支持的档位，
  不支持档位的模型不下发；不存在默认 `max`。模型支持哪些档位见
  `resolveModelCapabilities`（`shared/model-providers.ts`）：连接上声明的 → 能力表 →
  同系列推断（如 `gpt-6.1-terra` 取 `gpt-6.1-sol`）→ 无。ChatGPT 订阅连接仍用账号目录。
- HappyClaw 拥有的 Claude 环境（后端开关、端点、凭据、模型层级、会话的 effort/压缩/
  上下文，清单在 `shared/claude-provider-env.ts`）不取自宿主进程继承的环境，也从管理员
  的 settings 层剔除（连同 `apiKeyHelper` 等取凭据的命令），不会写进挂载给 Agent 的会话
  settings。Runner 再把 HappyClaw 设置了的值写进 flag settings，压过管理员、项目和
  local 的 settings 文件；后端开关一律写 `0`（除非连接打开），并关闭 `apiKeyHelper`。
  未被 HappyClaw 设置的键（例如官方连接的 `ANTHROPIC_BASE_URL`）仍可由工作区 cwd 下的
  项目/local settings 文件设置：Host 模式下那是管理员自己的仓库，Container 模式下所有者
  本就能读到该连接的凭据。
- 渠道格式说明随每轮的 `<channel_context>` 发送，不进 system prompt；换渠道或每十轮
  重发一次，在被替换或撤回前一直有效。
- 一个模型配置（连接）是一份凭据、一个地址和一组模型；设置页只添加和维护连接，选哪个
  模型属于智能体和会话。会话和智能体按「连接 · 模型」选择
  （`session_model_selections.model`、`agent_profiles.model`），换模型时开新的 SDK
  会话并注入近期历史。模型条目存上游原名、上下文长度和声明的档位，新写入的模型名里不带
  `[1m]`（旧数据里的 `[1m]` 仍表示 1M）：`[1m]` 是 Claude Code 的开关（请求前剥掉，只把上下文上限抬到 1M；不认识的
  模型上限 200K，`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 只能往下压），运行时按上下文长度
  推导，大于 200K 才加，再用压缩窗口压回实际长度（`buildConnectionModelEnv`）；只用
  条目上声明的长度，能力表里的长度只作为添加时的预填值，不会自行打开 `[1m]`。只改
  上下文长度不算换模型。子代理、后台轻量调用和 opus/sonnet 档由连接的 `roles` 从同一
  连接的模型里选，未设置时跟随本轮模型。连接环境变量只注入用户保存的非空值，新连接预填
  `API_TIMEOUT_MS`、`CLAUDE_CODE_NO_FLICKER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`；
  模型相关的键（`CONNECTION_MODEL_ENV_KEYS`）不接受自由填写。这些都存在 V5 配置文件的
  可选字段里，不升文件版本。测试连接和获取模型列表只有在上游确实接受了凭据时才记录
  认证头方式。
- 宿主机 Skills 由 `runtime_policy.skills.host` 独立选择，不能通过
  `host_claude` 开关隐式获得；每个智能体都存显式值，新建、复制、导入一律写显式值。
- 工作区 `CLAUDE.md`、项目 `.claude/skills` 和项目 MCP 属于项目上下文层。项目根按 CLI
  的规则从工作目录向上找到 git 根（Host 自定义目录与会话 worktree 同样适用），运行时、
  能力预览和工作区设置共用这个根；Host 自定义目录的 `.mcp.json` 因此会被加载。
- Skill、MCP、Plugin 变更会停相关 Runner 并开新 SDK 会话，下一轮自动补注近期历史；
  运行中的 Agent 自己调用 `install_skill` 时，本轮结果送达后才重置。安装、卸载 Skill
  只接受工作区主人亲自发起的轮次。
- Workspace Memory 只有整批输入都来自工作区主人的互动轮次才直接写入；群成员轮次与自动化
  运行的写入存为 `proposed`，在记忆页确认后才参与召回。每轮按用户本人正文的词项召回
  相关条目（`workspace_memory_recall_fts`），全部条目的标题目录随每轮笔记增量注入。
- 禁用、删除或缺失的精确选择能力必须让配置失败，不得静默替换。
- Prompt 或能力身份变化后必须失效旧的暖 Runner。

内置 Skills 由 `scripts/install-host-tools.sh` 固定版本下载到
`data/builtin-skills/`，并由 `scripts/builtin-skill-catalog.mjs` 校验清单和 payload hash。
仓库不再维护或注入另一套容器内未治理 Skills。

## 6. 渠道、账号和上下文

### 6.1 多账号

- 每个用户可以为同一 Provider 创建多个 `channel_accounts`。
- 每个渠道 JID 和 mount 都携带 `channel_account_id`，发送时使用绑定账号的机器人身份。
- 账号可以设置默认工作区；恢复默认绑定时先解析账号归属，不能跨用户或跨账号回退。
- 同一工作区可以绑定多个机器人账号和多个群聊。
- 飞书账号区分飞书与 Lark（国际版）品牌，存于账号 secret 的 `domain`；所有到平台的
  请求、长连接、CLI 与深链按品牌取 host（`src/feishu-domain.ts`）。账号可手填凭证，
  也可扫码一键创建应用（device-code，`src/feishu-app-registration.ts`），后者直接
  得到 owner open_id。同一 App 的长连接被别处占用时，账号状态记为 `error` 并说明原因。

### 6.2 绑定边界

绑定接受规则以 `conversationBindingPolicyError()`（`src/channel-conversation-kind.ts`）
为准，业务含义见 `docs/BUSINESS-MODEL.md`：

- 工作区绑定只接受原生话题群（飞书话题群、Telegram Forum），路由为 `thread_map`。
- Runtime Session 绑定接受私聊和普通群，可以绑定 Main Session。
- 会话类型无法确定时拒绝绑定，不猜测。
- Session 只能在工作区（`web:*` JID）下创建；`POST /api/groups/:jid/sessions`
  （及兼容别名 `/agents`）拒绝 IM 聊天 JID。`#agent:` 是逻辑会话地址，不是发送目标，
  宿主在任何连接器调用前拒绝把它当作 IM 路由。

回复归属按每条输入确定，不存在“首个原生渠道占有 Session”的持久化：

- 每条输入携带自己的来源与 `ChannelTurnContext`；流式卡片、`send_message`、
  最终答复与延迟回调都回到这条输入的来源。
- Web 输入只回到 Web，不因 Session 同时绑定 IM 而自动发往 IM；不同来源的输入
  不合并成只有单一回复目标的批次。
- 文件和图片投递必须使用当前 Turn 的 `ChannelTurnContext`，不能从“最近一条群消息”
  猜测目标。
- 主动模式下 Agent 用 `send_message(delivery_role=progress)` 发的进展，按这一轮输入自己的
  来源渠道路由：IM 来源作为独立消息发出（IM 无法折叠），没有可用路由时以
  `native_route_unavailable` 拒绝，绝不转进 Web；Web 来源进入过程视图，在
  `process_visibility` 的所有级别都显示（运行快照 `stream_snapshot.progress` 让新标签页和
  重连也能看到），最终回复送达后随过程折叠，并随回合存进 turn_traces（`hidden` 级别只存
  进展）。发过进展的 Web 轮次被停止、出错或因缺少 final 而终止时，宿主写一条收尾片段
  （`interrupt_partial`）承载这些进展。没有 inputTurnId 的进展与 main 一致直接作为消息
  发出。工具调用前的旁白仍只在 `full` 显示。

### 6.3 飞书会话语义

触发方式与响应对象互相独立：

- `activation_mode=always`：无需 @。
- `activation_mode=when_mentioned`：需要 @ 才激活。
- `activation_mode=disabled`：暂停响应。
- `audience_mode=everyone`：允许所有成员。
- `audience_mode=owner_only`：只允许已记录的主人。

普通飞书群：

- 整个群共享已绑定的那一个 Session（可以是 Main Session）。
- `always` 与 `when_mentioned` 只决定消息是否需要 @ 才激活；提及或激活策略
  不会为普通群新建话题 Session，也不会把它变成工作区绑定。
- 引用回复（带 root_id 但没有 thread_id，私聊同样）在主聊天作答，不在被引用消息下
  开话题；被引用内容作为引用上下文交给 Agent。普通群里真实话题内的消息仍回到该话题。

飞书话题群：

- 绑定到工作区；每个原生话题拥有独立 Runtime Session，同一话题复用其 Session。
- `always` 与 `when_mentioned` 只决定话题是否需要首次激活，不合并不同话题上下文。

飞书卡片上的 AskUserQuestion 单选按钮：点击等同点击者在该聊天/话题发出所选项文本，
走正常入站管线（受众、owner、激活检查照旧，命令不解析），重复点击幂等；本轮结束后的
终态卡片保留按钮。

Telegram 默认流式：回复期间约每 1.5 秒编辑一条进度消息，结束后另发最终答复并删除
进度消息；账号选项 `streamingMode: 'off'` 关闭。用户回复某条消息时，被回复内容作为
引用上下文交给 Agent（受保护内容、服务消息与话题隐式回复除外）。

原生上下文映射持久化在 `im_context_bindings`。工作区群聊挂载使用
`channel_mounts`，Agent/会话挂载使用 `agent_channel_mounts`；兼容字段仍双写，
迁移期间不得只更新其中一侧。

### 6.4 IM 命令

当前命令由 `src/index.ts` 的 `handleCommand()` 分发：

- 只读：`/list`、`/ls`、`/status`、`/where`、`/recall`、`/rc`、`/allowlist`
- 变更：`/clear`、`/fresh`、`/bind`、`/unbind`、`/new`、`/sw`、`/spawn`
- Owner：`/owner_mention`、`/release_owner`、`/allow`、`/disallow`
- 激活：`/require_mention`

破坏性命令受 `OWNER_REQUIRED_IM_COMMANDS` 和渠道原生 sender ID 约束。
响应对象策略不能因服务重启、同步聊天或恢复绑定而回退成默认值。所有支持群聊的渠道
（飞书、企微、Telegram、QQ、钉钉、Discord、WhatsApp）都按 `src/im-group-audience.ts`
执行同一响应对象语义：`owner_only` 只放行 owner（及 `/owner_mention` 认领路径），
白名单只在 `everyone` 下生效；owner 未认领时群成员一律拒绝；私聊不经过群检查。

飞书群聊中的通用斜杠命令必须由结构化真实 `@Bot` 触发并通过响应对象（audience）
检查，但不受激活闸门（`activation_mode`、`when_mentioned`、`disabled`）约束；
`/require_mention` 与 `/owner_mention` 还豁免激活与 owner 认领阻断，作为 IM 侧的
恢复路径。群里不带 `@Bot` 的斜杠文本按普通消息处理。私聊无需 `@`。

只读命令不能越过本会话读取 owner 的数据：

- 群聊中 `/list`、`/ls`、`/recall`、`/rc` 仅限 owner（`/list` 列出 owner 的全部
  工作区和会话，`/recall` 摘要可能包含 owner 的 Web 输入）；私聊不受限。是否私聊
  优先采用连接器随消息传入的 `chatType`，并在首次收到私聊时持久化
  `feishu_chat_mode=p2p`；仍未知时按群聊处理。
- `/status`、`/where` 只描述本聊天自己的绑定，群成员可用。
- `/recall` 读取本条消息实际路由到的 Session：普通群/私聊为其绑定的 Session；
  话题群为当前话题的 Session，缺少话题元数据时拒绝，永远不回退到 Workspace
  主会话，也不会为此新建话题 Session。

另有精确的 Session 运行时控制命令，由渠道连接器在通用斜杠命令之前解析。
群聊必须由渠道结构证明真实 `@Bot`，命令大小写敏感；私聊可直接使用。
飞书支持 `/steer`、`/break`、`/clear` 和 `/fresh`；QQ、Telegram、钉钉、Discord、
WhatsApp、企微、微信支持 `/steer` 和 `/break`，其 `/clear` 与 `/fresh` 仍走通用命令
处理器。各渠道的群聊结构证明：QQ 由平台保证（网关只在真实 `@Bot` 时投递
`GROUP_AT_MESSAGE_CREATE`）；Telegram 为行首 `@bot`、`text_mention` 或 `/cmd@bot`；
钉钉为 `isInAtList`；Discord 为平台解析出的行首 Bot 提及；WhatsApp 为 Bot 在
`mentionedJid` 中；企微群回调本身即 `@`；微信只有私聊。缺少证明的群聊文本按普通
消息处理：

- `/steer <非空消息>`：先可靠进入当前 Session 的 durable pending，再 clean interrupt
  当前 generation；当前已 pending 的普通消息与 steer 按可见顺序在下一轮合批，命令前缀
  不进入 Agent Prompt，也不额外发送框架确认。可携带图片。目标只查已有路由，不为
  `/steer`、`/break` 新建话题会话；目标不存在时回复目标不存在，消息不入库。
- `/break`：必须无附件且正文精确匹配；以到达时为截止点取消此前 pending 并中断 active
  Loop，保留 transcript，之后到达的消息继续运行；固定回复 `Current task stopped.` 或
  `No active task to stop.`。只受响应对象/激活策略约束，不要求 owner。
- `/clear`：必须无附件且正文精确匹配；重置当前逻辑 Session 并固定回复
  `Session context cleared.`。
- `/fresh [备注]`：必须无附件；停 runner、清 session 文件、写入
  `context_fresh_window` divider 和交接 notes（零摘要，不调 LLM）。旧历史留库。
  飞书按当前话题 / Runtime Session 换窗。MCP `fresh_window` 可由当前会话 Agent
  自行调用。
- `/clear`、`/fresh` 无论走运行时控制还是通用斜杠命令，都与 `OWNER_REQUIRED_IM_COMMANDS`
  同一破坏性边界：群聊中 `@Bot /clear`、`@Bot /fresh` 只允许 owner，未认领 owner 的
  群直接拒绝；私聊首次使用时认领发送者。
- 运行时控制的目标：群聊由连接器按本条消息的路由（含原生话题）解析；路由失败时
  回复目标不存在，绝不回退到绑定的 Workspace 主会话（话题群尤其如此）。只有私聊
  在连接器未给出目标时由绑定解析，`/break`、`/clear`、`/fresh` 相同。

飞书撤回（`im.message.recalled_v1`）经 `onMessageRecalled` 进入宿主：仍在 durable
队列中的输入被取消并移出可见队列；尚未开始执行或等待合并转发备注的输入被取消；正在
执行的输入一律持久标记为已撤回，重启后不会重放。若正在执行的批次只有这一条输入，
按 `/break` 语义中断但不留任何框架痕迹：不发送回复、不写中断片段，停止后的残余流式
输出不再创建卡片，已有卡片静默终结并通过 Bot 自己的消息删除能力撤掉，Turn 以
cancelled 结束且游标前进。批次含其他输入时不中断。回复锚点被撤回或机器人已无法在
该会话发送（`target_unavailable`）时，Turn 静默以 cancelled 结束，不向已失效的锚点
发送失败通知。

被显式中断（`/break`、停止按钮、撤回、引导）消费的输入，其 Turn 在中断状态到达时立即
关闭，不再等暖 Runner 退出。显式停止会在卡片记录上写入结构化标记 `stopReason`。

启动时在加载状态之后、恢复排队消息和启动任何 Runner 之前修复遗留的 Turn（跳过本进程
活跃租约持有的 Turn，可重复执行）：输入已撤回或已撤销的，Turn 置为 cancelled、消息保持
排除在重放之外，其仍处于进行中的卡片在渠道连接后静默删除并终结，不会被对账改写成
「已中断」卡；卡片带 `stopReason` 标记、且没有已送达/不确定输出的，Turn 置为 cancelled
并把会话游标推进到该输入。修复只认这个标记，不从可见文本推断停止。撤回停止后，被中断
查询的 usage 照常计费，迟到的 SDK 终态只做生命周期簿记，不投影也不投递。

普通消息默认就是 durable queue，不存在显式 `/queue` 控制命令。旧的 `/queue ...`
按普通 Agent 输入处理。飞书 Reaction 属于真正执行的 batch，而不是入站消息：同一 batch
最多在最后一条飞书输入上显示一个 `OnIt`，queued 消息不显示；只有真实飞书消息 ID
（`om_…`）能成为 `OnIt` 目标，自动化提示等宿主合成的输入不加 Reaction。同一 Session
的 Reaction 操作在该 Session 的确认链上串行，上一批的删除先于下一批的添加到达飞书，
但添加和清理都不阻塞 Agent 启动或排队交接；彼此独立的 Session 可以并发显示。

## 7. 数据与目录

运行时数据默认位于 `data/`，不进入 Git：

```text
data/
├── db/messages.db
├── config/
├── groups/{folder}/
├── worktrees/{folder}/{sessionId}/
├── sessions/{folder}/.claude/
├── sessions/{folder}/agents/{sessionId}/.claude/
├── ipc/{folder}/
├── ipc/{folder}/agents/{sessionId}/
├── memory/
├── skills/{userId}/
├── builtin-skills/
├── mcp-servers/{userId}/
├── plugins/
├── agent-profile-runtime/
├── env/
└── extra/
```

主要数据库当前 Schema 版本以 `src/db.ts` 的 `CURRENT_SCHEMA_VERSION` 为准。
不要在文档中复制版本号；迁移必须同时具备备份、前向升级和拒绝降级保护。只新增索引
不需要升级版本：在每次启动都会执行的建表函数里用 `CREATE INDEX IF NOT EXISTS`。

核心表族：

- 用户与认证：`users`、`user_sessions`、`invite_codes`、`auth_audit_log`、
  `guest_workspace_grants`
- 工作区与会话：`registered_groups`、`sessions`、`workspaces`、
  `workspace_runtime_sessions`、`session_model_selections`、`session_worktrees`、
  `session_history_reinjections`
- Agent：`agent_profiles`、`agent_builder_drafts`、`workspace_agent_profiles`、
  `agents`
- 渠道：`channel_accounts`、`channel_mounts`、`agent_channel_mounts`、
  `im_context_bindings`
- 消息：`chats`、`messages`、`subagent_checkpoints`、`turn_traces`（回合的思考摘要、
  执行轨迹与有序步骤，按 `(chat_jid, turn_id)` 存放，随消息一起清理）、
  `usage_limit_waits`、`web_message_dedup`（Web 发送的幂等键，保留 24 小时）
- 自动化：`automations`、`automation_runs`、`automation_failure_streaks`
- 记忆：`workspace_memory_*`（含召回索引 `workspace_memory_recall_fts`）
- 用量与计费：`usage_records`、`usage_events`、`usage_daily_summary`、
  `usage_event_connections` 及 `billing_*`、订阅、余额和兑换码相关表

Channel Reliability 的 Inbox/Turn/Outbox/Card 表由
`src/channel-reliability-store.ts` 在同一数据库连接上创建；同样，`session_worktrees` 由
`src/session-worktree-store.ts`，自动化表由 `src/automation-store.ts`，等待、补注、用量连接
和 Web 发送去重表由 `src/runtime-state-store.ts` 创建。

## 8. 认证与权限

- Cookie 会话使用 HMAC 签名，密钥来自环境变量、持久文件或首次自动生成。
- `canAccessGroup`、`canModifyGroup` 和 `canDeleteGroup` 不提供 admin 全局旁路；
  工作区和渠道资源按 `created_by` 隔离。
- Host 工作区额外要求 admin 角色。
- 系统配置、用户、邀请、审计和计费使用独立 Permission Middleware。
- 敏感写操作必须先停止或暂停相关 Runner，并在提交失败时恢复队列。
- API 返回资源不存在时通常使用 404 隐藏其他用户资源是否存在。
- 只读访客（`role=guest`）由 admin 通过 `/api/guests` 创建并授权查看自己的部分
  工作区；member 只有在系统设置 `allowMemberGuests` 开启时可以（默认关闭，关闭时
  member 的访客一并失效），每个 owner 最多 20 个。不要放宽 `canAccessGroup`：读取
  路径单独使用 `canViewGroup`，全局 Guard（`src/middleware/guest-guard.ts`）按显式
  白名单放行访客的 GET，新路由默认拒绝；访客 WebSocket 只接收（`ping` 除外）。
  文件路由对访客隐藏所有点开头的条目、常见密钥文件和 `logs`/`conversations`，按
  会话的文件根和真实路径判断。访客看到的思考和工具调用与 owner 相同，但看不到
  git diff 与 worktree、模型选择、上下文用量、token 用量与费用和自动化的前置检查，
  REST 与 WebSocket 一致（广播用 `getGroupAudience` 区分 owner 与访客）。Host
  工作区的授权只在 owner 仍是 admin 时生效。访客没有 Home、Agent、记忆写入、钱包或
  订阅。

完整边界见 `docs/ACL-MATRIX.md`。

## 9. 配置

系统设置优先级为：

```text
Web 持久设置 > 环境变量 > 代码默认值
```

常用环境变量：

| 变量                                 | 默认值                            | 说明                               |
| ------------------------------------ | --------------------------------- | ---------------------------------- |
| `WEB_PORT`                           | `3000`                            | HTTP、WebSocket 端口               |
| `WEB_SESSION_SECRET`                 | 自动生成并持久化                  | Cookie 签名                        |
| `CONTAINER_IMAGE`                    | `riba2534/happyclaw-agent:latest` | GitHub Actions 发布的 Runner 镜像  |
| `CONTAINER_TIMEOUT`                  | `1800000`                         | Runner 无输出看门狗                |
| `IDLE_TIMEOUT`                       | `1800000`                         | 暖 Runner 空闲时间                 |
| `STUCK_RUNNER_FORCE_RESTART_MINUTES` | `10`                              | IPC 债务强制恢复上限（4–120 分钟） |
| `MAX_CONCURRENT_CONTAINERS`          | `20`                              | Docker 并发                        |
| `MAX_FILE_SIZE_MB`                   | `50`                              | Web/IM 入站文件上限                |
| `CORS_ALLOWED_ORIGINS`               | 仅 localhost                      | WebSocket Origin 白名单            |
| `TRUST_PROXY`                        | `false`                           | 是否信任反向代理来源头             |
| `TZ`                                 | 系统时区                          | 调度时区；无效值回退并告警         |

Provider 和渠道账号应优先通过 Web 配置。Legacy `/api/config/user-im/*` 只用于兼容，
新功能统一使用 `/api/channel-accounts`。

## 10. 开发与验证

```bash
make install
make dev
make start
make typecheck
make test
make build
npm run self-test
```

约束：

- 只使用 Node.js/npm，不使用 Bun。
- 三个 Node 项目分别位于根目录、`web/`、`container/agent-runner/`，均使用
  `npm ci` 和已提交 lockfile。
- 修改共享类型后运行 `make sync-types`；`make typecheck` 会检查副本一致性。回复步骤归并器
  （`shared/stream-steps.ts`、`shared/thinking-text.ts`）同步到后端和 Web：后端用同一套
  纯函数记录已结算回合的有序步骤，与 Web 流式时渲染的步骤不会漂移。
  `shared/model-providers.ts` 同样同步到后端和 Web：添加向导的引导与服务端的校验、
  测试、模型发现用同一套预设和错误分类。
- 修改 Prompt 后确保 `scripts/check-agent-runner-prompts.sh` 通过。
- 修改文档后运行 `npm run docs:check`。
- SDK/CLI 升级必须显式执行 `make update-sdk`，验证后提交 package.json 与 lockfile；
  升级后重跑 `node tests/e2e/turn-context-dedup.mjs`，它固定 SessionStart(compact)
  补发的位置。preset 变了时 `tests/agent-runner-claude-preset.integration.test.ts`
  失败：对照差异复查 `prompts/runtime-adaptation.md`，再用
  `npx vitest run tests/agent-runner-claude-preset.integration.test.ts --update` 更新快照。
- 容器以非 root 用户执行 Agent；修改 Dockerfile 或 entrypoint 后需要重建镜像。
- 停止服务只能杀监听进程：`lsof -ti:PORT -sTCP:LISTEN | xargs kill`。
- 不要使用会杀死连接方或 Docker 网络代理的宽泛端口 kill 命令。

### 常见修改入口

| 任务             | 入口                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| 新增 Web 设置    | `src/runtime-config.ts`、`src/schemas.ts`、`web/src/components/settings/`    |
| 新增 HTTP API    | 对应 `src/routes/*.ts`，同步 `docs/API.md` 和 ACL                            |
| 新增 MCP 工具    | `container/agent-runner/src/mcp-tools.ts` 与 `src/index.ts` IPC              |
| 新增渠道         | 渠道工厂、`src/im-manager.ts`、`src/channel-prefixes.ts`、渠道账号 Schema/UI |
| 新增 StreamEvent | `shared/stream-event.ts` 后运行 `make sync-types`                            |
| 修改数据库       | `src/db.ts` 新 migration、升级 `CURRENT_SCHEMA_VERSION`、补迁移测试          |
| 修改 Agent 能力  | Resolver、Capability Preview、Runner 三侧同时验证                            |

### 提交前门槛

```bash
npm run format:changed
npm run docs:check
make typecheck
make test
make build
git diff --check
```

改动 Runner Prompt、`systemPrompt`、工具或 MCP 的 PR 须附改动前后的
`cache_read_input_tokens` 占比（真实或脚本化运行，见 PR 模板）。

真实 Provider 测试使用 `npm run test:real-model`，会产生真实请求和可能的费用，
不要把凭据、Endpoint、模型名或未脱敏回复写入日志。
