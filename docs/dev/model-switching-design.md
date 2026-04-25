# Model Switching Implementation Spec

This is the canonical implementation spec for adding Claude/GPT(Codex) model
switching to HappyClaw.

This file is written as the single document a GPT-5.5 coding agent should follow.
Do not treat `agent-auth.md` or `context-continuation.md` as separate normative
specs; their decisions have been merged here.

## How To Use This Spec

Implementation agents should read this document from top to bottom before
editing code.

Rules for implementation:

- This document is the source of truth for behavior.
- If code and this spec disagree, inspect the code and update this spec before
  implementing.
- Add Codex/GPT support without regressing current Claude behavior.
- Keep implementation layered. Do not start with UI commands before schema,
  resolver, continuation, and runner contracts exist.
- Prefer explicit failure over silent fallback when model intent is pinned.

## Current Code Anchors

Important current implementation points:

- Claude SDK runner:
  `container/agent-runner/src/index.ts`
  - reads `ANTHROPIC_MODEL` into `CLAUDE_MODEL`;
  - calls Claude `query(...)`;
  - passes `resume` and `resumeSessionAt`;
  - emits `StreamEvent`;
  - handles Claude resume failure with limited history injection.

- Stream event contract:
  `src/stream-event.types.ts`
  - copied to runner and web packages during build;
  - adapters must normalize to these event names.

- Session storage:
  `src/db.ts`
  - current `sessions(group_folder, session_id, agent_id)`;
  - `getSession`, `setSession`, `deleteSession`;
  - startup migrations and workspace deletion paths.

- In-memory session cache:
  `src/index.ts`
  - global `sessions: Record<string, string>`;
  - main workspace runs read `sessions[group.folder]`;
  - conversation agents call `getSession(groupFolder, agentId)`;
  - startup recovery mutates old sessions.

- Queue and process lifecycle:
  `src/group-queue.ts`
  - `requestGracefulRestart`;
  - `closeAllActiveForCredentialRefresh`;
  - IPC `_drain`, `_close`, `_interrupt`;
  - virtual JIDs for agents and task runs.

- Current runner split:
  `container/agent-runner/src/index.ts`
  - Claude still uses the mature legacy main loop that owns Claude SDK
    `query(...)`, live IPC message injection, `resumeAt`, PreCompact hooks,
    memory flush, `CLAUDE.md` update, Task/sub-agent event conversion, and
    usage extraction;
  - Codex uses the newer `AgentRuntimeAdapter` boundary through
    `codex-sdk-runner.ts` / optional CLI fallback;
  - this means the first implementation intentionally has two internal runner
    paths. Product behavior is unified through the control plane and canonical
    `StreamEvent`, but the runner implementation is not yet fully unified.

- Provider config and pool:
  `src/runtime-config.ts`, `src/container-runner.ts`, `src/provider-pool.ts`,
  `src/routes/config.ts`.

- Slash commands:
  `src/index.ts`, `src/commands.ts`
  - current commands include `/clear`, `/list`, `/status`, `/recall`, `/where`,
    `/bind`, `/new`, `/require_mention`, `/owner_mention`, `/sw`, `/spawn`,
    `/model`;
  - `/model use` is supported in Web and IM command paths.

- Scheduled tasks:
  `src/task-scheduler.ts`
  - creates dedicated `task-...` workspaces;
  - currently uses old session lookup by task workspace folder.

- Permissions:
  `src/permissions.ts`, `src/web-context.ts`
  - `manage_system_config`;
  - `manage_group_env`;
  - `canAccessGroup`;
  - `hasHostExecutionPermission`;
  - `canModifyGroup`.

## Product Decisions

First version supports:

- Claude existing behavior unchanged.
- Official Codex via ChatGPT OAuth.
- Official OpenAI API key for Codex/API-billed usage.
- Switching workspace main conversations.
- Switching persistent conversation agents.
- Provider-pool based model selection.
- Web-authenticated model switching.
- IM model status/list commands and IM `/model use`.
- Native resume when runtime/provider/auth/model identity is compatible.
- Soft context injection when native resume is unsafe or impossible.

First version does not support:

- Per-user Codex auth.
- Third-party OpenAI-compatible Codex providers.
- Automatic cross-runtime fallback.
- Complete official model catalog for Claude or GPT/Codex SDK/OAuth providers.
- Scraping interactive SDK model pickers.
- Switching raw SDK session/thread IDs.
- Switching transient SDK task agents.
- Switching already-running spawn agents.
- Cascading workspace default changes into every existing conversation agent.
- Live interruption/restart of a running turn solely because model changed.
- HappyClaw as a complete cross-runtime memory authority.
- Claude/Codex private memory merge, diff, or conflict resolution.
- Durable rolling conversation summaries as part of model switching.

## Settled Architecture Summary

The first version has four explicit layers.

1. Control plane:
   - HappyClaw stores provider pools, provider auth profiles, model options,
     workspace defaults, conversation/agent bindings, native session references,
     command/API permissions, UI state, audit, usage, and availability.
   - Users select a pool/model intent such as `gpt gpt-5.5` or
     `claude claude-opus-4.7`, not a concrete provider account.
   - Resolver chooses a concrete healthy provider inside the selected pool at
     run time and never silently falls back across pools or pinned models.

2. Runtime adapters:
   - Claude adapter owns Claude SDK query/resume/event conversion/auth files.
   - Codex adapter owns Codex SDK/CLI thread/resume/event conversion,
     `CODEX_HOME`, and Codex config.
   - Both adapters consume one runtime-aware runner input contract and emit the
     canonical HappyClaw stream/event envelope.
   - Host and container execution must both work for Claude and Codex.

3. Context and continuation:
   - Same-runtime compatible turns prefer native resume.
   - Cross-runtime/provider/auth/model changes and resume failures use one
     lightweight soft injection on the next turn.
   - Soft injection contains recent messages and a minimal handoff note only.
   - `CLAUDE.md` is not soft-injected. Claude and Codex must load the same
     canonical `CLAUDE.md` through their native project-instruction mechanisms.
   - HappyClaw does not merge Claude/Codex private memory or run a background
     rolling summary system for model switching.

4. Tooling and product behavior:
   - HappyClaw built-in tools, MCP catalog, skills, workspace file policy,
     scheduling, message sending, and permissions remain HappyClaw canonical
     capabilities.
   - Adapters translate those canonical capabilities into Claude/Codex-specific
     tool/MCP wiring.
   - Web and IM both support `/model`, `/model list`, and `/model use`.
   - IM `/model use` follows existing IM routing/gating and does not require
     HappyClaw owner identity mapping.

Operational constraints:

- Keep current Claude behavior as the compatibility baseline.
- Codex is enabled only when provider auth, dependency probes, and tool/MCP
  conformance checks pass.
- Missing Codex usage/cost data is recorded as zero cost; this is not a hard
  billing system.
- Every schema migration must create a timestamped SQLite backup before
  changing tables.

## Concepts And Scope

HappyClaw concepts:

- Chat window: message entry/display point, identified by `chat_jid`.
- Workspace: execution/file/instruction context, identified by
  `registered_groups.folder`.
- Conversation agent: persistent sub-conversation under a workspace, identified
  by `agent_id`.
- SDK session: native Claude/Codex continuation state.
- User session: web login session. It is unrelated to model switching.

The stable switching unit is:

```text
ConversationScope = (group_folder, agent_id)
```

Rules:

- Workspace main conversation uses `agent_id = ''`.
- Conversation agents use their own `agent_id`.
- IM chats resolve to a target conversation scope before reading or changing
  model state.
- IM `/model use` is authorized by existing IM channel routing/gating only; it
  does not require HappyClaw owner identity mapping.
- Model switching is not attached directly to `chat_jid`.
- Raw native SDK session/thread IDs are internal.

Supported switching targets:

- workspace main conversation: `(group_folder, '')`;
- persistent conversation agent: `(group_folder, agent_id)`.

Not direct switching targets:

- raw `chat_jid`;
- native SDK session/thread IDs;
- transient `task` agents;
- already-running `spawn` agents;
- every agent under a workspace as one cascade operation.

Agent kinds:

- `task`: internal task records produced by SDK Task/sub-agent tool events; users
  do not switch them directly.
- `spawn`: one-shot parallel work created by `/sw` or `/spawn`; it copies the
  parent scope's runtime/provider pool/model when created and runs to completion.
- `conversation`: persistent user-created conversation agent; switchable.

## Runtime Capability Ownership

The model switch must not create separate Claude and Codex product worlds.
HappyClaw owns user-visible semantics; SDKs provide runtime-specific
implementation mechanisms.

Decision rule:

- If a capability is visible to users, needs cross-runtime consistency, requires
  database state, permissions, audit, recovery, or UI/IM rendering, it is a
  HappyClaw canonical capability.
- If a capability exists only to let one SDK execute work, continue a native
  conversation, load files, expose tools, or stream SDK events, it is a runtime
  adapter detail.

Canonical HappyClaw capabilities:

- workspace, chat, conversation agent, scheduled task, spawn, and conversation
  scope identity;
- workspace/runtime/model binding and `/model use`;
- provider pools, auth profiles, and credential generations;
- the canonical instruction/context file graph;
- HappyClaw built-in tools and side effects:
  `send_message`, `send_image`, `send_file`, `schedule_task`, `list_tasks`,
  task control, memory tools, skill management, group registration, and model
  commands;
- user/workspace MCP server catalog;
- skills registry and `SKILL.md` format;
- workspace tree/file context policy;
- execution profile requirements such as container/host mode, PATH, installed
  CLI dependencies, sandbox, and permission phases;
- normalized stream events, usage records, audit, and billing;
- lightweight handoff/context maintenance phases and instruction update.

Runtime adapter details:

- Claude SDK `query(...)`, `settingSources`, `resume`, `resumeSessionAt`,
  `Read`/`Edit`/`Bash`/`Task`/`Skill`, Claude native memory loading, Claude
  transcript JSONL, and Claude event shapes;
- Codex SDK/CLI threads, `CODEX_HOME`, `project_doc_fallback_filenames`,
  Codex native shell/edit/apply behavior, Codex sessions, and Codex JSON events;
- how a canonical MCP server is wired into a runtime;
- how a canonical tool policy is translated into a runtime-specific allow/deny
  or sandbox flag set.

Rules:

- Do not expose raw SDK session/thread IDs as product state.
- Do not let Claude `Task` or any Codex-native delegation feature define the
  HappyClaw sub-agent product contract. They may be used only as optimization or
  implementation mechanisms.
- Do not fork separate Claude and Codex implementations for the same HappyClaw
  side effect. The side effect boundary is HappyClaw IPC, database, and file
  roots; adapters only translate runtime calls into that boundary.
- If a runtime lacks a native equivalent for a canonical capability, implement
  the capability in HappyClaw runner/control-plane code or return an explicit
  runtime-unavailable error. Do not silently change semantics.

## Harness Thickness And Context Layers

HappyClaw should be a thin Context & IO Harness for model switching, not a thick
agent orchestrator.

Thin Harness responsibilities in this feature:

