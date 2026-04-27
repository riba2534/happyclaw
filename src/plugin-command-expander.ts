/**
 * plugin-command-expander.ts
 *
 * Expands DMI (`disable-model-invocation: true`) plugin slash-commands typed by
 * a user before they reach the SDK / agent runner. Non-DMI commands are left
 * to the SDK's native `--plugin-dir` handler — those return `{ kind: 'miss' }`
 * here so the original message reaches the agent untouched.
 *
 * Three-state result (kept strict per PR2.b spec):
 *   - miss     → not a plugin command, or hits a non-DMI command (SDK path)
 *   - expanded → fully-rendered prompt to send to the agent
 *   - reply    → in-band system reply (conflict notice, container offline, ...)
 *
 * Inline-bash semantics (matches Claude Code CLI):
 *   - `!`<bash>``  on its own line is *replaced* with stdout of the executed
 *     shell command (host or docker depending on executionMode).
 *   - $ARGUMENTS goes through env, never JS interpolation.
 *   - Positional args ($1, $2, ...) come from `bash -c '<cmd>' -- a b c`.
 *   - Fenced ```bash``` (or any other ```lang```) blocks are passed through
 *     verbatim — those are for the agent to read, not for us to execute.
 *
 * The expander is deliberately self-contained: it doesn't import index.ts /
 * web.ts state. Callers wire it in via `expandMessagesIfNeeded()` (batch) or
 * `expandPluginSlashCommandIfNeeded()` (single) and pass an `ExpandContext`
 * built from request/queue state.
 */

import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  buildCommandIndex,
  resolveCommand,
  PluginCommandIndexEntry,
  Resolution,
} from './plugin-command-index.js';
import {
  executeInlineBashDocker,
  executeInlineBashHost,
  InlineExecResult,
} from './plugin-inline-bash.js';

export type ExecutionMode = 'host' | 'container';

export interface ExpandContext {
  userId: string;
  groupJid: string;
  groupFolder: string;
  /** host: absolute path; container: '/workspace/group'. */
  cwd: string;
  executionMode: ExecutionMode;
  /** Active container name (docker mode only). null when no runner is up. */
  containerName: string | null;
}

export type ExpansionResult =
  | { kind: 'miss' }
  | {
      kind: 'expanded';
      prompt: string;
      /**
       * True iff this expansion ran one or more inline `!` bash commands
       * AND every one of them succeeded. Persistable expansions (P1 round-14
       * crash-safety) gate on this — if any inline failed, the rendered
       * prompt contains `<!-- inline command failed -->` markers and we
       * want recovery to retry rather than freeze the failure.
       *
       * False when no inline commands ran (idempotent body-only expansion;
       * persistence has no value) or any inline failed.
       */
      inlineExecuted: boolean;
    }
  | { kind: 'reply'; text: string };

/** Single message row used by the batch helper — minimal subset of NewMessage. */
export interface ExpandableMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  /** Stringified JSON; may carry image entries and/or a plugin-expansion sentinel. */
  attachments?: string;
}

export interface BatchExpansionOutcome<M extends ExpandableMessage> {
  /** Messages to forward to the agent — miss (unchanged) + expanded (prompt content). */
  toSend: M[];
  /** In-band system replies. Caller stores + broadcasts each per-route. */
  replies: Array<{ originalMsg: M; text: string }>;
}

/**
 * Plugin-expansion sentinel persisted into a message's `attachments` JSON
 * after inline `!` commands run successfully. Recovery detects this and
 * skips re-running the inline (P1 round-14 crash-safety). Stored as an
 * extra item in the existing attachments array — `type !== 'image'` so all
 * image readers (frontend MessageBubble, normalizeImageAttachments,
 * agent collectMessageImages) ignore it naturally.
 */
export const PLUGIN_EXPANSION_ATTACHMENT_TYPE = 'plugin_expansion';

export interface PluginExpansionSentinel {
  type: typeof PLUGIN_EXPANSION_ATTACHMENT_TYPE;
  expanded: true;
  prompt: string;
  expandedAt: string;
}

/**
 * Parse the `attachments` JSON string and return a previously-persisted
 * plugin-expansion sentinel, or null if none / malformed. Tolerant of:
 *   - undefined / empty / non-array JSON (returns null silently)
 *   - extra unknown items (ignored, image entries co-exist)
 *   - missing fields on the sentinel (returns null — recovery re-expands)
 */
