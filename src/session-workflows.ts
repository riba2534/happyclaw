import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import type {
  WorkflowAgentSnapshot,
  WorkflowPhaseSnapshot,
  WorkflowRunSnapshot,
} from './stream-event.types.js';

type MessageLike = {
  id: string;
  timestamp: string;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  is_from_me?: boolean | number;
  token_usage?: string;
  workflow_runs?: WorkflowRunSnapshot[];
};

const cache = new Map<
  string,
  { signature: string; runs: WorkflowRunSnapshot[] }
>();

/**
 * Both caches are keyed by `<folder>:<agent>:<sessionId>`. Session ids are
 * unbounded over the host lifetime (every /clear, task run and agent gets a
 * new one) and the message-list poll touches every session it renders, so
 * the caches are LRU-bounded and forget a session whose files are gone.
 */
const MAX_CACHED_SESSIONS = 64;

/** Insert or refresh `key` as most recently used, evicting the oldest. */
function touchBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED_SESSIONS) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

interface SessionAssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
      costUSD: number;
    }
  >;
}

/** Incremental transcript parse state; see loadSessionAssistantUsage. */
interface TranscriptParseState {
  path: string;
  /** Identity of the file the offsets refer to; tmp+rename yields a new one. */
  dev: number;
  ino: number;
  /** Bytes already parsed into complete lines. */
  consumed: number;
  /** Raw bytes of a trailing partial line (mid-write or split UTF-8). */
  leftover: Buffer;
  turn: number;
  turnBySdkUuid: Map<string, number>;
  entriesByTurn: Map<
    number,
    Map<string, { model: string; usage: SessionAssistantUsage }>
  >;
  bySdkUuid: Map<string, SessionAssistantUsage>;
}

const assistantUsageCache = new Map<string, TranscriptParseState>();

function finite(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAgentState(value: unknown): WorkflowAgentSnapshot['state'] {
  switch (value) {
    case 'queued':
    case 'running':
    case 'done':
    case 'failed':
    case 'stopped':
      return value;
    case 'completed':
      return 'done';
    default:
      return 'unknown';
  }
}

function normalizeRunStatus(value: unknown): WorkflowRunSnapshot['status'] {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'stopped':
      return value;
    default:
      return 'unknown';
  }
}