- build clear runtime input from HappyClaw facts;
- choose native resume vs soft handoff;
- provide runtime-specific project-instruction loading policy;
- launch the selected SDK/CLI with isolated auth and workspace environment;
- expose the same HappyClaw tools/MCP/skills to every runtime;
- normalize final text, stream events, usage, errors, and tool lifecycle events;
- persist native session references and model binding state;
- protect product-level permissions, routing, audit, and billing.

SDK responsibilities:

- reason over the given input;
- decide whether and how to use available tools;
- manage SDK-private session, compaction, cache, and memory;
- emit native events that adapters translate;
- handle runtime-internal planning, delegation, and retries.

Do not build these in first-version model switching:

- complete Context Manager;
- complete State Store;
- persistent Run Tree;
- branch/merge manager;
- cross-runtime private memory reconciliation;
- step-level replay/recovery.

Those are future platform capabilities and should be added only when real
product requirements demand them.

Context layering for cache correctness:

```text
Stable layer:
  system rules, channel rules, canonical project instructions loaded by SDK,
  selected tool/MCP/skill catalog, runtime config

Session layer:
  native SDK session/thread, SDK compaction/private memory, HappyClaw native
  session reference, optional recovery marker

Turn layer:
  current pending messages, attachments, slash-command result, one-time handoff
  context, task/scheduled prefix
```

Rules:

- Keep the stable layer stable and native where possible. Do not prepend
  `CLAUDE.md` when the runtime can load it natively.
- Same-runtime compatible turns rely on the session layer.
- Soft injection is turn-layer context and must not become durable memory.
- Debug dumps should record canonical input, runtime input, raw runtime output,
  normalized output, runtime/session identifiers, and injected block kinds.
- Runtime event attribution may use lightweight `runId`, `parentRunId`,
  `eventSeq`, and raw event metadata for UI/debug grouping, but first version
  does not require a persistent Run Tree.

## Canonical Instruction And Context Graph

First version keeps the existing HappyClaw file graph as the only canonical
instruction/context graph:

```text
data/groups/<folder>/CLAUDE.md
data/groups/user-global/<userId>/CLAUDE.md
data/groups/user-global/<userId>/memory/YYYY-MM-DD.md
data/groups/<folder>/conversations/*.md
```

`CLAUDE.md` is the historical file name, not a Claude-only semantic contract.
It means HappyClaw canonical agent instructions and durable workspace notes. Do
not create a second persistent `AGENTS.md` graph for Codex.

Boundary decision:

- HappyClaw does not become a complete memory system in this feature.
- SDK native sessions, compaction, and private memory remain runtime-local
  optimizations owned by Claude/Codex.
- HappyClaw owns only explicit canonical files and the lightweight context
  needed when a native session cannot be safely resumed.
- Do not add a durable rolling conversation-summary database as part of model
  switching. Existing message history is already the durable product record.
- If a future memory feature is needed, design it separately instead of hiding
  it inside model switching.

Loading rules:

- Claude may use native Claude Code loading for `CLAUDE.md`,
  `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules`, and `@import`
  support where current HappyClaw behavior already relies on it.
- Codex must be configured to load the same project-level `CLAUDE.md` hierarchy,
  using `project_doc_fallback_filenames = ["CLAUDE.md"]` or the SDK/CLI
  equivalent.
- Codex must not rely on generated `AGENTS.md` as a second source of truth.
- Soft injection must not include the full workspace/project `CLAUDE.md` body.
  Target runtimes read workspace `CLAUDE.md` through their native
  project-instruction mechanism.
- The user-global `data/groups/user-global/<userId>/CLAUDE.md` is not treated as
  workspace handoff. Until both runtimes have a proven native cross-directory
  global-memory contract, HappyClaw may inject a bounded `<global-memory>` block
  from the user-global file into the stable system prompt. This is intentional
  compatibility glue, not a second durable memory source.
- If extra injection is needed for cross-runtime continuation, inject it as
  transient runtime context only. Do not persist a second file that can drift
  from `CLAUDE.md`.

Maintenance rules:

- Claude and Codex both update the same canonical files.
- Maintenance prompts must be runtime-neutral: update the same sections, keep
  the same size/format rules, and avoid Claude-only or Codex-only wording inside
  the canonical files.
- Model-specific tool names and runtime quirks belong in system prompts or
  adapter code, not in canonical `CLAUDE.md` content.
- If the file graph is later renamed, migrate once to one new canonical graph.
  Do not maintain parallel names by default. Symlinks may be used only as a
  compatibility view when they cannot create duplicate loading or ambiguous
  writes.

Codex memory/compact first-version rule:

- Claude keeps the existing `PreCompact` hook path: flush partial text, archive
  the Claude transcript when allowed, run memory flush, update workspace
  `CLAUDE.md`, and auto-continue.
- Codex SDK/CLI does not expose an equivalent `PreCompact` hook in the current
  integration. HappyClaw must not fake Claude compaction events or run an
  unrestricted hidden maintenance turn.
- Codex receives an explicit runtime-memory prompt that says: maintain the same
  canonical files during the current turn, do not wait for a compaction hook,
  do not create `AGENTS.md`, and respect privacy/disabled-memory modes.
- Home Codex runs may edit user-global `CLAUDE.md` and call `memory_append`.
  Non-home Codex runs treat global/date memory as read-only and may maintain
  only the workspace `CLAUDE.md`.
- HappyClaw's DB messages remain the canonical product transcript for Codex.
  Native Codex sessions remain runtime-local cache/state.

Practical first-version behavior:

- Normal same-runtime turns rely on native resume and do not replay recent
  history every time.
- New/pending user messages are always sent as the current prompt.
- Cross-runtime switches and resume failures may inject recent messages once as
  handoff context.
- The injected handoff context is not a memory update and is not persisted as a
  second truth source.

## Provider Model And Pools

`/model use` selects a model family/pool and model intent. It does not select
one concrete account/provider.

Provider families:

- `claude`: Claude runtime/account family.
- `gpt`: GPT/Codex runtime/account family.

First-version pools:

- `claude`: enabled Claude providers in the Claude account pool.
- `gpt`: enabled official Codex/OpenAI providers in the GPT/Codex account pool.

Pools are first-class control-plane entities. Do not reuse the current singleton
`providerPool` as-is after adding GPT/Codex.

```sql
CREATE TABLE provider_pools (
  provider_pool_id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  display_name TEXT NOT NULL,
  balancing_strategy TEXT NOT NULL DEFAULT 'round_robin',
  enabled INTEGER NOT NULL DEFAULT 1,
  unhealthy_threshold INTEGER NOT NULL DEFAULT 3,
  recovery_interval_ms INTEGER NOT NULL DEFAULT 60000,
  metadata_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
```

Default rows:

```text
claude -> runtime claude, provider_family claude, display_name Claude
gpt    -> runtime codex,  provider_family gpt,    display_name GPT
```

Provider-pool selection must be isolated per `provider_pool_id`:

- provider membership is filtered by `provider_pool_id`;
- round-robin/failover cursors are per pool;
- health, cooldown, failure counts, and active session counts are per
  `(provider_pool_id, provider_id)`;
- Claude provider failures must not affect GPT provider choice, and vice versa;
- model option availability is computed inside one pool only.

Examples:

- `/model use claude claude-opus-4.7` uses the Claude provider pool.
- `/model use gpt gpt-5.5` uses the GPT/Codex provider pool.

Resolver behavior:

- Choose an actual enabled provider inside the selected pool at run time.
- Prefer the same concrete provider when it owns a compatible native session.
- If that provider is unavailable or credentials changed, choose another provider
  from the same pool and use soft injection.
- Never silently change the selected model.
- Never fallback across provider families for a pinned selection.

Suggested provider metadata:

```ts
type AgentRuntime = 'claude' | 'codex';

type AgentProviderAuth =
  | { kind: 'anthropic_api_key' }
  | { kind: 'anthropic_oauth' }
  | { kind: 'anthropic_compatible' }
  | { kind: 'openai_api_key' }
  | { kind: 'codex_chatgpt_oauth' };

interface AgentProvider {
  id: string;
  name: string;
  runtime: AgentRuntime;
  providerFamily: 'claude' | 'gpt';
  providerPoolId: string;
  auth: AgentProviderAuth;
  model?: string;
  enabled: boolean;
  authProfileGeneration: number;
  authProfileFingerprint: string;
  createdAt: string;
  updatedAt: string;
}
```

Provider maintenance rules:

- Claude official OAuth/API-key/compatible providers belong to the `claude`
  family and Claude provider pool.
- Official Codex ChatGPT OAuth and OpenAI API-key providers belong to the `gpt`
  family and GPT/Codex provider pool.
- A provider can only serve model options configured for its family/pool.
- Public config can include provider ID, display name, runtime, provider family,
  provider pool, model, health, auth generation, and masked credential status.
- Public config must not include raw token/key material.

Implementation note:

- Replace `src/provider-pool.ts` singleton usage with a manager keyed by
  `provider_pool_id`.
- Existing Claude providers are assigned to `claude` during lazy migration.
- New Codex providers are assigned to `gpt`.
- A disabled pool makes every model in that pool unavailable even if individual
  providers are healthy.

## Authentication

Authentication is provider configuration, not conversation state.

### Current Claude Auth

Current Claude auth behavior:

- official API key is injected as `ANTHROPIC_API_KEY`;
- Claude OAuth credentials are written to per-session `.credentials.json`;
- legacy `CLAUDE_CODE_OAUTH_TOKEN` is only used when full OAuth credentials are
  absent;
- third-party Claude-compatible providers use `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, and optional `ANTHROPIC_MODEL`;
- the Claude Agent SDK runs with `permissionMode: 'bypassPermissions'`;
- maintenance turns restrict tools with `disallowedTools`.

Keep current Claude behavior stable while adding runtime-aware abstractions.

### Official Codex Auth Modes

Official Codex supports:

1. ChatGPT sign-in
   - subscription/workspace based;
   - follows ChatGPT workspace permissions, RBAC, retention, and residency;
   - Codex refreshes active sessions automatically;
   - cached credentials live in `CODEX_HOME/auth.json` when file storage is
     selected.

2. API key
   - usage billed through the OpenAI Platform/API account;
   - follows API organization data-handling settings;
   - better for non-interactive/server-side automation.

First-version decision:

- Codex providers are global/admin-managed, following the existing Claude
  provider pattern.
- Do not build per-user Codex auth.
- A Codex OAuth provider represents the configured HappyClaw service identity,
  not the end user's personal ChatGPT identity.

### Codex OAuth Scheme

HappyClaw must not implement OpenAI OAuth token refresh itself in the first
version.

Instead:

1. Create one isolated Codex home per HappyClaw Codex OAuth provider/profile.
2. Write a minimal Codex config in that home:

   ```toml
   cli_auth_credentials_store = "file"
   forced_login_method = "chatgpt"
   ```

3. Run the official Codex login flow with `CODEX_HOME` pointing at that provider
   home.
4. Treat the resulting `auth.json` as secret material.
5. Run Codex SDK/CLI calls with the same `CODEX_HOME`.
6. Let Codex refresh ChatGPT-login tokens during normal runtime use and persist
   the updated `auth.json` in the provider home.

HappyClaw login UX should stay close to the existing Claude OAuth pattern:

- `POST /api/config/codex/oauth/start` requires `manage_system_config`.
- The start call creates or targets one Codex OAuth provider, allocates its
  provider-scoped `CODEX_HOME`, writes `config.toml`, and starts the official
  Codex login flow for that home.
- The UI shows the official login URL/code/instructions produced by the Codex
  flow. HappyClaw does not implement the OpenAI OAuth protocol itself and does
  not parse token fields out of browser redirects.
- `POST /api/config/codex/oauth/cancel` stops an in-progress login for that
  provider and releases the provider lock.
- `POST /api/config/codex/oauth/complete` or passive status polling validates
  that `auth.json` now exists in the provider home, records masked status,
  increments auth generation, audits the actor, and drains affected idle
  runners before their next turn.
- If the official login flow cannot be driven in a headless deployment, first
  version may support an explicit admin import of an `auth.json` produced by
  the same official Codex login flow. This is a manual admin action, not
  background sync from host `~/.codex`.

Logical path:

```text
data/config/codex-providers/<providerId>/codex-home/
  auth.json
  config.toml