export function readPluginExpansionFromAttachments(
  attachmentsJson: string | undefined | null,
): PluginExpansionSentinel | null {
  if (!attachmentsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj.type !== PLUGIN_EXPANSION_ATTACHMENT_TYPE) continue;
    if (obj.expanded !== true) continue;
    if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) continue;
    const expandedAt =
      typeof obj.expandedAt === 'string' ? obj.expandedAt : '';
    return {
      type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
      expanded: true,
      prompt: obj.prompt,
      expandedAt,
    };
  }
  return null;
}

/**
 * Append (or replace) the plugin-expansion sentinel inside the existing
 * attachments JSON, preserving any image entries. Returns the new JSON
 * string; caller persists it back to the messages row (one DB write per
 * successful expansion).
 *
 * The replace path is defensive: re-running the writer with the same msg
 * id (e.g. an in-flight retry) yields the latest prompt without ever
 * accumulating duplicate sentinels.
 */
export function writePluginExpansionToAttachments(
  attachmentsJson: string | undefined | null,
  sentinel: PluginExpansionSentinel,
): string {
  let arr: unknown[] = [];
  if (attachmentsJson) {
    try {
      const parsed = JSON.parse(attachmentsJson);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // fall through with empty arr — original payload was non-JSON / corrupt
    }
  }
  const filtered = arr.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    return (
      (item as Record<string, unknown>).type !==
      PLUGIN_EXPANSION_ATTACHMENT_TYPE
    );
  });
  filtered.push(sentinel);
  return JSON.stringify(filtered);
}

/** Override seam for tests. Production callers must not pass this. */
export interface ExpandOverrides {
  buildIndex?: typeof buildCommandIndex;
  execHost?: typeof executeInlineBashHost;
  execDocker?: typeof executeInlineBashDocker;
}

/**
 * Persist a successfully-expanded prompt back to the message row.
 *
 * Crash-safety contract (P1 round-14): MUST be invoked synchronously after
 * inline execution succeeds, BEFORE the cursor advances past the message.
 * Otherwise a crash between exec and persist would re-execute on recovery.
 * The batch helper enforces ordering by writing inside the for-loop before
 * pushing the expanded message into `toSend`.
 */
export type PersistExpansionFn = (
  msgId: string,
  chatJid: string,
  expansion: PluginExpansionSentinel,
) => void;

/**
 * Pure helper that assembles an ExpandContext from already-resolved inputs.
 *
 * Host mode honors `customCwd` (when present) so inline `!` commands run
 * against the user's real repo rather than the synthetic data/groups path
 * (#18 P2-bug-4). Returns null when there is no resolvable owner — plugins
 * are per-user config so an ownerless group has no plugins to expand.
 */
export function makeExpandContext(args: {
  chatJid: string;
  groupFolder: string;
  ownerId: string | null | undefined;
  executionMode: 'host' | 'container' | string | null | undefined;
  customCwd?: string | null;
  groupsDir: string;
  containerName: string | null;
}): ExpandContext | null {
  if (!args.ownerId) return null;
  const executionMode: ExecutionMode =
    (args.executionMode || 'container') === 'host' ? 'host' : 'container';
  let cwd: string;
  if (executionMode === 'host') {
    cwd = args.customCwd
      ? path.resolve(args.customCwd)
      : path.resolve(args.groupsDir, args.groupFolder);
  } else {
    cwd = '/workspace/group';
  }
  return {
    userId: args.ownerId,
    groupJid: args.chatJid,
    groupFolder: args.groupFolder,
    cwd,
    executionMode,
    containerName: args.containerName,
  };
}

/**
 * Resolve runtime owner with admin-shared `web:main` sender precedence.
 *
 * On the admin-shared web:main workspace, plugin runtime is per-user so the
 * message sender is the correct owner — `group.created_by` is just whichever
 * admin first materialised the group (#18 P2-bug-5). On other workspaces
 * (single-owner home / member groups) `created_by` wins.
 *
 * Agent conversation tabs use a virtual jid `web:main#agent:<id>` — strip the
 * `#agent:` suffix before checking the web:main shared-home special case so
 * each admin's plugin runtime resolves to themselves rather than whichever
 * admin first materialised the parent group (#19 P2-5).
 *
 * @deprecated Use `resolvePerMessageRuntimeOwner` from `runtime-owner.ts`
 * instead — that helper additionally admin-gates the sender (active +
 * role=admin) so non-admin senders on `web:main + isHome` correctly fall
 * back to `created_by` like the cold-start path. Pre-fix divergence (#24
 * round-16 P2-1) made the same `/foo` command behave differently when the
 * runner was active vs idle. This export remains for the routing-bugs
 * regression tests that exercise the legacy precedence rule directly.
 */
