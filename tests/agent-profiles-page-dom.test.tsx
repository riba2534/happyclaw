// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from 'react-router-dom';

const mocks = vi.hoisted(() => {
  const profile = {
    id: 'research-profile',
    owner_user_id: 'admin-user',
    name: '调研智能体',
    identity_prompt: '',
    soul_prompt: '',
    agents_prompt: '',
    tools_prompt: '',
    prompt_mode: 'append' as const,
    include_claude_preset: true,
    avatar_emoji: null,
    avatar_color: null,
    avatar_url: null,
    runtime_policy: {
      context: {
        source: 'managed' as const,
        auto_compact_window: 0,
        auto_compact_percentage: 80,
      },
      skills: {
        mode: 'inherit' as const,
        ids: [],
        host: { mode: 'custom' as const, ids: ['research'] },
      },
      mcp: { mode: 'inherit' as const, ids: [] },
    },
    identity_hash: 'hash-1',
    version: 1,
    is_default: false,
    status: 'active' as const,
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
  };
  const otherProfile = {
    ...profile,
    id: 'second-profile',
    name: '第二智能体',
    runtime_policy: {
      ...profile.runtime_policy,
      skills: {
        ...profile.runtime_policy.skills,
        host: { mode: 'disabled' as const, ids: [] },
      },
    },
  };
  return {
    profile,
    otherProfile,
    profiles: [profile],
    governanceByProfile: {} as Record<string, unknown>,
    userRole: 'admin' as 'admin' | 'member',
    updateProfile: vi.fn(async () => ({
      ...profile,
      runtime_policy: {
        ...profile.runtime_policy,
        skills: {
          ...profile.runtime_policy.skills,
          host: { mode: 'inherit' as const, ids: [] },
        },
      },
      version: 2,
    })),
    loadProfiles: vi.fn(async () => undefined),
    refreshProfile: vi.fn(async () => profile),
    loadGovernance: vi.fn(async () => ({
      profile,
      workspaces: [],
      channel_mounts: [],
      runtime_cleanup_pending: false,
    })),
    retryRuntimeCleanup: vi.fn(async () => undefined),
    deleteProfile: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
  };
});

vi.mock('../web/src/stores/agent-profiles', () => ({
  useAgentProfilesStore: () => ({
    profiles: mocks.profiles,
    loading: false,
    profilesError: null,
    loadProfiles: mocks.loadProfiles,
    refreshProfile: mocks.refreshProfile,
    loadProfileGovernance: mocks.loadGovernance,
    retryRuntimeCleanup: mocks.retryRuntimeCleanup,
    loadPromptVersions: vi.fn(async () => []),
    restorePromptVersion: vi.fn(),
    governanceByProfile: mocks.governanceByProfile,
    governanceLoading: {},
    governanceErrors: {},
    generateProfileDraft: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: mocks.updateProfile,
    uploadProfileAvatar: vi.fn(),
    removeProfileAvatar: vi.fn(),
    deleteProfile: mocks.deleteProfile,
    setWorkspaceAgentProfile: vi.fn(),
  }),
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: { id: 'admin-user', role: mocks.userRole },
      appearance: null,
    }),
}));

vi.mock('../web/src/stores/skills', () => ({
  useSkillsStore: (selector: (state: unknown) => unknown) =>
    selector({
      skills: [
        {
          id: 'research',
          name: 'research',
          description: 'Research Skill',
          source: 'external',
          enabled: true,
        },
      ],
      loading: false,
      error: null,
      loadSkills: mocks.loadSkills,
    }),
}));

vi.mock('../web/src/stores/mcp-servers', () => ({
  useMcpServersStore: (selector: (state: unknown) => unknown) =>
    selector({
      servers: [],
      loading: false,
      error: null,
      loadServers: mocks.loadMcp,
    }),
}));

