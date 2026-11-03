/**
 * Agent tools for multi-task mode (多任务模式).
 *
 * A conversation of a multi-task workspace hands a sizeable task to a worker
 * session (`work_delegate`), lists what it handed over (`work_delegations`),
 * stops one (`work_stop`) or passes the user's answer on (`work_followup`).
 * The worker's reports come back to it as `<work_report>` inputs.
 *
 * Requests go through the work item IPC like the team tools. The host takes
 * the caller from the IPC directory and rechecks every rule; the schemas
 * only catch obvious mistakes before anything is sent.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { strict } from './automation-tools.js';
import { workSender, type WorkIpcCall } from './work-tools.js';
import {
  DELEGATE_CONTEXT_CHAR_LIMIT,
  DELEGATE_FILES_LIMIT,
  DELEGATE_FOLLOWUP_CHAR_LIMIT,
  DELEGATE_TASK_CHAR_LIMIT,
  WORK_TITLE_CHAR_LIMIT,
  type DelegatedWorkSummary,
  type WorkDelegateResult,
  type WorkStage,
} from './work-items.js';

/** Delegating creates a work item and a worker session. */
const DELEGATE_TIMEOUT_MS = 60_000;

const STAGE_LABELS: Record<WorkStage, string> = {
  answer: '等用户回答',
  blocked: '受阻',
  failed: '失败',
  approval: '等批准',
  working: '进行中',
  idle: '空闲',
  ended: '已结束',
};

function describeDelegation(item: DelegatedWorkSummary): string {
  const parts = [
    `#${item.seq} ${item.title}`,
    `id: ${item.workItemId}`,
    STAGE_LABELS[item.stage] ?? item.stage,
    `最近回报: ${item.lastReport ?? '无'}`,
    `派出于 ${item.createdAt}`,
  ];
  if (item.lastSummary) parts.push(`摘要: ${item.lastSummary}`);
  return `- ${parts.join(' · ')}`;
}

const itemSchema = z.string().trim().min(1).describe('任务编号（如 #3）或 id');

/**
 * The delegating session's tools. `currentInputTurnId` is read when the
 * request is written, as the automation tools do: the host admits a
 * delegation only from the owner's own turn, judged by the input it names.
 */
export function createDelegationTools(
  call: WorkIpcCall,
  currentInputTurnId: () => string | null | undefined,
): SdkMcpToolDefinition<any>[] {
  const send = workSender(call, (type) =>
    type === 'work_delegations'
      ? '等待宿主响应超时，请稍后再试。'
      : `等待宿主确认超时：${type} 可能已经生效。先用 work_delegations 核实，不要直接重试。`,
  );

  return [
    tool(
      'work_delegate',
      `把一件大任务交给后台 Worker：它在自己的会话里独立完成，你这一轮随即结束，可以接着回应用户。
- 适合派出：预计耗时长、步骤多、批量处理，或需要长时间运行的任务（跑完整测试、批量改写、长时间调研或监控）。
- 不要派出：一轮之内能完成的事；需要和用户边聊边改的事；用户说「就在这里做」「你直接做」时。
- Worker 看不到这段对话：task 写成自足的说明（目标、约束、要交回的结果），需要的背景放进 context，相关文件放进 files。它与你共用工作目录。
- 派出后简短告诉用户已交给后台，然后结束这一轮。结果会作为 <work_report> 输入自动回到本会话，不要等待或轮询。
宿主拒绝时按返回的说明处理。`,
      strict({
        title: z
          .string()
          .trim()
          .min(1)
          .max(WORK_TITLE_CHAR_LIMIT)
          .describe(
            `简短标题，给用户和任务列表看，最多 ${WORK_TITLE_CHAR_LIMIT} 字`,
          ),
        task: z
          .string()
          .trim()
          .min(1)
          .max(DELEGATE_TASK_CHAR_LIMIT)
          .describe(
            `交给 Worker 的完整说明：要做什么、约束、完成标准和要交回的结果，最多 ${DELEGATE_TASK_CHAR_LIMIT} 字`,
          ),
        context: z
          .string()
          .trim()
          .max(DELEGATE_CONTEXT_CHAR_LIMIT)
          .optional()
          .describe(
            `Worker 需要的对话背景：用户的偏好、已经确认的决定、相关结论，最多 ${DELEGATE_CONTEXT_CHAR_LIMIT} 字`,
          ),
        files: z
          .array(z.string().trim().min(1))
          .max(DELEGATE_FILES_LIMIT)
          .optional()
          .describe(
            `Worker 需要阅读或可以修改的文件，相对工作目录的路径，最多 ${DELEGATE_FILES_LIMIT} 个`,
          ),
      }),
      async ({ title, task, context, files }) =>
        send<WorkDelegateResult>(
          'work_delegate',
          {
            title,
            task,
            ...(context ? { context } : {}),
            ...(files?.length ? { files } : {}),
            inputTurnId: currentInputTurnId() || null,
          },
          ({ seq, workItemId }) =>
            `已派出 #${seq}「${title}」（id: ${workItemId}）。结果会作为 <work_report> 输入自动回到本会话，不要等待或轮询。简短告诉用户已交给后台，然后结束本轮。`,
          DELEGATE_TIMEOUT_MS,
        ),
    ),

    tool(
      'work_delegations',
      '列出本会话派出、还没结束的后台任务：编号、标题、阶段、最近一次回报。用户问后台进展时使用；派出后不要用它轮询。',
      strict({}),
      async () =>
        send<DelegatedWorkSummary[]>('work_delegations', {}, (items) =>
          items.length
            ? items.map(describeDelegation).join('\n')
            : '本会话没有进行中的后台任务。',
        ),
    ),

    tool(
      'work_stop',
      '停止本会话派出的一个后台任务，只在用户要求停止时使用。之后会收到一条 state="stopped" 的 <work_report>，不必再告诉用户一次。',
      strict({ item: itemSchema }),
      async ({ item }) => send('work_stop', { item }, () => `已停止 ${item}。`),
    ),

    tool(
      'work_followup',
      '把用户的回答、更正或补充要求转给一个进行中的后台任务，作为 Worker 的下一条输入。Worker 报告 blocked 等回答时，用它转达用户的回答。',
      strict({
        item: itemSchema,
        message: z
          .string()
          .trim()
          .min(1)
          .max(DELEGATE_FOLLOWUP_CHAR_LIMIT)
          .describe(
            `转给 Worker 的内容，写成自足的一段话，最多 ${DELEGATE_FOLLOWUP_CHAR_LIMIT} 字`,
          ),
      }),
      async ({ item, message }) =>
        send(
          'work_followup',
          { item, message },
          () =>
            `已转给 ${item} 的 Worker。它的回报会作为 <work_report> 输入回到本会话。`,
        ),
    ),
  ];
}