```

Rules:

- `CODEX_HOME` must be persistent, provider-scoped, and writable.
- Container execution should mount this provider home, or a provider-scoped
  writable credential volume.
- Do not copy `auth.json` into an ephemeral workspace.
- Never use the process owner's default `~/.codex` implicitly.
- Never sync host `~/.codex/auth.json` into HappyClaw as a background side
  effect.
- Never copy a user's personal Codex auth into a shared provider without an
  explicit admin action.
- Status/probe reads are passive and must not rewrite `auth.json`.
- Login, logout, credential deletion, future refresh, and normal OAuth runtime
  calls take a per-provider lock.

This is enough for automatic refresh as long as Codex is run with the same
persistent writable `CODEX_HOME`. If a future Codex SDK exposes a stable
server-side refresh API, HappyClaw can add proactive refresh later.

### Codex API Key Scheme

API key mode:

- Store key encrypted at rest.
- Expose only masked status in API/UI.
- Prefer Codex SDK explicit `apiKey` option.
- If a CLI path is used, inject through isolated env/file material, not command
  arguments.
- Avoid global process env mutation.
- Do not inherit unrelated host `OPENAI_API_KEY` or `CODEX_HOME`.

### Runtime Auth Material

Each runtime adapter converts a selected concrete provider into runtime-specific
auth material.

```ts
interface RuntimeAuthMaterial {
  env: Record<string, string>;
  files: Array<{
    relativePath: string;
    mode: number;
    content: string;
  }>;
  runtimeHome?: string;
}
```

Claude adapter:

- continue building `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`;
- continue writing `.credentials.json` for Claude OAuth;
- preserve current behavior.

Codex OAuth adapter:

- produce isolated `CODEX_HOME`;
- write/update Codex config forcing ChatGPT login and file credential store;
- do not expose token fields to HappyClaw runtime logic;
- launch Codex SDK/CLI with that `CODEX_HOME`.

Codex API key adapter:

- use SDK `apiKey` when available;
- otherwise inject `CODEX_API_KEY` or documented Codex env through isolated
  runtime environment;
- avoid global env mutation.

### Auth Lifecycle

Provider operations:

- create/update/delete Codex OAuth provider metadata;
- start/complete/cancel Codex ChatGPT login for one provider;
- logout/delete `auth.json` for one provider;
- create/update/delete Codex API-key provider;
- show masked/passive provider status;
- show last successful use and last failure;
- disable provider without deleting conversation state;
- increment auth generation when credentials are replaced or removed.

Permissions:

- Provider credential/config mutation requires `manage_system_config`.
- Future workspace provider override requires `manage_group_env` plus workspace
  access.
- Running an agent still requires normal workspace access through
  `canAccessGroup`.
- Host execution remains admin-only through `hasHostExecutionPermission`.
- Agent runtime permissions are separate from model auth and are handled by
  workspace/container isolation, sandbox settings, and runtime tool controls.

Credential changes:

- Do not kill an in-flight turn.
- Active turn continues with auth material it started with.
- Provider is marked changed/dirty after successful credential mutation.
- Idle runners use new auth immediately.
- Active runners for that provider are drained/restarted before their next turn.
- If next turn starts and provider is missing/disabled, fail with provider
  unavailable and ask owner to switch model/provider pool.

### Provider Settings UI

Settings UI must mirror the existing Claude provider management experience.

First-version UI requirements:

- Keep Claude provider management in the Claude settings tab.
- Add an independent GPT/Codex settings tab, for example
  `/settings?tab=gpt`, next to `/settings?tab=claude`.
- The GPT tab manages only `gpt` provider-family providers and model options.
- The Claude tab manages only `claude` provider-family providers and model
  options.
- Both tabs show provider display name, enabled state, auth kind, masked auth
  status, provider pool, selected/default model info, health, last success, last
  error, auth generation, and dependency/probe status where relevant.
- Raw token/key material is never shown.
- GPT provider creation supports:
  - official ChatGPT OAuth provider;
  - official OpenAI API-key provider.
- GPT OAuth creation includes a one-click login/start button equivalent to the
  Claude OAuth UI pattern. The button calls the HappyClaw Codex OAuth start API,
  then shows the official Codex login URL/code/instructions and status.
- GPT OAuth status polling must be passive and must not parse or expose token
  contents.
- GPT API-key form stores the key as secret material and only shows masked
  status after save.
- Provider delete/logout actions must clearly distinguish disabling a provider,
  deleting its auth material, and deleting provider metadata.
- Model option management is pool-level, not per-provider by default.

The GPT tab must also surface dependency readiness:

- Codex CLI found/not found;
- Codex SDK package installed/not installed if SDK path is enabled;
- host runner probe;
- container runner probe;
- MCP bridge smoke status;
- actionable install/rebuild hint when unavailable.

### Auth Generation

`authProfileGeneration` increments whenever provider credential material is
replaced or removed:

- Codex OAuth re-login;
- Codex API-key rotation;
- Claude OAuth replacement;
- Claude API-key/token replacement;
- credential deletion/logout.

`authProfileFingerprint` is non-secret metadata used for cache/session
invalidation. It must not be a reusable token or raw key hash that leaks secret
material.

Native resume is allowed only when provider ID, auth generation, and model
identity are compatible.

### Environment Isolation

Runtime env construction must be provider-scoped.

Required behavior:

- Start from a minimal allowed base env needed for filesystem, locale, timezone,
  and runtime execution.
- Explicitly inject selected provider auth material.
- Strip unrelated Claude and Codex/OpenAI reserved keys before launch.
- Prevent workspace custom env from overriding reserved model-auth keys.
- Never pass raw API keys in command-line arguments.
- Keep raw token/key material out of logs, error messages, audit detail, and
  stream events.

Sanitize at least:

```ts
const RESERVED_MODEL_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
]);
```

Host mode is especially sensitive because child processes can inherit variables
from the server operator's shell.

### Provider Disable/Delete

Disabling or deleting a provider is not deleting conversations.

Rules:

- Conversation state remains intact.
- Scopes pinned to a pool with no enabled providers become unavailable.
- Default-following scopes may re-resolve through remaining defaults.
- Provider-scoped `provider_model_options` can be deleted with the provider.
- Pool-level `provider_pool_model_options` remain unless an admin explicitly
  edits the pool menu.
- Provider-owned `CODEX_HOME` can be deleted only as part of explicit provider
  deletion/logout, not `/clear`.
- Audit which admin performed provider change.

## Data Model

### Conversation Runtime State

```sql
CREATE TABLE conversation_runtime_state (
  group_folder TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  active_runtime TEXT NOT NULL,
  active_provider_family TEXT NOT NULL,
  active_provider_pool_id TEXT NOT NULL,
  active_selected_model TEXT,
  active_model_kind TEXT NOT NULL,
  active_resolved_model TEXT,
  binding_source TEXT NOT NULL,
  binding_revision INTEGER NOT NULL DEFAULT 0,
  pending_runtime TEXT,
  pending_provider_family TEXT,
  pending_provider_pool_id TEXT,
  pending_selected_model TEXT,
  pending_model_kind TEXT,
  pending_resolved_model TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_folder, agent_id)
);
```

Fields:

- `active_runtime`: `claude` or `codex`.
- `active_provider_family`: `claude` or `gpt`.
- `active_provider_pool_id`: selected account pool, not one provider.
- `active_selected_model`: user/default selected model string.
- `active_model_kind`: how to interpret selected model.
- `active_resolved_model`: actual model observed/resolved for recent compatible
  run, when known.
- `binding_source`: `system_default`, `workspace_default`,
  `copied_workspace_default`, or `user_pinned`.
- `binding_revision`: increments whenever accepted model binding for the scope
  changes. Active runners store the revision they started with; a later message
  must not be IPC-injected into a runner with an older revision.
- `pending_*`: switch requested while a turn is running.

### Model Selection Kinds

```ts
type ModelSelectionKind =
  | 'provider_default' // no model override; concrete provider uses its default
  | 'runtime_default' // ask SDK/runtime to use default if it supports marker
  | 'alias' // e.g. Claude `opus`, `opus[1m]`
  | 'explicit_version' // e.g. `claude-opus-4-7`
  | 'custom'; // admin/user-entered provider-specific string
