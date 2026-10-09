import { Check, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  AgentSubheading,
  ChoiceCardBody,
  choiceCardClassName,
} from './AgentSection';
import {
  PolicyResourcePicker,
  type PolicyResourceOption,
} from './PolicyResourcePicker';
import type {
  RuntimePolicyMode,
  SkillSourcePolicy,
} from '@/utils/agent-runtime-policy';

interface AgentSkillsPolicyEditorProps {
  managedPolicy: SkillSourcePolicy;
  onManagedModeChange: (mode: RuntimePolicyMode) => void;
  onManagedIdsChange: (ids: string[]) => void;
  managedOptions: PolicyResourceOption[];
  hostPolicy: SkillSourcePolicy;
  onHostModeChange: (mode: RuntimePolicyMode) => void;
  onHostIdsChange: (ids: string[]) => void;
  hostOptions: PolicyResourceOption[];
  loading?: boolean;
  error?: string | null;
  hostAvailable: boolean;
  hostAutoSave?: boolean;
  hostSaving?: boolean;
  hostSaveStatus?: HostSkillSaveStatus;
  onRetryHostSave?: () => void;
  managedError?: string | null;
  hostError?: string | null;
}

export type HostSkillSaveStatus =
  | 'idle'
  | 'saved'
  | 'error'
  | 'warning'
  | 'uncertain';

export function AgentSkillsPolicyEditor({
  managedPolicy,
  onManagedModeChange,
  onManagedIdsChange,
  managedOptions,
  hostPolicy,
  onHostModeChange,
  onHostIdsChange,
  hostOptions,
  loading,
  error,
  hostAvailable,
  hostAutoSave = false,
  hostSaving,
  hostSaveStatus = 'idle',
  onRetryHostSave,
  managedError,
  hostError,
}: AgentSkillsPolicyEditorProps) {
  return (
    <div className="space-y-5">
      <SkillSourceSection
        title="HappyClaw Skills"
        description="控制 HappyClaw 为这个智能体附加的用户级 Skills；系统内置 Skills 始终生效。"
      >
        <PolicyModeCards
          label="HappyClaw Skills 使用方式"
          value={managedPolicy.mode}
          onChange={onManagedModeChange}
          options={[
            {
              value: 'inherit',
              label: '全部已启用',
              description: '自动使用当前已启用的全部用户 Skills。',
            },
            {
              value: 'custom',
              label: '选择部分',
              description: '只允许明确选择的用户 Skills。',
            },
            {
              value: 'disabled',
              label: '不使用',
              description: '不加载用户级 Skills。',
            },
          ]}
        />
        {managedPolicy.mode === 'custom' && (
          <PolicyResourcePicker
            label="选择 HappyClaw Skills"
            options={managedOptions}
            selectedIds={managedPolicy.ids}
            onChange={onManagedIdsChange}
            loading={loading}
            error={error}
            emptyText="没有已启用的用户 Skill"
          />
        )}
        {managedError && <InlineError message={managedError} />}
      </SkillSourceSection>

      <SkillSourceSection
        title="宿主机 Skills"
        description="来自 ~/.claude/skills，可单独启用；不会同时加载宿主机 CLAUDE.md 或 Rules。"
        badge="管理员"
      >
        {hostAvailable ? (
          <>
            <PolicyModeCards
              label="宿主机 Skills 使用方式"
              value={hostPolicy.mode}
              onChange={onHostModeChange}
              disabled={hostSaving}
              options={[
                {
                  value: 'disabled',
                  label: '不使用',
                  description: '这个智能体不加载宿主机 Skill。',
                },
                {
                  value: 'custom',
                  label: '选择部分',
                  description: '只加载明确选择的宿主机 Skills。',
                  recommended: true,
                },
                {
                  value: 'inherit',
                  label: '全部使用',
                  description: '当前及以后新增的宿主机 Skills 都会自动生效。',
                },
              ]}
            />
            {hostPolicy.mode === 'custom' && (
              <PolicyResourcePicker
                label="选择宿主机 Skills"
                options={hostOptions}
                selectedIds={hostPolicy.ids}
                onChange={onHostIdsChange}
                loading={loading}
                error={error}
                disabled={hostSaving}
                emptyText="未在 ~/.claude/skills 检测到有效 Skill"
              />
            )}
            {hostError && <InlineError message={hostError} />}
            {!hostError && (
              <p
                aria-live="polite"
                className={cn(
                  'flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption',
                  hostSaveStatus === 'error'
                    ? 'text-error'
                    : hostSaveStatus === 'warning' ||
                        hostSaveStatus === 'uncertain'
                      ? 'text-warning'
                      : hostSaveStatus === 'saved'
                        ? 'text-success'
                        : 'text-muted-foreground',
                )}
              >
                {hostSaving ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    正在保存并应用宿主机 Skills…
                  </>
                ) : hostSaveStatus === 'saved' ? (
                  <>
                    <Check className="size-3.5" />
                    已保存并生效；新会话会使用这项策略。
                  </>
                ) : hostSaveStatus === 'error' ? (
                  <>
                    保存失败，当前选择尚未生效。
                    {onRetryHostSave && (
                      <button
                        type="button"
                        className="font-medium underline underline-offset-2 hover:text-foreground"
                        onClick={onRetryHostSave}
                      >
                        重试保存
                      </button>
                    )}
                  </>
                ) : hostSaveStatus === 'warning' ? (
                  <>
                    配置已保存，但工作区运行时清理未完成。
                    {onRetryHostSave && (
                      <button
                        type="button"
                        className="font-medium underline underline-offset-2 hover:text-foreground"
                        onClick={onRetryHostSave}
                      >
                        重试清理
                      </button>
                    )}
                  </>
                ) : hostSaveStatus === 'uncertain' ? (
                  <>
                    连接中断，暂时无法确认服务端状态。
                    {onRetryHostSave && (
                      <button
                        type="button"
                        className="font-medium underline underline-offset-2 hover:text-foreground"
                        onClick={onRetryHostSave}
                      >
                        重新确认并应用
                      </button>
                    )}
                  </>
                ) : hostAutoSave ? (
                  '修改后会自动保存；“全部使用”也会自动包含以后新增的宿主机 Skills。'
                ) : (
                  '修改后需保存或创建智能体才会生效。'
                )}
              </p>
            )}
          </>
        ) : (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-caption leading-5 text-muted-foreground">
            只有管理员可以查看和授权宿主机 Skills。
          </p>
        )}
      </SkillSourceSection>

      <SkillSourceSection
        title="工作区 Skills"
        description="随实际运行的工作区自动加载，不能在智能体级别固定选择。创建后可在“最终生效能力”中按工作区预览。"
        badge="自动"
      />
    </div>
  );
}

