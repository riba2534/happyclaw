export type RuntimeGuidelineRuntime = 'claude' | 'codex';

const CLAUDE_BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务',
  '',
  '当用户要求执行耗时较长的批量任务（如批量文件处理、大规模数据操作等），',
  '你应该使用 Task 工具并设置 `run_in_background: true`，让任务在后台运行。',
  '这样用户无需等待，可以继续与你交流其他事项。',
  '任务结束时你会自动收到通知，届时在对话中向用户汇报即可。',
  '告知用户：「已为您在后台启动该任务，完成后我会第一时间反馈。现在有其他问题也可以随时问我。」',
  '',
  '### 任务通知处理（重要）',
  '',
  '当你收到多条后台任务的完成或失败通知时：',
  '- **禁止逐条回复**。不要对每条通知都调用 `send_message`，这会导致 IM 群刷屏。',
  '- **等待所有通知到齐后，汇总为一条消息回复用户**，例如：「N 个任务完成，M 个失败，失败原因：...」',
  '- 对于已知的无害失败（如浏览器进程被回收、临时资源超时），**不需要通知用户**，静默忽略即可。',
].join('\n');

const CODEX_BACKGROUND_TASK_GUIDELINES = [
  '',
  '## 后台任务与子代理',
  '',
  '当前运行时是 Codex。不要使用或声称使用 Claude 的 Task / TaskOutput / TaskStop 工具；Codex SDK 事件不会产生 Claude 的 task_start、task_notification 或 sub_agent_result 生命周期。',
  '如果任务可以在当前回合完成，直接在当前回合执行，并用 Codex 的 Todo/工具调用展示进度。',
  '如果用户明确需要定时、延后或周期执行，使用 HappyClaw MCP 的 schedule_task 工具创建系统定时任务。',
  '如果用户明确要求 Claude Task 风格的 subagent，请说明当前 Codex 运行时不支持这种 SDK-native 子代理，并给出可执行替代方案：在当前回合完成、切回 Claude，或让用户使用 HappyClaw 的 /spawn / conversation agent 产品能力。',
].join('\n');

export function buildRuntimeBackgroundTaskGuidelines(
  runtime: RuntimeGuidelineRuntime,
): string {
  return runtime === 'codex'
    ? CODEX_BACKGROUND_TASK_GUIDELINES
    : CLAUDE_BACKGROUND_TASK_GUIDELINES;
}