```

User intent must be preserved:

- `opus` means follow latest Opus alias.
- `claude-opus-4-7` means pin exact version.
- provider default means omit model override and let concrete provider decide.
- GPT pool default means let selected GPT/Codex provider/account default decide.

### Native Runtime Sessions

Native continuation state is keyed by concrete provider, auth generation, and
model identity.

```sql
CREATE TABLE conversation_runtime_sessions (
  group_folder TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  provider_pool_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  auth_profile_generation INTEGER NOT NULL DEFAULT 0,
  auth_profile_fingerprint TEXT,
  model_key TEXT NOT NULL,
  selected_model TEXT,
  model_kind TEXT NOT NULL,
  resolved_model TEXT,
  native_session_id TEXT NOT NULL,
  native_resume_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    group_folder,
    agent_id,
    runtime,
    provider_id,
    auth_profile_generation,
    model_key
  )
);
```

`model_key` identity:

```text
<runtime>:<providerId>:<authGeneration>:<selectionKind>:<effectiveModelIdentity>
```

`effectiveModelIdentity` rules:

- explicit version/custom: selected model string;
- alias/default with known resolved model: resolved model string;
- alias/default without known resolved model: selected identity such as
  `alias:opus` or `default`.

Prefer resolved model when runtime reports it. If runtime cannot reveal resolved
model before/after run, use selected identity.

Rules:

- `provider_id` must be non-empty.
- Lazy migration can use synthetic `__legacy_claude__` when old Claude session
  cannot be attributed to a real provider.
- Unresolved pool-scoped sessions use synthetic `__pool__:<provider_pool_id>`.
  Resolvers should prefer a concrete provider ID whenever an enabled provider is
  known, especially for Codex OAuth/API-key providers.
- If a first run started with a provisional alias/default key and later reports
  an exact `resolved_model`, atomically re-key that native session row to the
  resolved-model `model_key`. If a row already exists for the canonical key,
  keep the newer `updated_at` row and delete the provisional row.
- If alias/default later resolves differently than the previous compatible run,
  create a new `model_key` and use soft injection.
- Native rows are internal; users choose pool/model, not SDK session IDs.

### System Default

System default is the source for new workspace defaults and for resolver
fallback when a legacy workspace has no explicit row yet.

```sql
CREATE TABLE system_model_default (
  id TEXT PRIMARY KEY DEFAULT 'global',
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  provider_pool_id TEXT NOT NULL,
  selected_model TEXT,
  model_kind TEXT NOT NULL,
  resolved_model TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
```

Rules:

- There is exactly one active row, `id = 'global'`.
- Initial migration uses current Claude behavior:
  - `runtime = 'claude'`;
  - `provider_family = 'claude'`;
  - `provider_pool_id = 'claude'`;
  - `selected_model = null` and `model_kind = 'provider_default'`, unless the
    current persisted Claude config has an explicit default model.
- Only system config owners can mutate system default.
- Mutating system default affects future workspaces only. Existing workspace
  defaults are not rewritten.
- Resolver fallback order is scope state, workspace default, system default,
  hardcoded compatibility default. The last step exists only for startup
  safety and should self-heal by inserting missing default rows.

### Workspace Defaults

```sql
CREATE TABLE workspace_model_defaults (
  group_folder TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  provider_pool_id TEXT NOT NULL,
  selected_model TEXT,
  model_kind TEXT NOT NULL,
  resolved_model TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
```

Behavior:

- New workspace copies system default.
- Workspace main conversation follows workspace default while not user-pinned.
- New conversation agent copies current workspace default into its own runtime
  state at creation.
- Workspace default changes affect future scopes and main conversations still
  following the default.
- New conversation agent state uses `binding_source =
'copied_workspace_default'`; it does not follow future workspace default
  changes unless product behavior changes later.
- Workspace default changes do not silently switch existing
  `copied_workspace_default` or `user_pinned` conversation agents.
- New spawn copies parent scope runtime/provider pool/model at creation.

### Provider Model Options

Model availability is not the same as official catalog.

Pool-level options are the user-facing model menu. Provider-level options are
observations about whether one concrete account can run a model.

```sql
CREATE TABLE provider_pool_model_options (
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  provider_pool_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_kind TEXT NOT NULL,
  display_name TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    provider_pool_id,
    model_id,
    model_kind
  )
);
```

```sql
CREATE TABLE provider_model_options (
  runtime TEXT NOT NULL,
  provider_family TEXT NOT NULL,
  provider_pool_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  auth_profile_generation INTEGER NOT NULL DEFAULT 0,
  auth_kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_kind TEXT NOT NULL,
  display_name TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved_model TEXT,
  metadata_json TEXT,
  last_verified_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    provider_id,
    auth_profile_generation,
    model_id,
    model_kind
  )
);
```

```ts
type ModelOptionSource =
  | 'runtime_default'
  | 'admin_configured'
  | 'observed_success'
  | 'observed_failure'
  | 'api_discovered';

type ModelOptionStatus =
  | 'available'
  | 'unverified'
  | 'unsupported'
  | 'stale'
  | 'hidden';
```

Availability sources:

1. Runtime default.
2. Admin-configured pool model options.
3. Observed successful models per concrete provider/auth generation.
4. Observed unsupported models per concrete provider/auth generation.
5. API-discovered models only for API-key providers where listing is supported.

Rules:

- Current implementation treats model catalog as a HappyClaw-managed control
  plane resource for both Claude and GPT/Codex. `/model list` reads
  `provider_pool_model_options`; there is no implemented automatic provider
  model-list fetch for Claude either.
- The first manual-catalog implementation seeds a small editable recommended
  menu for both pools so a fresh install does not expose only `default`.
  Seeded rows are still normal pool model options; admins can hide, rename, or
  add entries from the model settings page.
- SDK OAuth providers must not rely on API `/models` endpoints.
- Do not scrape interactive SDK pickers in first version.
- Admin-configured models are stored in `provider_pool_model_options`, not
  copied into every provider. Newly added providers inherit the same pool menu
  automatically.
- Provider-level success/failure/API discovery is stored in
  `provider_model_options` and scoped to concrete provider plus current auth
  generation.
- Provider-level observations and API-discovered models are optional
  enhancements; they must not be required for the first version to offer
  Claude/GPT switching.
- For OAuth providers, show runtime default plus admin-configured/observed
  options.
- For API-key providers, API-discovered models are an enhancement.
- Pool-level model is usable when at least one enabled provider in that pool can
  try or has verified the model.
- Pool-level model is unsupported only when every enabled provider in current
  auth generations is known unsupported, or admin hides/disables it.
- Adding or re-enabling a provider in a pool makes prior "every provider failed"
  conclusions non-final until that provider is tried or marked unsupported.
- `/model list` merges pool options and provider observations. Display pool
  options first, then observed provider-only models.
- Credential rotation makes old observations historical, not current.

### Message Metadata

Assistant messages should record what actually ran.

Suggested fields:

```ts
runtime: 'claude' | 'codex';
providerFamily: 'claude' | 'gpt';
providerPoolId: string;
providerId: string;
authProfileGeneration: number;
selectedModel: string | null;
modelKind: ModelSelectionKind;
resolvedModel: string | null;
modelDisplayName: string;
nativeSessionId: string | null;
```

Rules:

- Persist `resolvedModel` when adapter can determine it.
- If runtime cannot reveal resolved model, persist selected model and kind.
- Do not rewrite historical rows when alias/default changes later.

### Usage Metadata

Usage records should keep current Claude accounting working while allowing
Codex to report partial or unavailable cost data.

Schema extension:

```sql
ALTER TABLE usage_records ADD COLUMN runtime TEXT;
ALTER TABLE usage_records ADD COLUMN provider_family TEXT;
ALTER TABLE usage_records ADD COLUMN provider_pool_id TEXT;
ALTER TABLE usage_records ADD COLUMN provider_id TEXT;
ALTER TABLE usage_records ADD COLUMN auth_profile_generation INTEGER;
ALTER TABLE usage_records ADD COLUMN selected_model TEXT;
ALTER TABLE usage_records ADD COLUMN resolved_model TEXT;
ALTER TABLE usage_records ADD COLUMN billing_scope TEXT;
ALTER TABLE usage_records ADD COLUMN cost_status TEXT;
ALTER TABLE usage_records ADD COLUMN cost_source TEXT;
ALTER TABLE usage_records ADD COLUMN usage_metadata_json TEXT;
```

Logical fields:

```ts
source:
  | 'conversation'
  | 'conversation_agent'
  | 'spawn'
  | 'scheduled_task'
  | 'internal';
billingScope: 'workspace_owner' | 'system';
runtime: 'claude' | 'codex';
providerFamily: 'claude' | 'gpt';
providerPoolId: string;
providerId: string;
authProfileGeneration: number;
selectedModel: string | null;
resolvedModel: string | null;
costStatus: 'exact' | 'estimated' | 'unavailable';
costSource: 'runtime' | 'pricing_table' | 'zero_fallback' | 'legacy';
```

Internal AI usage is system cost. Conversation, conversation-agent, spawn, and
scheduled-task usage follows existing workspace owner billing unless product
decision changes billing.

First-version cost policy:

- Existing Claude cost handling remains unchanged and maps to
  `cost_status = 'exact'` when current code has `costUSD`.
- If Codex reports exact cost, record and deduct it normally.
- If Codex reports token usage but not exact cost, first version records
  `cost_usd = 0`, `cost_status = 'unavailable'`, and
  `cost_source = 'zero_fallback'`.
- If Codex reports no usable usage details, record the run with
  `cost_usd = 0`, `cost_status = 'unavailable'`, and metadata explaining that
  runtime usage was unavailable.
- This project is not a commercial billing product; missing Codex cost must not
  block ordinary use.
- Daily summaries continue summing `cost_usd`; unavailable Codex cost naturally
  contributes zero.
- `messages.token_usage` should include runtime metadata when available, but
  token metadata is audit/debug data, not a hard dependency for Codex launch.

Owner charging:

- Main conversation, conversation agents, spawn, and scheduled tasks use the
  workspace owner as billing owner when the current code can identify one.
- Internal AI uses `billing_scope = 'system'`.
- If legacy workspace owner data is missing, record usage with zero cost and
  explicit metadata instead of failing the agent run.

## Binding Sources

```ts
type BindingSource =
  | 'system_default'
  | 'workspace_default'
  | 'copied_workspace_default'
  | 'user_pinned';
