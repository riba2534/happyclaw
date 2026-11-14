import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import {
  AgentModelSelect,
  modelBindingChanges,
} from '@/components/settings/AgentModelSelect';
import { effortLabel } from '@/components/settings/model-connections';
import { useMcpServersStore } from '@/stores/mcp-servers';
import { useSkillsStore } from '@/stores/skills';
import type {
  AgentEffortLevel,
  AgentProfile,
  AgentProfileRuntimePolicy,
  AgentSubagentPolicy,
  InheritedModel,
  ConnectionModel,
  ModelConfigOption,
} from '@/types';
import { normalizeMcpPolicyReferences } from '@/utils/mcp-servers';
import {
  buildHostSkillOptions,
  buildManagedSkillOptions,
  buildMcpSelectionOptions,
  getHostSkillPolicy,
  hostSkillPolicyForMode,
  skillSelectionError,
  type RuntimePolicyMode,
  type SkillSourcePolicy,
} from '@/utils/agent-runtime-policy';
import { AgentControlRow, AgentSubheading } from './AgentSection';
import { AgentSkillsPolicyEditor } from './AgentSkillsPolicyEditor';
import {
  AgentSubagentsEditor,
  subagentPolicyWithoutModels,
} from './AgentSubagentsEditor';
import { PolicyResourcePicker } from './PolicyResourcePicker';

/**
 * What the Agent page and the main HappyClaw settings both edit: the model
 * binding, reasoning effort and every capability source. Both save it the
 * same way, only when the user presses save.
 */
export interface AgentCapabilityFormValue {
  /** 'inherit' while the Agent follows another one (see ModelFollow). */
  modelConfigId: string;
  /** The model within that connection; null runs its own model. */
  model: string | null;
  effort: AgentEffortLevel;
  skills: SkillSourcePolicy;
  hostSkills: SkillSourcePolicy;
  mcp: SkillSourcePolicy;
  /** null when the Agent sets nothing about sub-agents. */
  subagents: AgentSubagentPolicy | null;
}

export function capabilityFormFromProfile(
  profile: Pick<
    AgentProfile,
    'model_config_id' | 'model' | 'runtime_policy' | 'effective_runtime_policy'
  >,
): AgentCapabilityFormValue {
  const policy = profile.runtime_policy;
  return {
    modelConfigId: profile.model_config_id ?? 'inherit',
    model: profile.model ?? null,
    effort: policy.reasoning?.effort ?? 'inherit',
    skills: { mode: policy.skills.mode, ids: [...policy.skills.ids] },
    hostSkills: getHostSkillPolicy(policy, profile.effective_runtime_policy),
    mcp: {
      mode: policy.mcp.mode,
      ids: normalizeMcpPolicyReferences(policy.mcp.ids),
    },
    subagents: policy.subagents ?? null,
  };
}

/** The runtime-policy part of the form, as the server stores it. */
export function capabilityFormPolicy(value: AgentCapabilityFormValue): Pick<
  AgentProfileRuntimePolicy,
  'reasoning' | 'skills' | 'mcp'
> & {
  subagents: AgentSubagentPolicy | null;
} {
  return {
    reasoning: { effort: value.effort },
    skills: {
      mode: value.skills.mode,
      ids: value.skills.ids,
      host: { mode: value.hostSkills.mode, ids: value.hostSkills.ids },
    },
    mcp: { mode: value.mcp.mode, ids: value.mcp.ids },
    // Saved as one unit; null clears what was set.
    subagents: value.subagents,
  };
}

function capabilityFormErrors(value: AgentCapabilityFormValue) {
  return {
    managed: skillSelectionError(' HappyClaw Skill', value.skills),
    host: skillSelectionError('宿主机 Skill', value.hostSkills),
  };
}

export function capabilityFormError(
  value: AgentCapabilityFormValue,
): string | null {
  const errors = capabilityFormErrors(value);
  return errors.managed ?? errors.host;
}

