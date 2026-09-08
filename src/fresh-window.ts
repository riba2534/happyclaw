/**
 * Zero-summary fresh-window helpers (host copy).
 *
 * Keep in step with container/agent-runner/src/fresh-window.ts. Host slash
 * commands and Web intercepts format the same handoff the runner MCP tool
 * produces. This does not summarize history and does not replace auto-compact.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2000;

export const FRESH_WINDOW_HANDOFF_MARKER = '[HAPPYCLAW_FRESH_WINDOW_HANDOFF]';

export interface WorkspaceSnapshot {
  available: boolean;
  branch?: string;
  commit?: string;
  statusLines?: string[];
  reason?: string;
}

async function gitText(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Light git snapshot of `cwd`. Safe for non-git directories and git timeouts.
 */
export async function captureWorkspaceSnapshot(
  cwd: string,
): Promise<WorkspaceSnapshot> {
  if (!cwd || typeof cwd !== 'string') {
    return { available: false, reason: 'no workspace directory' };
  }

  const inside = await gitText(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { available: false, reason: 'not a git repository' };
  }

  const branch =
    (await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const commit = (await gitText(cwd, ['rev-parse', '--short', 'HEAD'])) || '';
  const statusRaw = await gitText(cwd, ['status', '--short']);
  const statusLines = statusRaw
    ? statusRaw.split('\n').filter(Boolean).slice(0, 10)
    : [];

  return { available: true, branch, commit, statusLines };
}

export function formatFreshWindowHandoff(input: {
  notes: string;
  nextFocus?: string;
  snapshot?: WorkspaceSnapshot;
}): string {
  const notes = input.notes.trim() || '(none)';
  const lines = [
    FRESH_WINDOW_HANDOFF_MARKER,
    '',
    'This is a zero-summary window switch. Previous conversation history remains in the database and was not summarized.',
    '',
    '## Notes',
    notes,
  ];

  const nextFocus = input.nextFocus?.trim();
  if (nextFocus) {
    lines.push('', '## Next focus', nextFocus);
  }

  lines.push('', '## Workspace snapshot');
  if (input.snapshot?.available) {
    lines.push(`branch: ${input.snapshot.branch ?? ''}`);
    lines.push(`commit: ${input.snapshot.commit ?? ''}`);
    if (input.snapshot.statusLines && input.snapshot.statusLines.length > 0) {
      lines.push('status:');
      for (const line of input.snapshot.statusLines) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push('status: (clean)');
    }
  } else {
    lines.push(
      input.snapshot?.reason ? `(${input.snapshot.reason})` : '(unavailable)',
    );
  }

  return lines.join('\n');
}