/** Normalize both workflows/wf_*.json and task output JSON shapes. */
export function normalizeWorkflowRun(
  raw: Record<string, unknown>,
  fallbackTaskId = 'workflow',
): WorkflowRunSnapshot | null {
  const progress = Array.isArray(raw.workflowProgress)
    ? (raw.workflowProgress as Array<Record<string, unknown>>)
    : [];
  const declaredPhases = Array.isArray(raw.phases)
    ? (raw.phases as Array<Record<string, unknown>>)
    : [];
  const phasesByIndex = new Map<number, WorkflowPhaseSnapshot>();
  declaredPhases.forEach((phase, offset) => {
    const title = text(phase.title);
    if (!title) return;
    const index = finite(phase.index) ?? offset + 1;
    phasesByIndex.set(index, { index, title, detail: text(phase.detail) });
  });
  for (const item of progress) {
    if (item.type !== 'workflow_phase') continue;
    const title = text(item.title);
    if (!title) continue;
    const index = finite(item.index) ?? phasesByIndex.size + 1;
    const previous = phasesByIndex.get(index);
    phasesByIndex.set(index, {
      index,
      title,
      detail: text(item.detail) ?? previous?.detail,
    });
  }

  const agents: WorkflowAgentSnapshot[] = progress
    .filter((item) => item.type === 'workflow_agent')
    .map((item, offset) => ({
      index: finite(item.index) ?? offset + 1,
      label: text(item.label) ?? `Agent ${offset + 1}`,
      phaseIndex: finite(item.phaseIndex),
      phaseTitle: text(item.phaseTitle),
      agentId: text(item.agentId),
      model: text(item.model),
      fallbackModel: text(item.fallbackModel),
      state: normalizeAgentState(item.state),
      queuedAt: finite(item.queuedAt),
      startedAt: finite(item.startedAt),
      completedAt: finite(item.completedAt),
      attempt: finite(item.attempt),
      lastToolName: text(item.lastToolName),
      lastToolSummary: text(item.lastToolSummary),
      promptPreview: text(item.promptPreview),
      resultPreview: text(item.resultPreview),
      tokens: finite(item.tokens),
      toolCalls: finite(item.toolCalls),
      durationMs: finite(item.durationMs),
    }))
    .sort((a, b) => a.index - b.index);

  const taskId = text(raw.taskId) ?? fallbackTaskId;
  const summary =
    text(raw.summary) ??
    text(raw.description) ??
    text(raw.workflowName) ??
    '动态工作流';
  const timestamp = text(raw.timestamp);
  const completedAt = timestamp ? Date.parse(timestamp) : undefined;
  const explicitStatus = normalizeRunStatus(raw.status);
  const inferredStatus = agents.length
    ? agents.every((agent) => agent.state === 'done')
      ? 'completed'
      : agents.some((agent) => agent.state === 'failed')
        ? 'failed'
        : 'running'
    : explicitStatus;

  return {
    taskId,
    runId: text(raw.runId),
    workflowName: text(raw.workflowName),
    summary,
    status: explicitStatus === 'unknown' ? inferredStatus : explicitStatus,
    startTime: finite(raw.startTime),
    completedAt:
      completedAt !== undefined && Number.isFinite(completedAt)
        ? completedAt
        : undefined,
    durationMs: finite(raw.durationMs),
    agentCount: finite(raw.agentCount) ?? (agents.length || undefined),
    totalTokens: finite(raw.totalTokens),
    totalToolCalls: finite(raw.totalToolCalls),
    phases: [...phasesByIndex.values()].sort((a, b) => a.index - b.index),
    agents,
  };
}

function sessionProjectRoots(
  groupFolder: string,
  agentId: string | null,
): string[] {
  const claudeRoot = agentId
    ? path.join(DATA_DIR, 'sessions', groupFolder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const projectsRoot = path.join(claudeRoot, 'projects');
  try {
    return fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsRoot, entry.name));
  } catch {
    return [];
  }
}

function usageValue(
  usage: Record<string, unknown>,
  snakeCase: string,
  camelCase: string,
): number {
  return Math.max(finite(usage[snakeCase]) ?? 0, finite(usage[camelCase]) ?? 0);
}

function emptyAssistantUsage(): SessionAssistantUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    modelUsage: {},
  };
}

function usageTotal(usage: SessionAssistantUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens +
    usage.reasoningTokens
  );
}

/**
 * Recover assistant usage from the SDK transcript for old ledger rows written
 * by providers that exposed live usage in camelCase. The SDK transcript is the
 * durable authority and serializes the final counters in snake_case.
 *
 * Transcripts are append-only JSONL that keep growing while a session runs, so
 * the whole-file signature cache missed on every request of an active session
 * (measured 2.4MB reparsed per message-list request, on a 2s poll). The parse
 * state is therefore kept per session and only bytes appended since the last
 * pass are read; a shrunk file (rotation or the CLI's local transcript GC) or
 * a replaced file (history-image-prune rewrites via tmp+rename, so dev/ino
 * change) resets the
 * state. A partial trailing line is buffered as raw bytes so mid-write reads
 * and multi-byte UTF-8 at the chunk boundary stay intact.
 */
