/**
 * Agent tools for team mode (团队模式).
 *
 * The router session routes candidates (`work_route`), speaks in the group
 * (`work_reply`) and reads the group's work items (`work_list`); a worker
 * session confirms a request once (`work_ack`), reports to the router
 * (`work_report`) and hands back what is beyond its item (`work_handback`).
 * The worker of a multi-task mode delegated item only reports, to the
 * session that delegated it.
 *
 * Each call writes one request into the task IPC directory and waits for
 * `<type>_result`: `{ ok: true, data } | { ok: false, error }`. The host
 * derives the caller (workspace, session, role) from the IPC directory and
 * rechecks every rule; the local checks only catch obvious mistakes early,
 * before anything is sent.
 */

import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  strict,
  strictObject,
  text,
  type ToolResult,
} from './automation-tools.js';

import {
  DELEGATED_REPORT_STATES,
  TEAM_IM_WORD_LIMIT,
  WORK_NOTE_WORD_LIMIT,
  WORK_REPORT_STATES,
  WORK_SUMMARY_CHAR_LIMIT,
  WORK_TITLE_CHAR_LIMIT,
  countImWords,
  type TeamRole,
  type WorkIpcType,
  type WorkRouteItem,
  type WorkRouteResultItem,
} from './work-items.js';
import { sessionKind } from './session-kind.js';

