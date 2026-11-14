import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  normalizeSubagentPolicy,
  resolveSubagentLaunch,
  subagentPolicyModels,
} from '../src/agent-subagents.js';
import { AgentProfileRuntimePolicySchema } from '../src/schemas.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-subagents-'));
vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});
const db = await import('../src/db.ts');
const { normalizeAgentProfilePrompts } =
  await import('../src/agent-profile-prompts.ts');

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const reviewer = {
  name: 'code-reviewer',
  description: 'Review a diff for bugs',
  prompt: 'You review code.',
  tools: ['Read', 'Grep'],
  model: 'flash',
  effort: 'high',
};

describe('normalizeSubagentPolicy', () => {
  test('nothing set is absent, so an unused Agent keeps its policy', () => {
    expect(normalizeSubagentPolicy(undefined)).toBeUndefined();
    expect(
      normalizeSubagentPolicy({
        model: null,
        max_concurrent: null,
        definitions: [],
      }),
    ).toBeUndefined();
  });

  test('drops invalid, reserved and duplicate definitions; clamps the cap', () => {
    const policy = normalizeSubagentPolicy({
      max_concurrent: 99,
      definitions: [
        reviewer,
        { ...reviewer, prompt: 'duplicate' },
        { ...reviewer, name: 'general-purpose' },
        { ...reviewer, name: 'Bad Name' },
        { ...reviewer, name: 'no-prompt', prompt: ' ' },
        { ...reviewer, name: 'odd-effort', effort: 'ultra', tools: 'Read' },
      ],
    });
    expect(policy?.max_concurrent).toBe(20);
    expect(policy?.definitions.map((item) => item.name)).toEqual([
      'code-reviewer',
      'odd-effort',
    ]);
    expect(policy?.definitions[0].prompt).toBe('You review code.');
    expect(policy?.definitions[1]).toMatchObject({ effort: null, tools: null });
  });

  test('lists the models it names once', () => {
    expect(
      subagentPolicyModels(
        normalizeSubagentPolicy({ model: 'flash', definitions: [reviewer] }),
      ),
    ).toEqual(['flash']);
  });
});

describe('schema', () => {
  test('rejects a reserved or repeated name, accepts null to clear', () => {
    const parse = (subagents: unknown) =>
      AgentProfileRuntimePolicySchema.safeParse({ subagents }).success;
    expect(parse({ definitions: [reviewer] })).toBe(true);
    expect(parse(null)).toBe(true);
    expect(
      parse({ definitions: [{ ...reviewer, name: 'general-purpose' }] }),
    ).toBe(false);
    expect(parse({ definitions: [reviewer, reviewer] })).toBe(false);
    expect(parse({ max_concurrent: 0 })).toBe(false);
  });
});

describe('resolveSubagentLaunch', () => {
  const models = [{ id: 'pro', contextWindow: 1_000_000 }, { id: 'flash' }];
  const efforts: Record<string, string[]> = { pro: ['low', 'high'], flash: [] };
  const base = {
    models,
    effortsOf: (id: string) => (efforts[id]?.length ? efforts[id] : null),
    inheritedEfforts: ['low', 'high'],
  };
  const policy = normalizeSubagentPolicy({
    model: 'flash',
    max_concurrent: 3,
    definitions: [
      reviewer,
      { ...reviewer, name: 'deep', model: 'pro', effort: 'high' },
      { ...reviewer, name: 'plain', model: null, effort: 'low', tools: null },
    ],
  });

  test('on the Agent’s connection: launch names, efforts the model takes', () => {
    const launch = resolveSubagentLaunch({
      ...base,
      policy,
      onAgentConnection: true,
    });
    expect(launch.defaultModel).toBe('flash');
    expect(launch.maxConcurrent).toBe(3);
    expect(launch.agents).toEqual({
      // flash takes no effort, so none is sent.
      'code-reviewer': {
        description: 'Review a diff for bugs',
        prompt: 'You review code.',
        tools: ['Read', 'Grep'],
        model: 'flash',
      },
      deep: {
        description: 'Review a diff for bugs',
        prompt: 'You review code.',
        tools: ['Read', 'Grep'],
        model: 'pro[1m]',
        effort: 'high',
      },
      plain: {
        description: 'Review a diff for bugs',
        prompt: 'You review code.',
        effort: 'low',
      },
    });
  });

  test('on another connection the names drop and the definitions inherit', () => {
    const launch = resolveSubagentLaunch({
      ...base,
      policy,
      onAgentConnection: false,
    });
    expect(launch.defaultModel).toBeUndefined();
    expect(launch.maxConcurrent).toBe(3);
    expect(launch.agents?.deep.model).toBeUndefined();
    expect(launch.agents?.deep.effort).toBe('high');
  });

  test('a model the connection no longer offers inherits', () => {
    const launch = resolveSubagentLaunch({
      ...base,
      models: [{ id: 'pro' }],
      policy,
      onAgentConnection: true,
    });
    expect(launch.defaultModel).toBeUndefined();
    expect(launch.agents?.['code-reviewer'].model).toBeUndefined();
  });
});

describe('runtime policy storage', () => {
  const current = db.normalizeAgentProfileRuntimePolicy();

  test('merge replaces sub-agents as one unit; null clears them', () => {
    const set = db.mergeAgentProfileRuntimePolicy(current, {
      subagents: { max_concurrent: 2 },
    });
    expect(set.subagents).toEqual({
      model: null,
      max_concurrent: 2,
      definitions: [],
    });
    const kept = db.mergeAgentProfileRuntimePolicy(set, {
      mcp: { mode: 'disabled' },
    });
    expect(kept.subagents?.max_concurrent).toBe(2);
    expect(
      db.mergeAgentProfileRuntimePolicy(set, { subagents: null }).subagents,
    ).toBeUndefined();
  });

  test('the identity hash changes with sub-agents and not without them', () => {
    const prompts = normalizeAgentProfilePrompts({ identity_prompt: 'x' });
    const plain = db.computeAgentProfileIdentityHash(prompts, current);
    expect(
      db.computeAgentProfileIdentityHash(prompts, {
        ...current,
        subagents: null,
      } as never),
    ).toBe(plain);
    expect(
      db.computeAgentProfileIdentityHash(
        prompts,
        db.normalizeAgentProfileRuntimePolicy({
          subagents: { definitions: [reviewer] },
        }),
      ),
    ).not.toBe(plain);
  });
});
