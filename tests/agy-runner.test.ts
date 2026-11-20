import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildFreshSessionInstructions } from '../src/agy-runner/instructions.js';
import {
  ensureAgyWorkspaceMcpConfig,
  syncAgyWorkspaceSkills,
} from '../src/agy-runner/mcp-config.js';
import {
  HAPPYCLAW_MCP_TOOLS,
  signWorkspaceMemoryMutation,
} from '../src/agy-runner/mcp-server.js';
import {
  DEFAULT_AGY_MODEL,
  parseAgyModelsOutput,
} from '../src/agy-runner/models.js';
import {
  extractAgyOAuthUrl,
  isValidAgyProfileId,
} from '../src/agy-runner/oauth.js';
import {
  parseAgyResetTimestamp,
  parseAgyUsageOutput,
} from '../src/agy-runner/usage.js';
import {
  AgyStreamTranslator,
  formatAgyUserEvent,
} from '../src/agy-runner/protocol.js';

describe('parseAgyModelsOutput', () => {
  it('parses agy models lines with ANSI/spinner prefixes and infers metadata', () => {
    const raw = [
      '\r⠋ Fetching available models...\rgemini-4-neon-high              Gemini 4 Neon (High)',
      'gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)',
      'gemini-4-neon-medium            Gemini 4 Neon (Medium)',
      'claude-opus-5-5-medium          Claude Opus 5.5 (Medium)',
      'gpt-oss-120b-medium             GPT-OSS 120B (Medium)',
      'gemini-4-neon-medium            Duplicate should be ignored',
    ].join('\n');

    const models = parseAgyModelsOutput(raw);
    expect(models).toHaveLength(5);
    expect(models[0]).toEqual({
      id: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon (High)',
      contextWindow: 1_000_000,
      defaultEffort: 'high',
      vendor: 'google',
      thinks: true,
    });
    expect(models[1].defaultEffort).toBe('xhigh');
    expect(models[3]).toEqual({
      id: 'claude-opus-5-5-medium',
      displayName: 'Claude Opus 5.5 (Medium)',
      contextWindow: 200_000,
      defaultEffort: 'medium',
      vendor: 'anthropic',
      thinks: true,
    });
    expect(models[4].vendor).toBe('openai');
    expect(DEFAULT_AGY_MODEL).toBe('gemini-4-neon-medium');
  });
});

describe('AgyStreamTranslator', () => {
  it('translates init, text_delta, tool lifecycle, usage, and result', () => {
    const translator = new AgyStreamTranslator(
      undefined,
      'gemini-4-neon-medium',
    );
    translator.setTurnCorrelation({
      queryRunId: 'q-1',
      turnId: 't-1',
      inputTurnId: 'in-1',
    });

    const initFrames = translator.translateLine(
      JSON.stringify({
        event: 'init',
        conversation_id: 'conv-123',
        init: {
          model: 'gemini-4-neon-medium',
          cwd: '/tmp/ws',
          tools: ['run_command'],
        },
      }),
    );
    expect(initFrames).toHaveLength(1);
    expect(initFrames[0].newSessionId).toBe('conv-123');
    expect(initFrames[0].streamEvent?.eventType).toBe('init');
    expect(initFrames[0].streamEvent?.queryRunId).toBe('q-1');

    const deltaFrames = translator.translateLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 1,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Hello ',
        },
      }),
    );
    expect(deltaFrames).toHaveLength(1);
    expect(deltaFrames[0].streamEvent).toMatchObject({
      eventType: 'text_delta',
      text: 'Hello ',
      sessionId: 'conv-123',
    });

    const toolStartFrames = translator.translateLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: {
            name: 'run_command',
            parameters: { CommandLine: 'echo hi' },
          },
        },
      }),
    );
    expect(toolStartFrames).toHaveLength(1);
    expect(toolStartFrames[0].streamEvent).toMatchObject({
      eventType: 'tool_use_start',
      toolName: 'run_command',
      toolUseId: 'agy-step-2',
      toolInputSummary: 'echo hi',
    });

    const toolDoneFrames = translator.translateLine(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-123',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          duration_seconds: 0.12,
          tool_info: {
            name: 'run_command',
            parameters: { CommandLine: 'echo hi' },
            output: 'hi\n',
          },
        },
      }),
    );
    expect(toolDoneFrames).toHaveLength(2);
    expect(toolDoneFrames[0].streamEvent?.eventType).toBe('tool_use_end');
    expect(toolDoneFrames[1].streamEvent).toMatchObject({
      eventType: 'tool_result',
      toolIsError: false,
      toolResult: 'hi\n',
      elapsedSeconds: 0.12,
    });

    const resultFrames = translator.translateLine(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          response: 'Hello world',
          duration_seconds: 1.5,
          num_turns: 1,
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            thinking_tokens: 20,
            cache_read_tokens: 400,
            total_tokens: 1050,
          },
        },
      }),
    );
    expect(resultFrames).toHaveLength(2);
    expect(resultFrames[0].streamEvent).toMatchObject({
      eventType: 'usage',
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadInputTokens: 400,
        reasoningTokens: 20,
        durationMs: 1500,
        numTurns: 1,
      },
    });
    expect(resultFrames[1]).toMatchObject({
      status: 'success',
      result: 'Hello world',
      newSessionId: 'conv-123',
      inputTurnCompleted: true,
    });
  });

  it('translates ERROR result and formats user NDJSON event', () => {
    const translator = new AgyStreamTranslator();
    const frames = translator.translateLine(
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-err',
          status: 'ERROR',
          error: 'authentication required',
        },
      }),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      status: 'error',
      error: 'authentication required',
      newSessionId: 'conv-err',
      inputTurnCompleted: true,
    });
    expect(formatAgyUserEvent('hi')).toBe(
      '{"event":"user","message":{"content":"hi"}}\n',
    );
  });
});

