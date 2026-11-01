import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useMcpServersStore } from '../../stores/mcp-servers';
import { useSkillsStore } from '../../stores/skills';
import type { AgentProfileRuntimePolicy } from '../../types';
import { confirmRunnerRestart } from '../../utils/agent-save-confirm';
import {
  AgentCapabilityForm,
  capabilityFormBinding,
  capabilityFormError,
  capabilityFormFromProfile,
  capabilityFormModelChanges,
  capabilityFormPolicy,
  sameCapabilityForm,
  type AgentCapabilityFormValue,
} from '../agents/AgentCapabilityForm';
import { EffectiveCapabilitiesPreview } from '../agents/EffectiveCapabilitiesPreview';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { SettingsFormFooter } from './SettingsFormControls';
import { modelBindingErrorMessage } from './model-connections';
import { getErrorMessage } from './types';

export function MainAgentCapabilitiesSection() {
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const modelConfigs = useAgentProfilesStore(
    (state) => state.modelConfigs ?? [],
  );
  const inheritedModel = useAgentProfilesStore(
    (state) => state.inheritedModel ?? null,
  );
  const profilesLoading = useAgentProfilesStore((state) => state.loading);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  const updateProfile = useAgentProfilesStore((state) => state.updateProfile);
  const governanceByProfile = useAgentProfilesStore(
    (state) => state.governanceByProfile,
  );
  const loadProfileGovernance = useAgentProfilesStore(
    (state) => state.loadProfileGovernance,
  );
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);
  const profile = profiles.find((item) => item.is_default);
  const governance = profile ? governanceByProfile[profile.id] : undefined;

  const [form, setForm] = useState<AgentCapabilityFormValue | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([loadProfiles(), loadSkills(), loadMcpServers()]);
  }, [loadMcpServers, loadProfiles, loadSkills]);

  useEffect(() => {
    if (profile) setForm(capabilityFormFromProfile(profile));
  }, [profile?.id, profile?.updated_at]);

  useEffect(() => {
    if (!profile?.id) return;
    void loadProfileGovernance(profile.id).catch(() => undefined);
  }, [loadProfileGovernance, profile?.id]);

  const saved = useMemo(
    () => (profile ? capabilityFormFromProfile(profile) : null),
    [profile],
  );
  const dirty = !!form && !!saved && !sameCapabilityForm(form, saved);
  const formError = form ? capabilityFormError(form) : null;

  // The preview resolves the unsaved binding and refetches when it changes.
  const bindingConfigId = form?.modelConfigId;
  const bindingModel = form?.model ?? null;
  const previewBinding = useMemo(
    () =>
      bindingConfigId === undefined
        ? undefined
        : capabilityFormBinding({
            modelConfigId: bindingConfigId,
            model: bindingModel,
          }),
    [bindingConfigId, bindingModel],
  );
  const previewPolicy = useMemo<AgentProfileRuntimePolicy | null>(
    () =>
      profile && form
        ? { ...profile.runtime_policy, ...capabilityFormPolicy(form) }
        : null,
    [form, profile],
  );

  const save = async () => {
    if (!profile || !form || !saved || !dirty || formError) return;
    if (!(await confirmRunnerRestart(profile.id, loadProfileGovernance))) {
      return;
    }
    setSaving(true);
    try {
      const policy = capabilityFormPolicy(form);
      const policyChanged =
        JSON.stringify(policy) !== JSON.stringify(capabilityFormPolicy(saved));
      await updateProfile(profile.id, {
        ...capabilityFormModelChanges(profile, form),
        ...(policyChanged ? { runtime_policy: policy } : {}),
      });
      toast.success('主 HappyClaw 模型、推理等级与能力已保存');
    } catch (error) {
      toast.error(
        modelBindingErrorMessage(error) ??
          getErrorMessage(error, '保存能力失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  if (profilesLoading && !profile) {
    return (
      <SettingsGroup>
        <div className="flex min-h-28 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsGroup>
    );
  }

  if (!profile || !form) {
    return (
      <div
        role="alert"
        className="rounded-lg bg-error/10 px-3 py-2.5 text-body text-error"
      >
        无法读取当前管理员的主 HappyClaw 配置。
      </div>
    );
  }

  return (
    <>
      <SettingsSection
        title="模型与系统附加能力"
        description={
          <>
            为主智能体选择完整模型网关环境，并按来源控制 Skills 与 HappyClaw
            附加的 MCP。宿主机 Skills 可独立于宿主机 Prompt 与 Rules 启用。
          </>
        }
      >
        <AgentCapabilityForm
          value={form}
          onChange={setForm}
          modelConfigs={modelConfigs}
          inheritedModel={inheritedModel}
          profile={profile}
          hostAvailable
          labelPrefix="主 HappyClaw "
          modelConfigDescription="Home 工作区的会话与自动化都会继承该选择；你创建的其他智能体没有自己的模型时也跟随它。"
        />

        <SettingsFormFooter>
          <Button
            onClick={() => void save()}
            disabled={!dirty || saving || !!formError}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存模型与能力
          </Button>
        </SettingsFormFooter>
      </SettingsSection>

      {previewPolicy && (
        <ErrorBoundary resetKeys={[profile.id]}>
          <EffectiveCapabilitiesPreview
            profileId={profile.id}
            runtimePolicy={previewPolicy}
            modelBinding={previewBinding}
            workspaces={governance?.workspaces ?? []}
          />
        </ErrorBoundary>
      )}
    </>
  );
}
