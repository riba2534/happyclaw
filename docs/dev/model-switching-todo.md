# Model Switching TODO

This TODO tracks the remaining work needed to bring the local implementation in
line with `docs/dev/model-switching-design.md`.

Status values:

- `[ ]` not started
- `[~]` in progress
- `[x]` done locally
- `[!]` blocked or needs follow-up

## P0 Correctness

- [x] Stop manually injecting workspace `CLAUDE.md` into Codex prompts.
- [x] Configure Codex CLI/SDK to load workspace `CLAUDE.md` natively with
  `project_doc_fallback_filenames = ["CLAUDE.md"]`.
- [x] Force one lightweight handoff injection after runtime/provider/auth/model
  identity changes, even if the target runtime has an older native session.
- [x] Update runtime-input tests so Codex soft injection includes recent
  messages but not `<workspace-instructions>`.
- [x] Remove or neutralize `conversation_context_summaries` schema remnants from
  model switching. Do not add rolling summaries for this feature.

## P1 Runtime Parity

- [x] Remove Codex host-only forcing in main conversations.
- [x] Remove Codex host-only forcing in conversation agents/spawn path.
- [x] Remove Codex host-only forcing in scheduled tasks.
- [x] Make Codex container mode carry provider-scoped `CODEX_HOME`, API key env,
  workspace files, `CLAUDE.md`, IPC, MCP, and skills with parity to Claude.
- [x] Ensure Docker image/agent-runner install path contains a usable Codex
  runtime, or fails dependency probe before user traffic.

## P1 Sessions And Continuation

- [x] Replace remaining legacy `sessions` map/read/write usage on runtime paths.
- [x] Ensure startup recovery, `/clear`, workspace delete, agent delete, and
  scheduled-task paths clear runtime-aware native sessions.
- [x] Persist native sessions only under runtime/provider/auth generation/model
  identity.
- [x] Re-key or restart sessions when exact resolved model changes.

## P1 Codex Tools/MCP/Skills

- [x] Pass user MCP servers to Codex or mark them explicitly unavailable.
- [x] Pass workspace MCP servers to Codex or mark them explicitly unavailable.
- [x] Provide Codex with runtime-neutral skill routing and access to selected
  skill roots.
- [x] Ensure built-in HappyClaw MCP tools work in both host and container modes.
- [x] Ensure workspace tree/file policy and shell permission policy match Claude.

## P2 Conformance And UX

- [x] Extend Codex dependency probe to check `codex exec --help` for required
  flags/config and catch stale flags like unsupported `--ask-for-approval`.
- [x] Normalize Codex tool/file/MCP events beyond final text + zero-cost usage.
- [x] Use `@openai/codex-sdk` as the default GPT runtime adapter; keep direct
  CLI runner behind `HAPPYCLAW_CODEX_RUNNER=cli` only.
- [x] Run manual host/container Codex runtime smoke checks after rebuild.
- [x] Add tests for GPT provider auth material, API-key masking, OAuth
  `auth.json` writing, and dependency status shape.
- [x] Add automated host/container smoke tests for Codex.
- [x] Add route-level tests for GPT provider settings and OAuth start/complete.
- [x] Add tests for Web model APIs, core `/model use` parsing,
  IM command-level target execution, running-switch IPC drain, provider pool
  model options, and auth generation invalidation.
- [x] Add browser-level coverage for GPT provider settings and model switching.
  Verified on an authenticated browser session: GPT settings tab, provider
  list, Codex runtime probe, add-provider OAuth/API-key modes, model settings
  catalog/default selectors, chat `/model`, and chat `/model use gpt`.

## Already Mostly Implemented

- [x] Runtime/model schema foundations.
- [x] Provider pools and pool-level model options.
- [x] Web model APIs for system default, workspace default, and scope binding.
- [x] Web and IM `/model use` command paths.
- [x] Dedicated GPT settings tab.
- [x] GPT provider CRUD and first-pass ChatGPT OAuth/API-key UI.
- [x] Basic Codex SDK adapter with explicit CLI fallback.
- [x] Basic HappyClaw built-in MCP bridge for Codex.
- [x] Pending binding guard to avoid IPC reuse of stale runner.

## 2026-04-25 Runtime Audit Follow-up

These items come from the code/docs/log audit after the Codex SDK path was
introduced. They are intentionally tracked here so future implementation does
not treat "Codex can answer a chat turn" as equivalent to "Codex has full
Claude runtime parity".

Execution principle:

