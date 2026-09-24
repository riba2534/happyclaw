import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { hasBackgroundTaskTools } from '../container/agent-runner/src/prompt-plan.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-tool-init-'));
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function toolNames(
  isHome: boolean,
  options: {
    isScheduledTask?: boolean;
    currentTaskId?: string | null;
    agentBuilderEnabled?: boolean;
  } = {},
): string[] {
  return createMcpTools({
    chatJid: 'web:tool-init',
    groupFolder: 'tool-init',
    isHome,
    isAdminHome: true,
    agentBuilderEnabled: options.agentBuilderEnabled ?? isHome,
    isScheduledTask: options.isScheduledTask ?? false,
    currentTaskId: options.currentTaskId ?? null,
    currentInputTurnId: 'turn-1',
    workspaceIpc: '/tmp/tool-init-ipc',
    workspaceGroup: '/tmp/tool-init-group',
  }).map((tool) => tool.name);
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('HappyClaw tool initialization', () => {
  test('uses the SDK and Claude CLI versions pinned by the runner build', () => {
    const runnerPackage = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const runnerLock = JSON.parse(
      fs.readFileSync(path.join(runnerRoot, 'package-lock.json'), 'utf8'),
    ) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    const importedSdkPackage = JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(runnerSdkEntry), 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    const pinnedSdk =
      runnerPackage.dependencies['@anthropic-ai/claude-agent-sdk'];
    const pinnedCli = runnerPackage.dependencies['@anthropic-ai/claude-code'];
    const runnerCliPackage = JSON.parse(
      fs.readFileSync(
        path.join(
          runnerRoot,
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'package.json',
        ),
        'utf8',
      ),
    ) as { version: string };

    expect(pinnedSdk).toMatch(/^\d+\.\d+\.\d+$/);
    expect(runnerSdkEntry.startsWith(`${runnerRoot}${path.sep}`)).toBe(true);
    expect(importedSdkPackage.version).toBe(pinnedSdk);
    expect(
      runnerLock.packages['node_modules/@anthropic-ai/claude-agent-sdk']
        .version,
    ).toBe(pinnedSdk);
    expect(runnerCliPackage.version).toBe(pinnedCli);
    expect(
      runnerLock.packages['node_modules/@anthropic-ai/claude-code'].version,
    ).toBe(pinnedCli);
    expect(
      execFileSync(runnerClaudeExecutable, ['--version'], {
        encoding: 'utf8',
      }).trim(),
    ).toContain(pinnedCli);
    expect(
      runnerLock.packages[''].dependencies?.['@anthropic-ai/claude-agent-sdk'],
    ).toBe(pinnedSdk);
    expect(fs.readFileSync('container/Dockerfile', 'utf8')).toContain(
      'COPY agent-runner/package.json agent-runner/package-lock.json ./',
    );
  });

  test('main-Agent runtime exposes the complete tool set and Agent Builder', () => {
    const names = toolNames(true);
    expect(names).toEqual(
      expect.arrayContaining([
        'schedule_task',
        'install_skill',
        'workspace_memory_search',
        'workspace_memory_get',
        'workspace_memory_remember',
        'workspace_memory_update',
        'workspace_memory_forget',
        'agent_profile_list',
        'agent_profile_get',
        'agent_profile_draft_get',
        'agent_capability_catalog',
        'agent_profile_prepare',
        'agent_profile_publish',
        'agent_profile_discard',
      ]),
    );
  });

  test('main Agent exposes Agent Builder in every workspace', () => {
    const names = toolNames(false, { agentBuilderEnabled: true });
    expect(names).toContain('agent_profile_prepare');
    expect(names).toContain('agent_profile_publish');
  });

  test('custom Agent runtime keeps ordinary tools but does not advertise Agent Builder', () => {
    const names = toolNames(false, { agentBuilderEnabled: false });
    expect(names).toContain('schedule_task');
    expect(names).toEqual(
      expect.arrayContaining([
        'workspace_memory_search',
        'workspace_memory_get',
        'workspace_memory_remember',
        'workspace_memory_update',
        'workspace_memory_forget',
      ]),
    );
    expect(names).not.toContain('install_skill');
    expect(names).not.toContain('agent_profile_prepare');
  });

  test('home tool registration stays stable across scheduled and human turns', () => {
    expect(toolNames(true, { isScheduledTask: true })).toContain(
      'agent_profile_prepare',
    );
    expect(
      toolNames(true, { currentTaskId: 'scheduled-group-task' }),
    ).toContain('agent_profile_publish');
  });

  test('scheduled and task-triggered turns expose Workspace Memory read-only', () => {
    for (const names of [
      toolNames(false, { isScheduledTask: true }),
      toolNames(false, { currentTaskId: 'scheduled-group-task' }),
    ]) {
      expect(names).toContain('workspace_memory_search');
      expect(names).toContain('workspace_memory_get');
      expect(names).not.toContain('workspace_memory_remember');
      expect(names).not.toContain('workspace_memory_update');
      expect(names).not.toContain('workspace_memory_forget');
    }
  });

  test('real Claude CLI initializes unrestricted builtins and Agent Builder tools', async () => {
    const tools = createMcpTools({
      chatJid: 'web:tool-init-real',
      groupFolder: 'tool-init-real',
      isHome: true,
      isAdminHome: true,
      agentBuilderEnabled: true,
      isScheduledTask: false,
      currentTaskId: null,
      currentInputTurnId: 'turn-real',
      workspaceIpc: path.join(cwd, 'ipc'),
      workspaceGroup: cwd,
    });
    const server = runnerSdk.createSdkMcpServer({
      name: 'happyclaw',
      version: 'test',
      tools,
    });
    const stream = runnerSdk.query({
      prompt: 'Reply with OK.',
      options: {
        pathToClaudeCodeExecutable: runnerClaudeExecutable,
        cwd,
        model: 'claude-sonnet-4-5-20250929',
        env: {
          ...cleanEnv(),
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'happyclaw-init-test',
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        allowedTools: ['Bash', 'Write', 'Edit', 'Task', 'mcp__happyclaw__*'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: { happyclaw: server },
      },
    });

    let initializedTools: string[] | undefined;
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        initializedTools = message.tools;
        break;
      }
    }
    expect(initializedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'Task',
        'mcp__happyclaw__agent_profile_prepare',
        'mcp__happyclaw__agent_profile_publish',
      ]),
    );
  }, 20_000);

  test('background-task guidance is gated on tools the pinned Claude CLI still exposes', async () => {
    const stream = runnerSdk.query({
      prompt: 'Reply with OK.',
      options: {
        pathToClaudeCodeExecutable: runnerClaudeExecutable,
        cwd,
        model: 'claude-sonnet-4-5-20250929',
        env: {
          ...cleanEnv(),
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
          ANTHROPIC_AUTH_TOKEN: 'happyclaw-init-test',
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        allowedTools: ['Bash', 'Read', 'Task', 'TaskStop'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      },
    });

    let initializedTools: string[] | undefined;
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        initializedTools = message.tools;
        break;
      }
    }
    expect(initializedTools).toBeDefined();
    // A gate that names a tool the CLI no longer ships would silently drop the
    // background-task prompt as soon as the dead allowlist entry is removed.
    expect(hasBackgroundTaskTools(initializedTools ?? [])).toBe(true);
  }, 20_000);
});
