import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sdkMock = {
  constructed: [] as Array<Record<string, unknown>>,
  started: [] as Array<Record<string, unknown>>,
  resumed: [] as Array<{ id: string; options: Record<string, unknown> }>,
  inputs: [] as unknown[],
  turnOptions: [] as Array<Record<string, unknown> | undefined>,
  failResume: false,
  failWith: null as Error | null,
};

import { createCodexSdkAdapter } from '../container/agent-runner/src/codex-sdk-runner.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';

class MockThread {
  id: string | null;

  constructor(id: string | null) {
    this.id = id;
  }

  async runStreamed(input: unknown, turnOptions?: Record<string, unknown>) {
    sdkMock.inputs.push(input);
    sdkMock.turnOptions.push(turnOptions);
    if (sdkMock.failWith) {
      throw sdkMock.failWith;
    }
    if (this.id && sdkMock.failResume) {
      throw new Error('thread not found');
    }
    const self = this;
    async function* events() {
      self.id = 'sdk-thread-1';
      yield { type: 'thread.started', thread_id: 'sdk-thread-1' };
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'echo hi',
          aggregated_output: '',
          status: 'in_progress',
        },
      };
      yield {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'sdk-ok' },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          cached_input_tokens: 1,
          output_tokens: 3,
          reasoning_output_tokens: 0,
        },
      };
    }
    return { events: events() };
  }
}

class MockCodex {
  constructor(options: Record<string, unknown>) {
    sdkMock.constructed.push(options);
  }

  startThread(options: Record<string, unknown>) {
    sdkMock.started.push(options);
    return new MockThread(null);
  }

  resumeThread(id: string, options: Record<string, unknown>) {
    sdkMock.resumed.push({ id, options });
    return new MockThread(id);
  }
}

let tmpDir: string;
const previousRunner = process.env.HAPPYCLAW_CODEX_RUNNER;
const previousIpc = process.env.HAPPYCLAW_WORKSPACE_IPC;
const previousCli = process.env.HAPPYCLAW_CODEX_CLI_PATH;
const previousGroup = process.env.HAPPYCLAW_WORKSPACE_GROUP;
const previousGlobal = process.env.HAPPYCLAW_WORKSPACE_GLOBAL;
const previousMemory = process.env.HAPPYCLAW_WORKSPACE_MEMORY;
const previousUserMcp = process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON;

function runtimeInput(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      prompt: 'hello',
      groupFolder: 'flow-test',
      chatJid: 'web:flow-test',
      runtime: 'codex' as const,
      selectedModel: 'gpt-5.5',
    },
    prompt: 'hello',
    cwd: process.cwd(),
    systemPromptAppend: '<system>test</system>',
    model: 'gpt-5.5',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-sdk-'));
  process.env.HAPPYCLAW_WORKSPACE_IPC = tmpDir;
  delete process.env.HAPPYCLAW_CODEX_RUNNER;
  delete process.env.HAPPYCLAW_CODEX_CLI_PATH;
  sdkMock.constructed.length = 0;
  sdkMock.started.length = 0;
  sdkMock.resumed.length = 0;
  sdkMock.inputs.length = 0;
  sdkMock.turnOptions.length = 0;
  sdkMock.failResume = false;
  sdkMock.failWith = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (previousRunner === undefined) delete process.env.HAPPYCLAW_CODEX_RUNNER;
  else process.env.HAPPYCLAW_CODEX_RUNNER = previousRunner;
  if (previousIpc === undefined) delete process.env.HAPPYCLAW_WORKSPACE_IPC;
  else process.env.HAPPYCLAW_WORKSPACE_IPC = previousIpc;
  if (previousCli === undefined) delete process.env.HAPPYCLAW_CODEX_CLI_PATH;
  else process.env.HAPPYCLAW_CODEX_CLI_PATH = previousCli;
  if (previousGroup === undefined) delete process.env.HAPPYCLAW_WORKSPACE_GROUP;
  else process.env.HAPPYCLAW_WORKSPACE_GROUP = previousGroup;
  if (previousGlobal === undefined) delete process.env.HAPPYCLAW_WORKSPACE_GLOBAL;
  else process.env.HAPPYCLAW_WORKSPACE_GLOBAL = previousGlobal;
  if (previousMemory === undefined) delete process.env.HAPPYCLAW_WORKSPACE_MEMORY;
  else process.env.HAPPYCLAW_WORKSPACE_MEMORY = previousMemory;
  if (previousUserMcp === undefined) delete process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON;
  else process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON = previousUserMcp;
});

