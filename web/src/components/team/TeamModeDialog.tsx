import { useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Callout } from '@/components/capabilities/capability-ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsLayout';
import {
  ACCEPT_MODE_OPTIONS,
  ADMISSION_LABELS,
  ADMISSION_ROWS,
  TEAM_RULE_NAME_LIMIT,
  teamSettingsProblem,
  toSettingsDraft,
  type TeamMountView,
  type TeamSettingsDraft,
} from '../../lib/team-mode';
import { confirmDialog } from '../../stores/confirm';
import { fetchTeamMounts, saveTeamMount } from '../../stores/work-items';
import { extractErrorMessage } from '../../utils/error';
import { randomUuid } from '../../utils/random-uuid';
import {
  TEAM_RULE_LIMIT,
  TEAM_RULE_TEXT_LIMIT,
  type AdmissionOutcome,
  type TeamRule,
} from '../../work-items';

/** Mount it to open it; `onClose` unmounts it. */
interface TeamModeDialogProps {
  workspaceJid: string;
  channelJid: string;
  /** Shown until the mount loads. */
  channelName?: string;
  onClose: () => void;
}

/**
 * 团队模式 for one group binding: on/off, who counts (the admission table),
 * how candidates are taken (接单方式) and the proactive rules. On a phone the
 * Dialog is a bottom sheet.
 */
