# Antigravity (`agy`) Runner: Architecture, Trade-offs, and Switching

HappyClaw supports running Google Antigravity (`agy`) subscriptions—including
Gemini 4 Neon—through a dedicated **AGY Runner** (`agy-runner`) alongside the
existing Claude Code Runner (`cc-runner`).

Unlike the built-in ChatGPT/Codex OAuth gateway (`docs/codex-oauth-gateway.md`),
AGY integration operates at the **Runner boundary** rather than the HTTP
Anthropic Messages proxy boundary.

## Why a Runner instead of an HTTP subscription gateway?

1. **Product surface mismatch**: ChatGPT/Codex exposes a stateless single-turn
   inference endpoint where Claude Agent SDK owns the agent loop. Antigravity
   subscriptions instead expose an **agent runtime** (`agy` CLI headless mode,
   `agy acp`, and the official `google-antigravity` Python SDK) rather than a
   public stateless `/v1/messages` API.
2. **Compliance and account safety**: Community reverse-engineered proxies that
   spoof official client fingerprints against internal Cloud Code endpoints have
   triggered widespread 403 blocks and permanent Google account suspensions.
   Running the official `agy` CLI binary directly stays 100% within documented,
   sanctioned paths and carries no client-spoofing risk.
3. **Minimal blast radius**: HappyClaw's control plane (Web UI, WebSocket
   projections, IM channels, SQLite durable state, `GroupQueue`, and provider
   switching) already communicates with Runners through a clean process
   contract (`ContainerInput` on stdin, `OUTPUT_START_MARKER` /
   `OUTPUT_END_MARKER` `ContainerOutput` frames on stdout, and file-based IPC
   under `HAPPYCLAW_WORKSPACE_IPC`). Adding a second Runner leaves the control
   plane and `cc-runner` virtually untouched.

## Architecture

```text
Web / IM Channels / Scheduler
        │
        ▼
HappyClaw Control Plane (SQLite + GroupQueue + provider-switch-context)
        │
        ▼
src/container-runner.ts (runHostAgent)
        │ dispatch by provider.runner ('claude' | 'agy')
        ├──────────────────────────────┐
        ▼                              ▼
  cc-runner (default)            agy-runner (Host mode)
  container/agent-runner         src/agy-runner/index.ts -> dist/agy-runner/index.js
  (Claude Agent SDK)             (Node wrapper, zero extra npm deps)
        │                              │ stdin/stdout NDJSON (stream-json)
        ▼                              ▼
  Anthropic / Codex Gateway      Official `agy` CLI process
                                 `agy --input-format stream-json --output-format stream-json`
```

### Provider model (`runner?: 'claude' | 'agy'`)

- `StoredProviderV4`, `UnifiedProvider`, and `UnifiedProviderPublic` gain an
  optional field `runner?: 'claude' | 'agy'`.
- When absent, `runner` defaults to `'claude'`, keeping full backward
  compatibility with existing configs and safe rollback (config version stays 5).
- For `runner === 'agy'`:
  - `providerHasCredentials()` returns `true` (authentication is managed by the
    host's `agy` CLI login session; no API key is stored in HappyClaw).
  - Available models can be discovered dynamically from `agy models` and stored
    in `provider.models` so the existing workspace/conversation model picker
    works without new UI concepts.
  - `provider.anthropicModel` stores the default AGY model slug (for example
    `gemini-4-neon-medium`).

## Runner switching (`cc-runner` <-> `agy-runner`)

Switching between `cc-runner` and `agy-runner` reuses HappyClaw's existing
provider-switching pipeline with zero user-facing friction:

1. **Binding & triggers**:
   - Workspaces or Agent profiles bind to an AGY provider or a Claude/Codex
     provider just like any other provider.
   - Mid-conversation switching works through the existing provider/model
     selector.
2. **Session isolation and history continuity**:
   - `sessions.provider_id` records which provider owns the current session.
   - Claude SDK session IDs and `agy --conversation` IDs are incompatible.
     When a conversation switches between providers (including across
     `cc-runner` and `agy-runner`), `applyProviderSwitchToInput()` in
     `src/provider-switch-context.ts` automatically detects the provider change,
     clears the stale `sessionId`, and seeds the new Runner's opening prompt
     with up to 30 recent turns from HappyClaw's SQLite transcript.
3. **Warm process lifecycle**:
   - `GroupQueue` gracefully closes the previous Runner (via IPC `_close`) and
     spawns the target Runner for the newly selected provider.

## `agy` `stream-json` protocol mapping

`agy-runner` spawns one persistent `agy` child process per warm Runner lifetime
in the workspace `cwd`:

```bash
agy --input-format stream-json --output-format stream-json \
  --model <model> \
  [--effort <effort>] \
  --dangerously-skip-permissions \
  [--conversation <saved_session_id>]
```

### Input (Host IPC -> `agy` stdin)

Each turn (initial `ContainerInput.prompt`, plus follow-up messages polled from
`HAPPYCLAW_WORKSPACE_IPC/input/*.json`) is written as one NDJSON line:

```json
{"event":"user","message":{"content":"..."}}
```

When `HAPPYCLAW_WORKSPACE_IPC/input/_close` appears (or the host idle close
timer expires), `agy-runner` closes `agy`'s stdin, waits briefly for graceful
exit, and terminates cleanly.

### Output (`agy` stdout -> HappyClaw `ContainerOutput` / `StreamEvent`)

| `agy` NDJSON event | Key payload fields | HappyClaw output (`StreamEvent` / `ContainerOutput`) |
| --- | --- | --- |
| `init` | `conversation_id`, `init.model`, `init.tools` | `streamEvent: { type: 'init' }` + `newSessionId = conversation_id` |
| `step_update` (`agent_response`, `ACTIVE`/`DONE`) | `text_delta` | `streamEvent: { type: 'text_delta', text }` |
| `step_update` (`agent_response`, `DONE`) | `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`) | `streamEvent: { type: 'usage', ... }` |
| `step_update` (`tool`, `ACTIVE`) | `tool_name`, `tool_info.parameters` | `streamEvent: { type: 'tool_use_start', toolName, toolUseId, toolInputSummary }` |
| `step_update` (`tool`, `DONE`/`ERROR`) | `tool_info.output` / `tool_info.error` | `streamEvent: { type: 'tool_use_end' }` + `streamEvent: { type: 'tool_result' }` |
| `step_update` (`subagent_info`) | `subagents[]` | `streamEvent: { type: 'task_start' / 'task_progress' }` |
| `result` | `status`, `response`, `error`, `conversation_id`, `usage`, `denied_actions` | Turn-completing `ContainerOutput` (`status: 'success' \| 'error'`, `result`, `newSessionId`, `inputTurnCompleted: true`) |