function SkillSourceSection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-surface-border pt-5 first:border-t-0 first:pt-0">
      <AgentSubheading
        title={title}
        description={description}
        badge={badge && <Badge variant="neutral">{badge}</Badge>}
      />
      {children}
    </section>
  );
}

export function PolicyModeCards({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: RuntimePolicyMode;
  onChange: (mode: RuntimePolicyMode) => void;
  disabled?: boolean;
  options: Array<{
    value: RuntimePolicyMode;
    label: string;
    description: string;
    recommended?: boolean;
  }>;
}) {
  return (
    <div
      className="grid gap-2 md:grid-cols-3"
      role="radiogroup"
      aria-label={label}
      aria-busy={disabled}
    >
      {options.map((option, index) => {
        const checked = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const direction =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0;
              if (direction === 0) return;
              event.preventDefault();
              const nextIndex =
                (index + direction + options.length) % options.length;
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]',
                );
              buttons?.[nextIndex]?.focus();
              onChange(options[nextIndex]!.value);
            }}
            className={choiceCardClassName(
              checked,
              'disabled:cursor-wait disabled:opacity-60',
            )}
          >
            <ChoiceCardBody
              checked={checked}
              title={option.label}
              description={option.description}
              badge={
                option.recommended && <Badge variant="neutral">推荐</Badge>
              }
            />
          </button>
        );
      })}
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-caption text-error">
      {message}
    </p>
  );
}
