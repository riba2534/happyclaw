import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildFreshSessionInstructions } from '../src/agy-runner/instructions.js';
import {
  DEFAULT_AGY_MODEL,
  parseAgyModelsOutput,
} from '../src/agy-runner/models.js';
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
    const translator = new AgyStreamTranslator(undefined, 'gemini-4-neon-medium');
    translator.setTurnCorrelation({
      queryRunId: 'q-1',
      turnId: 't-1',
      inputTurnId: 'in-1',
    });

    const initFrames = translator.translateLine(
      JSON.stringify({
        event: 'init',
        conversation_id: 'conv-123',
        init: { model: 'gemini-4-neon-medium', cwd: '/tmp/ws', tools: ['run_command'] },
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