vi.mock('../web/src/components/agents/AgentPromptAssistant', () => ({
  AgentPromptAssistant: () => null,
}));
vi.mock('../web/src/components/agents/AgentPromptEditor', () => ({
  AgentPromptEditor: () => null,
}));
vi.mock('../web/src/components/agents/AgentPromptVersionHistory', () => ({
  AgentPromptVersionHistory: () => null,
}));
vi.mock('../web/src/components/agents/EffectiveCapabilitiesPreview', () => ({
  EffectiveCapabilitiesPreview: () => null,
}));
vi.mock('../web/src/components/agents/AgentGovernanceSection', () => ({
  AgentGovernanceSection: () => null,
}));
vi.mock('../web/src/components/agents/PolicyResourcePicker', () => ({
  PolicyResourcePicker: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock('../web/src/components/common/EmojiAvatar', () => ({
  EmojiAvatar: () => <div />,
}));
vi.mock('../web/src/components/common/EmojiPicker', () => ({
  EmojiPicker: () => <div />,
}));
vi.mock('../web/src/components/common/ColorPicker', () => ({
  ColorPicker: () => <div />,
}));

const { AgentProfilesPage } =
  await import('../web/src/pages/AgentProfilesPage');
const { useConfirmStore } = await import('../web/src/stores/confirm');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentLocation = '';

function LocationProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  currentLocation = '';
  mocks.profiles = [mocks.profile];
  mocks.governanceByProfile = {};
  mocks.userRole = 'admin';
  useConfirmStore.getState().settle(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('智能体宿主机 Skills 自动保存', () => {
  async function renderPage(): Promise<HTMLButtonElement>;
  async function renderPage(options: { expectHostAll: false }): Promise<null>;
  async function renderPage(
    options: { expectHostAll: boolean } = { expectHostAll: true },
  ): Promise<HTMLButtonElement | null> {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const router = createMemoryRouter(
      [
        {
          path: '/agent-profiles',
          element: (
            <>
              <LocationProbe />
              <AgentProfilesPage />
            </>
          ),
        },
      ],
      {
        initialEntries: ['/agent-profiles?agent=research-profile'],
      },
    );
    await act(async () => {
      root?.render(<RouterProvider router={router} />);
    });

    if (!options.expectHostAll) {
      await vi.waitFor(() =>
        expect(container?.textContent).toContain('能力配置'),
      );
      return null;
    }
    return vi.waitFor(() => {
      const match = Array.from(
        container!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).find((button) => button.textContent?.includes('全部使用'));
      expect(match).toBeDefined();
      return match!;
    });
  }

  test('真实点击全部使用后保持当前路由并发送最小 PATCH', async () => {
    const all = await renderPage();
    const before = currentLocation;

    await act(async () => {
      all.click();
    });

    await vi.waitFor(() =>
      expect(mocks.updateProfile).toHaveBeenCalledWith('research-profile', {
        runtime_policy: {
          skills: {
            host: { mode: 'inherit', ids: [] },
          },
        },
      }),
    );
    expect(currentLocation).toBe(before);
    expect(container.textContent).toContain('已保存并生效');
    expect(all.getAttribute('aria-checked')).toBe('true');
  });

  test('已持久化的清理任务可连续重试且不会错误回滚', async () => {
    const persistedProfile = {
      ...mocks.profile,
      runtime_policy: {
        ...mocks.profile.runtime_policy,
        skills: {
          ...mocks.profile.runtime_policy.skills,
          host: { mode: 'inherit' as const, ids: [] },
        },
      },
    };
    mocks.updateProfile.mockRejectedValueOnce({
      status: 503,
      message: '配置已更新，但运行时清理失败',
      body: {
        persisted: true,
        retryable: true,
        profile: persistedProfile,
      },
    });
    mocks.retryRuntimeCleanup
      .mockRejectedValueOnce({
        status: 503,
        message: '工作区运行时清理失败',
      })
      .mockResolvedValueOnce(undefined);
    const all = await renderPage();

    await act(async () => {
      all.click();
    });

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        '配置已保存，但工作区运行时清理未完成',
      ),
    );
    expect(all.getAttribute('aria-checked')).toBe('true');
    const retryCleanup = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('重试清理'));
    expect(retryCleanup).toBeDefined();

    await act(async () => {
      retryCleanup!.click();
    });
    await vi.waitFor(() =>
      expect(mocks.retryRuntimeCleanup).toHaveBeenCalledTimes(1),
    );
    expect(container?.textContent).toContain(
      '配置已保存，但工作区运行时清理未完成',
    );

    const retryAgain = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('重试清理'));
    expect(retryAgain).toBeDefined();
    await act(async () => {
      retryAgain!.click();
    });
    await vi.waitFor(() =>
      expect(container?.textContent).toContain('已保存并生效'),
    );
    expect(mocks.updateProfile).toHaveBeenCalledTimes(1);
    expect(mocks.retryRuntimeCleanup).toHaveBeenCalledTimes(2);
    expect(mocks.retryRuntimeCleanup).toHaveBeenLastCalledWith(
      'research-profile',
    );
  });

  test('刷新页面后会恢复待清理提示和幂等重试入口', async () => {
    mocks.governanceByProfile = {
      'research-profile': {
        profile: mocks.profile,
        workspaces: [],
        channel_mounts: [],
        runtime_cleanup_pending: true,
      },
    };
    await renderPage({ expectHostAll: false });

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        '配置已保存，但工作区运行时清理未完成',
      ),
    );
    const retryCleanup = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('重试清理'));
    expect(retryCleanup).toBeDefined();
    await act(async () => {
      retryCleanup!.click();
    });
    await vi.waitFor(() =>
      expect(mocks.retryRuntimeCleanup).toHaveBeenCalledOnce(),
    );
    expect(mocks.retryRuntimeCleanup).toHaveBeenCalledWith('research-profile');
    expect(mocks.updateProfile).not.toHaveBeenCalled();
  });

  test('普通成员也能看到并重试全局运行时清理', async () => {
    mocks.userRole = 'member';
    mocks.governanceByProfile = {
      'research-profile': {
        profile: mocks.profile,
        workspaces: [],
        channel_mounts: [],
        runtime_cleanup_pending: true,
      },
    };
    await renderPage({ expectHostAll: false });

    expect(container?.textContent).toContain(
      '智能体配置已保存，但工作区运行时清理未完成',
    );
    expect(container?.textContent).toContain(
      '只有管理员可以查看和授权宿主机 Skills',
    );
    const retryCleanup = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('重试清理'));
    expect(retryCleanup).toBeDefined();
    await act(async () => {
      retryCleanup!.click();
    });
    await vi.waitFor(() =>
      expect(mocks.retryRuntimeCleanup).toHaveBeenCalledWith(
        'research-profile',
      ),
    );
  });

  test('超时且服务端仍返回旧策略时保持待确认状态而不虚假回滚', async () => {
    mocks.updateProfile.mockRejectedValueOnce({
      status: 408,
      message: 'Request timeout',
    });
    mocks.refreshProfile.mockResolvedValueOnce(mocks.profile);
    const all = await renderPage();

    await act(async () => {
      all.click();
    });

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        '连接中断，暂时无法确认服务端状态',
      ),
    );
    expect(mocks.refreshProfile).toHaveBeenCalledWith('research-profile');
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(container?.textContent).toContain('重新确认并应用');
  });

  test('超时对账期间切换后返回仍会重试本次请求的策略', async () => {
    mocks.profiles = [mocks.profile, mocks.otherProfile];
    mocks.updateProfile.mockRejectedValueOnce({
      status: 408,
      message: 'Request timeout',
    });
    let resolveRefresh!: (profile: typeof mocks.profile) => void;
    mocks.refreshProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const all = await renderPage();

    await act(async () => {
      all.click();
    });
    await vi.waitFor(() => expect(mocks.refreshProfile).toHaveBeenCalledOnce());

    const profileButton = (name: string) =>
      Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.includes(name),
      );
    await act(async () => {
      profileButton('第二智能体')!.click();
    });
    await vi.waitFor(() =>
      expect(currentLocation).toContain('agent=second-profile'),
    );
    await act(async () => {
      profileButton('调研智能体')!.click();
    });
    await vi.waitFor(() =>
      expect(currentLocation).toContain('agent=research-profile'),
    );

    await act(async () => {
      resolveRefresh(mocks.profile);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        '连接中断，暂时无法确认服务端状态',
      ),
    );
    const retry = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('重新确认并应用'));
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    await vi.waitFor(() =>
      expect(mocks.updateProfile).toHaveBeenCalledTimes(2),
    );
    expect(mocks.updateProfile).toHaveBeenLastCalledWith('research-profile', {
      runtime_policy: {
        skills: {
          host: { mode: 'inherit', ids: [] },
        },
      },
    });
  });

  test('旧智能体的延迟失败不会回滚新选中的智能体', async () => {
    mocks.profiles = [mocks.profile, mocks.otherProfile];
    let rejectSave!: (reason: unknown) => void;
    mocks.updateProfile.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const all = await renderPage();

    await act(async () => {
      all.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledOnce());
    const secondProfileButton = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('第二智能体'));
    expect(secondProfileButton).toBeDefined();

    await act(async () => {
      secondProfileButton!.click();
    });
    expect(currentLocation).toContain('agent=second-profile');

    await act(async () => {
      rejectSave({ status: 500, message: 'save failed' });
      await Promise.resolve();
    });

    const hostGroup = container!.querySelector(
      '[role="radiogroup"][aria-label="宿主机 Skills 使用方式"]',
    );
    const disabled = Array.from(
      hostGroup!.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((button) => button.textContent?.includes('不使用'));
    expect(disabled?.getAttribute('aria-checked')).toBe('true');
    expect(container?.textContent).not.toContain('保存失败，当前选择尚未生效');
  });

  test('删除智能体通过应用内确认框而不是原生 confirm', async () => {
    const nativeConfirm = vi.fn((_message?: string) => true);
    vi.stubGlobal('confirm', nativeConfirm);
    await renderPage({ expectHostAll: false });

    const deleteButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="删除智能体"]',
    );
    expect(deleteButton).not.toBeNull();
    await act(async () => {
      deleteButton!.click();
    });

    await vi.waitFor(() =>
      expect(useConfirmStore.getState().pending).toMatchObject({
        title: '删除智能体',
        message: '确认删除智能体「调研智能体」？',
        variant: 'danger',
      }),
    );
    expect(mocks.deleteProfile).not.toHaveBeenCalled();

    await act(async () => {
      useConfirmStore.getState().settle(true);
    });
    await vi.waitFor(() =>
      expect(mocks.deleteProfile).toHaveBeenCalledWith('research-profile'),
    );
    // Native confirm() is reserved for the synchronous unsaved-changes guard.
    for (const [message] of nativeConfirm.mock.calls) {
      expect(message).not.toContain('确认删除智能体');
    }
  });
});
