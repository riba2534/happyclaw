import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  SUBAGENT_UNAVAILABLE_TOOLS,
  availableSubagentTools,
  launchSubagentDefault,
  normalizeSubagentPolicy,
  resolveSubagentLaunch,
  subagentLaunchModels,
  subagentPolicyModels,
  subagentPolicyWithoutModels,
  toollessSubagents,
} from '../src/agent-subagents.js';
import { AgentProfileRuntimePolicySchema } from '../src/schemas.js';
import { RUNNER_DISALLOWED_BUILTIN_TOOLS } from '../container/agent-runner/src/builtin-tool-policy.js';

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

  test('keeps tool rules with arguments and drops ones that cannot be rules', () => {
    const policy = normalizeSubagentPolicy({
      definitions: [
        {
          ...reviewer,
          tools: [
            'Bash(git log:*)',
            'mcp__github__*',
            'Read, Grep',
            'two words',
            'Bash(git log:*)',
          ],
        },
      ],
    });
    expect(policy?.definitions[0].tools).toEqual([
      'Bash(git log:*)',
      'mcp__github__*',
    ]);
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
  const parse = (subagents: unknown) =>
    AgentProfileRuntimePolicySchema.safeParse({ subagents }).success;

  test('rejects a reserved or repeated name, accepts null to clear', () => {
    expect(parse({ definitions: [reviewer] })).toBe(true);
    expect(parse(null)).toBe(true);
    expect(
      parse({ definitions: [{ ...reviewer, name: 'general-purpose' }] }),
    ).toBe(false);
    expect(parse({ definitions: [reviewer, reviewer] })).toBe(false);
    expect(parse({ max_concurrent: 0 })).toBe(false);
  });

  test('a tool is one rule: a name, optionally with its argument', () => {
    const withTools = (tools: string[]) =>
      parse({ definitions: [{ ...reviewer, tools }] });
    expect(
      withTools([
        'Read',
        'Bash(git log:*)',
        'Bash(npm run test:*)',
        'WebFetch(domain:example.com)',
        'mcp__my-server__get_issue',
        'mcp__github__*',
      ]),
    ).toBe(true);
    expect(withTools(['Read, Grep'])).toBe(false);
    expect(withTools(['Read\nGrep'])).toBe(false);
    expect(withTools(['two words'])).toBe(false);
    expect(withTools(['Bash(unclosed'])).toBe(false);
  });
});

describe('resolveSubagentLaunch', () => {
  const models = [{ id: 'pro', contextWindow: 1_000_000 }, { id: 'flash' }];
  const efforts: Record<string, string[]> = {
    pro: ['low', 'high'],
    flash: [],
    inherited: ['low', 'high'],
  };
  const base = {
    models,
    takesEffort: (model: string | null, effort: string) =>
      efforts[model ?? 'inherited'].includes(effort),
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
    expect(subagentLaunchModels(launch)).toEqual(['flash', 'pro[1m]']);
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
    expect(subagentLaunchModels(launch)).toEqual([]);
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

  test('a sub-agent does not get the tools no session has', () => {
    const launch = resolveSubagentLaunch({
      ...base,
      onAgentConnection: false,
      policy: normalizeSubagentPolicy({
        definitions: [
          {
            ...reviewer,
            tools: [
              'Read',
              'CronCreate',
              'ScheduleWakeup',
              'EnterPlanMode',
              'ExitWorktree',
              'Bash(git log:*)',
            ],
          },
        ],
      }),
    });
    expect(launch.agents?.['code-reviewer'].tools).toEqual([
      'Read',
      'Bash(git log:*)',
    ]);
    expect(availableSubagentTools(['CronList(x)', 'Cron'])).toEqual(['Cron']);
  });

  test('the host leaves out exactly the tools the Runner disables', () => {
    expect([...SUBAGENT_UNAVAILABLE_TOOLS].sort()).toEqual(
      [...RUNNER_DISALLOWED_BUILTIN_TOOLS].sort(),
    );
    // The Web editor names the same ones before a save.
    const editor = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/agents/AgentSubagentsEditor.tsx',
      ),
      'utf8',
    );
    const listed = /const UNAVAILABLE_TOOLS[^=]*=\s*\[([^\]]*)\]/.exec(
      editor,
    )?.[1];
    expect(
      [...(listed ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    ).toEqual([...SUBAGENT_UNAVAILABLE_TOOLS].sort());
  });

  test('a sub-agent left with no tool is not launched, never with none or all', () => {
    const policy = normalizeSubagentPolicy({
      definitions: [
        { ...reviewer, name: 'planner', tools: ['EnterPlanMode'] },
        { ...reviewer, name: 'empty', tools: [] },
        { ...reviewer, name: 'every-tool', tools: null },
        { ...reviewer, name: 'mixed', tools: ['CronList', 'Read'] },
      ],
    });
    expect(toollessSubagents(policy)).toEqual(['planner', 'empty']);
    const launch = resolveSubagentLaunch({
      ...base,
      policy,
      onAgentConnection: false,
    });
    expect(Object.keys(launch.agents ?? {})).toEqual(['every-tool', 'mixed']);
    expect(launch.agents?.['every-tool']).not.toHaveProperty('tools');
    expect(launch.agents?.mixed.tools).toEqual(['Read']);
    // None left: no definitions at all, not an empty set of them.
    expect(
      resolveSubagentLaunch({
        ...base,
        onAgentConnection: false,
        policy: normalizeSubagentPolicy({
          max_concurrent: 2,
          definitions: [{ ...reviewer, tools: ['ExitPlanMode'] }],
        }),
      }),
    ).toEqual({ maxConcurrent: 2 });
  });
});