```

Rules:

- New workspace gets workspace default copied from system default.
- Workspace main conversation follows workspace default until manually changed.
- New conversation agent copies workspace current default at creation and stores
  it as `copied_workspace_default`.
- Once a conversation scope is changed with `/model use` or Web equivalent, it is
  `user_pinned`.
- Workspace default changes do not automatically change existing
  `copied_workspace_default` or `user_pinned` conversation scopes.

Terminology:

- `default-following`: scope has not explicitly selected a model. It resolves
  from nearest default, usually workspace default.
- `copied_workspace_default`: scope copied the workspace default when created,
  but does not follow later default changes.
- `user_pinned`: scope was explicitly switched and keeps that binding until
  changed again.

## Model Resolver

All runtime calls go through resolver before starting an agent turn.

Input:

```ts
interface ModelResolveInput {
  groupFolder: string;
  agentId: string;
  modelSourceGroupFolder?: string;
  modelSourceAgentId?: string;
  requestedRuntime?: AgentRuntime;
  requestedProviderFamily?: 'claude' | 'gpt';
  requestedProviderPoolId?: string | null;
  requestedModel?: string | null;
  requestedModelKind?: ModelSelectionKind;
}
```

Output:

```ts
interface ModelResolveResult {
  runtime: AgentRuntime;
  providerFamily: 'claude' | 'gpt';
  providerPoolId: string;
  providerId: string;
  bindingRevision: number;
  authProfileGeneration: number;
  authProfileFingerprint: string;
  selectedModel: string | null;
  modelKind: ModelSelectionKind;
  resolvedModel: string | null;
  modelKey: string;
  displayName: string;
  authMaterialRef: string;
  availabilityStatus: 'available' | 'unverified' | 'unsupported' | 'stale';
}
```

Rules:

1. Resolve model binding scope.
   - Normal conversations use `(groupFolder, agentId)`.
   - Scheduled tasks use source workspace as `modelSourceGroupFolder` and task
     workspace only as runtime/session storage.
2. Resolve provider family/pool from explicit selection, workspace default, or
   system default.
3. Resolve selected model and model kind from conversation state or workspace
   default.
4. Prefer existing native session's concrete provider when it is still enabled,
   belongs to selected pool, has same auth generation, and can run selected
   model.
5. If no compatible concrete provider exists, select one from selected pool using
   pool rotation/failover.
6. For `provider_default`, omit model override unless provider config requires
   one.
7. For `runtime_default`, pass runtime default marker only if runtime supports
   one; otherwise omit model override.
8. For `alias`, pass alias string.
9. For `explicit_version` and `custom`, pass selected model string.
10. If selected model is unsupported for every enabled provider in selected pool
    and current auth generations, fail before launching runner.
11. If `resolvedModel` is unknown before run, use selected identity as
    provisional `modelKey`.
12. If run reports exact resolved model, update runtime state, message metadata,
    model option cache, native session row key, and future `modelKey` decisions.

Fallback rules:

- Provider rotation/failover is allowed only inside selected pool.
- Provider rotation must not change selected model.
- Pinned model failure across selected pool returns unavailable error.
- No cross-family fallback for first version.

## Model Commands And Web API

Commands:

```text
/model
/model list
/model list --all
/model use <pool> default
/model use <pool> <model>
/model use claude <model>
/model use gpt <model>
```

Behavior:

- `/model`: show current scope selected intent and resolved runtime/model.
- `/model list`: list enabled Claude/GPT pools and available model options.
  Each row must start with the exact `model_id` accepted by `/model use`;
  display names are secondary labels only.
- `/model list --all`: include hidden, stale, unsupported observed options.
- `/model use ...`: switch current conversation scope.

Command grammar:

- `<pool>` is the account pool, currently `claude` or `gpt`.
- `<model>` is a pool-level model option or a custom provider-specific model
  string if custom entries are allowed.
- The command never selects a concrete provider/account. Provider rotation stays
  inside the selected pool.
- `default` means provider default: omit model override unless the selected
  runtime requires an explicit default marker.
- `runtime default` is an internal `ModelSelectionKind`; first-version user
  syntax should prefer plain `default`.

Web API must expose two separate mutations and must address a workspace by a
canonical workspace identity, not by bare `registered_groups.folder`.
`registered_groups.folder` is not guaranteed unique across Web and IM rows.

Canonical workspace resolution:

- Preferred path identity is `workspaceJid`, because it maps to one
  `registered_groups.jid` row.
- If a compatibility endpoint accepts `groupFolder`, it must resolve to a
  canonical Web workspace row, then verify that every same-folder row with owner
  metadata has the same owner.
- If same-folder rows disagree on owner, or the canonical row is missing owner
  metadata, mutation is rejected and the UI should ask for workspace repair or
  migration.
- Read-only list/status endpoints may accept `groupFolder`, but mutations use
  canonical workspace authorization.
- First-version Web owner check is: authenticated user must be workspace owner
  for the canonical workspace row. IM does not get mutation endpoints.

Recommended route shape:

1. Set one conversation scope binding.

   ```http
   PUT /api/model/workspaces/:workspaceJid/scopes/main
   PUT /api/model/workspaces/:workspaceJid/agents/:agentId/model
   ```

   Body:

   ```json
   {
     "providerPoolId": "gpt",
     "model": "gpt-5.5",
     "modelKind": "explicit_version"
   }
   ```

   This resolves `workspaceJid` to canonical `groupFolder`, updates
   `conversation_runtime_state` for `(groupFolder, agentId)`, marks it
   `user_pinned`, increments `binding_revision`, and applies pending semantics
   if the scope is running.

2. Set workspace default.

   ```http
   PUT /api/model/workspaces/:workspaceJid/default
   ```

   Body:

   ```json
   {
     "providerPoolId": "claude",
     "model": "opus",
     "modelKind": "alias"
   }
   ```

   This updates `workspace_model_defaults`, increments the main conversation's
   binding revision only if it is still `workspace_default`, and does not touch
   `copied_workspace_default` or `user_pinned` conversation agents.

Compatibility route:

```http
PUT /api/model/scopes/:groupFolder
```

This may remain temporarily for internal callers, but it must call the same
canonical resolver and owner check before mutating anything.

First-version command decision:

- Web API/UI supports mutation because it has authenticated HappyClaw user.
- IM supports `/model`, `/model list`, and `/model use`.
- IM `/model use` mutates the conversation scope resolved from the current IM
  chat binding. If a Feishu thread maps to a conversation agent, the command
  targets that thread agent; otherwise it targets the bound main conversation
  or bound conversation agent.
- IM mutation permission follows existing IM gates: the chat must already be
  registered/bound/authorized by the channel path, and any mention/activation
  mode gates must have allowed the command to reach `handleCommand`. It does
  not prove or require HappyClaw workspace owner identity.

List display should include:

- runtime: `claude` or `codex`;
- provider pool display name, e.g. `Claude` or `GPT`;
- enabled provider count and masked aggregate health;
- auth kind/status: OAuth or API key, masked/passive;
- selection kind;
- model ID/display name;
- status;
- resolved model when known;
- source.

Example:

```text
Claude pool
  default              runtime default        available
  opus                 alias                  unverified, follows latest Opus
  opus[1m]             alias                  unverified, 1M context if allowed
  claude-opus-4-7      explicit version       admin configured
  claude-opus-4-6      explicit version       observed success

GPT pool
  default              runtime default        available
  gpt-5.5              explicit/custom        admin configured, unverified
  gpt-5.3-codex        explicit/custom        observed success
```

Permissions:

- `/model` and `/model list`: workspace access through `canAccessGroup`.
- Web `/model use`: resolved workspace owner only.
- IM `/model use`: existing IM channel authorization/gating only.
- Workspace default mutation: resolved workspace owner only.
- Provider credential/config mutation: `manage_system_config`.
- Future workspace provider override: `manage_group_env` plus workspace access.
- Host-mode execution: admin via `hasHostExecutionPermission`.

Owner resolution:

- normal workspace: `registered_groups.created_by`;
- conversation agent: owner of parent workspace;
- scheduled task workspace: task `created_by` or source workspace owner;
- admins do not bypass `/model` rules unless also resolved owner.

## Runtime Switch Behavior

When switch requested:

- if target scope idle, apply immediately;
- if target scope running, write pending binding;
- current turn is not interrupted;
- pending binding is promoted after the current turn completes;
- promotion increments `binding_revision`;
- next user message uses new active binding.

Active runner reuse guard:

- Every active runner records the `binding_revision`, runtime, provider pool,
  concrete provider, and model key it started with.
- If a scope has pending binding, `GroupQueue.sendMessage(...)` must not
  IPC-inject the next user message into the current runner after the current
  query returns.
- If current stored `binding_revision` differs from the active runner revision,
  treat that runner as stale for user-message IPC and return `no_active` so a
  fresh run is enqueued.
- After promoting pending binding, request drain/close for the old idle runner
  before the next user message is processed.
- This guard is required because current HappyClaw runners can stay alive for
  `idleTimeout` and accept follow-up IPC messages. Without it, a switch can be
  delayed indefinitely by continuous messages, not merely by one turn.

Concurrent switch requests:

- persist in command/message order;
- latest accepted switch before next turn wins;
- no first-version distributed transaction complexity.

Provider unavailable:

- If selected pool has no enabled providers, do not silently fallback.
- Show model/provider unavailable error.
- Ask owner to choose with `/model list` and `/model use`.
- Default-following scopes may re-resolve through new default.
- User-pinned scopes remain explicit until changed.

Concrete provider unavailable:

- Resolver may select another provider in same pool and soft-inject context.
- This is pool failover, not model fallback.

Selected model unavailable across pool:

- Record observed unsupported per provider/auth generation that returned error.
- Keep explicit selection unchanged.
- Return clear error naming selected model and provider pool.
- Suggest `/model list` and `/model use <pool> default` or another option.
- Do not downgrade from pinned version to alias/default.

## Continuation

HappyClaw must distinguish:

- Native resume: continue previous session inside same SDK/runtime/provider/auth
  generation/model identity.
- Soft injection: start a new SDK session and inject runtime-neutral context.
- Fresh: start with no injected context when no safe context exists.

Current Claude behavior:

- HappyClaw does not inject full conversation every turn.
- Claude SDK resume uses `options.resume = sessionId`.
- Claude SDK resume cursor uses `options.resumeSessionAt = resumeAt`.
- Claude restores its own transcript from per-workspace `.claude` directory.
- HappyClaw injects current prompt, system rules, memory recall, HEARTBEAT
  background, and channel/runtime instructions.
- On Claude resume failure, current code extracts recent messages from old
  Claude JSONL transcript and prepends compact `<system_context>` fallback.
- That fallback is limited and truncated, not full-history replay.

### Continuation Types

```ts
type ContinuationMode = 'native_resume' | 'soft_injection' | 'fresh';

interface RuntimeSessionRef {
  runtime: AgentRuntime;
  providerFamily?: string;
  providerPoolId?: string;
  providerId?: string;
  authProfileGeneration?: number;
  authProfileFingerprint?: string;
  selectedModel?: string;
  modelKind?: string;
  resolvedModel?: string;
  modelKey?: string;
  sessionId?: string; // Claude session_id or Codex thread_id
  resumeAt?: string; // Claude assistant uuid or runtime-specific cursor
}

interface ContinuationPlan {
  mode: ContinuationMode;
  runtime: AgentRuntime;
  resumeSessionId?: string;
  resumeAt?: string;
  injectedContext?: string;
  reason:
    | 'same_runtime'
    | 'runtime_changed'
    | 'provider_changed'
    | 'auth_profile_changed'
    | 'model_identity_changed'
    | 'resume_failed'
    | 'missing_session'
    | 'transcript_unavailable';
}
```

### Continuation Rules

Use native resume only when all are compatible:

- same runtime;
- same concrete provider;
- same auth generation;
- same compatible model identity;
- native session exists and runtime can resume it.

Use soft injection when:

- runtime changes;
- concrete provider changes within same pool;
- provider pool/family changes;
- auth generation changes;
- explicit model version changes;
- alias/default resolves to different model than previous compatible run;
- native resume fails.

Use fresh when:

- same identity but no session exists;
- usable history/transcript is unavailable.

On native resume failure:

- clear failed SDK session reference;
- build injected context;
- retry as fresh SDK session with soft injection.

### Lightweight Handoff Injection

Soft injection is a small handoff mechanism, not a memory system.

It exists only to avoid losing recent conversational context when native resume
is unsafe or impossible:

- runtime changes, for example Claude -> Codex or Codex -> Claude;
- concrete provider changes within the same pool;
- auth generation/fingerprint changes;
- explicit model identity changes;
- native resume fails;
- startup recovery clears a native session to avoid session ghosting.

Do not add a `conversation_context_summaries` table or background rolling
summary job for model switching. The first-version durable source is the
existing HappyClaw message database plus canonical files that SDKs read
natively.

Handoff source order:

1. Current pending messages:
   always included as the active prompt and never treated as historical context.
2. Recent HappyClaw messages from the same `ConversationScope`:
   at most `N` messages, default `N = 20`, excluding current pending messages
   and messages before the latest `/clear` / `context_reset`.
3. Runtime transcript fallback:
   Claude JSONL or Codex thread/session artifact may be used only after native
   resume failure when HappyClaw DB history is unavailable or incomplete.
4. Minimal switch note:
   one short system line explaining that the previous SDK session could not be
   directly resumed and the following block is background context.

Explicitly excluded from handoff injection:

- full workspace/project `CLAUDE.md` body;
- generated `AGENTS.md`;
- SDK private memory files as durable truth;
- old tool-result logs unless they are part of the recent messages selected
  from HappyClaw DB;
- rolling summaries generated by a background HappyClaw memory process.

`CLAUDE.md` loading rule:

- Claude reads `CLAUDE.md` through native Claude project-instruction loading.
- Codex reads the same `CLAUDE.md` by setting
  `project_doc_fallback_filenames = ["CLAUDE.md"]` or equivalent runtime config.
- HappyClaw may compute and store `workspaceInstructionHash` for diagnostics,
  session keying, or cache invalidation, but must not prepend the full file body
  during soft injection.
- HappyClaw may separately inject the user-global `CLAUDE.md` as bounded
  `<global-memory>` in the stable prompt. This exception exists because the
  global file applies across workspaces, while native project instruction loading
  is workspace-scoped and differs between runtimes.

Budget/safety:

- Do not inject full raw conversation by default.
- Keep handoff within a small configurable budget. First-version default is the
  latest 20 displayable messages with per-message truncation.
- Preserve the latest user/assistant turns first.
- Wrap handoff context as background, never as current user instruction.
- Mark recovered context as historical.
- Chinese conversations should use Chinese handoff instructions.
- Privacy-mode conversations do not persist additional handoff artifacts and may
  use only in-memory current-turn context.
- Mention context loss to the user only when it materially affects the turn.

Normal steady-state behavior:

- Same-runtime compatible turns use native resume and do not inject recent
  history.
- Same-runtime missing session starts fresh unless recovery/resume-failure logic
  can safely provide recent DB messages.
- Cross-runtime switches force one soft injection on the target runtime's first
  turn, then subsequent turns use the target runtime's native resume.

Injection shape:

```text
<system_context>
The previous SDK session cannot be resumed directly. Continue the conversation
using the following background context. Focus on the latest user message.