describe('Codex SDK runner', () => {
  it('runs through @openai/codex-sdk with project docs and MCP config', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    const outputs: ContainerOutput[] = [];
    const additionalDirectories = [
      path.join(tmpDir, 'global'),
      path.join(tmpDir, 'memory'),
    ];

    const result = await codexSdkAdapter.run(
      runtimeInput({ additionalDirectories }),
      (output) => {
        outputs.push(output);
      },
    );

    expect(codexSdkAdapter).toMatchObject({
      supportsNativeResume: true,
      supportsLiveInput: false,
      supportsPreCompactHook: false,
    });
    expect(result).toMatchObject({
      status: 'success',
      result: 'sdk-ok',
      newSessionId: 'sdk-thread-1',
    });
    expect(sdkMock.constructed).toHaveLength(1);
    expect(sdkMock.started[0]).toMatchObject({
      workingDirectory: process.cwd(),
      additionalDirectories,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      model: 'gpt-5.5',
    });
    expect(sdkMock.resumed).toHaveLength(0);
    expect(sdkMock.constructed[0].config).toMatchObject({
      project_doc_fallback_filenames: ['CLAUDE.md'],
      mcp_servers: {
        happyclaw: {
          command: 'node',
        },
      },
    });
    expect(outputs.some((output) => output.streamEvent?.eventType === 'text_delta')).toBe(
      true,
    );
    expect(outputs.some((output) => output.streamEvent?.eventType === 'usage')).toBe(
      true,
    );
  });

  it('falls back to a fresh SDK thread when SDK resume fails', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    sdkMock.failResume = true;
    const outputs: ContainerOutput[] = [];

    const result = await codexSdkAdapter.run(
      runtimeInput({ sessionId: 'old-thread' }),
      (output) => outputs.push(output),
    );

    expect(result.status).toBe('success');
    expect(sdkMock.resumed[0].id).toBe('old-thread');
    expect(sdkMock.started).toHaveLength(1);
    expect(
      outputs.some((output) =>
        output.streamEvent?.eventType === 'status' &&
        output.streamEvent.statusText?.includes('resume 失败'),
      ),
    ).toBe(true);
  });

  it('uses the host-built soft-injection prompt on SDK resume failure', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    sdkMock.failResume = true;

    const result = await codexSdkAdapter.run(
      runtimeInput({
        sessionId: 'old-thread',
        prompt: 'resume prompt without recent history',
        resumeFailureFallbackPrompt:
          '<happyclaw-context reason="native_resume_failed"><recent-messages>old context</recent-messages></happyclaw-context>\n\nhello',
        resumeFailureFallbackInputContextHash: 'fallback-hash',
        resumeFailureFallbackSoftInjectionReason: 'native_resume_failed',
      }),
      () => {},
    );

    expect(result.status).toBe('success');
    expect(result.runtimeContext).toMatchObject({
      resumeMode: 'soft_inject',
      inputContextHash: 'fallback-hash',
      softInjectionReason: 'native_resume_failed',
    });
    expect(sdkMock.inputs).toHaveLength(2);
    expect(String(sdkMock.inputs[0])).toContain('resume prompt without recent history');
    expect(String(sdkMock.inputs[1])).toContain('<recent-messages>old context</recent-messages>');
    expect(String(sdkMock.inputs[1])).not.toContain('resume prompt without recent history');
  });

  it('preserves the host-mode Codex context contract', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    const workspaceGroup = path.join(tmpDir, 'group');
    const workspaceGlobal = path.join(tmpDir, 'global');
    const workspaceMemory = path.join(tmpDir, 'memory');
    fs.mkdirSync(path.join(workspaceGroup, '.claude'), { recursive: true });
    fs.mkdirSync(workspaceGlobal, { recursive: true });
    fs.mkdirSync(workspaceMemory, { recursive: true });
    fs.writeFileSync(path.join(workspaceGroup, 'CLAUDE.md'), 'project rule\n');
    fs.writeFileSync(
      path.join(workspaceGroup, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          workspaceTool: { command: 'node', args: ['workspace-tool.js'] },
        },
      }),
    );
    process.env.HAPPYCLAW_WORKSPACE_GROUP = workspaceGroup;
    process.env.HAPPYCLAW_WORKSPACE_GLOBAL = workspaceGlobal;
    process.env.HAPPYCLAW_WORKSPACE_MEMORY = workspaceMemory;
    process.env.HAPPYCLAW_USER_MCP_SERVERS_JSON = JSON.stringify({
      userTool: {
        command: 'node',
        args: ['user-tool.js'],
        env: { TOKEN: 'redacted-test-token' },
      },
    });

    const result = await codexSdkAdapter.run(
      runtimeInput({
        cwd: workspaceGroup,
        additionalDirectories: [workspaceGlobal, workspaceMemory],
        images: [
          {
            data: Buffer.from('png-bytes').toString('base64'),
            mimeType: 'image/png',
          },
        ],
        resumeMode: 'soft_inject',
        inputContextHash: 'ctx-hash',
        workspaceInstructionHash: 'workspace-hash',
        softInjectionReason: 'runtime_changed',
      }),
      () => {},
    );

    expect(result.status).toBe('success');
    expect(sdkMock.started[0]).toMatchObject({
      workingDirectory: workspaceGroup,
      additionalDirectories: [workspaceGlobal, workspaceMemory],
      model: 'gpt-5.5',
    });

    const constructed = sdkMock.constructed[0] as {
      config: {
        project_doc_fallback_filenames?: string[];
        mcp_servers?: Record<string, { command?: string; args?: string[] }>;
      };
    };
    expect(constructed.config.project_doc_fallback_filenames).toEqual([
      'CLAUDE.md',
    ]);
    expect(constructed.config.mcp_servers?.userTool).toMatchObject({
      command: 'node',
      args: ['user-tool.js'],
    });
    expect(constructed.config.mcp_servers?.workspaceTool).toMatchObject({
      command: 'node',
      args: ['workspace-tool.js'],
    });
    const happyclawArgs =
      constructed.config.mcp_servers?.happyclaw?.args ?? [];
    const contextPath = happyclawArgs[happyclawArgs.length - 1];
    expect(contextPath).toBeTruthy();
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
    expect(context).toMatchObject({
      chatJid: 'web:flow-test',
      groupFolder: 'flow-test',
      workspaceGroup,
      workspaceGlobal,
      workspaceMemory,
      resumeMode: 'soft_inject',
      inputContextHash: 'ctx-hash',
      workspaceInstructionHash: 'workspace-hash',
      softInjectionReason: 'runtime_changed',
    });

    const codexInput = sdkMock.inputs[0] as Array<Record<string, string>>;
    expect(Array.isArray(codexInput)).toBe(true);
    expect(codexInput[0]).toMatchObject({ type: 'text' });
    expect(codexInput[1]).toMatchObject({ type: 'local_image' });
    expect(codexInput[1].path).toContain('codex-images');
    expect(fs.readFileSync(codexInput[1].path, 'utf-8')).toBe('png-bytes');
  });

  it('keeps direct CLI behind an explicit debug flag in the agent runner', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'container/agent-runner/src/index.ts'),
      'utf-8',
    );

    expect(source).toContain("process.env.HAPPYCLAW_CODEX_RUNNER === 'cli'");
    expect(source).toContain(': codexSdkAdapter');
  });

  it('passes runtime cancellation through to the SDK turn', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    const controller = new AbortController();

    await codexSdkAdapter.run(
      runtimeInput({ signal: controller.signal }),
      () => {},
    );

    expect(sdkMock.turnOptions[0]?.signal).toBe(controller.signal);
  });

  it('classifies aborted SDK turns as closed runtime results', async () => {
    const codexSdkAdapter = createCodexSdkAdapter(MockCodex);
    sdkMock.failWith = new Error('The operation was aborted');

    const result = await codexSdkAdapter.run(runtimeInput(), () => {});

    expect(result).toMatchObject({
      status: 'closed',
      result: null,
      errorClass: 'cancelled',
    });
  });
});