/** The (configuration, model) part of a save; see modelBindingChanges. */
export function capabilityFormModelChanges(
  saved: Pick<AgentProfile, 'model_config_id' | 'model'>,
  value: AgentCapabilityFormValue,
) {
  return modelBindingChanges(
    saved,
    capabilityFormBinding(value).model_config_id,
    value.model,
  );
}

/** The model binding the form would save, as the profile stores it. */
export function capabilityFormBinding(
  value: Pick<AgentCapabilityFormValue, 'modelConfigId' | 'model'>,
) {
  const modelConfigId =
    value.modelConfigId === 'inherit' ? null : value.modelConfigId;
  return {
    model_config_id: modelConfigId,
    model: modelConfigId ? value.model : null,
  };
}

export function sameCapabilityForm(
  a: AgentCapabilityFormValue,
  b: AgentCapabilityFormValue,
): boolean {
  return (
    JSON.stringify({
      ...capabilityFormBinding(a),
      ...capabilityFormPolicy(a),
    }) ===
    JSON.stringify({
      ...capabilityFormBinding(b),
      ...capabilityFormPolicy(b),
    })
  );
}

/**
 * What an Agent without its own binding follows: an ordinary Agent its
 * owner's main Agent, a user's main Agent the system's main HappyClaw. The
 * system main HappyClaw itself follows nothing (null).
 */
export type ModelFollow = 'owner_main' | 'system_main' | null;

function modelFollowFor(
  profile: Pick<AgentProfile, 'id' | 'is_default'>,
  inherited: InheritedModel | null,
): ModelFollow {
  if (!profile.is_default) return 'owner_main';
  return profile.id === inherited?.system_main_profile_id
    ? null
    : 'system_main';
}

/**
 * The connection and model a run of this binding uses: its own, else the one
 * it follows (a main Agent without a binding follows the system's). Null
 * when nothing is bound or the connection is gone.
 */
function resolveBinding(
  value: Pick<AgentCapabilityFormValue, 'modelConfigId' | 'model'>,
  configs: ModelConfigOption[],
  follow: ModelFollow,
  inherited: InheritedModel | null,
): { config: ModelConfigOption; model: string } | null {
  let binding: { configId: string; model: string | null } | null = null;
  if (value.modelConfigId !== 'inherit') {
    binding = { configId: value.modelConfigId, model: value.model };
  } else if (follow && inherited) {
    const followed =
      follow === 'owner_main'
        ? (inherited.owner_main ?? inherited.system_main)
        : inherited.system_main;
    if (followed) {
      binding = { configId: followed.model_config_id, model: followed.model };
    }
  }
  const config = configs.find((item) => item.id === binding?.configId);
  return config && binding
    ? { config, model: binding.model || config.model }
    : null;
}

const FOLLOWING = { modelConfigId: 'inherit', model: null } as const;

/** The option that follows another Agent, with what it currently runs. */
function followOptionLabel(
  follow: Exclude<ModelFollow, null>,
  configs: ModelConfigOption[],
  inherited: InheritedModel | null,
): string {
  const runs = resolveBinding(FOLLOWING, configs, follow, inherited);
  const name = follow === 'owner_main' ? '跟随主智能体' : '跟随主 HappyClaw';
  const label = runs
    ? [runs.config.name, runs.model].filter(Boolean).join(' · ')
    : '未设置';
  return `${name}（${label}）`;
}

/** The bound model with what it is known to take; null when unknown. */
function boundModelEntry(
  value: Pick<AgentCapabilityFormValue, 'modelConfigId' | 'model'>,
  configs: ModelConfigOption[],
  follow: ModelFollow,
  inherited: InheritedModel | null,
): ConnectionModel | null {
  const runs = resolveBinding(value, configs, follow, inherited);
  return runs?.config.models.find((item) => item.id === runs.model) ?? null;
}

/**
 * A binding change keeps the picked effort only if the new model takes it;
 * otherwise the Agent returns to the model's default. A model nothing is
 * known about keeps it, and the server decides.
 */
