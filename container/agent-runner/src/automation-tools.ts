/**
 * Agent tools for automations (自动化).
 *
 * Each call writes one `Automation*Request` into the task IPC directory and
 * waits for `<type>_result`. The host derives the workspace, the calling
 * session, the source route and whether the turn is the owner's from the IPC
 * channel and the turn being processed, so requests never carry them.
 *
 * Schemas are strict: an unknown parameter is rejected with the list of the
 * tool's parameters instead of being dropped silently. Script execution and
 * pre-run checks are judged by the host (only it knows whether this is an
 * admin's host workspace); the local check skips that rule.
 */

import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  AUTOMATION_LIMITS,
  AUTOMATION_RUN_STATUS_LABELS,
  AUTOMATION_SESSION_MODE_LABELS,
  AUTOMATION_STATUS_LABELS,
  describeAutomationSchedule,
  formatAutomationTime,
  validateAutomationDraft,
  type Automation,
  type AutomationCompleteRequest,
  type AutomationCreateRequest,
  type AutomationCurrentRunRequest,
  type AutomationDraft,
  type AutomationIdRequest,
  type AutomationIpcRequest,
  type AutomationIpcResult,
  type AutomationListRequest,
  type AutomationListRunsRequest,
  type AutomationRun,
  type AutomationRunTrigger,
  type AutomationSessionChoice,
  type AutomationSessionMode,
  type AutomationUpdateRequest,
} from './automation.js';

/** Writes the request and resolves with the host's result; throws on timeout. */
export type AutomationIpcCall = (
  request: AutomationIpcRequest,
  resultPrefix: string,
) => Promise<Record<string, unknown>>;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const SESSION_MODE: Record<AutomationSessionChoice, AutomationSessionMode> = {
  current: 'bound',
  fresh: 'fresh',
  persistent: 'persistent',
};

function text(value: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: value }],
    ...(isError ? { isError: true } : {}),
  };
}

/** An object that rejects unknown keys, naming the keys it does accept. */
function strictObject<T extends z.ZodRawShape>(shape: T) {
  const usage = `可用参数：${Object.keys(shape).join('、') || '无'}`;
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `不支持的参数：${issue.keys.join('、')}。${usage}`
        : undefined,
  });
}

/**
 * A tool's parameters as a strict object. The SDK accepts an object schema
 * in place of a raw shape; typing it as the shape keeps handler inference.
 */
function strict<T extends z.ZodRawShape>(shape: T): T {
  return strictObject(shape) as unknown as T;
}

const scheduleSchema = strictObject({
  kind: z.enum(['cron', 'interval', 'once', 'manual']),
  cronExpr: z.string().optional().describe('cron：5 段表达式'),
  timezone: z.string().optional().describe('cron：IANA 时区，省略用服务器时区'),
  intervalMs: z
    .number()
    .int()
    .optional()
    .describe(
      `interval：上次运行结束后再等的毫秒数，至少 ${AUTOMATION_LIMITS.intervalMinMs}`,
    ),
  runAt: z
    .string()
    .optional()
    .describe('once：带时区的 ISO 时间，如 2026-11-01T09:00:00+08:00'),
});

const preRunCheckSchema = strictObject({
  command: z.string(),
  timeoutMs: z
    .number()
    .int()
    .optional()
    .describe(`默认 ${AUTOMATION_LIMITS.preRunCheckDefaultTimeoutMs}`),
});

const RUN_TRIGGER_LABELS: Record<AutomationRunTrigger, string> = {
  schedule: '按计划',
  manual: '手动',
  backfill: '补跑',
};

/** Writes whose outcome is unknown after a timeout; reads are just retried. */
const READ_ONLY_TYPES = new Set<AutomationIpcRequest['type']>([
  'automation_list',
  'automation_list_runs',
]);

function zoneOf(automation: Automation): string | undefined {
  return automation.schedule.timezone ?? undefined;
}

function time(iso: string | null, automation: Automation): string {
  return iso ? formatAutomationTime(iso, zoneOf(automation)) : '无';
}

