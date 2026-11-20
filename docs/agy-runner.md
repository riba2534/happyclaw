# Antigravity (`agy`) Runner: Architecture, Trade-offs, and Operations

HappyClaw supports running Google Antigravity (`agy`) subscriptions—including
Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 4 Argon, and other AGY-hosted models—
through a dedicated **AGY Runner** (`agy-runner`) alongside the existing Claude
Code Runner (`cc-runner`).

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
Web / IM Channels (QQ, Discord, Feishu, ...) / Scheduler / Automations
        │
        ▼
HappyClaw Control Plane (SQLite + GroupQueue + provider-switch-context)
        │
        ▼
src/container-runner.ts (runHostAgent & runContainerAgent)
        │ dispatch by provider.runner ('claude' | 'agy')
        ├────────────────────────────────────┐
        ▼                                    ▼
  cc-runner (default)                  agy-runner (Host & Docker)
  container/agent-runner               src/agy-runner/index.ts -> dist/agy-runner/index.js
  (Claude Agent SDK)                   (Node wrapper, zero extra npm deps)
        │                                    │
        ▼                                    ├─► stdin/stdout NDJSON (stream-json)
  Anthropic / Codex Gateway                  │   Official `agy` CLI (isolated HOME)
                                             │
                                             ├─► <workspace>/.agents/mcp_config.json
                                             │   dist/agy-runner/mcp-server.js (stdio MCP -> Host IPC)
                                             │
                                             └─► <workspace>/.agents/skills/
                                                 Materialized from <CLAUDE_CONFIG_DIR>/skills/
```

### Module layout (`src/agy-runner/`)

| File | Responsibility |
| --- | --- |
| `src/agy-runner/index.ts` | Standalone Runner entrypoint (`dist/agy-runner/index.js`): reads `ContainerInput`, registers MCP & Skills, spawns persistent `agy` process, bridges IPC follow-up turns (`_close`, `_drain`), handles Proactive fallback delivery |
| `src/agy-runner/protocol.ts` | Stateful NDJSON translator (`AgyStreamTranslator`) from `agy --output-format stream-json` to HappyClaw `ContainerOutput` / `StreamEvent` (`init`, `text_delta`, `tool_use_*`, `tool_result`, `task_start`, `usage`, `queryIdle`, `ipcReceipts`) |
| `src/agy-runner/models.ts` | `agy` binary resolution (`resolveAgyBinary`) and `agy models` parser (`discoverAgyModels`, `parseAgyModelsOutput`) with inferred context windows and efforts |
| `src/agy-runner/oauth.ts` | Isolated per-provider OAuth lifecycle via official `agy acp --login` (`data/config/agy-profiles/<profileId>`, mode `0700`) |
| `src/agy-runner/usage.ts` | 5-hour and weekly quota query & parser (`agy -p "/usage"`, supporting both non-TTY TSV/ISO-8601 and TTY space-aligned output, 60s cache) |
| `src/agy-runner/instructions.ts` | Deduplicated cold-start instruction loader merging `agentProfile.identityPrompt`, session `CLAUDE_CONFIG_DIR/CLAUDE.md`, and workspace `CLAUDE.md` |
| `src/agy-runner/mcp-server.ts` | Zero-dependency JSON-RPC 2.0 stdio MCP server exposing HappyClaw's host IPC tools (`send_message`, `send_image`, `send_file`, `get_channel_context`, `automation_*`) |
| `src/agy-runner/mcp-config.ts` | Workspace `.agents/mcp_config.json` merger and `.agents/skills/` real-directory synchronizer (mtime-cached via `.happyclaw-managed.json`) |

## Authentication, isolation, and provider model

### Provider fields (`runner?: 'claude' | 'agy'`, `agyProfileId?: string`)

- `StoredProviderV4`, `UnifiedProvider`, and `UnifiedProviderPublic` add
  optional backward-compatible fields (`runner` defaults to `'claude'`; config
  file version stays 5 for safe rollback).
- `UnifiedProviderPublic` exposes `hasAgyProfile: boolean` (never raw paths).
- Duplicating an OAuth-backed AGY provider is refused (same rule as Claude and
  ChatGPT OAuth), and deleting a provider cleans up its profile directory.

### Isolated OAuth login flow (`agy acp --login`)

1. **Start** (`POST /api/config/agy/oauth/start`):
   - Creates a fresh `0700` directory `data/config/agy-profiles/<profileId>`.
   - Spawns `agy acp --login` with `HOME=<profileDir>`, `DISPLAY=""`,
     `BROWSER=""` (10-minute pending TTL, bounded concurrency).
   - Extracts the official `https://accounts.google.com/o/oauth2/auth?...` URL
     and returns `{ authorizeUrl, state }` to `OAuthLoginPanel`.