export function resolvePluginRuntimeOwner(args: {
  groupJid: string;
  isHome?: boolean | null;
  createdBy?: string | null;
  senderUserId?: string | null;
}): string | null {
  const hashIdx = args.groupJid.indexOf('#');
  const baseJid = hashIdx >= 0 ? args.groupJid.slice(0, hashIdx) : args.groupJid;
  const isAdminSharedHome = baseJid === 'web:main' && args.isHome === true;
  const owner = isAdminSharedHome
    ? (args.senderUserId ?? args.createdBy ?? null)
    : (args.createdBy ?? args.senderUserId ?? null);
  return owner || null;
}

// --- Plugin runtime path resolution ----------------------------------------

/**
 * Build the absolute plugin runtime root for the resolved entry.
 * Host:   {DATA_DIR}/plugins/runtime/{userId}/snapshots/{snapshot}/{mp}/{plugin}
 * Docker: /workspace/plugins/snapshots/{snapshot}/{mp}/{plugin}
 *
 * Note: docker mounts /workspace/plugins from a per-user host path so the
 * userId is implicit on that side. Do NOT include userId in the docker path.
 */
function resolvePluginRoot(
  ctx: ExpandContext,
  entry: PluginCommandIndexEntry,
): string {
  if (ctx.executionMode === 'host') {
    return path.join(
      DATA_DIR,
      'plugins',
      'runtime',
      ctx.userId,
      'snapshots',
      entry.snapshot,
      entry.marketplace,
      entry.plugin,
    );
  }
  return `/workspace/plugins/snapshots/${entry.snapshot}/${entry.marketplace}/${entry.plugin}`;
}

// --- Slash-command head extraction -----------------------------------------

interface ParsedHead {
  /** Token after the leading `/`, e.g. "codex:status" or "review". */
  token: string;
  /** Raw whitespace-trimmed args string after the head, may include quotes. */
  rawArgs: string;
}

/**
 * Parse the leading slash-command head from a message's first line.
 *
 * Returns null when the message doesn't start with `/` or the first character
 * after `/` is not a valid command-name leader.
 *
 * `rawArgs` preserves the original argument string verbatim; positional split
 * happens in `whitespaceSplit()` separately so $ARGUMENTS env stays exact.
 */
function parseSlashHead(message: string): ParsedHead | null {
  const trimmed = message.replace(/^\s+/, '');
  if (!trimmed.startsWith('/')) return null;
  // Take only the first line for the head — multi-line bodies after a slash
  // command (rare but possible) keep their tail in rawArgs intact.
  const newlineIdx = trimmed.indexOf('\n');
  const head = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;
  const tail = newlineIdx >= 0 ? trimmed.slice(newlineIdx) : '';
  const m = /^\/([^\s]+)(\s+([\s\S]*))?$/.exec(head);
  if (!m) return null;
  const token = m[1];
  if (!token) return null;
  const headArgs = m[3] ?? '';
  const rawArgs = (headArgs + tail).trim();
  return { token, rawArgs };
}