export function TeamModeDialog({
  workspaceJid,
  channelJid,
  channelName,
  onClose,
}: TeamModeDialogProps) {
  const [mount, setMount] = useState<TeamMountView | null>(null);
  const [draft, setDraft] = useState<TeamSettingsDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTeamMounts(workspaceJid)
      .then((mounts) => {
        if (cancelled) return;
        const found = mounts.find((item) => item.channelJid === channelJid);
        if (!found) {
          setLoadError('这个群不在该工作区的绑定里。');
          return;
        }
        setMount(found);
        setDraft(toSettingsDraft(found.settings));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(extractErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceJid, channelJid]);

  const dirty = useMemo(
    () =>
      !!mount &&
      !!draft &&
      JSON.stringify(draft) !== JSON.stringify(toSettingsDraft(mount.settings)),
    [mount, draft],
  );
  const problem = draft ? teamSettingsProblem(draft) : null;

  const close = async () => {
    if (
      dirty &&
      !(await confirmDialog({
        title: '放弃未保存的修改？',
        message: '团队模式的设置还没有保存。',
        confirmText: '放弃修改',
        variant: 'danger',
      }))
    )
      return;
    onClose();
  };

  const save = async () => {
    if (!mount || !draft || problem) return;
    if (
      mount.settings.enabled &&
      !draft.enabled &&
      !(await confirmDialog({
        title: '关闭团队模式？',
        message:
          '群里的新消息不再分派给工作项，回到普通绑定的处理方式。已有的工作项保留在「工作项」页面。',
        confirmText: '关闭团队模式',
        variant: 'danger',
      }))
    )
      return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveTeamMount(workspaceJid, channelJid, draft);
      toast.success('团队模式已保存');
      onClose();
    } catch (err) {
      setSaveError(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const name = mount?.channelName || channelName || '群聊';
  const editable = !!mount?.eligible;

  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) void close();
      }}
    >
      <DialogContent className="flex max-h-[min(52rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-xl phone:not-has-[>[data-slot=dialog-footer]]:pb-0">
        <DialogHeader className="border-b border-surface-border px-5 pt-5 pb-4">
          <DialogTitle>团队模式</DialogTitle>
          <DialogDescription>
            「{name}」里的请求按工作项分头处理，只有机器人在群里说话。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {loadError ? (
            <Callout tone="error" role="alert">
              {loadError}
            </Callout>
          ) : !mount || !draft ? (
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在加载…
            </p>
          ) : (
            <TeamSettingsForm
              draft={draft}
              disabled={!editable || saving}
              ineligibleReason={
                editable
                  ? null
                  : mount.ineligibleReason || '这个群暂不能开启团队模式。'
              }
              onChange={setDraft}
            />
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-surface-border px-5 py-3 sm:flex-row sm:items-center phone:pb-[calc(0.75rem+var(--safe-bottom))]">
          <div className="min-w-0 flex-1" aria-live="polite">
            {(saveError || (dirty && problem)) && (
              <p role="alert" className="text-caption text-error">
                {saveError || problem}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void close()}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={!editable || !dirty || !!problem || saving}
              onClick={() => void save()}
            >
              {saving && <Loader2 className="animate-spin" />}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TeamSettingsForm({
  draft,
  disabled,
  ineligibleReason,
  onChange,
}: {
  draft: TeamSettingsDraft;
  disabled: boolean;
  ineligibleReason: string | null;
  onChange: (draft: TeamSettingsDraft) => void;
}) {
  const switchId = useId();
  const patch = (next: Partial<TeamSettingsDraft>) =>
    onChange({ ...draft, ...next });
  const setRule = (id: string, next: Partial<TeamRule>) =>
    patch({
      rules: draft.rules.map((rule) =>
        rule.id === id ? { ...rule, ...next } : rule,
      ),
    });
  const addRule = () =>
    patch({
      rules: [
        ...draft.rules,
        { id: randomUuid(), name: '', instruction: '', enabled: true },
      ],
    });
  const removeRule = async (rule: TeamRule) => {
    if (
      (rule.name.trim() || rule.instruction.trim()) &&
      !(await confirmDialog({
        title: `删除规则「${rule.name || '未命名'}」？`,
        message: '保存后，机器人不再按这条规则主动接单。',
        confirmText: '删除规则',
        variant: 'danger',
      }))
    )
      return;
    patch({ rules: draft.rules.filter((item) => item.id !== rule.id) });
  };
  const acceptMode = ACCEPT_MODE_OPTIONS.find(
    (option) => option.value === draft.acceptMode,
  );
  const enabledRules = draft.rules.filter((rule) => rule.enabled).length;

  return (
    <>
      {ineligibleReason && (
        <Callout tone="warning" role="status">
          {ineligibleReason}
        </Callout>
      )}

      <SettingsGroup>
        <SettingsRow
          inline
          label="开启团队模式"
          description="关闭时这个群和普通绑定完全一样。"
          htmlFor={switchId}
          control={
            <Switch
              id={switchId}
              checked={draft.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => patch({ enabled })}
            />
          }
        />
      </SettingsGroup>

      <SettingsSection
        title="准入表：谁说的话算数"
        description="名单 = 主人 + 群白名单（/allow）。名单内的人 @ 机器人总是算请求。「只作候选」交给机器人按主动规则判断；名单外的人发起的请求只读，你批准后才能修改。"
      >
        <SettingsGroup>
          <SettingsRow
            label="名单内、@ 了"
            control={
              <span className="text-label text-muted-foreground">
                {ADMISSION_LABELS.explicit}（固定）
              </span>
            }
          />
          {ADMISSION_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              label={row.label}
              control={
                <SegmentedControl<AdmissionOutcome>
                  label={row.label}
                  size="sm"
                  disabled={disabled}
                  value={draft.admission[row.key]}
                  options={row.options.map((value) => ({
                    value,
                    label: ADMISSION_LABELS[value],
                  }))}
                  onChange={(value) =>
                    patch({
                      admission: { ...draft.admission, [row.key]: value },
                    })
                  }
                />
              }
            />
          ))}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="接单方式" description={acceptMode?.description}>
        <SegmentedControl
          label="接单方式"
          disabled={disabled}
          value={draft.acceptMode}
          options={ACCEPT_MODE_OPTIONS.map(({ value, label }) => ({
            value,
            label,
          }))}
          onChange={(acceptMode) => patch({ acceptMode })}
        />
        {draft.acceptMode !== 'off' && enabledRules === 0 && (
          <p className="text-caption text-warning">
            还没有启用的主动规则，候选都会被忽略。
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={`主动规则 · ${draft.rules.length}/${TEAM_RULE_LIMIT}`}
        description="用一句话写清什么情况下可以主动接手，例如「有人贴线上报错时先排查原因」。"
      >
        {draft.rules.length > 0 && (
          <SettingsGroup>
            <AnimatePresence initial={false}>
              {draft.rules.map((rule, index) => (
                <m.div
                  key={rule.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <RuleEditor
                    rule={rule}
                    index={index}
                    disabled={disabled}
                    onChange={(next) => setRule(rule.id, next)}
                    onRemove={() => void removeRule(rule)}
                  />
                </m.div>
              ))}
            </AnimatePresence>
          </SettingsGroup>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || draft.rules.length >= TEAM_RULE_LIMIT}
          onClick={addRule}
        >
          <Plus />
          添加规则
        </Button>
      </SettingsSection>
    </>
  );
}

function RuleEditor({
  rule,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  rule: TeamRule;
  index: number;
  disabled: boolean;
  onChange: (next: Partial<TeamRule>) => void;
  onRemove: () => void;
}) {
  const nameId = useId();
  const textId = useId();
  const label = rule.name.trim() || `规则 ${index + 1}`;
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <label htmlFor={nameId} className="sr-only">
          规则名称
        </label>
        <Input
          id={nameId}
          value={rule.name}
          maxLength={TEAM_RULE_NAME_LIMIT}
          placeholder="规则名称"
          disabled={disabled}
          onChange={(event) => onChange({ name: event.target.value })}
          className="min-w-0 flex-1"
        />
        <Switch
          aria-label={`启用「${label}」`}
          checked={rule.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        <IconButton
          label={`删除「${label}」`}
          icon={<Trash2 />}
          disabled={disabled}
          onClick={onRemove}
          className="text-muted-foreground hover:text-error"
        />
      </div>
      <label htmlFor={textId} className="sr-only">
        规则说明
      </label>
      <Textarea
        id={textId}
        value={rule.instruction}
        rows={3}
        maxLength={TEAM_RULE_TEXT_LIMIT}
        placeholder="什么情况下可以主动接手，接手后做到哪一步。"
        disabled={disabled}
        onChange={(event) => onChange({ instruction: event.target.value })}
      />
      <p className="text-right text-micro text-faint-foreground tabular-nums">
        {rule.instruction.length}/{TEAM_RULE_TEXT_LIMIT}
      </p>
    </div>
  );
}