## Recent Conversation
...
</system_context>

<current_user_message>
...
</current_user_message>
```

Implementation requirements in current code:

- `src/runtime-injection-policy.ts`:
  - Claude: keep native project instructions enabled and do not prepend
    workspace instructions.
  - Codex: mark native project instructions as supported once the adapter
    configures `project_doc_fallback_filenames = ["CLAUDE.md"]`.
  - Codex: set workspace-instruction prompt injection to `never`.
  - Both runtimes: recent history injection is `when_soft_inject`.
- `src/runtime-input-builder.ts`:
  - Build handoff blocks only from recent messages and minimal handoff note.
  - Do not render `<workspace-instructions>` for Codex or Claude.
  - Keep `workspaceInstructionHash` as metadata if useful, but do not include
    the file body in the prompt.
- `container/agent-runner/src/codex-cli-runner.ts` and any future Codex SDK
  adapter:
  - pass Codex config equivalent to
    `project_doc_fallback_filenames = ["CLAUDE.md"]`;
  - set working directory to the workspace root so Codex discovers the same
    canonical file;
  - support the same behavior in host and container execution.
- Model switch command/API path:
  - when runtime/provider/auth/model identity changes, mark the next turn as
    requiring soft injection;
  - after the target runtime completes its first successful turn, persist the
    new native session and return to native resume.
- Tests:
  - Codex fresh/soft-inject tests should assert recent messages are injected and
    `CLAUDE.md` is not prepended;
  - a separate adapter/config test should assert Codex receives
    `project_doc_fallback_filenames = ["CLAUDE.md"]`.

## Runtime Session Store

Replace old `sessions` table accessors and global in-memory
`sessions: Record<string, string>` with a runtime-aware store.

Current paths to replace:

- main workspace runs read `sessions[group.folder]`;
- conversation agents call `getSession(groupFolder, agentId)`;
- scheduled tasks call `deps.getSessions()` and index by workspace folder;
- `/clear`, startup recovery, execution-mode migration, workspace deletion call
  `deleteSession` or mutate in-memory map.

Interface:

```ts
interface RuntimeSessionStore {
  getNativeSession(
    scope: ConversationScope,
    resolved: ModelResolveResult,
  ): RuntimeSessionRef | null;
  setNativeSession(
    scope: ConversationScope,
    resolved: ModelResolveResult,
    ref: RuntimeSessionRef,
  ): void;
  clearScope(scope: ConversationScope): void;
  clearWorkspace(groupFolder: string): void;
  clearByProvider(providerId: string, authProfileGeneration?: number): void;
  lazyMigrateLegacyClaude(scope: ConversationScope): RuntimeSessionRef | null;
}
```

Rules:

- Remove direct runtime reads from `sessions[group.folder]`.
- Keep old `getSession`/`setSession` wrappers only as temporary compatibility
  shims.
- Startup recovery clears runtime sessions for affected scope, not only old
  Claude row.
- `/clear` clears all native sessions for current scope while preserving model
  binding.
- Scheduled tasks use task workspace as native session scope and source
  workspace as model binding scope.
- Old `sessions` rows migrate into `conversation_runtime_sessions` using runtime
  `claude`, provider `__legacy_claude__`, auth generation `0`, and current
  default Claude model identity.

## Runner And Adapter Boundary

Do not add Codex by threading more Claude-shaped env vars through existing
runner. First add runtime-aware runner input/output.

Current Claude-specific protocol:

- host passes `sessionId` as single string;
- runner imports Claude Agent SDK directly;
- runner reads `ANTHROPIC_MODEL` into `CLAUDE_MODEL`;
- session files live under `.claude`;
- usage fallback keyed by Claude model string.

Current implementation caveat:

- Claude and Codex do not yet share one fully unified runner implementation.
- Claude remains in the legacy long-running query loop because that path carries
  mature behavior: live IPC follow-up injection, interrupt requeue,
  PreCompact-driven memory flush, `CLAUDE.md` maintenance, Claude Task/sub-agent
  lifecycle mapping, and Claude-specific usage parsing.
- Codex runs through the new adapter branch. This is acceptable for the first
  version, but it is a known architecture debt. A future cleanup should wrap the
  existing Claude loop as a `ClaudeRuntimeAdapter` while preserving
  `supportsLiveInput`, `supportsPreCompactHook`, `resumeAt`, and existing
  memory/Task semantics.
- Do not collapse Claude into a Codex-style one-turn runner as part of that
  cleanup; that would regress current Claude behavior.

### Adapter Contract

```ts
type RuntimeErrorClass =
  | 'auth'
  | 'unsupported_model'
  | 'rate_limit'
  | 'quota'
  | 'network'
  | 'runtime_unavailable'
  | 'permission'
  | 'cancelled'
  | 'unknown';

interface RuntimeAuthMaterialRef {
  id: string;
  providerId: string;
  authProfileGeneration: number;
  env: Record<string, string>;
  runtimeHome?: string;
  files?: Array<{
    relativePath: string;
    mode: number;
    contentRef: string;
  }>;
}

interface RuntimePrepareInput {
  resolved: ModelResolveResult;
  scope: ConversationScope;
  executionMode: 'container' | 'host';
}

interface RuntimePreparedRun {
  resolved: ModelResolveResult;
  auth: RuntimeAuthMaterialRef;
  env: Record<string, string>;
  mounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>;
}

type RuntimeRunInput = AgentRunnerInput;

interface AgentRuntimeAdapter {
  runtime: AgentRuntime;
  prepareRun(input: RuntimePrepareInput): Promise<RuntimePreparedRun>;
  run(input: RuntimeRunInput): AsyncIterable<NormalizedAgentEvent>;
  cancel?(runId: string): Promise<void>;
  drain?(scope: ConversationScope): Promise<void>;
  canNativeResume(ref: RuntimeSessionRef | undefined): boolean;
  classifyError(error: unknown): RuntimeErrorClass;
}
```

Adapter owns:

- translating auth material into env/files/runtime home;
- passing model arg or omitting it for provider default;
- applying continuation plan;
- extracting native session/thread IDs;
- extracting resolved model when runtime exposes it;
- normalizing usage;
- classifying unsupported-model and auth failures;
- mapping SDK events into HappyClaw events.

`RuntimeAuthMaterialRef` is launcher-private. It may include env values or
references to secret file content needed by the child process, but it must never
be exposed through public API responses, logs, stream events, or persisted
message metadata.

### Runner Input

```ts
interface AgentRunnerInput {
  runtime: 'claude' | 'codex';
  providerFamily: 'claude' | 'gpt';
  providerPoolId: string;
  providerId: string;
  bindingRevision: number;
  authProfileGeneration: number;
  model: {
    selectedModel: string | null;
    modelKind: ModelSelectionKind;
    resolvedModel: string | null;
    modelKey: string;
  };
  continuation: ContinuationPlan;
  auth: RuntimeAuthMaterialRef;
  workspace: {
    groupFolder: string;
    agentId: string;
    chatJid: string;
    cwd: string;
    ipcDir: string;
    isHome: boolean;
    isAdminHome: boolean;
    isScheduledTask?: boolean;
    taskRunId?: string;
  };
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
  turnId?: string;
}
```

### Normalized Output Additions

```ts
interface NormalizedAgentEvent {
  streamEvent: StreamEvent;
  runtime: 'claude' | 'codex';
  providerFamily: 'claude' | 'gpt';
  providerPoolId: string;
  providerId: string;
  authProfileGeneration: number;
  selectedModel: string | null;
  modelKind: ModelSelectionKind;
  resolvedModel: string | null;
  nativeSessionId?: string;
  nativeResumeAt?: string;
}
```

Implementation shape:

1. Host/control plane resolves model, pool, concrete provider, auth generation,
   binding revision, and continuation plan before launching runner.
2. `runContainerAgent` and `runHostAgent` pass one serialized
   `AgentRunnerInput` to the child runner instead of separate Claude-shaped
   `sessionId` and env assumptions.
3. `container/agent-runner` becomes a runtime dispatcher. It chooses
   `ClaudeRunner` or `CodexRunner` from `input.runtime`.
4. `ClaudeRunner` owns Claude SDK query, `.claude`, Claude session IDs, and
   Claude event conversion.
5. `CodexRunner` uses `@openai/codex-sdk` as the primary execution boundary,
   owns `CODEX_HOME`, Codex thread IDs, and Codex event conversion. A direct
   `codex exec` runner may exist only behind an explicit debug/fallback flag.
6. Both runners emit same `ContainerOutput`/`StreamEvent` envelope plus runtime
   metadata.
7. Host writes native sessions through `RuntimeSessionStore`.
8. The queue stores active runner runtime metadata. IPC reuse is allowed only
   when active runner metadata still matches current `bindingRevision`.

## Dependency, Build, And Execution Packaging

Codex support must be present in the same execution environments where
HappyClaw can run agents.

Host execution requirements:

- The host runner can locate an approved Codex CLI or SDK entry point.
- The configured path may be an installed Codex CLI, the Codex desktop bundled
  CLI, or a pinned package executable.
- Dependency probes run before GPT execution is enabled.
- The host runtime uses provider-scoped `CODEX_HOME` and sanitized env.

Container execution requirements:

- Docker image installs or receives the same approved Codex CLI/SDK capability.
- `container/agent-runner/package.json` includes required runtime dependencies
  for the runner path being used.
- The root/package install and service install scripts include Codex runner
  dependencies where needed.
- Docker mounts or copies only provider-scoped auth material needed for the
  selected provider.
- Provider-scoped `CODEX_HOME` is writable and persistent across runs.
- Workspace `CLAUDE.md`, workspace files, selected MCP config, skills, and IPC
  roots are mounted with the same semantics as Claude container execution.
- `danger-full-access` or equivalent Codex sandbox mode inside Docker is
  container-scoped and must not grant broader host access than the existing
  container execution model.

Build/install surfaces to update:

- root `package.json` and lockfile when root code needs SDK imports;
- `container/agent-runner/package.json` and lockfile for runner imports;
- `container/Dockerfile` for CLI/SDK install and runtime PATH;
- local install/restart service scripts;
- Makefile or setup scripts that prepare runner dependencies;
- config diagnostics that report missing dependency, stale build, or wrong
  version.

CLI compatibility rules:

- Do not hardcode stale Codex CLI flags without a version/probe check.
- In particular, `--ask-for-approval` is not accepted by every `codex exec`
  version. Prefer the current CLI's documented flag or config override, such as
  approval policy config, after probing `codex exec --help`.
- CLI args must be constructed in one adapter location and covered by tests.
- Unsupported CLI flag errors are adapter/dependency errors, not model errors.
- The UI should report them as actionable dependency/runtime issues.

SDK vs CLI:

- Prefer the official Codex SDK when it can meet runner, auth, MCP, streaming,
  and container requirements.
- A gated CLI adapter is acceptable as first implementation when it is the only
  locally reliable official path.
- The SDK and CLI adapters must share the same `AgentRuntimeAdapter` contract
  and conformance tests.
- Do not expose GPT execution to users until the selected adapter passes the
  minimum conformance gates.

## Tool And Permission Mapping

Codex must not launch as a chat-only runtime. HappyClaw agent behavior depends
on built-in tools, permission policy, hooks, memory, skills, and IPC side
effects.

Current state:

- `container/agent-runner/src/mcp-tools.ts` defines tools with Claude SDK
  `tool()`.
- Claude `query()` receives a `happyclaw` MCP server plus user MCP servers.
- Tool implementations communicate with the host by writing IPC files and
  waiting for host responses.
- Runtime permissions are currently expressed with Claude concepts such as
  `allowedTools`, `disallowedTools`, and `permissionMode: 'bypassPermissions'`.

Target shape:

```ts
type HappyClawToolName =
  | 'send_message'
  | 'send_image'
  | 'send_file'
  | 'schedule_task'
  | 'register_group'
  | 'list_groups'
  | 'memory_search'
  | 'memory_append'
  | 'skill_read'
  | 'skill_run'
  | 'workspace_file_op'
  | 'shell_command';