/** First-version positional split: whitespace only, quotes preserved literally. */
export function whitespaceSplit(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

// --- Body expansion --------------------------------------------------------

/**
 * Match a leading-whitespace `!` command line wrapping a single backtick-
 * quoted bash command, e.g.:
 *
 *     !`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs "$ARGUMENTS"`
 *
 * The captured group (1) is the raw bash command (no template-string
 * substitution happens in JS — bash will resolve env vars at exec time).
 *
 * Multiline / global so we can find every inline line and replace each with
 * its captured stdout.
 */
const INLINE_BASH_RE = /^[ \t]*!\s*`([^`\n]+)`\s*$/gm;

/**
 * Find fenced code block ranges (```...```). Inline `!` matches inside these
 * ranges are left untouched — they are part of agent-facing examples.
 *
 * Tracks fence pairs by line: we walk the raw body and toggle "inside fence"
 * whenever we see a line that *starts* with three backticks. This matches
 * how markdown renderers (and Claude) treat fences.
 */
function fencedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = body.split('\n');
  let inside = false;
  let fenceStart = 0;
  // Pre-compute char offsets for each line.
  const offsets: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsets.push(off);
    off += line.length + 1; // +1 for the newline we split on
  }
  for (let i = 0; i < lines.length; i++) {
    const ltrim = lines[i].replace(/^[ \t]*/, '');
    if (ltrim.startsWith('```')) {
      if (!inside) {
        inside = true;
        fenceStart = offsets[i];
      } else {
        inside = false;
        const end = offsets[i] + lines[i].length;
        ranges.push([fenceStart, end]);
      }
    }
  }
  // Unterminated fence: the rest of the body is treated as fenced (defensive).
  if (inside) {
    ranges.push([fenceStart, body.length]);
  }
  return ranges;
}

function isInsideAnyRange(
  index: number,
  ranges: ReadonlyArray<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Find inline-bash invocations outside fenced code blocks. Returns one entry
 * per match, in document order (so we can splice from the end backwards).
 */
interface InlineMatch {
  start: number;
  end: number;
  rawCmd: string;
}

function findInlineMatches(body: string): InlineMatch[] {
  const fences = fencedRanges(body);
  const out: InlineMatch[] = [];
  // Reset lastIndex defensively — RE has /g state.
  INLINE_BASH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_BASH_RE.exec(body))) {
    const start = m.index;
    const end = start + m[0].length;
    if (isInsideAnyRange(start, fences)) continue;
    out.push({ start, end, rawCmd: m[1].trim() });
  }
  return out;
}

/**
 * Single-pass body assembly that:
 *   - Substitutes ${CLAUDE_PLUGIN_ROOT} / $ARGUMENTS / $1.. in **free** text
 *     (text outside both fenced blocks and inline ranges).
 *   - Keeps fenced ```...``` blocks verbatim — those are agent-facing
 *     examples that Claude expects to see with literal placeholders.
 *   - Splices inline `!` outputs verbatim — captured stdout is opaque and
 *     must NOT be re-scanned for placeholders (#19 P2-3).
 *
 * `inlineMatches` and `inlineOutputs` are parallel arrays (matches[i] →
 * outputs[i]) ordered by document position. inlineMatches must not overlap
 * fences (findInlineMatches already filters those out).
 */
function replacePlaceholdersAndSpliceInline(
  body: string,
  pluginRoot: string,
  rawArgs: string,
  posArgs: string[],
  inlineMatches: ReadonlyArray<InlineMatch>,
  inlineOutputs: ReadonlyArray<string>,
): string {
  const fences = [...fencedRanges(body)].sort((a, b) => a[0] - b[0]);
  const inlines = inlineMatches.map((m, i) => ({
    start: m.start,
    end: m.end,
    text: inlineOutputs[i] ?? '',
  }));
  // Merge fence + inline ranges into a single "preserved" list; everything
  // else is "free" text that gets placeholder substitution.
  type Preserved = { start: number; end: number; text: string };
  const preserved: Preserved[] = [];
  for (const [start, end] of fences) {
    preserved.push({ start, end, text: body.slice(start, end) });
  }
  for (const r of inlines) {
    preserved.push({ start: r.start, end: r.end, text: r.text });
  }
  preserved.sort((a, b) => a.start - b.start);

  const out: string[] = [];
  let cursor = 0;
  for (const p of preserved) {
    if (cursor < p.start) {
      out.push(
        applyPlaceholders(body.slice(cursor, p.start), pluginRoot, rawArgs, posArgs),
      );
    }
    out.push(p.text);
    cursor = p.end;
  }
  if (cursor < body.length) {
    out.push(applyPlaceholders(body.slice(cursor), pluginRoot, rawArgs, posArgs));
  }
  return out.join('');
}

