# HappyClaw Claude Code 插件自动化导入与运行设计方案

## 1. 背景与目标

HappyClaw 当前通过 `@anthropic-ai/claude-agent-sdk` 启动 Claude Code Agent，并已经具备把本地 Claude Code plugin 目录注入 SDK 的基础能力。SDK 的 `options.plugins` 会被转换为 Claude Code CLI 的 `--plugin-dir <path>` 参数，因此插件中的 `agents/`、`skills/`、`hooks/`、`mcp-servers/`、普通 slash command 可以被 Claude Code 原生加载。

当前仍存在三个核心缺口：

1. 插件导入依赖手动从宿主机同步到用户 cache，缺少全局 catalog、版本追踪和自动发现。
2. 用户启用状态与插件文件混在 per-user cache 中，不利于多用户共享、审计和回滚。
3. 带 `disable-model-invocation: true` 的 slash command 在 SDK 模式下不会被模型主动调用；这类命令在 Claude Code REPL 中属于“用户手动输入后由 CLI 展开”的命令，需要 HappyClaw 在消息进入 Agent 前补齐展开逻辑。

本方案目标：

- 自动发现并导入宿主机 Claude Code 已安装插件。
- 建立全局插件 catalog，member 用户从 catalog 启用插件，不直接读取宿主机插件目录。
- 保留 SDK `options.plugins` 作为插件资源加载主路径，不重新实现 Claude Code plugin runtime。
- 对用户手动输入的 plugin slash command 建立索引和展开机制，补齐 `disable-model-invocation: true` 命令在 SDK 模式下的缺口。
- 不为单个插件写固定适配逻辑，尽量按 Claude Code command 语义实现通用处理。

## 2. 设计原则

1. **原生优先**

   Plugin 的资源加载继续走 Claude Code SDK/CLI 原生机制。HappyClaw 只负责导入、启用、路径转换和必要的 slash command 展开。

2. **Catalog 与用户启用分离**

   宿主机插件先进入全局 catalog。用户配置只保存启用引用，不把 admin 的宿主机插件能力无差别暴露给 member。

3. **不把 Markdown command 当脚本接口**

   Claude Code command 是 Markdown prompt，加 frontmatter 和动态上下文。HappyClaw 不应把 fenced bash 块当作本地脚本直接执行。只有 Claude Code 明确定义的 inline `!` bash context 可以作为 command expansion 的一部分处理。

4. **手动命令才展开 `disable-model-invocation`**

   `disable-model-invocation: true` 的含义是禁止模型通过 SlashCommand tool 自动触发，但用户手动输入 `/xxx` 仍应可执行。HappyClaw 的展开逻辑只针对用户真实消息，不提供给模型自动调用。

5. **安全默认**

   插件代码是供应链入口。导入、启用、执行都需要明确边界：路径段白名单、只读挂载、用户隔离、权限检查、冲突检测、可审计状态。

## 3. 当前代码基础

相关现有能力：

- `src/plugin-utils.ts`
  - per-user plugin 配置读写。
  - `loadUserPlugins(userId, { runtime })` 生成 SDK `options.plugins`。
  - Docker 路径转换为 `/workspace/plugins/<marketplace>/<plugin>`。

- `src/routes/plugins.ts`
  - 插件列表、启用、从宿主机同步、删除 marketplace。
  - 当前同步直接把宿主机 marketplace plugins 复制到 `data/plugins/{userId}/cache/`。

- `src/container-runner.ts`
  - Docker 模式挂载用户插件 cache 到 `/workspace/plugins`。
  - 启动 agent-runner 时注入 `ContainerInput.plugins`。

- `container/agent-runner/src/index.ts`
  - 把 `containerInput.plugins` 传给 SDK `query({ options: { plugins } })`。

- `src/index.ts`
  - IM slash command 统一入口 `handleCommand()`。
  - Web 端不走 `handleCommand()`，WebSocket 中单独拦截 `/sw|/spawn` 和 `/clear`。

- `src/group-queue.ts`
  - 维护运行中 host process / docker container 状态。
  - `containerName` 在 active state 中，但当前没有稳定对外 getter。

这些能力构成后续实现的基础，但数据模型需要从“每个用户各自复制 host 插件”升级到“全局 catalog + per-user enable + per-user runtime materialization”。

## 4. 目标数据模型

