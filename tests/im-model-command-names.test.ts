/**
 * IM `/model <name> [effort]` with models a connection names for people: a
 * display name may contain spaces, its last word included, so the whole
 * text is tried as a name before a trailing word is read as an effort.
 */
import { describe, expect, test, vi } from 'vitest';

const service = vi.hoisted(() => ({
  checks: [] as Array<{ model: string | null; effort: string | null }>,
}));

vi.mock('../src/session-model-service.js', () => ({
  buildSessionModelSelectionView: () => ({
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    default: {
      source: 'none',
      modelConfigId: null,
      connectionMissing: false,
      model: null,
      effort: null,
    },
    options: [
      {
        id: 'relay',
        name: '中转',
        kind: 'third_party',
        model: 'k3',
        usable: true,
        models: [
          { id: 'k3', displayName: 'Kimi K3', efforts: ['low', 'high'] },
          { id: 'k3-max', displayName: 'Kimi K3 max', efforts: ['high'] },
        ],
      },
    ],
  }),
  checkSessionModelChoice: (
    _group: unknown,
    requested: {
      modelConfigId: string;
      model: string | null;
      effort: string | null;
    },
  ) => {
    service.checks.push({ model: requested.model, effort: requested.effort });
    return { ok: true, choice: requested };
  },
  saveSessionModelChoice: () => ({
    previous: null,
    drained: 0,
    liveUpdated: 0,
  }),
}));

const { runModelCommand } = await import('../src/im-model-command.js');

function run(args: string): string {
  return runModelCommand({
    args,
    workspace: { folder: 'ws', name: 'ws' } as never,
    workspaceJid: 'web:ws',
    agentId: 'session',
    chooser: { id: 'owner', role: 'member', permissions: [] },
    runners: null,
  });
}

describe('/model by name', () => {
  test('a display name whose last word reads like an effort is the name', () => {
    service.checks.length = 0;
    expect(run('Kimi K3 max')).toBe(
      '已切换到 中转 · k3-max，下一条消息起生效。',
    );
    expect(service.checks).toEqual([{ model: 'k3-max', effort: null }]);
  });

  test('otherwise a trailing word after a name is its effort', () => {
    service.checks.length = 0;
    expect(run('Kimi K3 high')).toBe(
      '已切换到 中转 · k3 · 档位 high，下一条消息起生效。',
    );
    expect(service.checks).toEqual([{ model: 'k3', effort: 'high' }]);
  });
});