/** One line per automation, for lists and update results. */
function describeAutomation(automation: Automation): string {
  const parts = [
    `「${automation.name}」id: ${automation.id}，revision ${automation.revision}`,
    AUTOMATION_STATUS_LABELS[automation.status] +
      (automation.statusReason ? `（${automation.statusReason}）` : ''),
    describeAutomationSchedule(automation.schedule),
    AUTOMATION_SESSION_MODE_LABELS[automation.sessionMode],
    `下次：${time(automation.nextFireAt, automation)}`,
  ];
  if (automation.stopWhen) parts.push(`停止条件：${automation.stopWhen}`);
  if (automation.endAt)
    parts.push(`结束：${time(automation.endAt, automation)}`);
  if (automation.silentWhenIdle) parts.push('安静模式');
  if (automation.execution === 'script') parts.push('脚本');
  return parts.join(' · ');
}

function describeCreated(automation: Automation): string {
  return [
    `已创建自动化「${automation.name}」（id: ${automation.id}，revision ${automation.revision}）。`,
    `- 计划：${describeAutomationSchedule(automation.schedule)}`,
    `- 运行会话：${AUTOMATION_SESSION_MODE_LABELS[automation.sessionMode]}`,
    `- 下次运行：${time(automation.nextFireAt, automation)}`,
    `- 停止条件：${automation.stopWhen ?? '未设置'}${automation.endAt ? `；结束时间 ${time(automation.endAt, automation)}` : ''}`,
    ...(automation.silentWhenIdle ? ['- 安静模式：没有发现问题时不通知'] : []),
    ...(automation.preRunCheck
      ? [`- 前置检查：${automation.preRunCheck.command}`]
      : []),
    '请向用户简要确认以上设置。',
  ].join('\n');
}

function describeRun(run: AutomationRun): string {
  const parts = [
    `${run.id}`,
    AUTOMATION_RUN_STATUS_LABELS[run.status] + (run.silenced ? '（安静）' : ''),
    RUN_TRIGGER_LABELS[run.trigger],
    formatAutomationTime(run.scheduledFor),
  ];
  if (run.error) parts.push(`错误：${run.error}`);
  return `- ${parts.join(' · ')}`;
}

function draftErrors(draft: AutomationDraft): string[] {
  return validateAutomationDraft(draft, {
    now: new Date(),
    allowHostCommands: true,
  });
}

/**
 * Check only what the patch changes: absent fields get placeholder values the
 * validator accepts, so the errors left are about the patch itself. The host
 * validates the merged automation; this only catches obvious mistakes early.
 */
function patchErrors(patch: AutomationUpdateRequest['patch']): string[] {
  return draftErrors({
    name: patch.name ?? '-',
    prompt: patch.prompt || '-',
    stopWhen: patch.stopWhen,
    schedule: patch.schedule ?? { kind: 'manual' },
    endAt: patch.endAt,
    sessionMode: 'persistent',
    preRunCheck: patch.preRunCheck,
    execution:
      patch.scriptCommand !== undefined && patch.scriptCommand !== null
        ? 'script'
        : 'agent',
    scriptCommand: patch.scriptCommand,
  });
}

/**
 * `currentInputTurnId` is read when each request is written, as the
 * workspace memory tools do: the host judges the request by the input it
 * names, so a request that arrives after its turn ended cannot pass for the
 * owner's next one. Without a turn it sends null and the host refuses.
 */