### 4.1 目录结构

新增或调整为：

```text
data/plugins/
  catalog/
    index.json
    marketplaces/
      {marketplaceName}/
        marketplace.json
        plugins/
          {pluginName}/
            manifest.json
            versions/
              {snapshotId}/
                .claude-plugin/plugin.json
                commands/
                agents/
                hooks/
                skills/
                scripts/
                mcp-servers/
                ...
  users/
    {userId}/
      plugins.json
  runtime/
    {userId}/
      {marketplaceName}/
        {pluginName}/
          .claude-plugin/plugin.json
          commands/
          agents/
          hooks/
          skills/
          scripts/
          mcp-servers/
```

兼容期继续读取现有：

```text
data/plugins/{userId}/plugins.json
data/plugins/{userId}/cache/
```

但新写入走 `data/plugins/users/{userId}/plugins.json` 和 `data/plugins/runtime/{userId}/`。

### 4.2 Catalog Index

`data/plugins/catalog/index.json`：

```json
{
  "schemaVersion": 1,
  "lastScannedAt": "2026-04-26T00:00:00.000Z",
  "marketplaces": {
    "openai-codex": {
      "name": "openai-codex",
      "sourceType": "host",
      "sourcePath": "/Users/example/.claude/plugins/marketplaces/openai-codex",
      "lastImportedAt": "2026-04-26T00:00:00.000Z",
      "plugins": {
        "codex": {
          "name": "codex",
          "version": "1.0.3",
          "description": "Use Codex from Claude Code to review code or delegate tasks.",
          "activeSnapshot": "sha256-...",
          "snapshots": {
            "sha256-...": {
              "snapshotId": "sha256-...",
              "importedAt": "2026-04-26T00:00:00.000Z",
              "contentHash": "sha256-...",
              "relativePath": "marketplaces/openai-codex/plugins/codex/versions/sha256-..."
            }
          }
        }
      }
    }
  }
}
```

### 4.3 用户启用配置

`data/plugins/users/{userId}/plugins.json`：

```json
{
  "schemaVersion": 1,
  "enabled": {
    "codex@openai-codex": {
      "enabled": true,
      "marketplace": "openai-codex",
      "plugin": "codex",
      "snapshot": "sha256-...",
      "enabledAt": "2026-04-26T00:00:00.000Z"
    }
  }
}
```

设计要点：

- `plugin@marketplace` 仍作为稳定 fullId，兼容现有 UI 和 API。
- 用户配置只保存启用引用，不保存宿主机绝对路径。
- 是否更新到新 snapshot 是显式行为，可提供“跟随最新版本”选项，但默认不自动升级运行中用户。

### 4.4 Runtime Materialization

用户启用后，把 catalog snapshot materialize 到：

```text
data/plugins/runtime/{userId}/{marketplace}/{plugin}
```

实现方式优先级：

1. 同文件系统可用时使用硬链接或目录复制。
2. 不使用 symlink 暴露 catalog 真实路径给容器。
3. Docker 挂载 `data/plugins/runtime/{userId}` 到 `/workspace/plugins`，只读。

禁用插件时删除 runtime 对应目录。更新插件时先写新目录，再原子替换，避免运行中读到半写入目录。

## 5. 自动导入设计

### 5.1 新增模块

新增：

- `src/plugin-catalog.ts`
- `src/plugin-manifest.ts`
- `src/plugin-importer.ts`

职责：

- `plugin-manifest.ts`
  - 读取 marketplace manifest 和 plugin manifest。
  - 校验 name segment。
  - 扫描 commands、agents、skills、hooks、mcp-servers。

- `plugin-catalog.ts`
  - 读写 catalog index。
  - 查询可用 marketplace/plugin/snapshot。
  - 生成 fullId。

- `plugin-importer.ts`
  - 扫描宿主机 Claude plugin 目录。
  - 计算 plugin 内容 hash。
  - 导入新 snapshot。
  - 生成导入报告。

### 5.2 扫描来源

默认扫描：

```text
getEffectiveExternalDir()/plugins/marketplaces
```

这与现有 `src/routes/plugins.ts` 的 host marketplace root 保持一致。

后续可支持多来源：

```json
{
  "sources": [
    {
      "type": "host-claude-dir",
      "path": "/Users/example/.claude/plugins/marketplaces"
    },
    {
      "type": "directory",
      "path": "/opt/happyclaw/plugin-marketplaces"
    }
  ]
}
```