describe('launchSubagentDefault', () => {
  const thirdParty = {
    anthropicBaseUrl: 'https://relay.example',
    roles: { subagent: 'role-model' },
  };

  test('the Agent’s default, else the connection role, else the turn', () => {
    expect(launchSubagentDefault(thirdParty, 'mine', 'turn')).toEqual({
      model: 'mine',
      source: 'agent',
    });
    expect(launchSubagentDefault(thirdParty, undefined, 'turn')).toEqual({
      model: 'role-model',
      source: 'connection',
    });
    expect(
      launchSubagentDefault(
        { anthropicBaseUrl: 'https://relay.example' },
        undefined,
        'turn',
      ),
    ).toEqual({ model: 'turn', source: 'turn' });
  });

  test('the official endpoint takes only the Agent’s; ChatGPT only the turn', () => {
    expect(
      launchSubagentDefault(
        { anthropicBaseUrl: '', roles: { subagent: 'role-model' } },
        undefined,
        'claude-opus-5-5',
      ),
    ).toEqual({ model: null, source: 'claude_code' });
    expect(
      launchSubagentDefault(
        { ...thirdParty, codexOAuthCredentials: {} },
        'mine',
        'gpt-6.1-sol',
      ),
    ).toEqual({ model: 'gpt-6.1-sol', source: 'turn' });
  });
});

describe('subagentPolicyWithoutModels', () => {
  const policy = normalizeSubagentPolicy({
    model: 'flash',
    max_concurrent: 4,
    definitions: [reviewer, { ...reviewer, name: 'deep', model: 'pro' }],
  });

  test('clears every name, keeping the definitions and the cap', () => {
    expect(subagentPolicyWithoutModels(policy)).toEqual({
      model: null,
      max_concurrent: 4,
      definitions: policy!.definitions.map((definition) => ({
        ...definition,
        model: null,
      })),
    });
  });

  test('keeps the names `keep` accepts; nothing left is absent', () => {
    const kept = subagentPolicyWithoutModels(policy, (id) => id === 'pro');
    expect(kept?.model).toBeNull();
    expect(kept?.definitions.map((item) => item.model)).toEqual([null, 'pro']);
    expect(
      subagentPolicyWithoutModels(normalizeSubagentPolicy({ model: 'flash' })),
    ).toBeUndefined();
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

  const prompts = normalizeAgentProfilePrompts({ identity_prompt: 'x' });
  const hashOf = (subagents: unknown) =>
    db.computeAgentProfileIdentityHash(
      prompts,
      db.normalizeAgentProfileRuntimePolicy({ subagents } as never),
    );

  test('the identity hash changes with custom sub-agents and not without them', () => {
    const plain = db.computeAgentProfileIdentityHash(prompts, current);
    expect(hashOf(null)).toBe(plain);
    expect(hashOf({ definitions: [reviewer] })).not.toBe(plain);
    expect(
      hashOf({ definitions: [{ ...reviewer, prompt: 'Review harder.' }] }),
    ).not.toBe(hashOf({ definitions: [reviewer] }));
  });

  test('the cap and the default model restart the Runner, not the session', () => {
    const plain = db.computeAgentProfileIdentityHash(prompts, current);
    expect(hashOf({ max_concurrent: 3 })).toBe(plain);
    expect(hashOf({ model: 'flash', max_concurrent: 3 })).toBe(plain);
    expect(
      hashOf({ model: 'pro', max_concurrent: 5, definitions: [reviewer] }),
    ).toBe(hashOf({ definitions: [reviewer] }));
  });
});
