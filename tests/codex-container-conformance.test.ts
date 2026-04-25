import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContainerInput } from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

const tmpDirs: string[] = [];

function makeProvider() {
  return {
    id: 'gpt-provider-test',
    name: 'GPT Provider Test',
    type: 'official',
    runtime: 'codex',
    providerFamily: 'gpt',
    providerPoolId: 'gpt',
    authMode: 'api_key',
    authProfileGeneration: 4,
    enabled: true,
    weight: 1,
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicModel: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    openaiApiKey: 'sk-test-container',
    codexAuthJson: '',
    customEnv: {},
    updatedAt: '2026-04-25T00:00:00.000Z',
  };
}

async function loadContainerRunner(tmpDir: string) {
  vi.resetModules();

  const dataDir = path.join(tmpDir, 'data');
  const groupsDir = path.join(dataDir, 'groups');
  const provider = makeProvider();
  const spawnCalls: Array<{
    cmd: string;
    args: string[];
    opts: Record<string, unknown>;
    stdinData: () => string;
  }> = [];

  vi.doMock('../src/config.js', () => ({
    CONTAINER_IMAGE: 'happyclaw:test',
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    TIMEZONE: 'UTC',
  }));

  vi.doMock('../src/runtime-config.js', () => {
    const blankClaudeConfig = {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
      anthropicModel: '',
      updatedAt: null,
    };
    return {
      buildContainerEnvLines: () => [],
      getBalancingConfig: () => ({
        strategy: 'round-robin',
        unhealthyThreshold: 1,
        recoveryIntervalMs: 60_000,
      }),
      getClaudeProviderConfig: () => blankClaudeConfig,
      getContainerEnvConfig: () => ({}),
      getEffectiveExternalDir: () => path.join(tmpDir, 'external-claude'),
      getEnabledProvidersForPool: (poolId: string) =>
        poolId === 'gpt' ? [provider] : [],
      getProviderById: (providerId: string) =>
        providerId === provider.id ? provider : null,
      getSystemSettings: () => ({
        autoCompactWindow: 0,
        containerMaxOutputSize: 10 * 1024 * 1024,
        containerTimeout: 5_000,
        disableMemoryLayerForAdminHost: false,
      }),
      mergeClaudeEnvConfig: () => blankClaudeConfig,
      resolveProviderById: () => ({
        config: blankClaudeConfig,
        customEnv: {},
      }),
      shellQuoteEnvLines: (lines: string[]) => lines,
      writeCodexProviderAuthMaterial: () => {
        const codexHomeDir = path.join(dataDir, 'config', 'codex', provider.id);
        fs.mkdirSync(codexHomeDir, { recursive: true });
        fs.writeFileSync(
          path.join(codexHomeDir, 'config.toml'),
          'project_doc_fallback_filenames = ["CLAUDE.md"]\n',
        );
        return {
          providerId: provider.id,
          authMode: provider.authMode,
          authProfileGeneration: provider.authProfileGeneration,
          env: {
            OPENAI_API_KEY: provider.openaiApiKey,
            CODEX_HOME: codexHomeDir,
          },
          codexHomeDir,
        };
      },
      writeCredentialsFile: vi.fn(),
    };
  });

  vi.doMock('../src/mcp-utils.js', () => ({
    loadUserMcpServers: () => ({
      userTool: {
        command: 'node',
        args: ['user-tool.js'],
      },
    }),
  }));

  vi.doMock('../src/mount-security.js', () => ({
    loadMountAllowlist: () => null,
    validateAdditionalMounts: () => [],
  }));

  vi.doMock('../src/provider-pool.js', () => ({
    providerPool: {
      acquireSession: vi.fn(),
      releaseSession: vi.fn(),
      refreshFromConfig: vi.fn(),
      reportFailure: vi.fn(),
      reportSuccess: vi.fn(),
      selectProvider: vi.fn(),
    },
    providerPoolManager: {
      acquireSession: vi.fn(),
      releaseSession: vi.fn(),
      refreshPoolFromConfig: vi.fn(),
      reportFailure: vi.fn(),
      reportSuccess: vi.fn(),
      selectProvider: vi.fn(() => provider.id),
    },
  }));

  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    const spawn = vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const proc = new EventEmitter() as any;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      let stdinData = '';
      stdin.on('data', (chunk) => {
        stdinData += chunk.toString();
      });
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.stdin = stdin;
      proc.kill = vi.fn();
      spawnCalls.push({
        cmd,
        args,
        opts,
        stdinData: () => stdinData,
      });
      setImmediate(() => {
        stdout.write(
          [
            OUTPUT_START_MARKER,
            JSON.stringify({
              status: 'success',
              result: 'container-ok',
              newSessionId: 'codex-container-thread',
            }),
            OUTPUT_END_MARKER,
            '',
          ].join('\n'),
        );
        stdout.end();
        proc.emit('close', 0, null);
      });
      return proc;
    });
    return { ...actual, spawn };
  });

  const mod = await import('../src/container-runner.js');
  return { ...mod, dataDir, groupsDir, provider, spawnCalls };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex container runtime conformance', () => {
  it('mounts Codex auth, workspace context, MCP settings, and env in container mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-container-'));
    tmpDirs.push(tmpDir);
    const { runContainerAgent, dataDir, groupsDir, provider, spawnCalls } =
      await loadContainerRunner(tmpDir);

    const group: RegisteredGroup = {
      name: 'Codex Container Test',
      folder: 'flow-codex-container-test',
      added_at: '2026-04-25T00:00:00.000Z',
      created_by: 'user-1',
      is_home: false,
    };
    const input: ContainerInput = {
      prompt: 'hello codex',
      groupFolder: group.folder,
      chatJid: `web:${group.folder}`,
      isMain: false,
      runtime: 'codex',
      providerPoolId: 'gpt',
      providerId: provider.id,
      selectedModel: 'gpt-5.5',
      modelOverride: 'gpt-5.5',
    };
    const outputs: unknown[] = [];
    let selectedProviderId: string | null = null;

    const result = await runContainerAgent(
      group,
      input,
      (_proc, _containerName, providerId) => {
        selectedProviderId = providerId;
      },
      async (output) => {
        outputs.push(output);
      },
      'home-main',
    );

    expect(result).toMatchObject({
      status: 'success',
      newSessionId: 'codex-container-thread',
    });
    expect(outputs).toHaveLength(1);
    expect(selectedProviderId).toBe(provider.id);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('docker');

    const volumeSpecs = spawnCalls[0].args.filter(
      (_arg, index, args) => args[index - 1] === '-v',
    );
    expect(volumeSpecs).toEqual(
      expect.arrayContaining([
        `${path.join(groupsDir, 'user-global', 'user-1')}:/workspace/global:ro`,
        `${path.join(groupsDir, group.folder)}:/workspace/group`,
        `${path.join(dataDir, 'memory', 'home-main')}:/workspace/memory:ro`,
        `${path.join(dataDir, 'ipc', group.folder)}:/workspace/ipc`,
        `${path.join(dataDir, 'config', 'codex', provider.id)}:/workspace/codex-home`,
        `${path.join(dataDir, 'env', group.folder)}:/workspace/env-dir:ro`,
        `${path.join(process.cwd(), 'container', 'agent-runner', 'src')}:/app/src:ro`,
      ]),
    );
    expect(spawnCalls[0].args.at(-1)).toBe('happyclaw:test');

    const envFile = path.join(dataDir, 'env', group.folder, 'env');
    const envContent = fs.readFileSync(envFile, 'utf-8');
    expect(envContent).toContain('OPENAI_API_KEY=sk-test-container');
    expect(envContent).toContain('CODEX_HOME=/workspace/codex-home');
    expect(envContent).toContain(
      'HAPPYCLAW_CODEX_CLI_PATH=/app/node_modules/.bin/codex',
    );

    const settings = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'sessions', group.folder, '.claude', 'settings.json'),
        'utf-8',
      ),
    );
    expect(settings.env).toMatchObject({
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
    });
    expect(settings.mcpServers.userTool).toMatchObject({
      command: 'node',
      args: ['user-tool.js'],
    });

    const stdinPayload = JSON.parse(spawnCalls[0].stdinData());
    expect(stdinPayload).toMatchObject({
      runtime: 'codex',
      providerPoolId: 'gpt',
      providerId: provider.id,
      selectedModel: 'gpt-5.5',
      modelOverride: 'gpt-5.5',
    });
  });
});