### 5.3 导入流程

1. 枚举 `marketplaces/*`。
2. 读取 `.claude-plugin/marketplace.json`，缺失时允许降级但记录 warning。
3. 枚举 `plugins/*/.claude-plugin/plugin.json`。
4. 校验 marketplace/plugin 目录名：
   - 匹配 `/^[\w.-]+$/`
   - 拒绝 `.`、`..`
   - 拒绝路径分隔符
5. 计算 plugin 目录内容 hash：
   - 排除临时文件、`.DS_Store`。
   - 使用文件相对路径、size、mtime 可选；最终 hash 以内容为准。
6. 若 hash 未变化，只更新 scan 时间。
7. 若 hash 变化，复制到 catalog snapshot 临时目录。
8. 校验复制结果包含 `.claude-plugin/plugin.json`。
9. 原子 rename 到最终 snapshot 目录。
10. 更新 catalog index。

### 5.4 自动化策略

- 服务启动时执行一次 scan。
- 后台定时 scan，默认 1 小时。
- Admin UI 提供“立即扫描”。
- 扫描只更新 catalog，不自动启用给用户。
- 可选策略：admin 用户可启用“导入宿主机 settings.json 中已 enabled 的插件并为 admin 启用”。

## 6. SDK 插件注入路径

继续使用 SDK `options.plugins`。

调整 `src/plugin-utils.ts`：

- `readUserPluginsFile(userId)` 兼容旧路径和新路径。
- `loadUserPlugins(userId, { runtime })` 从新用户配置读取 enabled refs。
- 校验 runtime 目录存在 `.claude-plugin/plugin.json`。
- Docker 模式返回：

```text
/workspace/plugins/{marketplace}/{plugin}
```

- Host 模式返回：

```text
<repo>/data/plugins/runtime/{userId}/{marketplace}/{plugin}
```

调整 `src/container-runner.ts`：

- Docker 挂载从 `data/plugins/{userId}/cache` 改为 `data/plugins/runtime/{userId}`。
- 保持只读挂载。
- 启动前调用 materializer，保证 runtime 与用户 enabled refs 一致。

## 7. Slash Command 索引设计

### 7.1 为什么需要索引

当前数据模型只有 `plugin@marketplace`，无法从用户输入 `/codex:status` 稳定反查到具体 plugin。不同 marketplace 可以有同名 plugin，不同插件也可能暴露冲突 command。

因此需要按 enabled plugin 扫描真实 `commands/*.md`，生成 per-user command index。

### 7.2 命令名规则

对每个 enabled plugin：

```text
runtime/{userId}/{marketplace}/{plugin}/commands/{commandName}.md
```

生成候选 slash names：

1. `/{commandName}`
2. `/{plugin}:{commandName}`
3. 若 `commandName` 已包含冒号，保留原始 commandName。

示例：

```text
openai-codex/codex/commands/status.md
  /status
  /codex:status

claude-plugins-official/hookify/commands/list.md
  /list
  /hookify:list

commit-commands/commands/commit.md
  /commit
  /commit-commands:commit
```

为了避免覆盖 HappyClaw 内置命令：

- `clear/list/status/recall/where/bind/new/spawn/allow/...` 这些内置命令优先。
- 如果 plugin 也提供 `/status`，裸 `/status` 不注册，仍可用 `/codex:status`。

### 7.3 冲突处理

索引结构：

```ts
interface PluginCommandIndexEntry {
  slashName: string;
  fullId: string;
  marketplace: string;
  plugin: string;
  commandName: string;
  commandFile: string;
  description?: string;
  argumentHint?: string;
  disableModelInvocation: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
}
```

若多个 enabled plugin 注册同一个 slash name：

- index 标记为 conflict。
- 不自动选择。
- 用户输入该命令时返回冲突提示，并列出 namespaced 命令。

### 7.4 Frontmatter 解析

引入 YAML parser，例如 `yaml` 包。

原因：

- 官方插件存在数组字段：

```yaml
allowed-tools: ["Read", "Write", "AskUserQuestion"]
```

- 也存在单行字符串、布尔值、多行结构。
- 现有 regex 只适合 best-effort dependency warning，不适合作为 command runtime。

解析函数：