function keepSupportedEffort(
  effort: AgentEffortLevel,
  entry: ConnectionModel | null,
): AgentEffortLevel {
  if (effort === 'inherit' || !entry) return effort;
  return entry.efforts.includes(effort) ? effort : 'inherit';
}

export function AgentCapabilityForm({
  value,
  onChange,
  modelConfigs,
  inheritedModel,
  profile,
  hostAvailable,
  labelPrefix,
  modelConfigDescription,
}: {
  value: AgentCapabilityFormValue;
  onChange: (next: AgentCapabilityFormValue) => void;
  modelConfigs: ModelConfigOption[];
  /** What an Agent without a binding of its own follows. */
  inheritedModel: InheritedModel | null;
  /** The Agent edited: decides what it follows (see ModelFollow). */
  profile: Pick<AgentProfile, 'id' | 'is_default'>;
  /** Host Skills can only be granted by an admin. */
  hostAvailable: boolean;
  /** Names the controls, e.g. "智能体" or "主 HappyClaw ". */
  labelPrefix: string;
  modelConfigDescription: string;
}) {
  const follow = modelFollowFor(profile, inheritedModel);
  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);

  const skillOptions = useMemo(
    () => buildManagedSkillOptions(skills, value.skills.ids),
    [skills, value.skills.ids],
  );
  const hostSkillOptions = useMemo(
    () => buildHostSkillOptions(skills, value.hostSkills.ids),
    [skills, value.hostSkills.ids],
  );
  const mcpOptions = useMemo(
    () => buildMcpSelectionOptions(mcpServers, value.mcp.ids),
    [mcpServers, value.mcp.ids],
  );
  const errors = capabilityFormErrors(value);
  const update = (patch: Partial<AgentCapabilityFormValue>) =>
    onChange({ ...value, ...patch });
  // A new connection or model keeps only an effort that model takes.
  const rebind = (
    binding: Pick<AgentCapabilityFormValue, 'modelConfigId' | 'model'>,
  ) =>
    update({
      ...binding,
      // Sub-agent models belong to the connection; another one drops them.
      subagents:
        binding.modelConfigId === value.modelConfigId
          ? value.subagents
          : subagentPolicyWithoutModels(value.subagents),
      effort: keepSupportedEffort(
        value.effort,
        boundModelEntry(binding, modelConfigs, follow, inheritedModel),
      ),
    });
  const entry = boundModelEntry(value, modelConfigs, follow, inheritedModel);
  const efforts = entry?.efforts ?? [];
  // A saved level the model does not list stays visible as what is saved.
  const unsupportedEffort =
    value.effort !== 'inherit' && !efforts.includes(value.effort)
      ? value.effort
      : null;
  const unset = !follow && value.modelConfigId === 'inherit';
  // Only the Agent's own connection offers sub-agent models; a ChatGPT
  // subscription runs every sub-agent on the turn's model.
  const ownConnection = modelConfigs.find(
    (config) => config.id === value.modelConfigId,
  );
  const subagentModels =
    ownConnection && !ownConnection.chatgpt ? ownConnection.models : null;

  return (
    <div className="space-y-6">
      <SettingsGroup>
        <AgentControlRow
          label="模型连接"
          description={
            <>
              {modelConfigDescription}
              {unset && (
                <span className="mt-1 block text-warning">
                  还没有选择模型连接；选择一个连接，或先在 设置 → 模型
                  添加模型。
                </span>
              )}
            </>
          }
          control={
            <Select
              // '' shows 未设置 when there is nothing to follow.
              value={unset ? '' : value.modelConfigId}
              // A model belongs to its connection.
              onValueChange={(next) =>
                rebind({ modelConfigId: next, model: null })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix}模型连接`}
                className="w-full"
              >
                <SelectValue placeholder={follow ? '选择模型连接' : '未设置'} />
              </SelectTrigger>
              <SelectContent>
                {follow && (
                  <SelectItem value="inherit">
                    {followOptionLabel(follow, modelConfigs, inheritedModel)}
                  </SelectItem>
                )}
                {modelConfigs.map((config) => (
                  <SelectItem key={config.id} value={config.id}>
                    {config.name}
                    {config.model ? ` · ${config.model}` : ''}
                    {config.usable === false ? '（缺少凭据）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <AgentControlRow
          label="模型"
          description="在所选连接里选择模型；连接默认是添加连接时的首个模型。跟随其他智能体时随它的选择。"
          control={
            <AgentModelSelect
              configs={modelConfigs}
              configId={value.modelConfigId}
              value={value.model}
              onChange={(model) =>
                rebind({ modelConfigId: value.modelConfigId, model })
              }
              ariaLabel={`${labelPrefix}模型`}
              className="w-full"
            />
          }
        />
        <AgentControlRow
          label="推理等级"
          description="模型默认使用该模型自己的默认等级；只列出所选模型支持的等级。"
          control={
            <Select
              value={value.effort}
              onValueChange={(next) =>
                update({ effort: next as AgentEffortLevel })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix}推理等级`}
                className="w-full"
              >
                <SelectValue placeholder="选择推理等级" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">
                  {entry?.defaultEffort
                    ? `模型默认（${effortLabel(entry.defaultEffort)}）`
                    : '模型默认'}
                </SelectItem>
                {unsupportedEffort && (
                  <SelectItem value={unsupportedEffort}>
                    {effortLabel(unsupportedEffort)}
                    {entry ? '（当前模型不支持）' : ''}
                  </SelectItem>
                )}
                {efforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {effortLabel(effort)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup>
        <div className="px-4 py-4">
          <AgentSkillsPolicyEditor
            managedPolicy={value.skills}
            onManagedModeChange={(mode) =>
              update({ skills: { ...value.skills, mode } })
            }
            onManagedIdsChange={(ids) =>
              update({ skills: { ...value.skills, ids } })
            }
            managedOptions={skillOptions}
            hostPolicy={value.hostSkills}
            onHostModeChange={(mode) =>
              update({
                hostSkills: hostSkillPolicyForMode(mode, value.hostSkills.ids),
              })
            }
            onHostIdsChange={(ids) =>
              update({
                hostSkills: hostSkillPolicyForMode(value.hostSkills.mode, ids),
              })
            }
            hostOptions={hostSkillOptions}
            loading={skillsLoading}
            error={skillsError}
            hostAvailable={hostAvailable}
            managedError={errors.managed}
            hostError={errors.host}
          />
        </div>

        <section className="min-w-0 space-y-3 px-4 py-4">
          <AgentSubheading
            title="HappyClaw MCP"
            description="控制 HappyClaw 额外附加的 MCP；宿主机 MCP 随宿主机 Claude Code 配置加载。"
          />
          <div className="max-w-xl space-y-3">
            <Select
              value={value.mcp.mode}
              onValueChange={(mode) =>
                update({
                  mcp: { ...value.mcp, mode: mode as RuntimePolicyMode },
                })
              }
            >
              <SelectTrigger
                aria-label={`${labelPrefix} MCP`}
                className="w-full max-w-72"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">使用全部 HappyClaw MCP</SelectItem>
                <SelectItem value="custom">只允许所选 HappyClaw MCP</SelectItem>
                <SelectItem value="disabled">关闭 HappyClaw MCP</SelectItem>
              </SelectContent>
            </Select>
            {value.mcp.mode === 'custom' && (
              <PolicyResourcePicker
                label="选择 HappyClaw MCP"
                options={mcpOptions}
                selectedIds={value.mcp.ids}
                onChange={(ids) => update({ mcp: { ...value.mcp, ids } })}
                loading={mcpLoading}
                error={mcpError}
                emptyText="没有已启用的 HappyClaw MCP"
              />
            )}
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup>
        <AgentSubagentsEditor
          value={value.subagents}
          onChange={(subagents) => update({ subagents })}
          connectionModels={subagentModels}
          labelPrefix={labelPrefix}
        />
      </SettingsGroup>
    </div>
  );
}
