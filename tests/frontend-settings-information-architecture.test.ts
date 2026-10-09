import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Skill } from '../web/src/stores/skills';
import { isReadonlySkill } from '../web/src/utils/skill-sources';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('settings information architecture', () => {
  test('keeps account, system, and administration scopes explicit', () => {
    const nav = read('web/src/components/settings/SettingsNav.tsx');

    expect(nav).toContain("label: '账户设置'");
    expect(nav).toContain("label: '系统配置'");
    expect(nav).toContain("label: '管理后台'");
    expect(nav).toContain("label: '关于 HappyClaw'");
    expect(nav).toContain("key: 'my-channels'");
    expect(nav).toContain("key: 'security'");
    expect(nav).toContain("key: 'main-agent'");
    expect(nav).toContain("key: 'host-integration'");
    expect(nav).toContain('min-h-0 flex-1 overflow-y-auto px-3 pb-28');
    expect(nav).toContain('SheetDescription');
    expect(nav).not.toMatch(
      /key: '(groups|agent-profiles|memory|skills|mcp-servers|plugins|usage)'/,
    );
  });

  test('uses the app scroll root and keeps settings content out of shell cards', () => {
    const appLayout = read('web/src/components/layout/AppLayout.tsx');
    const settings = read('web/src/pages/SettingsPage.tsx');
    const billing = read('web/src/pages/BillingPage.tsx');

    expect(appLayout).toContain('data-app-scroll-root="true"');
    expect(settings).toContain('data-settings-page="true"');
    expect(settings).toContain('data-settings-content="true"');
    expect(settings).not.toContain('overflow-y-auto');
    expect(settings).not.toContain('<Card');
    expect(settings).not.toContain(
      'h-full bg-background flex flex-col lg:flex-row overflow-hidden',
    );
    expect(billing).not.toContain('flex-1 overflow-y-auto');
  });

  test('moves product resources out of settings while preserving old links', () => {
    const app = read('web/src/App.tsx');
    const settings = read('web/src/pages/SettingsPage.tsx');
    const navItems = read('web/src/components/layout/nav-items.ts');
    const capabilities = read('web/src/pages/CapabilitiesPage.tsx');

    expect(app).toContain('path="/capabilities/:section?"');
    expect(app).toContain('path="/usage"');
    expect(app).toContain('requiredPermission="manage_system_config"');
    expect(settings).toContain("skills: '/capabilities/skills'");
    expect(settings).toContain("'mcp-servers': '/capabilities/mcp'");
    expect(settings).toContain("plugins: '/capabilities/plugins'");
    expect(settings).toContain(
      "bindings: '/settings?tab=my-channels&view=bindings'",
    );
    expect(navItems).toContain("label: '能力库'");
    expect(capabilities).toMatch(/能力库[\s\S]*具体智能体的“能力配置”/);
  });

  test('keeps workspaces private and removes the abandoned collaboration surface', () => {
    const database = read('src/db.ts');
    const groupRoutes = read('src/routes/groups.ts');
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const groupTypes = read('web/src/types.ts');

    expect(database).toContain('DROP TABLE IF EXISTS group_members');
    expect(groupRoutes).not.toMatch(/\/:jid\/members|canManageGroupMembers/);
    expect(chatView).not.toMatch(/共享成员|GroupMembersPanel/);
    expect(groupTypes).not.toMatch(
      /GroupMember|can_manage_members|member_role/,
    );
  });

  test('separates profile, device preferences, messaging, and security', () => {
    const profile = read('web/src/components/settings/ProfileSection.tsx');
    const preferences = read(
      'web/src/components/settings/PreferencesSection.tsx',
    );
    const channels = read(
      'web/src/components/settings/UserChannelsSection.tsx',
    );
    const security = read('web/src/components/settings/SecuritySection.tsx');

    expect(profile).not.toMatch(/密码|default_require_mention|桌面通知/);
    expect(preferences).toMatch(
      /当前设备|运行中的后续消息|排队|引导|桌面通知|恢复上次页面/,
    );
    expect(channels).toMatch(
      /新群默认响应方式|已接入会话|default_require_mention/,
    );
    expect(security).toMatch(/修改密码|登录设备|shortId|撤销这台设备/);
  });

  test('keeps admin-only host policy separate from runtime settings', () => {
    const system = read(
      'web/src/components/settings/SystemSettingsSection.tsx',
    );
    const page = read('web/src/pages/SettingsPage.tsx');

    expect(system).toMatch(/scope: 'runtime'/);
    expect(system).toMatch(/scope: 'security'/);
    expect(system).not.toMatch(/scope: 'automation'/);
    const validTabs = page.match(
      /const VALID_TABS:[\s\S]*?=\s*\[([\s\S]*?)\];/,
    )?.[1];
    expect(validTabs).toBeDefined();
    expect(validTabs).not.toContain("'automation'");
    expect(page).toContain("rawTabValue === 'automation' ? 'system'");
    expect(system).toMatch(/普通模型通常为 200K\s+上下文/);
    expect(system).toMatch(/\[1m\] 时按 1M 处理/);
    expect(system).toMatch(
      /当前目录同时作为提示词、Rules、Skills、MCP 与 Plugin\s+Marketplace\s+的来源/,
    );
    expect(system).toMatch(
      /管理员纯宿主机模式[\s\S]*普通成员仍固定使用\s+Docker/,
    );
    expect(page).toContain("currentUser?.role !== 'admin'");
  });

  test('uses accurate channel and provider safety semantics', () => {
    const bindings = read('web/src/components/settings/BindingsSection.tsx');
    const bindingRow = read('web/src/components/settings/ImBindingRow.tsx');
    const provider = read('web/src/components/settings/ProviderEditor.tsx');
    const providerList = read('web/src/components/settings/ProviderList.tsx');
    const providerModel = read('web/src/utils/provider-model.ts');
    const settings = read('web/src/pages/SettingsPage.tsx');

    expect(bindings).toMatch(/解除发言者限制|不可恢复|解除绑定/);
    expect(bindingRow).toMatch(
      /消息响应方式|supports_owner_mention|require_mention/,
    );
    expect(provider).toContain('高级设置 · 环境变量');
    expect(provider).toContain('系统预填环境变量');
    expect(provider).toContain('已自定义');
    expect(provider).toContain('恢复默认值');
    expect(providerModel).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(provider).toContain('1M 上下文');
    expect(provider).toContain('系统预填 Claude Code 运行环境');
    expect(providerList).not.toContain('设为默认');
    expect(providerList).not.toContain('系统默认');
    expect(providerList).not.toContain('权重');
    expect(settings).toContain('toast.success(message)');
    expect(settings).toContain('toast.error(message)');
  });

  test('offers supported official model aliases', () => {
    const provider = read('web/src/components/settings/ProviderEditor.tsx');
    const officialModels = provider.slice(
      provider.indexOf('/* ─── 官方模型选择 ─── */'),
      provider.indexOf('/* ─── 环境变量 ─── */'),
    );

    expect(officialModels).toMatch(
      /value="">default（默认）[\s\S]*value="opus">opus[\s\S]*value="sonnet">sonnet[\s\S]*value="haiku">haiku[\s\S]*value="fable">fable/,
    );
  });

  test('keeps Agent add-ons, project context, and Provider settings in distinct layers', () => {
    const settings = read('web/src/pages/SettingsPage.tsx');
    const mainCapabilities = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );
    const workspaceEnv = read('web/src/components/chat/ContainerEnvPanel.tsx');
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const agentProfiles = read('web/src/pages/AgentProfilesPage.tsx');
    const effectivePreview = read(
      'web/src/components/agents/EffectiveCapabilitiesPreview.tsx',
    );

    expect(settings).toContain('<MainAgentCapabilitiesSection />');
    expect(mainCapabilities).toMatch(/HappyClaw 用户 Skills|HappyClaw MCP/);
    expect(mainCapabilities).not.toContain('工具与扩展能力边界');
    expect(mainCapabilities).toContain('/api/agent-profiles/');
    expect(workspaceEnv).toMatch(/Provider\s+地址和凭据由系统管理员统一管理/);
    expect(workspaceEnv).not.toContain('MODEL_PRESETS');
    expect(workspaceEnv).not.toContain('setAuthToken');
    expect(workspaceEnv).toContain("anthropicModel: ''");
    expect(workspaceEnv).toMatch(
      /config\?\.anthropicModel[\s\S]*config\?\.anthropicBaseUrl[\s\S]*hasAnthropicAuthToken/,
    );
    expect(workspaceEnv).toMatch(/环境变量加载失败|保存失败/);
    expect(chatView).toContain('{canModifyWorkspaceConfig && (');
    expect(chatView).toContain(
      "contextPanelView === 'env' && canModifyWorkspaceConfig",
    );
    expect(agentProfiles).toContain('能力配置');
    expect(agentProfiles).toContain('<EffectiveCapabilitiesPreview');
    expect(effectivePreview).toMatch(/最终生效能力|同名来源冲突|预览工作区/);
  });

  test('supports governed Skill imports and preserves read-only sources', () => {
    const dialog = read('web/src/components/skills/InstallSkillDialog.tsx');
    const card = read('web/src/components/skills/SkillCard.tsx');
    const routes = read('src/routes/skills.ts');
    const importer = read('src/skill-import-service.ts');

    expect(dialog).toMatch(
      /搜索市场|HTTPS Git 仓库地址|技能 ZIP 文件|覆盖同名用户级技能/,
    );
    expect(routes).toMatch(
      /\/import\/git|\/import\/archive|recordImportedSkills/,
    );
    expect(importer).toMatch(/path traversal|symbolic links|MAX_ARCHIVE_BYTES/);
    const base = {
      id: 'skill',
      name: 'Skill',
      description: '',
      sourceKey: 'user:skill',
      enabled: true,
      userInvocable: true,
      allowedTools: [],
      argumentHint: null,
      updatedAt: '',
      files: [],
    } satisfies Omit<Skill, 'source'>;
    expect(isReadonlySkill({ ...base, source: 'external' })).toBe(true);
    expect(isReadonlySkill({ ...base, source: 'user' })).toBe(false);
    expect(isReadonlySkill({ ...base, source: 'user', readonly: true })).toBe(
      true,
    );
    expect(card).toContain('isReadonlySkill(skill)');
    expect(card).toContain('<Switch');
  });

  test('uses one channel binding commit path across settings and workspace routes', () => {
    const service = read('src/channel-mount-service.ts');
    const configRoutes = read('src/routes/config.ts');
    const agentRoutes = read('src/routes/agents.ts');

    expect(service).toMatch(
      /commitChannelMountUpdate[\s\S]*setRegisteredGroup/,
    );
    expect(configRoutes).toContain('commitChannelMountUpdate(imJid, updated)');
    expect(agentRoutes).toContain('commitChannelMountUpdate(imJid, updated)');
    expect(agentRoutes).not.toContain('setRegisteredGroup(imJid, updated)');
  });

  test('exposes main-session binding and complete mobile workspace actions', () => {
    const sessions = [
      'web/src/components/chat/SessionSidebar.tsx',
      'web/src/lib/session-presentation.ts',
    ]
      .map(read)
      .join('\n');
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const bindingDialog = read('web/src/components/chat/ImBindingDialog.tsx');
    const bindings = read('web/src/components/settings/BindingsSection.tsx');
    const mobileChat = read('web/src/pages/ChatPage.tsx');
    const createWorkspace = read(
      'web/src/components/chat/CreateContainerDialog.tsx',
    );
    const bindingRoute = read('src/routes/config.ts');

    expect(sessions).toContain('? () => onBindSession(null)');
    expect(chatView).toContain('setBindingAgentId(id ?? MAIN_BINDING)');
    expect(chatView).toContain('setBindingAgentId(WORKSPACE_BINDING)');
    expect(chatView).toContain('title="管理工作区话题群绑定"');
    expect(chatView).not.toContain('{!isHome && canModifyWorkspaceConfig && (');
    expect(chatView).toContain("? 'workspace' : 'session'");
    expect(bindingDialog).toContain(
      'resolveBindingTargetType(group) === destination.type',
    );
    expect(bindingDialog).toContain("group.conversation_kind === 'group'");
    expect(bindingDialog).toContain("group.conversation_kind === 'direct'");
    expect(bindings).toContain('resolveBindingTargetType(rebindGroup)');
    expect(bindings).toContain("resolveBindingTargetType(item) === 'session'");
    expect(bindings).toContain('解除渠道绑定');
    expect(mobileChat).toMatch(/onRename=|onTogglePin=|onDelete=/);
    expect(createWorkspace).toContain('effective_runtime_policy');
    expect(bindingRoute).toContain(
      "threadCapable ? 'thread_map' : 'single_session'",
    );
    expect(bindingRoute).not.toContain(
      'ordinary channels must bind to a session',
    );
    const sessionBindingRoute = read('src/routes/agents.ts');
    expect(sessionBindingRoute).toContain(
      "threadCapable ? 'thread_map' : 'single_session'",
    );
    const frontendTypes = read('web/src/types.ts');
    expect(frontendTypes).toContain("'native_thread'");
    expect(frontendTypes).toContain("'native_root'");
    expect(sessions).toContain('isNativeManagedSession(session)');
    expect(sessions).toContain("detail = '渠道原生话题'");
    expect(chatView).toContain(
      "group?.conversation_source === 'native_thread'",
    );
  });

  test('presents Feishu response audience independently from mention activation', () => {
    const dialog = read('web/src/components/chat/ImBindingDialog.tsx');
    const row = read('web/src/components/settings/ImBindingRow.tsx');
    const constants = read('web/src/constants/im.ts');

    expect(constants).toContain('AUDIENCE_MODE_OPTIONS');
    expect(constants).toContain("value: 'everyone'");
    expect(constants).toContain("value: 'owner_only'");
    expect(dialog).toContain('handleAudienceModeChange');
    expect(dialog).toContain('handleActivationModeChange');
    expect(row).toContain('onAudienceModeChange');
    expect(row).toContain('onActivationModeChange');
  });
});