```ts
parseCommandMarkdown(file): {
  frontmatter: Record<string, unknown>;
  body: string;
}
```

字段：

- `description`
- `argument-hint`
- `allowed-tools`
- `model`
- `disable-model-invocation`
- `hide-from-slash-command-tool`

## 8. Command Expansion 运行设计

### 8.1 接入点

不只接入 `handleCommand()`。

原因：

- IM slash command 会调用 `handleCommand()`。
- Web 端当前不走 `handleCommand()`。
- 如果在 `handleCommand()` 中直接返回字符串，会阻止未知 slash command 进入 Agent。

建议接入位置：

1. IM 端仍先走 `handleCommand()` 处理 HappyClaw 内置命令。
2. `handleCommand()` 对 plugin command 返回 `null`，让消息进入普通消息流。
3. 在消息进入 Agent 前统一调用：

```ts
expandPluginSlashCommandIfNeeded({
  chatJid,
  userId,
  content,
  runtime,
  cwd,
})
```

4. Web 和 IM 共用同一 expansion。

具体可以放在：

- `processGroupMessages()` 组装 user prompt 前。
- `processAgentConversation()` 组装 agent prompt 前。
- `handleWebUserMessage()` 之前或内部统一处理，但最终应只保留一处核心函数。

### 8.2 DMI 命令处理策略

用户输入 `/plugin:cmd args`：

1. 解析 slash token。
2. 查询当前 owner 的 enabled command index。
3. 未命中：不处理，走普通 Agent。
4. 命中但不是 `disable-model-invocation: true`：
   - 不展开，走 SDK 原生 plugin command。
5. 命中且 DMI=true：
   - 说明这是“用户手动命令”，允许 HappyClaw 展开为 Agent prompt。

展开后 prompt 结构：

```text
The user manually invoked Claude Code plugin command:

Command: /codex:status
Plugin: codex@openai-codex
Arguments: --all

Use the following command definition exactly as Claude Code would for a user-invoked slash command.
Do not treat this as model-initiated SlashCommand invocation.

<expanded command markdown body>
```

### 8.3 参数替换

支持：

- `$ARGUMENTS`
- `$1`, `$2`, ...

解析方式：

- raw arguments 保留原始字符串。
- positional arguments 使用 shell-like parser，但不执行 shell。
- 替换时做文本替换，不把参数拼进本地 shell。

### 8.4 Inline `!` Bash 处理

Claude Code command 支持：

```markdown
Current status: !`git status`
```

Expansion 层执行 inline `!`，把 stdout 注入 body。

执行规则：

- 只处理 inline `!` backtick，不处理 fenced bash。
- 每个 inline command 单独执行。
- timeout 默认 30s。
- maxBuffer 默认 1MB。
- cwd 使用当前工作区 cwd。
- env 注入：
  - `CLAUDE_PLUGIN_ROOT`
  - `ARGUMENTS`
- Docker 模式优先在当前 active container 中执行：
  - `docker exec -i -u node -w /workspace/group ...`
- 若 Docker 工作区没有 active container：
  - 方案 A：返回提示“请先启动工作区后重试”。
  - 方案 B：启动短生命周期 helper container 执行 inline context。

推荐先实现方案 A，helper container 后续作为增强。

### 8.5 不执行 fenced bash

不把以下内容当作 HappyClaw 本地脚本：

```markdown
```bash
node ...
```
```

原因：

- 这通常是给模型看的操作说明。
- 可能需要 AskUserQuestion、Task、Bash run_in_background、上下文判断。
- 直接执行会绕过 Claude Code 的工具权限和交互逻辑。

对于这类内容，HappyClaw 展开后交给 Agent，由 Claude Code SDK 中的工具机制执行。

### 8.6 `review --background` 语义

不要通过本地 spawn `codex-companion review --background` 来模拟后台。

正确策略：

- 展开 command Markdown。
- 让 Agent 看到 command 中关于 `Bash(... run_in_background: true)` 的说明。
- 由 Claude Code 自己处理 background Bash。

如果后续需要 HappyClaw 自管后台任务，应另行设计通用 job system，而不是写 codex 特例。

## 9. 权限与安全

### 9.1 插件导入权限

- 扫描宿主机插件目录：admin only。
- catalog 可对 member 展示插件名、版本、描述、依赖 warning。
- member 不可看到宿主机绝对路径。
- member 只能启用 catalog 中已导入/批准的插件。