- Prefer complete, stable changes that match the runtime's real semantics.
- Do not make Codex emit fake Claude lifecycle events just to satisfy existing
  UI cards.
- Keep first-version scope small enough to ship and test: runtime-aware
  presentation first, runtime boundary/tool catalog/memory lifecycle after that.

Current priority order:

1. Done: runtime-aware streaming presentation. Claude keeps the existing agent
   card; Codex uses a Codex-native working/finish split. Working state shows
   only live Codex SDK artifacts that exist (`reasoning`, `todo_list`,
   `command_execution`, `mcp_tool_call`, `file_change`, `web_search`,
   `status`). Finish state renders collapsed `计划 / Todo`, `操作记录`, and
   `推理过程` panels only when the turn actually produced those artifacts.
2. Done: automated host/container Codex conformance tests.
3. Done: runtime-neutral built-in tool catalog.
4. Done: unified runtime permission policy.
5. Done: runtime boundary cleanup: cancel/drain/error classification/native
   resume capability flags. Codex remains a one-turn adapter branch for now,
   but it no longer accepts live IPC injection and can be interrupted/closed
   through the shared sentinel path.
6. Done: Codex long-context memory/compact lifecycle. Codex has no current
   PreCompact hook, so first version uses a runtime-memory prompt that makes
   memory/CLAUDE.md maintenance immediate and canonical-file based.

### P0 Correctness Follow-up

- [x] Fix Codex native resume failure fallback so retrying with a fresh thread
  uses a host-built soft-injection prompt, not the original resume prompt.
- [x] Make the `CLAUDE.md` loading contract explicit: workspace/project
  `CLAUDE.md` is loaded natively by the runtime; HappyClaw user-global
  `CLAUDE.md` is intentionally injected as bounded global memory until both
  runtimes have a proven native, cross-directory global-memory contract.

### P1 Runtime Boundary Follow-up

- [x] Promote the current minimal `AgentRuntimeAdapter.run()` shape to the
  designed runtime boundary: prepare/cancel/drain/error classification/native
  resume capability. Today Claude still lives in the legacy main loop while
  Codex is a one-turn adapter branch.
- [x] Normalize Codex resume-failure telemetry so the persisted native session
  metadata records the fallback context that actually seeded the new thread.
- [x] Add automated conformance tests that run Codex in both host and container
  modes and verify project `CLAUDE.md`, user-global memory, MCP tools, images,
  model selection, native resume, and soft-injection fallback.

### P1 Claude SDK Parity Follow-up

- [x] Split streaming card presentation by runtime. Claude keeps Task/subagent
  lifecycle panels; Codex uses Codex-native reasoning/todo/operation/log panels
  and must not display fake Claude planning/subagent placeholders.
- [x] Define and implement the Codex SDK working/finish Feishu card policy:
  persist native `thread.started`, treat `turn.started` as working-only status,
  stream `agent_message` only to the answer body, show bounded operation logs for
  tools/files/search/MCP, and carry real todos/operations/reasoning into the
  final card only when present.
- [x] Decide and implement the Codex story for Claude SDK-native `Task` /
  subagent semantics. The current Codex SDK stream exposes text/tool events but
  not Claude's structured `task_start`, `task_notification`,
  `sub_agent_result`, or `parentToolUseId` lifecycle.
- [x] Decide and implement Codex equivalents for Claude `PreCompact` hooks,
  transcript archive, memory flush, and automatic `CLAUDE.md` maintenance. The
  current Codex path has prompt/tool based memory access but no compact hook.
- [x] Extract built-in tools from Claude SDK `tool()` definitions into a
  runtime-neutral catalog, then generate Claude SDK tools and Codex MCP tools
  from the same source.
- [x] Normalize runtime permission policy. Claude currently uses
  `allowedTools`/`disallowedTools` plus `permissionMode`; Codex currently uses
  `sandboxMode=danger-full-access` and `approvalPolicy=never` plus HappyClaw MCP
  side-effect boundaries.

### P2 Observability And UX Follow-up

- [x] Improve Codex event aggregation so multiple top-level assistant messages
  are represented with `assistant_text_boundary` semantics instead of relying on
  the last `agent_message` item.
- [x] Add route-level coverage for GPT provider OAuth/API-key settings, model
  pool options, and Web model mutations.
- [x] Add browser-level coverage for GPT provider OAuth/API-key settings and
  model pool options.
- [x] Add an IM command-level harness for `/model use` that exercises bound
  workspace and thread-map conversation-agent targets without starting the full
  server.