function applyPlaceholders(
  segment: string,
  pluginRoot: string,
  rawArgs: string,
  posArgs: string[],
): string {
  let result = segment;
  // ${CLAUDE_PLUGIN_ROOT} — exact form, no $CLAUDE_PLUGIN_ROOT bare matches
  // (matches Claude Code CLI behavior; bare $VAR is too greedy and would also
  // catch $ARGUMENTS as $A + RGUMENTS).
  result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
  // $ARGUMENTS — bare or $ARGUMENTS preceded by non-word char.
  result = result.replace(/\$ARGUMENTS\b/g, rawArgs);
  // $1, $2, ... — replace with positional or empty string when out of range.
  result = result.replace(/\$(\d+)/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    if (idx < 0 || idx >= posArgs.length) return '';
    return posArgs[idx];
  });
  return result;
}

// --- Frontmatter rendering -------------------------------------------------

interface FrontmatterLine {
  key: string;
  value: string;
}

function renderFrontmatterSummary(
  fm: Record<string, unknown>,
): FrontmatterLine[] {
  const lines: FrontmatterLine[] = [];
  for (const key of Object.keys(fm)) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    let value: string;
    if (typeof v === 'string') {
      value = v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      value = String(v);
    } else {
      try {
        value = JSON.stringify(v);
      } catch {
        value = String(v);
      }
    }
    if (value.length === 0) continue;
    lines.push({ key, value });
  }
  return lines;
}

// --- Audit log -------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// --- Main expansion --------------------------------------------------------

export async function expandPluginSlashCommandIfNeeded(
  ctx: ExpandContext,
  message: string,
  overrides?: ExpandOverrides,
): Promise<ExpansionResult> {
  const head = parseSlashHead(message);
  if (!head) return { kind: 'miss' };

  const buildIdx = overrides?.buildIndex ?? buildCommandIndex;
  let resolution: Resolution;
  try {
    const idx = await buildIdx(ctx.userId);
    resolution = resolveCommand(idx, head.token);
  } catch (err) {
    logger.warn(
      { userId: ctx.userId, token: head.token, err },
      'plugin-command-expander: failed to build index',
    );
    return { kind: 'miss' };
  }

  if (resolution.kind === 'miss') return { kind: 'miss' };
  if (resolution.kind === 'conflict') {
    const fullIds = resolution.candidates.map((c) => c.fullId).sort();
    const namespacedSamples = resolution.candidates
      .map((c) => `/${c.plugin}:${c.commandName}`)
      .sort();
    const text =
      `命令 \`/${resolution.key}\` 在多个已启用插件中冲突。请使用带命名空间的形式：\n` +
      namespacedSamples.map((s) => `- \`${s}\``).join('\n') +
      `\n\n来源插件：${fullIds.join(', ')}`;
    return { kind: 'reply', text };
  }

  const entry = resolution.entry;
  if (!entry.disableModelInvocation) {
    // Non-DMI: SDK handles via --plugin-dir. Pass through unchanged.
    return { kind: 'miss' };
  }

  const posArgs = whitespaceSplit(head.rawArgs);
  const rawArgs = head.rawArgs; // verbatim; quotes literal
  const pluginRoot = resolvePluginRoot(ctx, entry);

  const inlineMatches = findInlineMatches(entry.body);

  // Container check happens before exec so we can short-circuit with a clear
  // message instead of letting docker exec fail with a cryptic error.
  if (
    inlineMatches.length > 0 &&
    ctx.executionMode === 'container' &&
    !ctx.containerName
  ) {
    return {
      kind: 'reply',
      text: '请先发起对话启动工作区后重试。',
    };
  }

  // Inline outputs collected per-match (in document order). Spliced AFTER
  // placeholder substitution so the executed stdout is treated as opaque
  // payload — never re-scanned for $ARGUMENTS / ${CLAUDE_PLUGIN_ROOT} / $1
  // (#19 P2-3: a plugin that prints a literal `$1` would otherwise have it
  // rewritten to posArgs[0]).
  const inlineOutputs: string[] = [];
  // Track aggregate inline success — caller persists the rendered prompt
  // back to the message row only when ALL inlines succeeded (P1 round-14).
  // If any failed, the prompt contains `<!-- inline command failed -->`
  // markers; recovery should retry rather than freeze that failure.
  let allInlinesSucceeded = inlineMatches.length > 0; // false stays false; only flip to false on failure
  if (inlineMatches.length > 0) {
    const execHost = overrides?.execHost ?? executeInlineBashHost;
    const execDocker = overrides?.execDocker ?? executeInlineBashDocker;

    // Audit log per inline command (one entry per inline call, not per command).
    for (const match of inlineMatches) {
      logger.info(
        {
          userId: ctx.userId,
          groupFolder: ctx.groupFolder,
          fullId: entry.fullId,
          commandName: entry.commandName,
          inlineCmd: truncate(match.rawCmd, 200),
          executionMode: ctx.executionMode,
          containerName: ctx.containerName,
        },
        'plugin-command-expander: executing inline bash',
      );
    }

    // Execute each match (sequentially so audit logs interleave naturally).
    for (const match of inlineMatches) {
      let result: InlineExecResult;
      try {
        if (ctx.executionMode === 'host') {
          result = await execHost(
            match.rawCmd,
            posArgs,
            { CLAUDE_PLUGIN_ROOT: pluginRoot, ARGUMENTS: rawArgs },
            ctx.cwd,
          );
        } else {
          // containerName non-null guaranteed by earlier check.
          result = await execDocker(
            ctx.containerName as string,
            match.rawCmd,
            posArgs,
            { CLAUDE_PLUGIN_ROOT: pluginRoot, ARGUMENTS: rawArgs },
          );
        }
      } catch (err) {
        // executeInlineBash* shouldn't throw; defensive.
        result = {
          ok: false,
          stdout: '',
          stderr: (err as Error).message,
          exitCode: null,
          signal: null,
          timedOut: false,
          spawnError: (err as Error).message,
        };
      }

      let replacement: string;
      if (result.ok) {
        replacement = result.stdout.replace(/\n+$/, '');
      } else {
        allInlinesSucceeded = false;
        const reason = describeFailure(result);
        replacement = `<!-- inline command failed: ${reason} -->`;
        logger.warn(
          {
            userId: ctx.userId,
            groupFolder: ctx.groupFolder,
            fullId: entry.fullId,
            commandName: entry.commandName,
            inlineCmd: truncate(match.rawCmd, 200),
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            spawnError: result.spawnError,
            stderr: truncate(result.stderr, 200),
          },
          'plugin-command-expander: inline command failed',
        );
      }
      inlineOutputs.push(replacement);
    }
  }

  // Placeholder substitution honors fence blocks (verbatim) and inline ranges
  // (replaced with the captured stdout, never re-substituted). Single pass so
  // length-changing replacements don't invalidate later offsets.
  const body = replacePlaceholdersAndSpliceInline(
    entry.body,
    pluginRoot,
    rawArgs,
    posArgs,
    inlineMatches,
    inlineOutputs,
  );

  const fmLines = renderFrontmatterSummary(entry.frontmatter);
  const prompt = renderExpandedPrompt({
    fullId: entry.fullId,
    plugin: entry.plugin,
    marketplace: entry.marketplace,
    commandName: entry.commandName,
    rawArgs,
    fmLines,
    body,
  });

  return { kind: 'expanded', prompt, inlineExecuted: allInlinesSucceeded };
}