### 9.2 Slash Command 权限

插件 slash command 执行应遵守当前消息通道权限：

- Web：沿用 `canAccessGroup()` 和 host mode admin 检查。
- IM：与普通消息一致，遵守绑定、activation mode、owner mention、allowlist。
- 不允许未授权群成员通过 `/plugin:cmd` 绕过普通消息门控。

### 9.3 路径安全

所有 marketplace/plugin/command name：

- 目录段使用 `/^[\w.-]+$/`。
- 拒绝 `.`、`..`。
- command 文件只能来自 `commands/{name}.md`。
- 不允许用户输入直接拼路径。

### 9.4 Shell 安全

- 用户参数不直接拼 shell。
- `$ARGUMENTS` 作为 env 注入。
- inline command 来自已启用 plugin，属于用户信任的插件代码。
- 仍需记录审计日志：谁、在哪个 workspace、执行了哪个 inline command。

### 9.5 运行中更新安全

- catalog snapshot immutable。
- runtime materialization 原子替换。
- 禁用/更新插件时提示运行中 Agent 需要重启后完全生效。
- 不在运行中直接 `rm` 正被容器只读挂载的目录。

## 10. API 设计

### 10.1 Catalog API

```text
GET  /api/plugins/catalog
POST /api/plugins/catalog/scan
GET  /api/plugins/catalog/marketplaces/:marketplace
GET  /api/plugins/catalog/marketplaces/:marketplace/plugins/:plugin
```

权限：

- `GET /catalog`：所有登录用户可看已批准 catalog。
- `POST /scan`：admin only。
- sourcePath 仅 admin 返回。

### 10.2 User Plugin API

```text
GET    /api/plugins
PATCH  /api/plugins/enabled/:pluginFullId
DELETE /api/plugins/enabled/:pluginFullId
POST   /api/plugins/materialize
```

`PATCH` body：

```json
{
  "enabled": true,
  "snapshot": "sha256-..."
}
```

### 10.3 Command API

```text
GET /api/plugins/commands
GET /api/plugins/commands/conflicts
```

返回：

```json
{
  "commands": [
    {
      "slashName": "/codex:status",
      "fullId": "codex@openai-codex",
      "description": "Show active and recent Codex jobs",
      "argumentHint": "[job-id] [--all]",
      "disableModelInvocation": true
    }
  ],
  "conflicts": []
}
```

### 10.4 兼容 API

现有：

```text
GET /api/plugins/available-on-host
POST /api/plugins/sync-host
DELETE /api/plugins/marketplaces/:name
```

迁移后：

- `available-on-host` 可变为 catalog scan preview。
- `sync-host` 可变为 `catalog/scan` 的兼容 alias。
- `DELETE /marketplaces/:name` 不再删除用户 cache，而是 admin catalog 管理操作；用户删除启用项使用 `DELETE /enabled/:fullId`。

## 11. 前端设计

### 11.1 Plugins 页面

信息结构：

- Catalog marketplace 列表。
- 每个 plugin 展示：
  - 名称、版本、描述。
  - 是否已启用。
  - 最新 snapshot。
  - 依赖 warning。
  - command 列表。
  - 冲突提示。

操作：

- Admin：
  - 扫描宿主机插件。
  - 查看 sourcePath。
  - 批准/隐藏 catalog plugin。
- 用户：
  - 启用/禁用 plugin。
  - 选择版本。
  - 查看可用 slash commands。

### 11.2 Chat 输入提示

可选增强：

- 输入 `/` 时展示当前 workspace 可用 plugin commands。
- 对 DMI command 标记“用户手动命令”。
- 对冲突 command 提示 namespaced 形式。

## 12. 实施步骤

### Step 1：Catalog 基础

文件：

- 新建 `src/plugin-manifest.ts`
- 新建 `src/plugin-catalog.ts`
- 新建 `src/plugin-importer.ts`
- 修改 `src/routes/plugins.ts`

内容：

- 实现 host scan。
- 实现 immutable snapshot 导入。
- 实现 catalog index 读写。
- API 返回 catalog。

验证：

- 扫描本机 `openai-codex` 和 `claude-plugins-official`。
- hash 未变化时不重复导入。
- 非 admin 不能看到 sourcePath。

### Step 2：用户启用与 Runtime Materializer