export function createAutomationTools(
  call: AutomationIpcCall,
  currentInputTurnId: () => string | null | undefined,
): SdkMcpToolDefinition<any>[] {
  const stamp = () => ({
    requestId: randomUUID(),
    inputTurnId: currentInputTurnId() || null,
    timestamp: new Date().toISOString(),
  });

  /**
   * Send and turn the host's answer into tool text. A timeout leaves the
   * outcome unknown, so a write must be checked before it is retried.
   */
  const send = async (
    request: AutomationIpcRequest,
    onSuccess: (result: AutomationIpcResult) => string,
  ): Promise<ToolResult> => {
    let raw: Record<string, unknown>;
    try {
      raw = await call(request, `${request.type}_result`);
    } catch {
      return text(
        READ_ONLY_TYPES.has(request.type)
          ? '等待宿主响应超时，请稍后再试。'
          : `等待宿主确认超时：${request.type === 'automation_create' ? '自动化可能已创建' : '操作可能已生效'}，请先用 automation_list 核实，不要直接重试。`,
        true,
      );
    }
    const result = raw as unknown as AutomationIpcResult;
    if (!result.success) return text(result.error || '操作失败', true);
    return text(onSuccess(result));
  };

  const automationOf = (result: AutomationIpcResult, fallback: string) =>
    result.automation ? describeAutomation(result.automation) : fallback;

  const idShape = { id: z.string().min(1).describe('自动化 id') };

  const idTool = (
    type: AutomationIdRequest['type'],
    description: string,
    done: (result: AutomationIpcResult, id: string) => string,
  ) =>
    tool(type, description, strict(idShape), async (args) =>
      send(
        { type, id: args.id, ...stamp() } satisfies AutomationIdRequest,
        (result) => done(result, args.id),
      ),
    );
  const changed = (verb: string) => (result: AutomationIpcResult, id: string) =>
    `${verb}：${automationOf(result, id)}`;

  return [
    tool(
      'automation_create',
      `新建自动化：按计划把 prompt 作为真实的一轮发进会话。用户要求定期、定时或稍后做某事时使用。
- 只在缺少会实质改变目标的信息（做什么、何时）时才问；用户已说清的不要重复问。
- prompt 写成每次运行要执行的指令，保留用户的目标、限制和停止条件；频率由 schedule 表达，不要写进 prompt。
- 检查类任务设 silentWhenIdle；轮询类任务建议加 preRunCheck，没有新情况时直接跳过。
- 只有工作区主人（或主人指定的私聊委托对象，不含脚本与前置检查）发起的轮次能创建或修改，宿主拒绝时照实告诉用户。`,
      strict({
        name: z.string().describe('简短名称，显示在列表和通知里'),
        prompt: z
          .string()
          .optional()
          .describe('每次运行发给 Agent 的指令（execution=agent 时必填）'),
        schedule: scheduleSchema.describe(
          'cron 按时刻，interval 按间隔，once 运行一次，manual 只手动运行',
        ),
        session: z
          .enum(['current', 'fresh', 'persistent'])
          .default('current')
          .describe(
            `运行在哪个会话。current=${AUTOMATION_SESSION_MODE_LABELS.bound}（默认：就是当前会话，回复回到当前渠道）；fresh=${AUTOMATION_SESSION_MODE_LABELS.fresh}（每次开一个新会话，互不相干）；persistent=${AUTOMATION_SESSION_MODE_LABELS.persistent}（第一次运行开一个新会话，之后一直复用）`,
          ),
        stopWhen: z
          .string()
          .optional()
          .describe(
            '停止条件。用户说了「直到…为止」「…之后停止」时必须写；每次运行先核实，满足后用 automation_complete 结束',
          ),
        endAt: z
          .string()
          .optional()
          .describe(
            '结束时间（带时区的 ISO 时间），到点不再运行，作停止条件的兜底',
          ),
        silentWhenIdle: z
          .boolean()
          .optional()
          .describe(
            '安静模式：检查类任务（有变化才告诉我）设 true，没发现问题时不通知；提醒、定时发送不要设',
          ),
        preRunCheck: preRunCheckSchema
          .optional()
          .describe(
            '前置检查（只在管理员的宿主机工作区可用）：每次运行前执行，退出码 0 运行、2 跳过本次（不消耗 token），其他记为失败；输出会交给本次运行',
          ),
        execution: z
          .enum(['agent', 'script'])
          .optional()
          .describe(
            'agent（默认）；script 直接执行 scriptCommand、不调用模型，只在管理员的宿主机工作区可用，不能配 fresh',
          ),
        scriptCommand: z
          .string()
          .optional()
          .describe('execution=script 的命令'),
      }),
      async (args) => {
        const { session, ...fields } = args;
        const errors = draftErrors({
          ...fields,
          sessionMode: SESSION_MODE[session],
        });
        if (errors.length > 0)
          return text(`参数有误：${errors.join('；')}`, true);
        return send(
          {
            type: 'automation_create',
            ...stamp(),
            ...args,
          } satisfies AutomationCreateRequest,
          (result) =>
            result.automation
              ? describeCreated(result.automation)
              : '已创建自动化。',
        );
      },
    ),

    tool(
      'automation_update',
      '修改自动化，只传用户点名要改的字段，不要顺手改别的；目标值不明确时先问。字段含义同 automation_create，传 null 清除可选字段。改计划后下次运行从现在重算。会话方式不能改，需要时删除后重建。',
      strict({
        ...idShape,
        expectedRevision: z
          .number()
          .int()
          .describe('automation_list 返回的 revision；期间被改过会被拒绝'),
        name: z.string().optional(),
        prompt: z.string().optional(),
        schedule: scheduleSchema.optional(),
        stopWhen: z.string().nullable().optional(),
        endAt: z.string().nullable().optional(),
        silentWhenIdle: z.boolean().optional(),
        preRunCheck: preRunCheckSchema.nullable().optional(),
        scriptCommand: z.string().nullable().optional(),
      }),
      async ({ id, expectedRevision, ...fields }) => {
        const patch: AutomationUpdateRequest['patch'] = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        );
        if (Object.keys(patch).length === 0)
          return text('参数有误：没有要修改的字段', true);
        const errors = patchErrors(patch);
        if (errors.length > 0)
          return text(`参数有误：${errors.join('；')}`, true);
        return send(
          {
            type: 'automation_update',
            ...stamp(),
            id,
            expectedRevision,
            patch,
          } satisfies AutomationUpdateRequest,
          (result) => changed('已修改')(result, id),
        );
      },
    ),

    idTool(
      'automation_pause',
      '暂停自动化，可用 automation_resume 恢复。在运行中暂停自己是安全的，本次运行会正常结束。',
      changed('已暂停'),
    ),
    idTool(
      'automation_resume',
      '恢复已暂停或已完成的自动化，下次运行从现在重算。',
      changed('已恢复'),
    ),

    tool(
      'automation_complete',
      '结束自动化（状态变为已完成）并记录原因。停止条件满足时在运行中调用它结束自己，本次运行会正常结束；没把握时不要调用。',
      strict({
        ...idShape,
        reason: z
          .string()
          .min(1)
          .describe('给用户看的原因，如「第 1–29 集已全部下载」'),
      }),
      async (args) =>
        send(
          {
            type: 'automation_complete',
            ...stamp(),
            id: args.id,
            reason: args.reason,
          } satisfies AutomationCompleteRequest,
          (result) => changed('已结束')(result, args.id),
        ),
    ),

    idTool(
      'automation_delete',
      '删除自动化及其运行记录，不可撤销。用户要求删除，或任务本身规定完成后清理时才用；在运行中删除自己时本次运行会正常结束。',
      () => '已删除',
    ),
    idTool(
      'automation_run_now',
      '立即运行一次，不改变后续计划。',
      (result) =>
        `已开始运行${result.run ? `（运行 id: ${result.run.id}，${AUTOMATION_RUN_STATUS_LABELS[result.run.status]}）` : ''}`,
    ),

    tool(
      'automation_list',
      '列出当前工作区的自动化：id、revision、状态、计划和下次运行时间。',
      strict({}),
      async () =>
        send(
          {
            type: 'automation_list',
            ...stamp(),
          } satisfies AutomationListRequest,
          (result) =>
            result.automations?.length
              ? result.automations
                  .map((a) => `- ${describeAutomation(a)}`)
                  .join('\n')
              : '当前工作区没有自动化。',
        ),
    ),

    tool(
      'automation_list_runs',
      '查看自动化最近的运行记录。',
      strict({
        ...idShape,
        limit: z.number().int().min(1).max(50).optional().describe('默认 20'),
      }),
      async (args) =>
        send(
          {
            type: 'automation_list_runs',
            ...stamp(),
            id: args.id,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          } satisfies AutomationListRunsRequest,
          (result) =>
            result.runs?.length
              ? result.runs.map(describeRun).join('\n')
              : '还没有运行记录。',
        ),
    ),

    tool(
      'automation_notify_current_run',
      '安静模式的运行中发现需要用户知道的变化或问题时调用，本次运行会正常通知用户。只在自动化运行中可用。',
      strict({}),
      async () =>
        send(
          {
            type: 'automation_notify_current_run',
            ...stamp(),
          } satisfies AutomationCurrentRunRequest,
          () => '本次运行会通知用户。',
        ),
    ),

    tool(
      'automation_silence_current_run',
      '本次运行没有值得通知的内容时调用：不通知用户、不标未读（失败仍会通知）。只在自动化运行中可用。',
      strict({}),
      async () =>
        send(
          {
            type: 'automation_silence_current_run',
            ...stamp(),
          } satisfies AutomationCurrentRunRequest,
          () => '本次运行不会通知用户。',
        ),
    ),
  ];
}
