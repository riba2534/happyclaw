import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildAgentPromptPatch,
  composeAgentPrompt,
  estimatePromptTokens,
  totalPromptStats,
} from '../web/src/utils/agent-prompts';
import {
  AGENT_PROMPT_MAX_CHARS,
  promptLengthError,
} from '../web/src/utils/agent-prompts';
import {
  getHostSkillPolicy,
  hostSkillPolicyForMode,
} from '../web/src/utils/agent-runtime-policy';
import { AGENT_TEMPLATES } from '../web/src/utils/agent-templates';
import {
  capabilityFormFromProfile,
  capabilityFormPolicy,
} from '../web/src/components/agents/AgentCapabilityForm';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Agent prompt and capability frontend contract', () => {
  test('composes the same canonical four-part prompt as the runner', () => {
    const prompt = composeAgentPrompt({
      identity_prompt: '  identity body  ',
      soul_prompt: '',
      agents_prompt: 'agents body',
      tools_prompt: 'tools body\n',
    });

    expect(prompt).toBe(
      '## IDENTITY\n  identity body  \n\n## AGENTS\nagents body\n\n## TOOLS\ntools body\n',
    );
    expect(prompt).not.toContain('## SOUL');
  });

  test('reports useful, explicitly estimated prompt size', () => {
    expect(estimatePromptTokens('你好abcd')).toBe(3);
    expect(
      totalPromptStats({
        identity_prompt: '身份',
        soul_prompt: '简洁',
        agents_prompt: '',
        tools_prompt: '',
      }),
    ).toMatchObject({ characters: 4, completedSections: 2 });
  });

  test('sends the complete four-part payload when only identity changes', () => {
    expect(
      buildAgentPromptPatch(
        {
          identity_prompt: 'new identity',
          soul_prompt: 'existing soul',
          agents_prompt: 'existing agents',
          tools_prompt: 'existing tools',
        },
        'append',
        {
          identity_prompt: 'old identity',
          soul_prompt: 'existing soul',
          agents_prompt: 'existing agents',
          tools_prompt: 'existing tools',
          prompt_mode: 'append',
        },
      ),
    ).toEqual({
      identity_prompt: 'new identity',
      soul_prompt: 'existing soul',
      agents_prompt: 'existing agents',
      tools_prompt: 'existing tools',
      prompt_mode: 'append',
      prompt_schema_version: 2,
    });
  });

  test('offers four ready-to-use templates for a new Agent', () => {
    expect(AGENT_TEMPLATES.map((template) => template.name)).toEqual([
      '代码开发助手',
      '调研分析',
      '写作编辑',
      '运维值守',
    ]);
    for (const template of AGENT_TEMPLATES) {
      for (const value of Object.values(template.prompts)) {
        expect(value.trim().length).toBeGreaterThan(20);
        expect(value.length).toBeLessThanOrEqual(AGENT_PROMPT_MAX_CHARS);
      }
    }
    const dialog = read('web/src/components/agents/CreateAgentDialog.tsx');
    expect(dialog).toContain('AGENT_TEMPLATES.map');
    expect(dialog).toContain('generateProfileDraft');
    const editor = read('web/src/components/agents/AgentPromptEditor.tsx');
    expect(editor).toContain('一键填入推荐模板');
    expect(editor).toContain('DEFAULT_AGENT_PROMPTS');
  });

  test('names the prompt section that is over the limit', () => {
    const parts = {
      identity_prompt: '',
      soul_prompt: '',
      agents_prompt: 'x'.repeat(AGENT_PROMPT_MAX_CHARS + 1),
      tools_prompt: '',
    };
    expect(promptLengthError(parts)).toBe(
      `行为规则（AGENTS）超过 ${AGENT_PROMPT_MAX_CHARS} 字上限（当前 ${AGENT_PROMPT_MAX_CHARS + 1} 字）`,
    );
    expect(
      promptLengthError({
        ...parts,
        agents_prompt: 'x'.repeat(AGENT_PROMPT_MAX_CHARS),
      }),
    ).toBeNull();
  });

  test('governs host Skills independently from host Prompt and Rules', () => {
    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const form = read('web/src/components/agents/AgentCapabilityForm.tsx');
    const skillEditor = read(
      'web/src/components/agents/AgentSkillsPolicyEditor.tsx',
    );
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );
    const system = read(
      'web/src/components/settings/SystemSettingsSection.tsx',
    );
    const policy = read('web/src/utils/agent-runtime-policy.ts');

    expect(profiles).toContain(
      'HappyClaw MCP 与宿主机 Skills 由上面的设置独立控制',
    );
    // The Agent page and the main HappyClaw settings share one form.
    expect(profiles).toContain('<AgentCapabilityForm');
    expect(main).toContain('<AgentCapabilityForm');
    expect(form).toContain('<AgentSkillsPolicyEditor');
    expect(form).toContain(
      'buildHostSkillOptions(skills, value.hostSkills.ids)',
    );
    expect(form).toContain(
      'buildManagedSkillOptions(skills, value.skills.ids)',
    );
    expect(skillEditor).toMatch(/不使用[\s\S]*选择部分[\s\S]*全部使用/);
    expect(skillEditor).toContain('来自 ~/.claude/skills，可单独启用');
    expect(policy).toContain("skill.source === 'user' && skill.enabled");
    expect(policy).toContain("skill.source === 'external' && skill.enabled");
    expect(system).toContain('宿主机');
  });

  test('treats all host Skills as symbolic inherit and saves them with the form', () => {
    expect(
      hostSkillPolicyForMode('inherit', [
        'old-custom-selection',
        'another-selection',
      ]),
    ).toEqual({ mode: 'inherit', ids: [] });
    expect(
      hostSkillPolicyForMode('custom', ['research', 'research', 'docs']),
    ).toEqual({ mode: 'custom', ids: ['research', 'docs'] });

    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const skillEditor = read(
      'web/src/components/agents/AgentSkillsPolicyEditor.tsx',
    );
    expect(profiles).not.toContain('persistHostSkillPolicy');
    expect(skillEditor).not.toContain('hostAutoSave');
    expect(skillEditor).toContain('修改后点击“保存”生效');
  });

  test('isolates capability preview failures instead of blanking the page', () => {
    const app = read('web/src/App.tsx');
    const appLayout = read('web/src/components/layout/AppLayout.tsx');
    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );
    const boundary = read('web/src/components/common/ErrorBoundary.tsx');

    expect(appLayout).toMatch(
      /<ErrorBoundary resetKeys=\{\[location\.pathname\]\}>[\s\S]*<Outlet \/>/,
    );
    expect(profiles).toMatch(
      /<ErrorBoundary resetKeys=\{\[selected\.id\]\}>[\s\S]*<EffectiveCapabilitiesPreview/,
    );
    expect(main).toMatch(
      /<ErrorBoundary resetKeys=\{\[profile\.id\]\}>[\s\S]*<EffectiveCapabilitiesPreview/,
    );
    expect(boundary).toMatch(/role="alert"[\s\S]*重试渲染[\s\S]*刷新页面/);
    expect(app).toContain(
      '<Suspense fallback={<AgentProfilesRouteFallback />}>',
    );
    expect(app).toContain('正在加载智能体设置…');
  });

  test('never refills or reveals stored MCP secrets', () => {
    const detail = read('web/src/components/mcp-servers/McpServerDetail.tsx');
    const store = read('web/src/stores/mcp-servers.ts');

    expect(detail).not.toMatch(
      /\bEye\b|EyeOff|showEnvValues|server\.env(?!Keys)|server\.headers(?!Keys)/,
    );
    expect(detail).toContain('密钥不会回填或显示');
    expect(detail).toContain('buildMcpSecretClear');
    expect(detail).toContain('buildMcpSecretReplacement');
    const responseShape = store.slice(
      store.indexOf('export interface McpServer'),
      store.indexOf('interface SyncHostResult'),
    );
    expect(responseShape).not.toContain('env?: Record');
    expect(responseShape).not.toContain('headers?: Record');
  });

  test('keeps each Skill source visible and read-only sources immutable', () => {
    const page = read('web/src/pages/SkillsPage.tsx');
    const card = read('web/src/components/skills/SkillCard.tsx');
    const store = read('web/src/stores/skills.ts');

    expect(page).toMatch(/我的 Skills[\s\S]*HappyClaw 内置[\s\S]*宿主机/);
    expect(page).toContain('skill.sourceKey');
    expect(card).toContain('isReadonlySkill(skill)');
    expect(card).toContain('skillConflictLabel');
    expect(store).toContain('effective?: boolean');
  });

  test('allows every saved model configuration to be selected by an Agent', () => {
    const form = read('web/src/components/agents/AgentCapabilityForm.tsx');
    // `enabled` no longer exists: every connection is offered as is.
    expect(form).not.toContain('config.enabled');
  });

  test('reads and saves the reasoning effort through the shared form', () => {
    const value = capabilityFormFromProfile({
      model_config_id: null,
      model: null,
      runtime_policy: {
        reasoning: { effort: 'high' },
        skills: {
          mode: 'inherit',
          ids: [],
          host: { mode: 'inherit', ids: [] },
        },
        mcp: { mode: 'custom', ids: ['github'] },
      },
    });
    expect(value).toMatchObject({ effort: 'high', modelConfigId: 'inherit' });
    expect(capabilityFormPolicy({ ...value, effort: 'max' })).toEqual({
      reasoning: { effort: 'max' },
      skills: { mode: 'inherit', ids: [], host: { mode: 'inherit', ids: [] } },
      mcp: { mode: 'custom', ids: ['user:github'] },
    });
    const form = read('web/src/components/agents/AgentCapabilityForm.tsx');
    expect(form).toContain('aria-label={`${labelPrefix}推理等级`}');
    // Only the efforts the bound model takes are offered (all of them,
    // unverified, for a model whose efforts are unknown).
    expect(form).toContain('selectableEfforts(entry).efforts.includes(effort)');
  });

  test('a profile from an older server without host Skills follows its effective context', () => {
    expect(
      getHostSkillPolicy(
        { context: { source: 'managed' } },
        { context: { source: 'host_claude' } },
      ),
    ).toEqual({ mode: 'inherit', ids: [] });
    expect(
      getHostSkillPolicy(
        {
          context: { source: 'managed' },
          skills: {
            mode: 'inherit',
            ids: [],
            host: { mode: 'disabled', ids: [] },
          },
        },
        { context: { source: 'host_claude' } },
      ),
    ).toEqual({ mode: 'disabled', ids: [] });
  });
});