function loadSessionAssistantUsage(input: {
  groupFolder: string;
  agentId: string | null;
  sessionId: string;
}): Map<string, SessionAssistantUsage> {
  const transcript = sessionProjectRoots(input.groupFolder, input.agentId)
    .map((root) => path.join(root, `${input.sessionId}.jsonl`))
    .find((candidate) => fs.existsSync(candidate));
  const cacheKey = `${input.groupFolder}:${input.agentId ?? 'main'}:${input.sessionId}`;
  if (!transcript) {
    assistantUsageCache.delete(cacheKey);
    return new Map();
  }
  const stat = fs.statSync(transcript);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
    assistantUsageCache.delete(cacheKey);
    return new Map();
  }
  let state = assistantUsageCache.get(cacheKey);
  if (
    !state ||
    state.path !== transcript ||
    state.dev !== stat.dev ||
    state.ino !== stat.ino ||
    stat.size < state.consumed + state.leftover.length
  ) {
    state = {
      path: transcript,
      dev: stat.dev,
      ino: stat.ino,
      consumed: 0,
      leftover: Buffer.alloc(0),
      turn: 0,
      turnBySdkUuid: new Map(),
      entriesByTurn: new Map(),
      bySdkUuid: new Map(),
    };
  }
  touchBounded(assistantUsageCache, cacheKey, state);
  const alreadyExamined = state.consumed + state.leftover.length;
  if (stat.size === alreadyExamined) return state.bySdkUuid;

  const appended = Buffer.allocUnsafe(stat.size - alreadyExamined);
  const fd = fs.openSync(transcript, 'r');
  let appendedLength = 0;
  try {
    while (appendedLength < appended.length) {
      const read = fs.readSync(
        fd,
        appended,
        appendedLength,
        appended.length - appendedLength,
        alreadyExamined + appendedLength,
      );
      if (read <= 0) break;
      appendedLength += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  const combined = Buffer.concat([
    state.leftover,
    appended.subarray(0, appendedLength),
  ]);
  const lastNewline = combined.lastIndexOf(0x0a);
  const parseable =
    lastNewline >= 0
      ? combined.subarray(0, lastNewline + 1).toString('utf8')
      : '';
  state.leftover = Buffer.from(combined.subarray(lastNewline + 1));
  // 不变量：consumed + leftover.length === 已从文件检视的总字节数
  state.consumed = alreadyExamined + appendedLength - state.leftover.length;

  let mutated = false;
  for (const line of parseable.split('\n')) {
    consumeTranscriptLine(state, line);
    mutated = true;
  }
  // 无终止换行的尾行：只有当它已是完整 JSON 时才提交（写到一半的行会解析
  // 失败并留在缓冲区，等下一轮追加补齐）。
  if (state.leftover.length > 0) {
    const tail = state.leftover.toString('utf8');
    try {
      JSON.parse(tail);
      consumeTranscriptLine(state, tail);
      state.consumed += state.leftover.length;
      state.leftover = Buffer.alloc(0);
      mutated = true;
    } catch {
      /* 残行未写完，保留待续 */
    }
  }
  if (mutated) state.bySdkUuid = aggregateAssistantUsage(state);
  return state.bySdkUuid;
}

function consumeTranscriptLine(
  state: TranscriptParseState,
  line: string,
): void {
  if (!line.trim()) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const message = raw.message as Record<string, unknown> | undefined;
  if (
    raw.type === 'user' &&
    typeof message?.content === 'string' &&
    /<messages(?:\s|>)/u.test(message.content)
  ) {
    state.turn += 1;
    return;
  }
  if (raw.type !== 'assistant' || !message || state.turn === 0) return;
  const turn = state.turn;
  const { turnBySdkUuid, entriesByTurn } = state;
  const sdkUuid = text(raw.uuid);
  const messageId = text(message.id);
  const rawUsage = message.usage as Record<string, unknown> | undefined;
  if (!sdkUuid || !messageId || !rawUsage) return;
  turnBySdkUuid.set(sdkUuid, turn);
  const snapshot: SessionAssistantUsage = {
    inputTokens: usageValue(rawUsage, 'input_tokens', 'inputTokens'),
    outputTokens: usageValue(rawUsage, 'output_tokens', 'outputTokens'),
    cacheReadInputTokens: usageValue(
      rawUsage,
      'cache_read_input_tokens',
      'cacheReadInputTokens',
    ),
    cacheCreationInputTokens: usageValue(
      rawUsage,
      'cache_creation_input_tokens',
      'cacheCreationInputTokens',
    ),
    reasoningTokens: Math.max(
      usageValue(rawUsage, 'reasoning_output_tokens', 'reasoningOutputTokens'),
      finite(rawUsage.reasoningTokens) ?? 0,
    ),
    modelUsage: {},
  };
  const model = text(message.model) ?? 'unknown';
  const entries =
    entriesByTurn.get(turn) ??
    new Map<string, { model: string; usage: SessionAssistantUsage }>();
  const previous = entries.get(messageId);
  if (!previous || usageTotal(snapshot) > usageTotal(previous.usage)) {
    entries.set(messageId, { model, usage: snapshot });
  }
  entriesByTurn.set(turn, entries);
}

function aggregateAssistantUsage(
  state: TranscriptParseState,
): Map<string, SessionAssistantUsage> {
  const { turnBySdkUuid, entriesByTurn } = state;
  const aggregateByTurn = new Map<number, SessionAssistantUsage>();
  for (const [turnId, entries] of entriesByTurn) {
    const aggregate = emptyAssistantUsage();
    for (const { model, usage } of entries.values()) {
      aggregate.inputTokens += usage.inputTokens;
      aggregate.outputTokens += usage.outputTokens;
      aggregate.cacheReadInputTokens += usage.cacheReadInputTokens;
      aggregate.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      aggregate.reasoningTokens += usage.reasoningTokens;
      const modelUsage = aggregate.modelUsage[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        costUSD: 0,
      };
      modelUsage.inputTokens += usage.inputTokens;
      modelUsage.outputTokens += usage.outputTokens;
      modelUsage.cacheReadInputTokens += usage.cacheReadInputTokens;
      modelUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      modelUsage.reasoningTokens += usage.reasoningTokens;
      aggregate.modelUsage[model] = modelUsage;
    }
    aggregateByTurn.set(turnId, aggregate);
  }
  const bySdkUuid = new Map<string, SessionAssistantUsage>();
  for (const [sdkUuid, turnId] of turnBySdkUuid) {
    const aggregate = aggregateByTurn.get(turnId);
    if (aggregate && usageTotal(aggregate) > 0) {
      bySdkUuid.set(sdkUuid, aggregate);
    }
  }
  return bySdkUuid;
}

function hasRecordedTokens(tokenUsage: string | undefined): boolean {
  if (!tokenUsage) return false;
  try {
    const usage = JSON.parse(tokenUsage) as Record<string, unknown>;
    return (
      usageValue(usage, 'input_tokens', 'inputTokens') +
        usageValue(usage, 'output_tokens', 'outputTokens') +
        usageValue(usage, 'cache_read_input_tokens', 'cacheReadInputTokens') +
        usageValue(
          usage,
          'cache_creation_input_tokens',
          'cacheCreationInputTokens',
        ) +
        Math.max(
          usageValue(usage, 'reasoning_output_tokens', 'reasoningOutputTokens'),
          finite(usage.reasoningTokens) ?? 0,
        ) >
      0
    );
  } catch {
    return false;
  }
}

function mergeRecoveredUsage(
  tokenUsage: string | undefined,
  recovered: SessionAssistantUsage,
): string {
  let existing: Record<string, unknown> = {};
  try {
    existing = tokenUsage
      ? (JSON.parse(tokenUsage) as Record<string, unknown>)
      : {};
  } catch {
    existing = {};
  }
  return JSON.stringify({
    ...existing,
    ...recovered,
    // The transcript has no price authority; retain the ledger's cost and
    // latency metadata while replacing only its false zero token counters.
    costUSD: finite(existing.costUSD) ?? 0,
    durationMs: finite(existing.durationMs) ?? 0,
    numTurns: finite(existing.numTurns) ?? 0,
  });
}

export function loadSessionWorkflowRuns(input: {
  groupFolder: string;
  agentId: string | null;
  sessionId: string;
}): WorkflowRunSnapshot[] {
  const dirs = sessionProjectRoots(input.groupFolder, input.agentId)
    .map((projectRoot) => path.join(projectRoot, input.sessionId, 'workflows'))
    .filter((dir) => fs.existsSync(dir));
  const files = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^wf_.+\.json$/.test(entry.name))
      .map((entry) => path.join(dir, entry.name)),
  );
  const signature = files
    .map((file) => {
      const stat = fs.statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
  const cacheKey = `${input.groupFolder}:${input.agentId ?? 'main'}:${input.sessionId}`;
  if (files.length === 0) {
    cache.delete(cacheKey);
    return [];
  }
  const cached = cache.get(cacheKey);
  if (cached?.signature === signature) {
    touchBounded(cache, cacheKey, cached);
    return cached.runs;
  }

  const runs = files
    .map((file) => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
          string,
          unknown
        >;
        return normalizeWorkflowRun(raw, path.basename(file, '.json'));
      } catch {
        return null;
      }
    })
    .filter((run): run is WorkflowRunSnapshot => run !== null)
    .sort(
      (a, b) =>
        (a.startTime ?? a.completedAt ?? 0) -
        (b.startTime ?? b.completedAt ?? 0),
    );
  touchBounded(cache, cacheKey, { signature, runs });
  return runs;
}

