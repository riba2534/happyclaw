/**
 * Built-in tools removed from every session because they depend on a Claude
 * Code process that outlives the turn. The runner ends the CLI process a few
 * seconds after each result, so a session-scoped cron or ScheduleWakeup would
 * silently never fire (HappyClaw schedules through mcp__happyclaw__schedule_task),
 * and a worktree would move the session away from the workspace directory
 * whose transcript and IPC paths the runner resolves.
 */
export const RUNNER_DISALLOWED_BUILTIN_TOOLS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
];