/** Writes the request and resolves with the host's result; throws on timeout. */
export type WorkIpcCall = (
  request: Record<string, unknown> & { type: WorkIpcType; requestId: string },
  resultPrefix: string,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

type WorkIpcResult<D> = { ok: true; data?: D } | { ok: false; error?: string };

/** Accepting creates sessions and maybe a git worktree, so it waits longer. */
const ROUTE_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Sends one work request at a time and turns the host's answer into tool
 * text. A timeout leaves the outcome of a write unknown, so `timedOut` says,
 * per request type, how to check before retrying.
 */
export function workSender(
  call: WorkIpcCall,
  timedOut: (type: WorkIpcType) => string,
) {
  return async <D = Record<string, unknown>>(
    type: WorkIpcType,
    payload: object,
    onSuccess: (data: D) => string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ToolResult> => {
    const request = { type, requestId: randomUUID(), ...payload };
    let result: WorkIpcResult<D>;
    try {
      result = (await call(
        request,
        `${type}_result`,
        timeoutMs,
      )) as unknown as WorkIpcResult<D>;
    } catch {
      return text(timedOut(type), true);
    }
    if (!result.ok) return text(result.error || `${type} failed`, true);
    return text(onSuccess(result.data ?? ({} as D)));
  };
}

function overWordLimit(label: string, value: string, limit: number) {
  // Every word is at least one character, so a short text needs no count.
  if (value.length <= limit) return null;
  const words = countImWords(value);
  return words > limit
    ? `${label} is ${words} words; the limit is ${limit}`
    : null;
}

/** What a route item is missing for its kind; empty when it can be sent. */
function routeItemErrors(item: WorkRouteItem): string[] {
  const errors: string[] = [];
  const need = (field: keyof WorkRouteItem) => {
    const value = item[field];
    if (typeof value !== 'string' || !value.trim())
      errors.push(`${item.kind} needs ${field}`);
  };
  if (item.kind === 'accept') {
    need('title');
    need('acknowledgement');
    if (item.acknowledgement) {
      const over = overWordLimit(
        'acknowledgement',
        item.acknowledgement,
        TEAM_IM_WORD_LIMIT,
      );
      if (over) errors.push(over);
    }
  } else if (item.kind === 'attach' || item.kind === 'stop') {
    need('workItemId');
  } else {
    need('reason');
  }
  if (item.note) {
    const over = overWordLimit('note', item.note, WORK_NOTE_WORD_LIMIT);
    if (over) errors.push(over);
  }
  return errors;
}

function describeRouteResult(result: WorkRouteResultItem): string {
  if (!result.ok)
    return `- ${result.triggerMessageId}: refused: ${result.error ?? 'unknown error'}`;
  const parts = [result.decision ?? 'done'];
  if (result.workItemId) parts.push(`work item ${result.workItemId}`);
  return `- ${result.triggerMessageId}: ${parts.join(', ')}`;
}

interface WorkListEntry {
  id: string;
  seq: number;
  title: string;
  stage: string;
  lastReport: string | null;
  lastSummary: string | null;
  attention: string | null;
  sourceMessageId: string;
}

function describeListEntry(item: WorkListEntry): string {
  const parts = [
    `#${item.seq} ${item.title}`,
    `id: ${item.id}`,
    `stage: ${item.stage}`,
    `last report: ${item.lastReport ?? 'none'}`,
    `source: ${item.sourceMessageId}`,
  ];
  if (item.attention) parts.push(`waiting on a person: ${item.attention}`);
  if (item.lastSummary) parts.push(`summary: ${item.lastSummary}`);
  return `- ${parts.join(' · ')}`;
}

const routeItemSchema = strictObject({
  kind: z
    .enum(['accept', 'attach', 'stop', 'ignore'])
    .describe(
      'accept: new work; attach: the message continues an existing work item; stop: an explicit candidate asks to stop an item; ignore: not work',
    ),
  triggerMessageId: z
    .string()
    .min(1)
    .describe(
      'The candidate\'s trigger, exactly as <team_candidate trigger="...">',
    ),
  title: z
    .string()
    .max(WORK_TITLE_CHAR_LIMIT)
    .optional()
    .describe(
      `accept: a short title for people, at most ${WORK_TITLE_CHAR_LIMIT} characters`,
    ),
  workItemId: z
    .string()
    .optional()
    .describe('attach/stop: the work item id (from work_list or the card)'),
  acknowledgement: z
    .string()
    .optional()
    .describe(
      `accept: one short sentence posted as a reply to the request, naming the change and the intended result, in the requester's language; at most ${TEAM_IM_WORD_LIMIT} words`,
    ),
  note: z
    .string()
    .optional()
    .describe(
      `accept/attach: routing background or an explicit human constraint for the worker, at most ${WORK_NOTE_WORD_LIMIT} words; never a plan`,
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'ignore: why (required); other kinds: optional, for the decision log',
    ),
  ruleAssessments: z
    .array(
      strictObject({
        ruleId: z.string().min(1),
        matched: z.boolean(),
        reason: z.string().min(1).describe('A factual reason'),
      }),
    )
    .optional()
    .describe(
      'Inferred candidates (accept or ignore): exactly one entry per rule in <team_rules>, matched or not',
    ),
});

/**
 * Requests carry only the contract's fields; the host takes the caller from
 * the IPC directory, never from the body.
 */
export function createWorkTools(
  teamRole: TeamRole,
  call: WorkIpcCall,
): SdkMcpToolDefinition<any>[] {
  if (sessionKind({ teamRole }) === 'delegated-worker') {
    return delegatedWorkerTools(call);
  }
  const send = workSender(call, (type) =>
    type === 'work_list'
      ? 'The host did not answer in time; try again shortly.'
      : `The host did not confirm in time; ${type} may have taken effect. Check with ${teamRole.role === 'router' ? 'work_list' : 'the next input'} before retrying.`,
  );

  if (teamRole.role === 'router') {
    return [
      tool(
        'work_route',
        `Decide team candidates (<team_candidate> inputs), one item per candidate, several in one call. Each item is judged on its own and gets its own result.
- accept: new work. Needs title and acknowledgement. An inferred candidate needs ruleAssessments with exactly one entry per rule in its <team_rules> and at least one matched; with mode="observe" the accept is only recorded, nothing is created.
- attach: only when the message explicitly points at that work item (quotes or replies to its request or its messages, names it, or refers to the change just made and exactly one item fits). A similar topic is not enough: accept or ignore it instead. Needs workItemId and an explicit candidate; never attach a hand-back to the item that handed it back.
- stop: a listed person explicitly asks to stop an item. Needs workItemId and an explicit candidate.
- ignore: ordinary discussion, thanks, a duplicate, or anything that is not work. Needs reason.
note is at most ${WORK_NOTE_WORD_LIMIT} words of routing background; the worker reads the original message, so never add a plan, requirements or checklists.`,
        strict({
          items: z
            .array(routeItemSchema)
            .min(1)
            .describe('One decision per candidate'),
        }),
        async ({ items }) => {
          const errors = (items as WorkRouteItem[]).flatMap((item) =>
            routeItemErrors(item).map(
              (error) => `${item.triggerMessageId}: ${error}`,
            ),
          );
          if (errors.length > 0)
            return text(
              `Nothing was sent; fix these and call again: ${errors.join('; ')}`,
              true,
            );
          return send(
            'work_route',
            { items },
            (data) => {
              const results = (data.results ?? []) as WorkRouteResultItem[];
              return results.length
                ? results.map(describeRouteResult).join('\n')
                : 'Routed.';
            },
            ROUTE_TIMEOUT_MS,
          );
        },
      ),

      tool(
        'work_reply',
        `Post one message in the group. This is the only way the team speaks; the host replies under the right message.
- result: deliver a work item's outcome. Only when its last report is ready, or blocked or failed (then say it cannot be done as asked and why). Needs workItemId.
- attention: ask the one question a work item is waiting on a person for (its <work_report> carried attention). Needs workItemId; copy the question faithfully.
- answer: a short direct answer to a candidate that asked a question and belongs to no work item. Needs triggerMessageId.
text is at most ${TEAM_IM_WORD_LIMIT} words (a hard ceiling, not a target), in the group's language; write a fresh message from the report's facts instead of forwarding it. Do not repeat an outcome already posted. A refused reply is final: do not rephrase it into another purpose or send it some other way.`,
        strict({
          purpose: z.enum(['result', 'attention', 'answer']),
          workItemId: z
            .string()
            .optional()
            .describe('result/attention: the work item id'),
          triggerMessageId: z
            .string()
            .optional()
            .describe('answer: the candidate trigger being answered'),
          text: z.string().trim().min(1),
        }),
        async (args) => {
          const errors: string[] = [];
          if (args.purpose === 'answer' && !args.triggerMessageId)
            errors.push('answer needs triggerMessageId');
          if (args.purpose !== 'answer' && !args.workItemId)
            errors.push(`${args.purpose} needs workItemId`);
          const over = overWordLimit('text', args.text, TEAM_IM_WORD_LIMIT);
          if (over) errors.push(over);
          if (errors.length > 0)
            return text(`Nothing was sent: ${errors.join('; ')}`, true);
          return send(
            'work_reply',
            args,
            () =>
              'Queued for the group. A queued reply is not yet delivered; do not send it again.',
          );
        },
      ),

      tool(
        'work_list',
        "List this group's work items: id, #number, title, stage, last report and summary, and any question waiting on a person. Use it to find the item a message points at, or to check state after a timeout or compaction. Never use it to investigate the work yourself.",
        strict({
          status: z
            .enum(['open', 'ended', 'all'])
            .optional()
            .describe('Default open'),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        async (args) =>
          send('work_list', args, (data) => {
            const items = (data.items ?? []) as WorkListEntry[];
            return items.length
              ? items.map(describeListEntry).join('\n')
              : 'No work items.';
          }),
      ),
    ];
  }

  return [
    tool(
      'work_ack',
      `Confirm once, before substantial work, that you are handling a person's request: the assignment's trigger, or a follow-up you will act on. The host replies under that message, so do not quote it. One short sentence naming the concrete object and intended result, in the requester's language, at most ${TEAM_IM_WORD_LIMIT} words. Never acknowledge bots, CI, thanks or plain discussion. A repeat for the same trigger is a no-op (duplicate=true) and keeps the first text.`,
      strict({
        triggerMessageId: z
          .string()
          .min(1)
          .describe('The trigger from <work_assignment> or <work_followup>'),
        text: z.string().trim().min(1),
      }),
      async (args) => {
        const over = overWordLimit('text', args.text, TEAM_IM_WORD_LIMIT);
        if (over) return text(`Nothing was sent: ${over}`, true);
        return send('work_ack', args, (data) =>
          data.duplicate === true
            ? 'Already acknowledged; nothing new was posted.'
            : 'Acknowledgement queued. Keep working; do not send it again.',
        );
      },
    ),

    tool(
      'work_report',
      `Report to the router. Only the router speaks to people, from this report.
- progress: internal bookkeeping; updates the item and wakes no one.
- waiting: you are idle until a person or a follow-up moves the item.
- ready: the result is usable and verified as far as you can; summary states the outcome a person cares about, then the evidence.
- blocked: you cannot go on until a person acts; name the concrete missing prerequisite, and add humanAction when there is a specific question.
- failed: you tried and it did not work; say what failed and what you tried.
- dropped: nothing for anyone to do (not reproduced, not a defect, already handled); ends the item without a message.
humanAction is the one concrete question a person must decide; it reaches the router at once with any state, including progress. Report honestly: a draft is not ready, and a failure is reported as failed.`,
      strict({
        state: z.enum(WORK_REPORT_STATES),
        summary: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Concise facts for the router: outcome, changes, checks actually run, risks, links',
          ),
        humanAction: z
          .string()
          .nullable()
          .optional()
          .describe(
            'One specific question for a person; null clears an earlier one',
          ),
        questionForMessageId: z
          .string()
          .optional()
          .describe(
            "The person's message the question is about (e.g. a <work_followup> trigger), so the question is posted under it",
          ),
      }),
      async (args) =>
        send('work_report', args, () =>
          args.state === 'progress' && !args.humanAction
            ? 'Recorded.'
            : 'Reported to the router.',
        ),
    ),

    tool(
      'work_handback',
      "Hand a follow-up that is beyond this work item, or belongs to another one, back to the router as a new candidate. Do not acknowledge it. Only for a <work_followup> delivered to this item; a message on this item's thread that is in scope is yours to do.",
      strict({
        triggerMessageId: z
          .string()
          .min(1)
          .describe('The <work_followup> trigger'),
        reason: z
          .string()
          .trim()
          .min(1)
          .describe('One sentence: why it is not this item'),
      }),
      async (args) =>
        send('work_handback', args, () => 'Handed back to the router.'),
    ),
  ];
}

const REPORTED: Record<(typeof DELEGATED_REPORT_STATES)[number], string> = {
  progress: '已记录。',
  ready: '已回报，任务已结束。结束本轮。',
  failed: '已回报，任务已结束。结束本轮。',
  blocked: '已回报。结束本轮，回答会作为 <work_followup> 输入回来。',
};

/** A delegated item's worker only reports, to the session that delegated it. */
function delegatedWorkerTools(call: WorkIpcCall): SdkMcpToolDefinition<any>[] {
  const send = workSender(
    call,
    () => '等待宿主确认超时：回报可能已经生效。结束本轮，不要重复回报。',
  );
  return [
    tool(
      'work_report',
      `向派出这个任务的会话回报；只有它看得到，由它转述给用户。
- progress：内部记录进展，不唤醒任何人。
- ready：任务完成并已核实，任务随之结束。summary 写成能直接转述的结论：结果、要点、产物路径、实际做过的检查。
- blocked：需要用户决定或提供什么才能继续。summary 把问题和可选项写清楚，然后结束本轮；回答会作为 <work_followup> 输入回来。
- failed：试过但没做成，任务随之结束。写清失败原因和试过什么。
如实回报：没完成的草稿不是 ready，失败就报 failed。`,
      strict({
        state: z.enum(DELEGATED_REPORT_STATES),
        summary: z
          .string()
          .trim()
          .min(1)
          .max(WORK_SUMMARY_CHAR_LIMIT)
          .describe(
            `给派出任务的会话看的事实：结论、要点、产物路径、实际做过的检查。最多 ${WORK_SUMMARY_CHAR_LIMIT} 字；更长的结果写进工作目录里的文件，这里给结论和路径。`,
          ),
      }),
      async (args) => send('work_report', args, () => REPORTED[args.state]),
    ),
  ];
}