interface RenderInput {
  fullId: string;
  plugin: string;
  marketplace: string;
  commandName: string;
  rawArgs: string;
  fmLines: FrontmatterLine[];
  body: string;
}

function renderExpandedPrompt(r: RenderInput): string {
  const parts: string[] = [];
  parts.push('The user manually invoked Claude Code plugin command:');
  parts.push('');
  parts.push(`Command: /${r.commandName}`);
  parts.push(`Plugin: ${r.plugin}@${r.marketplace}`);
  parts.push(`Arguments: ${r.rawArgs || '(none)'}`);
  if (r.fmLines.length > 0) {
    parts.push('');
    parts.push('Frontmatter:');
    for (const { key, value } of r.fmLines) {
      parts.push(`- ${key}: ${value}`);
    }
  }
  parts.push('');
  parts.push(
    'Use the following command definition exactly as Claude Code would for a user-invoked slash command.',
  );
  parts.push('');
  parts.push(r.body);
  return parts.join('\n');
}

function describeFailure(result: InlineExecResult): string {
  if (result.timedOut) return 'timed out after 30s';
  if (result.spawnError) return `spawn error: ${result.spawnError}`;
  if (result.signal) return `killed by signal ${result.signal}`;
  if (result.exitCode !== null) return `exit code ${result.exitCode}`;
  return 'unknown error';
}

// --- Batch helper ----------------------------------------------------------