## Trade-offs and known limitations

| Area | Decision in Phase 1 (MVP) | Rationale & future path |
| --- | --- | --- |
| **Execution mode** | Universal: supports Host mode, Docker container mode, and multi-user group chats | In Docker mode, HappyClaw bind-mounts the host's standalone `agy` binary (`/usr/local/bin/agy`, read-only), `dist/` (`/opt/happyclaw-host-dist`, read-only), and the provider's isolated `.gemini` profile directory (`/home/node/.gemini`) without requiring an image rebuild |
| **Authentication & isolation** | Per-provider isolated OAuth via official `agy acp --login` (`data/config/agy-profiles/<profileId>`) | Each AGY provider authenticates via a browser OAuth link + pasted callback code/URL (identical UX to Claude/ChatGPT login) and stores credentials in its own `0700` directory rather than sharing the host user's `~/.gemini` |
| **Permissions** | Pass `--dangerously-skip-permissions` in Host mode (mirrors `cc-runner`'s `bypassPermissions`) | On Linux hosts without an available terminal sandbox, `agy --mode auto` falls back to `default` and soft-denies headless shell commands. Scoped `permissions.allow` via `--settings` can be added as a policy option later |
| **Thinking stream** | Account `thinking_tokens` in usage; no live thinking text delta | `agy --output-format stream-json` currently reports `thinking_tokens` in `usage` without emitting raw thinking text deltas; `agy acp` can be evaluated later if live thinking text is needed |
| **Multimodal inputs** | Pass image/file paths in text prompt so `agy` reads them via `view_file` | `agy --input-format stream-json` currently accepts `text` content blocks only |
| **HappyClaw built-in MCP tools** | Bridged via standalone zero-dependency stdio MCP server (`dist/agy-runner/mcp-server.js`) registered in `<workspace>/.agents/mcp_config.json` | Exposes `send_message`, `send_image`, `send_file`, `get_channel_context`, and `automation_*` directly over HappyClaw's host IPC protocol; inherits per-runner `HAPPYCLAW_WORKSPACE_IPC` from `agy`'s process env so concurrent agents share one static config safely |
| **HappyClaw Skills** | Materialized as real directories from `<CLAUDE_CONFIG_DIR>/skills/` into `<workspace>/.agents/skills/` on launch (with mtime caching) | `agy` natively discovers Agent Skills in `.agents/skills/` but skips symlinked directories; copying real directories (cached via `.happyclaw-managed.json`) makes every HappyClaw skill appear in `agy`'s `<skills>` list while preserving unmanaged user skills |
| **System prompt / identity** | Prepend Agent profile identity prompt plus session & workspace `CLAUDE.md` to the first turn of a fresh `agy` session | `agy` CLI does not auto-read `CLAUDE.md` or take an inline `--system-prompt` flag; injecting deduplicated `CLAUDE.md` + identity prompt once on cold start keeps behavior consistent across runner switches without mutating workspace files |

## Phased implementation plan

- **Phase 1 (MVP — Host mode end-to-end)**:
  1. Add `runner?: 'claude' | 'agy'` to provider storage/runtime/public types and config API routes, plus `GET /api/config/agy/models` discovery.
  2. Implement `src/agy-runner/` (standalone Node entrypoint + unit-tested NDJSON protocol translator + IPC loop).
  3. Dispatch `runner === 'agy'` in `runHostAgent` (and fail fast with a clear message in `runContainerAgent`).
  4. Add minimal UI support in Provider settings to create/edit/view an AGY CLI provider and pick its models.
- **Phase 2 (HappyClaw MCP bridge)**:
  - Expose HappyClaw's workspace-scoped tools (automations, proactive IM replies, delegation) as a standard MCP server passed to `agy` via `--settings`.
- **Phase 3 (Hardening & optional extensions)**:
  - Mid-turn interrupt/abort handling, richer usage/cost telemetry, optional `agy acp` transport evaluation, and Docker support if required.