interface HappyClawToolDefinition {
  name: HappyClawToolName;
  description: string;
  inputSchema: unknown;
  permission: 'agent' | 'workspace' | 'admin' | 'maintenance_only';
  handler: (input: unknown, ctx: HappyClawToolContext) => Promise<unknown>;
}

interface HappyClawToolCatalog {
  list(input: ToolCatalogInput): HappyClawToolDefinition[];
}
```

Rules:

- First version may treat existing `createMcpTools(ctx)` as the canonical
  built-in tool catalog and adapt its Claude SDK tool definitions into a
  generic MCP server. A later cleanup may extract a fully runtime-neutral
  catalog, but Codex must not wait on that refactor.
- Keep host IPC semantics as the tool implementation boundary; do not fork
  separate Claude and Codex implementations for the same HappyClaw side effect.
- Claude adapter maps catalog tools back to Claude SDK `tool()` definitions or
  a Claude-compatible in-process MCP server.
- Codex adapter maps the same catalog to the official Codex-supported tool/MCP
  mechanism.
- If Codex SDK cannot consume in-process tools directly, expose built-ins through
  a local MCP server launched inside the runner/container and point Codex at
  that server.
- User MCP servers remain separate from HappyClaw built-ins and are filtered by
  the same workspace/provider permission policy.
- Tool allow/deny policy is computed once by HappyClaw and passed as normalized
  `ToolPolicy`; adapters translate it to runtime-specific allow/deny controls.
- Runtime-specific permission bypass modes are adapter-private and must not
  widen HappyClaw permissions.
- Maintenance turns keep their restricted tool policy regardless of runtime.
- Memory and skills use the existing workspace policy and file roots; Codex does
  not get broader filesystem access than Claude.
- `send_message`, `schedule_task`, and other representational side effects must
  continue to flow through the existing host authorization/audit path.

First-version launch gate:

- GPT/Codex options are visible only through the model control plane and the
  workspace model selector after dependency/auth probes are available.
- The CLI-backed Codex adapter must launch a local `happyclaw` MCP server using
  the same built-in tool implementations as Claude. It is user-facing only when
  dependency/auth probes pass and the MCP bridge can at least list tools and
  smoke-call `send_message`.
- UI and errors must make missing Codex auth/dependency actionable and must not
  silently fall back to Claude.

Minimum tool conformance:

- text response streaming;
- workspace file read/write behavior equal to Claude path;
- shell/tool permission policy equal to Claude path;
- `send_message` IPC round trip;
- scheduled task creation/list/status;
- memory read/write if enabled;
- skill discovery/execution if enabled;
- user MCP server wiring or explicit runtime-unavailable error;
- cancellation/drain while a tool call is pending;
- audit and StreamEvent mapping for every tool start/end/progress event.

### MCP, Skills, CLI, And Workspace Tree

The following are HappyClaw canonical surfaces, not Claude-only surfaces:

- built-in HappyClaw tools;
- user MCP catalog;
- workspace MCP catalog;
- selected skills and `SKILL.md` content;
- workspace tree/file visibility policy;
- shell/CLI permission profile;
- IPC roots and host authorization/audit side effects.

MCP rules:

- Built-in HappyClaw tools are exposed to Claude and Codex from the same
  implementation boundary.
- User/workspace MCP servers remain configured once at HappyClaw level and are
  materialized for the selected runtime.
- Host mode and container mode both receive equivalent MCP config, adjusted only
  for path mapping.
- If a user/workspace MCP server cannot be run under Codex, the runtime reports
  `runtime_unavailable` or marks that MCP unavailable explicitly; it must not
  silently disappear from the agent's capability set.
- MCP tool results continue to flow through HappyClaw IPC/audit/permission
  checks when they cause HappyClaw side effects.

Skills rules:

- `SKILL.md` remains the canonical skill format.
- Do not create separate Claude skills and Codex skills for the same HappyClaw
  skill.
- Existing skill roots are mounted/materialized for Codex with the same
  visibility and permission rules as Claude.
- Runtime-specific skill discovery quirks belong in the adapter prompt/config,
  not in duplicate persisted skill trees.
- If Codex cannot use Claude-native skill discovery, HappyClaw must provide a
  runtime-neutral skill routing prompt and file access path.
- Skill execution/read tools must behave the same in host and container modes.

Workspace tree/file rules:

- The workspace root is the canonical current working directory for both
  runtimes.
- Runtime adapters may build a tree/file context view, but the underlying files
  and access policy come from HappyClaw.
- Hidden/blocked directories remain blocked regardless of runtime.
- Runtime-specific project files may be used only as compatibility views and
  must not become a second source of truth.

CLI/tool permission rules:

- Shell access follows existing HappyClaw workspace execution policy.
- Host/container execution mode is selected by HappyClaw, not by the runtime.
- Runtime sandbox flags translate the existing HappyClaw permission profile; they
  do not define product permissions by themselves.
- Maintenance turns keep restricted tools even if a runtime's default mode would
  allow more.

## Stream Events

UI, IM cards, usage persistence, and billing consume normalized HappyClaw
events, not raw Claude/Codex SDK events.

Canonical source is `src/stream-event.types.ts`. Adapters must target:

- `text_delta`, `thinking_delta`;
- `tool_use_start`, `tool_use_end`, `tool_progress`;
- `hook_started`, `hook_progress`, `hook_response`;
- `task_start`, `task_notification`;
- `todo_update`;
- `assistant_text_boundary`;
- `sub_agent_result`;
- `usage`;
- `status`, `init`.

Codex-specific details can go in adapter-private metadata. First-version UI
behavior should use normalized event types. If Codex cannot produce an exact
Claude-like event, degrade to status/text event rather than leaking raw SDK JSON.

### Codex SDK Phases And Feishu Cards

Codex must not be forced into Claude's Task/sub-agent card model. The official
Codex SDK event stream has these stable phases:

- `thread.started`: native session/thread identity. Persist for resume, do not
  display to Feishu users.
- `turn.started`: the model accepted a new user turn. This is a working-state
  signal only.
- `item.started` / `item.updated` / `item.completed`: live work items. Item
  types are `agent_message`, `reasoning`, `todo_list`, `command_execution`,
  `mcp_tool_call`, `file_change`, `web_search`, and `error`.
- `turn.completed`: finish-state signal plus usage.
- `turn.failed` / `error`: terminal error or recoverable status.

Feishu working-state policy for Codex:

- Show a Codex-specific working card, not the Claude lifecycle skeleton.
- `reasoning` becomes a bounded live reasoning block.
- `todo_list` becomes live `计划 / Todo`.
- `command_execution`, `mcp_tool_call`, `file_change`, and `web_search` become
  an operation/log timeline with bounded summaries. Do not show raw full command
  output, full MCP arguments/results, auth material, environment variables, or
  raw SDK JSON.
- `agent_message` streams only into the main answer body. It is not duplicated
  into the operation timeline.
- `thread.started` is persistence metadata only.
- `turn.started` is a lightweight status/log marker at most.

Feishu finish-state policy for Codex:

- Replace the working card with a structured final reply card.
- Include the final answer body and usage metadata.
- Include collapsed `计划 / Todo`, `操作记录`, and `推理过程` panels only when
  the turn actually produced those artifacts.
- Do not render empty placeholders like "暂无计划" in a final card.
- Claude final cards continue to use Claude-specific prior text/sub-agent
  panels. Codex final cards use Codex process artifacts and do not fabricate
  Claude `task_start`, `task_notification`, or `sub_agent_result` events.

## Queue, Tasks, Spawn, Clear

### Queue And Ordering

Reuse existing `GroupQueue`, virtual JIDs, IPC injection, scheduled-task
serialization, and drain hooks.

Rules:

- One active run per conversation scope remains serialization model.
- Switch while running writes `pending_*`.
- Current turn is not interrupted.
- Credential changes can drain affected runners before next turn.
- Scheduled-task runners are not reused for user messages.
- Conversation-agent virtual JIDs map to `(group_folder, agent_id)`.
- Spawn agents copy parent selection at creation and run to completion.

### Scheduled Tasks

Scheduled tasks need two scopes:

- Model binding scope: source workspace `task.group_folder`.
- Runtime/session scope: dedicated task workspace `task.workspace_folder`.

Behavior:

- Scheduled agent tasks follow source workspace main/default at run time.
- If source workspace default changes before next scheduled run, next run uses
  new default.
- Running scheduled task is not interrupted by model change.
- Scheduler passes both model source scope and native session scope.

### Spawn

Spawn behavior:

- Copies parent scope's provider pool and selected/resolved model at creation.
- Does not track later parent changes.
- Runs to completion.
- Is not direct switch target.
- Stale spawn recovery remains current behavior.

### SDK Task Agents

SDK Task/sub-agent records:

- remain internal;
- are not user-switchable;
- continue current stale running task recovery behavior.

Codex first-version decision:

- Codex does not emulate Claude SDK `Task` / `TaskOutput` / `TaskStop`.
- Codex stream events must not be converted into fake `task_start`,
  `task_notification`, or `sub_agent_result` records.
- Codex gets runtime-specific background/subagent instructions: do work in the
  current turn with Codex Todo/tool events; use `schedule_task` only for real
  scheduled/deferred work; tell the user to switch to Claude or use HappyClaw
  `/spawn` / conversation-agent product features when they explicitly need
  Claude Task-style subagents.
- HappyClaw product-level spawn/conversation agents remain available outside
  SDK-native Task semantics and keep their own `(group_folder, agent_id)` model
  binding/session scope.

### Clear And Delete

Current `/clear`:

- stops current scope runner;
- removes Claude session files;
- deletes old `sessions(group_folder, agent_id)` row;
- inserts `context_reset`;
- advances cursors so old messages are not replayed.

After multi-runtime:

- `/clear` clears all native continuation state for current conversation scope;
- `/clear` preserves active runtime/provider pool/model binding;
- deleting conversation agent deletes its runtime state and sessions;
- deleting workspace deletes all runtime state/sessions under folder;
- deleting/disabling provider does not delete conversation history;
- pinned scopes become unavailable until owner switches.

## Internal AI

Internal AI calls:

- `/recall` conversation summarization;
- AI task schedule parsing;
- bug report title/body generation;
- future auto-title or helper calls.

First-version decision:

- Internal AI does not follow current conversation scope model.
- Continue using Claude for internal AI.
- Route gradually through `internalAgentQuery(...)`.
- Internal calls are stateless.
- Internal calls do not use native resume/thread continuation.
- Internal calls do not use workspace files, memory, or tools.
- Internal calls are max one turn.
- Internal usage is system cost.
- Internal usage should still be recorded for audit/cost visibility.

Config shape:

```ts
interface InternalAiConfig {
  enabled: boolean;
  providerPoolId: string | null; // null = system internal default
  model: string | null; // null = provider default
}
```

First migration targets:

- `/recall`;
- `/api/tasks/ai`;
- `/api/tasks/parse`;
- bug report generation.

Daily-report script can migrate later.

## Rollout

Layered rollout:

1. Schema:
   - add runtime state/session/model option tables;
   - include provider family, pool, concrete provider, auth generation in keys;
   - add message metadata;
   - extend usage records if needed.

2. Provider/auth:
   - introduce runtime-aware provider metadata;
   - classify providers into Claude vs GPT/Codex pools;
   - add official Codex OAuth/API-key provider records;
   - implement Codex OAuth start/status/cancel/complete in the same
     admin-managed provider style as Claude OAuth;
   - allocate persistent provider-scoped `CODEX_HOME`;
   - add per-provider lock;
   - increment auth generation on credential replacement/removal;
   - add passive status and login/logout/delete;
   - sanitize env.

3. Resolver:
   - resolve runtime/pool/model intent;
   - merge `provider_pool_model_options` with provider observations;
   - prefer compatible concrete provider with existing session;
   - allow provider rotation only inside selected pool;
   - keep cross-pool/model fallback out of pinned selections;
   - update model option cache.

4. Continuation/session:
   - implement `RuntimeSessionStore`;
   - lazy-migrate old `sessions`;
   - remove global `sessions: Record<string, string>` from runtime paths;
   - re-key provisional native session rows when exact resolved model is
     learned;
   - implement lightweight handoff context builder from existing messages;
   - do not add durable rolling conversation summaries for model switching.

5. Runner adapters:
   - add `AgentRunnerInput`;
   - wrap current Claude runner;
   - adapt existing HappyClaw tool definitions into both Claude and Codex MCP
     wiring, keeping the same IPC handlers;
   - update root install scripts, runner package dependencies, and Docker image
     build so Codex works in both host and container execution;
   - add dependency probes and version diagnostics for Codex CLI/SDK;
   - probe official `@openai/codex-sdk` and Codex CLI separately;
   - make `@openai/codex-sdk` the default Codex runner contract once installed
     in the same runner environment;
   - keep direct `codex exec` usage behind an explicit debug/fallback flag only;
   - fail closed when Codex SDK, its bundled CLI, or usable auth material is
     unavailable and keep Claude available;
   - normalize events;
   - classify failures.

6. Commands/API:
   - Web `/model`, `/model list`, `/model list --all`, `/model use`;
   - separate API for scope binding and workspace default mutation;
   - IM `/model`, `/model list`, `/model use`;
   - owner-only Web mutation helper;
   - unsupported model/provider/auth errors.

7. Task/spawn:
   - scheduled task source/runtime scopes;
   - spawn copy semantics;
   - keep SDK task non-switchable.

8. Internal AI:
   - add `internalAgentQuery`;
   - migrate `/recall`, task parsing, bug reports.

9. UI/audit:
   - add a dedicated GPT/Codex provider settings tab beside the Claude provider
     tab;
   - add a one-click ChatGPT OAuth login/start button for GPT providers;
   - show Codex dependency/probe status and actionable install/rebuild hints;
   - show selected intent and resolved model separately;
   - surface availability;
   - audit switches, credential changes, unsupported failures;
   - keep credentials out of logs.

Rollout safeguards:

- Keep Claude behavior as compatibility baseline.
- Gate Codex runtime with provider/auth/dependency availability.
- Enable `/model list` before `/model use gpt`.
- Keep Codex execution disabled when dependency probes, auth material, or MCP
  bridge startup fail; configured GPT conversations should show an actionable
  runtime-unavailable error instead of silently falling back.
- Keep old `sessions` compatibility until runtime-aware path is stable.
- Rollback can disable Codex and continue old Claude sessions.
- Every schema migration must create a timestamped SQLite backup before changing
  tables. Backup failures stop startup unless an explicit development override is
  set.

## Codex Conformance Checks

Before enabling Codex by default, verify:

- SDK/CLI dependency is installed in the same place the runner executes.
- Version probe passes and reports an expected pinned version/range.
- `codex exec --help` or SDK capability probe confirms every adapter flag/config
  used by HappyClaw. Stale flags such as unsupported `--ask-for-approval` fail
  the dependency probe before user traffic reaches the runtime.
- SDK can run with explicit API key without reading unrelated host env.
- SDK/CLI respects injected `CODEX_HOME`.
- ChatGPT login writes credentials only inside provider home.
- Runtime calls refresh credentials without exposing token contents.
- Logout removes only selected provider's Codex home/auth files.
- OAuth run works with mounted persistent `CODEX_HOME`.
- Native thread/session resume works.
- Streaming maps to canonical `StreamEvent`.
- Cancellation/drain works.
- Usage can be extracted or safely omitted with clear behavior.
- Unsupported-model errors are classifiable.
- Sandbox/workspace behavior matches HappyClaw isolation.
- HappyClaw built-in tool catalog works through Codex:
  send message, schedule task, memory, skills, workspace files, and shell
  policy.
- Host and container modes both pass the same smoke suite.
- GPT provider settings tab can start OAuth login, show status, and manage API
  key providers without exposing secrets.

## Tests

Minimum test matrix:

- Resolver:
  provider default, runtime default, alias, explicit version, custom model,
  unsupported cache, pinned vs default fallback, same-pool provider rotation,
  cross-pool no fallback, pool-level model options merged with provider-level
  observed success/failure.

- Permissions:
  Web owner can switch, member cannot, admin not owner cannot, provider config
  requires `manage_system_config`, IM `/model use` follows existing IM channel
  routing/gating without HappyClaw owner checks.

- Migration:
  old `sessions` rows lazy-migrate, global sessions cache removed from runtime
  paths, startup recovery clears runtime sessions, provisional session row
  re-keyed after resolved model is learned.

- Session keying:
  runtime/provider/auth generation/model identity, OAuth re-login invalidates
  native resume, API-key rotation invalidates native resume.

- Cleanup:
  `/clear`, agent delete, workspace delete, provider delete/logout.

- Auth/env:
  host env sanitization, container `CODEX_HOME` persistence, reserved env cannot
  be overridden by workspace custom env, Codex OAuth login flow creates auth only
  under selected provider home, GPT settings one-click OAuth flow works, API-key
  provider stores and masks secrets correctly.

- Adapter conformance:
  Claude unchanged, Codex OAuth, Codex API key, host mode, container mode, stream
  events, usage, errors, CLI flag compatibility.

- Tasks/spawn:
  scheduled task model source scope vs runtime scope, spawn copies parent
  selection, SDK task not switchable.

- Billing/usage:
  conversation, conversation agent, spawn, scheduled task, internal AI metadata;
  Codex exact cost, Codex token-only zero-cost fallback, Codex no-usage
  zero-cost fallback, daily summary includes zero-cost runs.

- Provider pools:
  Claude/GPT pools are isolated; provider health, failover, active session count,
  and model options do not leak across pools; disabled pool blocks selection.

- System default:
  initial migration uses current Claude default; new workspace copies system
  default; changing system default does not rewrite existing workspaces.

- Web API workspace resolution:
  mutation by canonical `workspaceJid`; legacy folder route rejects ambiguous
  same-folder owner data; member/admin-not-owner cannot mutate model binding.

- Running switch:
  current turn keeps old binding; next turn uses pending binding; old active
  runner cannot receive IPC after binding revision changes.

- Soft context:
  cross-runtime switch forces one handoff injection, normal same-runtime resume
  does not replay recent history, `/clear` excludes older messages, privacy mode
  does not persist extra handoff artifacts, soft injection stays within token
  budget, `CLAUDE.md` is loaded natively rather than prepended.

- Tool bridge:
  existing built-in tool definitions map to Claude and Codex MCP wiring; tool
  policy is enforced before adapter translation; Codex is not user-facing until
  required HappyClaw tools pass conformance; user/workspace MCP, skills, workspace
  tree visibility, and shell policy behave consistently in host and container
  modes.

- Dependency/build:
  Codex SDK and CLI probes are exposed in the config UI. Missing Codex capability
  disables GPT execution without affecting Claude. The default GPT execution
  path is `@openai/codex-sdk`; the SDK still depends on a compatible Codex CLI
  binary, so packaging must install both in host and container runner
  environments.

## External References

Reference material used while designing:

- OpenClaw OAuth/auth profile pattern:
  https://docs.openclaw.ai/concepts/oauth
- OpenClaw model failover/auth profile routing:
  https://docs.openclaw.ai/concepts/model-failover
- OpenClaw Codex harness split:
  https://docs.openclaw.ai/plugins/codex-harness
- OpenAI Codex authentication:
  https://developers.openai.com/codex/auth
- OpenAI Codex SDK:
  https://developers.openai.com/codex/sdk
- Harness agent control-plane pattern:
  https://developer.harness.io/docs/platform/harness-ai/harness-agents/