/** Attach completed Workflow snapshots to the assistant message that delivered them. */
export function attachSessionWorkflowRuns<T extends MessageLike>(
  messages: T[],
  input: { groupFolder: string; agentId: string | null },
): T[] {
  if (messages.length === 0) return messages;
  const bySession = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.session_id || !message.is_from_me) continue;
    const list = bySession.get(message.session_id) ?? [];
    list.push(message);
    bySession.set(message.session_id, list);
  }
  let changed = false;
  const cloned = new Map<string, T>();
  for (const [sessionId, assistantMessages] of bySession) {
    const ensureClone = (message: T): T => {
      const existing = cloned.get(message.id);
      if (existing) return existing;
      const next = {
        ...message,
        workflow_runs: [...(message.workflow_runs ?? [])],
      };
      cloned.set(message.id, next);
      changed = true;
      return next;
    };
    const needsRecovery = assistantMessages.filter(
      (message) =>
        !!message.sdk_message_uuid && !hasRecordedTokens(message.token_usage),
    );
    // Reading the transcript is only needed to recover missing usage; on a
    // cold cache it is a synchronous read+parse of up to 64MB (a 40MB
    // transcript took ~165ms) for pages whose rows already carry tokens.
    const usageBySdkUuid =
      needsRecovery.length > 0
        ? loadSessionAssistantUsage({ ...input, sessionId })
        : new Map<string, SessionAssistantUsage>();
    for (const message of needsRecovery) {
      const recovered = usageBySdkUuid.get(message.sdk_message_uuid!);
      if (!recovered) continue;
      ensureClone(message).token_usage = mergeRecoveredUsage(
        message.token_usage,
        recovered,
      );
    }
    const runs = loadSessionWorkflowRuns({ ...input, sessionId });
    const ordered = [...assistantMessages].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    for (const run of runs) {
      const completedAt = run.completedAt ?? run.startTime ?? 0;
      const target =
        ordered.find(
          (message) => Date.parse(message.timestamp) >= completedAt,
        ) ?? ordered.at(-1);
      if (!target) continue;
      let next = cloned.get(target.id);
      if (!next) {
        next = ensureClone(target);
      }
      if (!next.workflow_runs!.some((item) => item.taskId === run.taskId)) {
        next.workflow_runs!.push(run);
      }
    }
  }
  return changed
    ? messages.map((message) => cloned.get(message.id) ?? message)
    : messages;
}