/**
 * Per-message ExpandContext resolver. Callers that share a chat across
 * multiple senders (e.g. the admin-shared `web:main` workspace where
 * each admin's plugin runtime is per-user) can use this to look up the
 * correct context for each message in the batch instead of pinning one
 * context for the whole batch.
 *
 * Returning `null` means "no expansion for this message" — pass-through.
 * That's the same semantics as `makeExpandContext()` returning null when
 * the resolved owner is empty.
 */
export type ResolveContextFn<M extends ExpandableMessage> = (
  msg: M,
) => ExpandContext | null;

/**
 * Process a list of pending messages, splitting into:
 *   - toSend: forward to agent (miss = unchanged content; expanded = prompt)
 *   - replies: in-band system reply (conflict / no container / etc.)
 *
 * Caller is responsible for writing replies to DB + broadcasting + advancing
 * cursor to the original user message timestamp.
 *
 * Crash-safety (P1 round-14): when a message has a previously-persisted
 * plugin-expansion sentinel in its `attachments`, this helper SKIPS the
 * (non-idempotent) inline `!` execution and uses the stored prompt
 * verbatim. Otherwise, after a successful expansion (with all inlines
 * succeeded), it invokes `persistExpansion` BEFORE adding the message to
 * `toSend` so the persistence write completes before the cursor advances.
 *
 * `persistExpansion` is optional — callers without DB access (tests, the
 * single-message web fast-path) can pass undefined and the recovery
 * window stays the same as before this fix. Production cold-start callers
 * MUST pass the DB writer.
 *
 * Per-message context (#23 round-15 P2-2): the second positional argument
 * accepts either a single `ExpandContext` (legacy: same context for every
 * message in the batch) or a `ResolveContextFn` that's called per-message.
 * The per-message form is required when the chat is shared across multiple
 * plugin owners — e.g. the admin-shared `web:main` workspace where
 * runtimeOwner is per-sender. Pinning one context for the whole batch
 * caused mixed-admin batches to expand under the wrong runtime.
 */
export async function expandMessagesIfNeeded<M extends ExpandableMessage>(
  messages: M[],
  ctxOrResolver: ExpandContext | ResolveContextFn<M>,
  overrides?: ExpandOverrides,
  persistExpansion?: PersistExpansionFn,
): Promise<BatchExpansionOutcome<M>> {
  const toSend: M[] = [];
  const replies: Array<{ originalMsg: M; text: string }> = [];

  const resolveCtx: ResolveContextFn<M> =
    typeof ctxOrResolver === 'function'
      ? (ctxOrResolver as ResolveContextFn<M>)
      : () => ctxOrResolver;

  for (const msg of messages) {
    // Recovery short-circuit: if a prior run already expanded this message
    // and persisted the prompt, replay that prompt verbatim — DO NOT call
    // expandPluginSlashCommandIfNeeded again, which would re-run inline `!`
    // and double-fire side effects (P1 round-14).
    const persisted = readPluginExpansionFromAttachments(msg.attachments);
    if (persisted) {
      toSend.push({ ...msg, content: persisted.prompt });
      continue;
    }

    const ctx = resolveCtx(msg);
    if (!ctx) {
      // No resolvable owner / context for this message → pass-through.
      toSend.push(msg);
      continue;
    }

    const result = await expandPluginSlashCommandIfNeeded(
      ctx,
      msg.content,
      overrides,
    );
    if (result.kind === 'miss') {
      toSend.push(msg);
    } else if (result.kind === 'expanded') {
      // Crash-safety ordering: persist BEFORE pushing to toSend so the
      // write completes (and on rollback nothing was queued downstream)
      // before any caller sees the expanded message and advances cursors.
      if (result.inlineExecuted && persistExpansion) {
        try {
          persistExpansion(msg.id, msg.chat_jid, {
            type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
            expanded: true,
            prompt: result.prompt,
            expandedAt: new Date().toISOString(),
          });
        } catch (err) {
          // Persist failure is logged but non-fatal: the prompt still
          // reaches the agent on this run; recovery may re-run inline
          // (worst case is the original bug, no regression).
          logger.warn(
            { err, msgId: msg.id, chatJid: msg.chat_jid },
            'plugin-command-expander: failed to persist expansion sentinel',
          );
        }
      }
      // Replace content; preserve all other metadata.
      toSend.push({ ...msg, content: result.prompt });
    } else {
      replies.push({ originalMsg: msg, text: result.text });
    }
  }

  return { toSend, replies };
}