文件：

- 修改 `src/plugin-utils.ts`
- 新建 `src/plugin-materializer.ts`
- 修改 `src/container-runner.ts`
- 修改 tests

内容：

- 新用户配置路径。
- runtime materialization。
- `loadUserPlugins()` 从 runtime 生成 SDK `plugins`。
- 兼容旧 cache 读取。

验证：

- Docker/Host 路径正确。
- 禁用后不注入 SDK。
- 启用后 agent-runner 日志包含 plugin path。

### Step 3：Command Index

文件：

- 新建 `src/plugin-command-index.ts`
- 新增 tests

内容：

- YAML frontmatter 解析。
- enabled plugin commands 扫描。
- slash name 生成。
- 内置命令保留。
- 冲突检测。

验证：

- `/codex:status` 命中 codex。
- `/commit` 命中 commit-commands。
- 内置 `/status` 不被 plugin 覆盖。
- 多插件冲突返回 conflict。

### Step 4：Command Expansion

文件：

- 新建 `src/plugin-command-expander.ts`
- 新建 `src/plugin-inline-bash.ts`
- 修改消息处理入口
- 新增 tests

内容：

- 识别用户手动 slash command。
- 对 DMI command 展开 Markdown。
- 参数替换。
- inline `!` 执行与输出注入。
- fenced bash 保留给 Agent。

验证：

- `/codex:status` 展开并返回 jobs 表。
- `/codex:review` 展开给 Agent，不本地 spawn。
- 普通 plugin command 继续走 SDK。
- 未启用 command 不拦截。
- Web 与 IM 走同一逻辑。

### Step 5：UI 与迁移

文件：

- 修改 `web/src/pages/PluginsPage.tsx`
- 修改 `web/src/stores/plugins.ts`
- 增加 migration helper

内容：

- Catalog UI。
- 用户启用 UI。
- commands preview。
- 旧 `data/plugins/{userId}` 迁移到新结构。

验证：

- 老用户插件仍可用。
- 新启用走 catalog。
- 页面能展示 commands 与 warnings。

## 13. 测试策略

### 单元测试

- manifest parser
- catalog importer
- content hash
- user config migration
- materializer
- command index
- frontmatter parser
- argument substitution
- inline bash expansion
- command conflict

### 集成测试

- 导入 fake marketplace。
- 启用 plugin。
- 启动 agent-runner，确认 `options.plugins` 注入。
- Web 输入 DMI command，确认进入 expansion。
- IM 输入 DMI command，确认行为一致。

### 回归测试

- `npm run typecheck`
- `npm run test`
- `npm --prefix web run build`
- existing MCP/Skills 不退化。
- `/clear`、`/spawn`、`/status` 内置命令不被 plugin command 覆盖。

## 14. 风险与边界

1. **无法 100% 复刻 Claude Code REPL**

   Claude Code REPL 内部可能有未公开行为。方案尽量复用 SDK/CLI 原生 plugin 加载，HappyClaw 只补 command expansion。

2. **复杂交互 command 仍依赖 Agent**

   AskUserQuestion、Task、background Bash、Skill 等语义不在 HappyClaw 本地执行。它们通过展开后的 prompt 交给 Agent 处理。

3. **Inline bash 有供应链风险**

   inline bash 来自用户启用的 plugin。需要 UI 明确提示 plugin 可执行本地命令。

4. **运行中插件更新不是热更新**

   已启动 Agent 不保证立即看到插件变更。UI 应提示重启工作区后完全生效。

## 15. 最终效果

完成后，HappyClaw 的 Claude Code plugin 能力将形成完整闭环：

1. Admin 安装或更新 Claude Code plugin。
2. HappyClaw 自动扫描并导入 catalog。
3. 用户从 catalog 启用插件。
4. HappyClaw materialize 用户 runtime，并在 Agent 启动时通过 SDK `options.plugins` 注入。
5. 普通 plugin 资源由 Claude Code 原生加载。
6. 用户手动输入的 DMI slash command 由 HappyClaw 展开为 Agent prompt，补齐 SDK 模式缺口。
7. Web 与 IM 通道共享同一套 plugin command 行为。

该方案不是针对某个插件的临时适配，而是围绕 Claude Code plugin 的公开目录结构、SDK plugin 注入能力和 command markdown 语义建立的通用实现。