2. **Callback** (`POST /api/config/agy/oauth/callback`):
   - Writes the user-pasted authorization code or full
     `antigravity.google/oauth-callback` URL to the pending `agy` stdin.
   - Waits for `agy acp --login` to exit `0` and verifies by calling
     `discoverAgyModels({ homeDir })`.
   - Creates a new AGY provider (or atomically swaps `agyProfileId` on re-login
     and deletes the old profile directory).
3. **Connectivity test** (`POST /api/config/claude/providers/test`):
   - Dedicated `runner === 'agy'` branch runs `discoverAgyModels()` against the
     provider's isolated profile and persists `lastTest`.
4. **Legacy fallback**:
   - Older AGY providers without `agyProfileId` continue to fall back to the
     host's default `HOME` and prompt the admin to re-login for isolation.

## Universal execution: Host, Docker container, and Group chats

- **Host mode (`runHostAgent`)**:
  - Dispatches `runner === 'agy'` to `dist/agy-runner/index.js`.
  - Strips Claude Code's `[1m]` context-window suffix before passing
    `HAPPYCLAW_AGY_MODEL`.
  - Passes `HAPPYCLAW_AGY_HOME` so only the `agy` child process inherits the
    isolated `HOME` directory.
- **Docker container mode (`runContainerAgent`)**:
  - Works on existing `riba2534/happyclaw-agent:latest` images without needing
    an image rebuild (and `container/entrypoint.sh` also supports
    `HAPPYCLAW_RUNNER=agy` natively).
  - Bind-mounts:
    - Host `agy` binary -> `/usr/local/bin/agy` (`ro`)
    - Host `dist/` -> `/opt/happyclaw-host-dist` (`ro`)
    - Provider's isolated `.gemini` directory -> `/home/node/.gemini` (`rw`,
      for `agy` conversation transcripts and runtime state)
  - Sets `HAPPYCLAW_RUNNER=agy`, `HAPPYCLAW_AGY_BIN=/usr/local/bin/agy`,
    `HAPPYCLAW_AGY_MODEL`, `HAPPYCLAW_WORKSPACE_GROUP=/workspace/group`,
    `HAPPYCLAW_WORKSPACE_IPC=/workspace/ipc`, and
    `CLAUDE_CONFIG_DIR=/home/node/.claude`.
- **Group chats & interaction modes**:
  - Supports both `assistant` (direct `ContainerOutput.result` publishing) and
    `proactive` (native `send_message` MCP tool + automatic fallback delivery to
    `HAPPYCLAW_WORKSPACE_IPC/messages/` with `send_message_result_<requestId>.json`
    acknowledgement and `.agy-final-sent.json` deduplication).

## Runner switching (`cc-runner` <-> `agy-runner`)

Switching between `cc-runner` and `agy-runner` reuses HappyClaw's existing
provider-switching pipeline:

1. **Binding & triggers**: Workspaces, Agent profiles, and mid-conversation
   model selections bind to any AGY or Claude/Codex provider seamlessly.
2. **Session isolation & history continuity**: `sessions.provider_id` tracks
   ownership. When switching across providers/runners,
   `applyProviderSwitchToInput()` clears the incompatible session ID and seeds
   the new Runner's opening prompt with up to 30 recent turns from SQLite.
3. **Warm lifecycle**: `GroupQueue` signals `_close` or `_drain` via IPC;
   `agy-runner` checks both sentinels after each turn and while idle in
   `waitForNextIpcTurn()`, exiting cleanly so the target Runner takes over.

## `agy` `stream-json` protocol mapping

`agy-runner` spawns one persistent `agy` child process per warm Runner lifetime
in the workspace `cwd`:

```bash
agy --input-format stream-json --output-format stream-json \
  --dangerously-skip-permissions \
  --model <model> \
  [--effort <effort>] \
  [--conversation <saved_session_id>]
```

(`--effort` is omitted when the model slug already encodes a level such as
`gemini-4-neon-medium`.)

### Input (Host IPC -> `agy` stdin)

Each turn (initial `ContainerInput.prompt`, plus warm follow-up turns polled
from `HAPPYCLAW_WORKSPACE_IPC/input/*.json`) is written as one NDJSON line:

```json
{"event":"user","message":{"content":"..."}}
```

### Output (`agy` stdout -> HappyClaw `ContainerOutput` / `StreamEvent`)