describe('buildFreshSessionInstructions', () => {
  it('merges identityPrompt, session CLAUDE.md, and workspace CLAUDE.md with deduplication', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-instr-'));
    try {
      const wsDir = path.join(tmp, 'ws');
      const cfgDir = path.join(tmp, 'cfg');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'CLAUDE.md'), 'Global rule');
      fs.writeFileSync(path.join(wsDir, 'CLAUDE.md'), 'Workspace rule');

      const merged = buildFreshSessionInstructions({
        cwd: wsDir,
        claudeConfigDir: cfgDir,
        identityPrompt: 'Agent identity',
      });
      expect(merged).toContain('Agent identity');
      expect(merged).toContain('Global rule');
      expect(merged).toContain('Workspace rule');

      // When claudeConfigDir points to the same dir, CLAUDE.md is not duplicated
      const deduped = buildFreshSessionInstructions({
        cwd: wsDir,
        claudeConfigDir: wsDir,
      });
      expect(deduped?.match(/Workspace rule/g)?.length).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ensureAgyWorkspaceMcpConfig & HAPPYCLAW_MCP_TOOLS', () => {
  it('merges happyclaw stdio server while preserving existing user MCP servers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-'));
    try {
      const agentsDir = path.join(tmp, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            custom: { command: 'python3', args: ['server.py'] },
          },
        }),
      );

      const cfgPath = ensureAgyWorkspaceMcpConfig({
        workspaceDir: tmp,
        nodeBinary: '/usr/bin/node',
        mcpServerEntrypoint: '/app/dist/agy-runner/mcp-server.js',
      });
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.mcpServers.custom).toEqual({
        command: 'python3',
        args: ['server.py'],
      });
      expect(parsed.mcpServers.happyclaw).toEqual({
        command: '/usr/bin/node',
        args: ['/app/dist/agy-runner/mcp-server.js'],
      });

      const toolNames = HAPPYCLAW_MCP_TOOLS.map((t) => t.name);
      expect(toolNames).toContain('send_message');
      expect(toolNames).toContain('send_image');
      expect(toolNames).toContain('send_file');
      expect(toolNames).toContain('automation_list');
      expect(toolNames).toContain('automation_create');
      expect(toolNames).toContain('workspace_memory_search');
      expect(toolNames).toContain('workspace_memory_get');
      expect(toolNames).toContain('workspace_memory_remember');
      expect(toolNames).toContain('workspace_memory_update');
      expect(toolNames).toContain('workspace_memory_forget');

      const sigA = signWorkspaceMemoryMutation(
        'test-secret',
        { groupFolder: 'main', agentId: 'a1' },
        { b: 2, a: 1, type: 'workspace_memory' },
      );
      const sigB = signWorkspaceMemoryMutation(
        'test-secret',
        { groupFolder: 'main', agentId: 'a1' },
        { type: 'workspace_memory', a: 1, b: 2, mutationSignature: 'ignored' },
      );
      expect(sigA).toBe(sigB);
      expect(sigA.length).toBeGreaterThan(20);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('syncs HappyClaw skills into .agents/skills, preserves user skills, and prunes removed ones', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-skills-'));
    try {
      const wsDir = path.join(tmp, 'ws');
      const cfgDir = path.join(tmp, 'cfg');
      const srcSkills = path.join(cfgDir, 'skills');
      const skillA = path.join(tmp, 'store', 'skill-a');
      const skillB = path.join(tmp, 'store', 'skill-b');
      const userSkill = path.join(wsDir, '.agents', 'skills', 'user-own');
      fs.mkdirSync(srcSkills, { recursive: true });
      fs.mkdirSync(skillA, { recursive: true });
      fs.mkdirSync(skillB, { recursive: true });
      fs.mkdirSync(userSkill, { recursive: true });
      fs.writeFileSync(path.join(skillA, 'SKILL.md'), '# A');
      fs.writeFileSync(path.join(skillB, 'SKILL.md'), '# B');
      fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User');
      fs.symlinkSync(skillA, path.join(srcSkills, 'skill-a'), 'dir');
      fs.symlinkSync(skillB, path.join(srcSkills, 'skill-b'), 'dir');

      const first = syncAgyWorkspaceSkills({
        workspaceDir: wsDir,
        claudeConfigDir: cfgDir,
      });
      expect(first).toEqual({ synced: 2, pruned: 0 });
      expect(
        fs
          .lstatSync(path.join(wsDir, '.agents', 'skills', 'skill-a'))
          .isSymbolicLink(),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(wsDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(wsDir, '.agents', 'skills', 'user-own', 'SKILL.md'),
        ),
      ).toBe(true);

      // Remove skill-b from HappyClaw effective skills -> should prune managed copy only
      fs.unlinkSync(path.join(srcSkills, 'skill-b'));
      const second = syncAgyWorkspaceSkills({
        workspaceDir: wsDir,
        claudeConfigDir: cfgDir,
      });
      expect(second).toEqual({ synced: 1, pruned: 1 });
      expect(
        fs.existsSync(path.join(wsDir, '.agents', 'skills', 'skill-b')),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(wsDir, '.agents', 'skills', 'user-own', 'SKILL.md'),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('AGY OAuth helpers', () => {
  it('extracts Google OAuth URL from agy acp --login output and validates profile IDs', () => {
    const sample =
      'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\n\nThen paste the authorization code:';
    expect(extractAgyOAuthUrl(sample)).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz',
    );
    expect(extractAgyOAuthUrl('no url here')).toBeNull();
    expect(isValidAgyProfileId('a1b2c3d4e5f6a1b2c3d4e5f6')).toBe(true);
    expect(isValidAgyProfileId('../escape')).toBe(false);
    expect(isValidAgyProfileId('short')).toBe(false);
  });
});

describe('AGY usage parser', () => {
  it('parses agy -p /usage output into 5-hour and weekly quota windows', () => {
    const sample = [
      'Quota:',
      'Gemini Models          Weekly Limit Remaining       66%   2026-11-27 10:08 CST',
      'Gemini Models          Five Hour Limit Remaining    37%   2026-11-20 20:08 CST',
      'Claude and GPT models  Weekly Limit Remaining       100%  2026-11-27 17:08 CST',
      'Claude and GPT models  Five Hour Limit Remaining    100%  2026-11-20 22:08 CST',
      'Gemini 4 Argon         Gemini 4 Argon Weekly Limit  100%  2026-11-27 17:08 CST',
    ].join('\n');

    const usage = parseAgyUsageOutput(sample, '2026-11-20T09:00:00.000Z');
    expect(usage.kind).toBe('agy_quotas');
    expect(usage.groups).toHaveLength(3);
    expect(usage.groups[0].group).toBe('Gemini Models');
    expect(usage.groups[0].fiveHour).toMatchObject({
      windowKind: 'five_hour',
      remainingPercent: 37,
      usedPercent: 63,
      resetsAt: '2026-11-20T12:08:00.000Z',
    });
    expect(usage.groups[0].weekly).toMatchObject({
      windowKind: 'weekly',
      remainingPercent: 66,
      usedPercent: 34,
      resetsAt: '2026-11-27T02:08:00.000Z',
    });
    expect(usage.groups[2].weekly?.usedPercent).toBe(0);
    expect(parseAgyResetTimestamp('2026-11-20 20:08 CST')).toBe(
      '2026-11-20T12:08:00.000Z',
    );

    // Non-TTY piped output uses TSV with ISO-8601 UTC timestamps
    const tsv =
      'Gemini Models\tWeekly Limit Remaining\t65%\t2026-11-27T02:08:25Z\n' +
      'Gemini Models\tFive Hour Limit Remaining\t34%\t2026-11-20T12:08:25Z\n';
    const tsvUsage = parseAgyUsageOutput(tsv, '2026-11-20T09:00:00.000Z');
    expect(tsvUsage.groups).toHaveLength(1);
    expect(tsvUsage.groups[0].fiveHour).toMatchObject({
      remainingPercent: 34,
      usedPercent: 66,
      resetsAt: '2026-11-20T12:08:25.000Z',
    });
    expect(tsvUsage.groups[0].weekly).toMatchObject({
      remainingPercent: 65,
      usedPercent: 35,
      resetsAt: '2026-11-27T02:08:25.000Z',
    });
  });
});