| `agy` NDJSON event | Key payload fields | HappyClaw output (`StreamEvent` / `ContainerOutput`) |
| --- | --- | --- |
| `init` | `conversation_id`, `init.model`, `init.tools` | `streamEvent: { eventType: 'init' }` + `newSessionId = conversation_id` |
| `step_update` (`agent_response`) | `text_delta` | `streamEvent: { eventType: 'text_delta', text }` |
| `step_update` (`tool`, `ACTIVE`) | `tool_name`, `tool_info.parameters` | `streamEvent: { eventType: 'tool_use_start', toolName, toolUseId, toolInputSummary, toolInput }` |
| `step_update` (`tool`, `DONE`/`ERROR`) | `tool_info.output` / `tool_info.error`, `duration_seconds` | `streamEvent: { eventType: 'tool_use_end' }` + `streamEvent: { eventType: 'tool_result' }` |
| `step_update` (`subagent_info`) | `subagents[]` | `streamEvent: { eventType: 'task_start' }` |
| `result` | `status`, `response`, `error`, `conversation_id`, `usage`, `denied_actions` | `streamEvent: { eventType: 'usage', ... }` + turn-completing `ContainerOutput` (`status: 'success' \| 'error'`, `result`, `newSessionId`, `inputTurnCompleted: true`, `queryIdle: true`, `ipcReceipts`) |

## Quota usage & UI integration

- **5-hour & weekly quota bars**: `GET /api/config/claude/providers/:id/usage`
  serves `kind: 'agy_quotas'` by running `agy -p "/usage"` against the
  provider's isolated profile (60s cache). `UsageBars.tsx` renders per-group
  (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`, etc.) `5h` and
  `7d` utilization bars, remaining percentage, and reset countdowns in
  **Settings -> 模型连接** (both desktop and mobile).
- **Brand marks & Runner badges**:
  - `vendorMarks.ts` / `vendor.ts` add monochrome `antigravity` and `gemini`
    vector marks for connection lists and model pickers.
  - `ProviderList.tsx`, desktop tooltips, and the mobile `ModelSelector` sheet
    header display `agy-runner` / `cc-runner` badges.

## Trade-offs and known limitations

| Area | Current design | Rationale & notes |
| --- | --- | --- |
| **Execution mode** | Universal: Host mode, Docker container mode, and multi-user group chats | Docker mode bind-mounts the host `agy` binary, `dist/`, and isolated `.gemini` dir without requiring an image rebuild |
| **Authentication & isolation** | Per-provider isolated OAuth via official `agy acp --login` (`data/config/agy-profiles/<profileId>`) | Eliminates dependency on host `~/.gemini`; supports multiple independent AGY accounts |
| **Permissions** | Pass `--dangerously-skip-permissions` (mirrors `cc-runner`'s `bypassPermissions`) | On Linux hosts/containers without a terminal sandbox, `agy --mode auto` falls back to `default` and soft-denies headless shell commands |
| **Thinking stream** | Account `thinking_tokens` in `usage`; no live thinking text delta | `agy --output-format stream-json` currently reports `thinking_tokens` without emitting raw thinking text deltas |
| **Multimodal inputs** | Materialize inline base64 images under `HAPPYCLAW_WORKSPACE_IPC/agy-images/` and pass paths in text prompt | `agy --input-format stream-json` accepts `text` content blocks only; `agy` reads materialized images via `view_file` |
| **HappyClaw built-in MCP tools** | Zero-dependency stdio MCP server (`dist/agy-runner/mcp-server.js`) in `<workspace>/.agents/mcp_config.json` | Exposes `send_message`, `send_image`, `send_file`, `get_channel_context`, and `automation_*` over native host IPC; inherits per-runner env so concurrent agents share one static config safely |
| **HappyClaw Skills** | Materialized as real directories from `<CLAUDE_CONFIG_DIR>/skills/` into `<workspace>/.agents/skills/` (mtime-cached) | `agy` skips symlinked directories when scanning `.agents/skills/`; real copies cached via `.happyclaw-managed.json` keep all HappyClaw skills visible while preserving unmanaged user skills |
| **System prompt / identity** | Prepend `agentProfile.identityPrompt` + deduplicated session & workspace `CLAUDE.md` on cold start | `agy` does not auto-read `CLAUDE.md` or accept an inline `--system-prompt` flag |

## Delivery status & optional future work

- **Phase 1 (Done)**: Host-mode `agy-runner`, `stream-json` protocol translator,
  `CLAUDE.md` injection, provider CRUD, model discovery, and settings wizard.
- **Phase 2 (Done)**: Zero-dependency HappyClaw stdio MCP bridge (messaging,
  images/files, automations) and real-directory workspace Skills sync.
- **Phase 3 (Done)**: Universal Docker container & group chat support, isolated
  per-provider OAuth login (`agy acp --login`), connectivity testing, `_drain`
  idle handling, Antigravity/Gemini brand icons, Runner badges, and 5-hour /
  weekly quota `UsageBars`.
- **Optional future enhancements**:
  - Mid-turn `_interrupt` / steer forwarding to `agy`.
  - Additional HappyClaw MCP tools (e.g. `workspace_memory_*`, delegation,
    Feishu/Discord channel helpers) in `mcp-server.ts`.
  - Evaluating `agy acp` transport if live thinking text deltas or native
    multimodal input blocks become needed.
