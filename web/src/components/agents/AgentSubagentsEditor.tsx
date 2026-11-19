import { useEffect, useState, type FormEvent } from 'react';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { SettingsField } from '@/components/settings/SettingsLayout';
import { selectableEfforts } from '@/components/settings/AgentModelSelect';
import { effortLabel } from '@/components/settings/model-connections';
import { confirmDialog } from '@/stores/confirm';
import type {
  AgentSubagentDefinition,
  AgentSubagentPolicy,
  ConnectionModel,
  SubagentEffortLevel,
} from '@/types';
import { AgentControlRow, AgentSubheading } from './AgentSection';

const NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
const RESERVED = new Set([
  'general-purpose',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
  'explore',
  'plan',
  'fork',
]);
const MAX_DEFINITIONS = 20;
const CONCURRENCY_CHOICES = [1, 2, 3, 5, 8, 10, 15, 20];
const EFFORTS: SubagentEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
/** As the server checks a tool rule (SUBAGENT_TOOL_RE in agent-subagents.ts). */
const TOOL_RE = /^[A-Za-z][\w.*-]*(?:\([^,\r\n\0]*\))?$/;
const MAX_TOOL_CHARS = 200;
/** Select items cannot hold '' or null. */
const INHERIT = '__inherit__';

/**
 * The tool rules typed into the field: one per line or comma-separated, so a
 * rule with an argument such as `Bash(git log:*)` keeps its spaces.
 */
export function parseSubagentTools(text: string): string[] {
  const tools = text
    .split(/[,，\r\n]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
  return [...new Set(tools)];
}

/** A typed tool rule the server would refuse, or null. */
export function invalidSubagentTool(tools: string[]): string | null {
  return (
    tools.find((tool) => tool.length > MAX_TOOL_CHARS || !TOOL_RE.test(tool)) ??
    null
  );
}

/**
 * The levels a sub-agent may pick on the model it runs: what the model
 * takes, every level for a model nothing is known about (`unverified`,
 * sent as picked), and every level while it follows a model this form
 * cannot name (the server sends only what that model takes).
 */
export function subagentEffortChoices(model: ConnectionModel | undefined): {
  efforts: SubagentEffortLevel[];
  unverified: boolean;
} {
  if (!model) return { efforts: EFFORTS, unverified: false };
  const { efforts, unverified } = selectableEfforts(model);
  return {
    efforts: EFFORTS.filter((effort) => efforts.includes(effort)),
    unverified,
  };
}

const EMPTY_POLICY: AgentSubagentPolicy = {
  model: null,
  max_concurrent: null,
  definitions: [],
};

/** null when nothing is set, as the server stores it. */
export function compactSubagentPolicy(
  policy: AgentSubagentPolicy,
): AgentSubagentPolicy | null {
  return policy.model === null &&
    policy.max_concurrent === null &&
    policy.definitions.length === 0
    ? null
    : policy;
}

/**
 * The policy once the Agent moves to another connection: its model names
 * belonged to the old one, so they go back to following.
 */
export function subagentPolicyWithoutModels(
  policy: AgentSubagentPolicy | null,
): AgentSubagentPolicy | null {
  if (!policy) return null;
  return compactSubagentPolicy({
    ...policy,
    model: null,
    definitions: policy.definitions.map((item) => ({ ...item, model: null })),
  });
}

/**
 * Sub-agents of an Agent: the default sub-agent model and each defined
 * sub-agent's model come from the Agent's own connection, because a
 * sub-agent runs in the same Claude Code process, on the same endpoint.
 */
export function AgentSubagentsEditor({
  value,
  onChange,
  connectionModels,
  labelPrefix,
}: {
  value: AgentSubagentPolicy | null;
  onChange: (next: AgentSubagentPolicy | null) => void;
  /**
   * Models of the Agent's own connection; null when the Agent follows
   * another one or is on a ChatGPT subscription (no model choice).
   */
  connectionModels: ConnectionModel[] | null;
  labelPrefix: string;
}) {
  const policy = value ?? EMPTY_POLICY;
  const [editing, setEditing] = useState<{
    index: number | null;
    definition: AgentSubagentDefinition;
  } | null>(null);
  const update = (patch: Partial<AgentSubagentPolicy>) =>
    onChange(compactSubagentPolicy({ ...policy, ...patch }));

  const remove = async (index: number) => {
    const target = policy.definitions[index];
    const confirmed = await confirmDialog({
      title: '删除子代理',
      message: `删除子代理「${target.name}」？保存后生效。`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    update({
      definitions: policy.definitions.filter((_, i) => i !== index),
    });
  };

  const save = (definition: AgentSubagentDefinition) => {
    const definitions = [...policy.definitions];
    if (editing?.index === null || editing?.index === undefined) {
      definitions.push(definition);
    } else {
      definitions[editing.index] = definition;
    }
    update({ definitions });
    setEditing(null);
  };

  return (
    <section className="min-w-0 space-y-3">
      <div className="px-4 pt-4">
        <AgentSubheading
          title="子代理"
          description="主 Agent 用 Agent 工具派出的子代理。子代理和主 Agent 在同一个进程里运行，只能使用本智能体所选连接里的模型。"
        />
      </div>
      <AgentControlRow
        label="默认子代理模型"
        description={
          connectionModels
            ? '内置子代理和没有指定模型的自定义子代理使用它；跟随连接时由连接的「后台与子代理」设置决定。'
            : '为本智能体选择自己的模型连接（ChatGPT 订阅除外）后可单独指定。'
        }
        control={
          <ModelSelect
            ariaLabel={`${labelPrefix}默认子代理模型`}
            value={policy.model}
            models={connectionModels}
            inheritLabel="跟随连接设置"
            onChange={(model) => update({ model })}
          />
        }
      />
      <AgentControlRow
        label="同时运行上限"
        description="最多同时运行的子代理数。达到上限后，Claude Code 会拒绝再派出新的子代理。"
        control={
          <Select
            value={
              policy.max_concurrent === null
                ? INHERIT
                : String(policy.max_concurrent)
            }
            onValueChange={(next) =>
              update({
                max_concurrent: next === INHERIT ? null : Number(next),
              })
            }
          >
            <SelectTrigger
              aria-label={`${labelPrefix}子代理同时运行上限`}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                不设置（使用 Claude Code 默认）
              </SelectItem>
              {CONCURRENCY_CHOICES.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {count} 个
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="space-y-2 px-4 pb-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-label font-medium">自定义子代理</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={policy.definitions.length >= MAX_DEFINITIONS}
            onClick={() =>
              setEditing({
                index: null,
                definition: {
                  name: '',
                  description: '',
                  prompt: '',
                  tools: null,
                  model: null,
                  effort: null,
                },
              })
            }
          >
            <Plus />
            添加子代理
          </Button>
        </div>
        {policy.definitions.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            还没有自定义子代理。主 Agent 按每个子代理的「何时使用」决定派给谁。
          </p>
        ) : (
          <ListGroup>
            {policy.definitions.map((definition, index) => (
              <ListRow
                key={definition.name}
                media={<Bot className="size-4 text-muted-foreground" />}
                title={definition.name}
                description={definition.description}
                meta={[
                  definition.model ?? '默认模型',
                  definition.effort ? effortLabel(definition.effort) : null,
                  definition.tools
                    ? `${definition.tools.length} 个工具`
                    : '全部工具',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                actions={
                  <>
                    <IconButton
                      label={`编辑子代理 ${definition.name}`}
                      icon={<Pencil />}
                      onClick={() => setEditing({ index, definition })}
                    />
                    <IconButton
                      label={`删除子代理 ${definition.name}`}
                      icon={<Trash2 />}
                      onClick={() => void remove(index)}
                      className="text-muted-foreground hover:text-error"
                    />
                  </>
                }
              />
            ))}
          </ListGroup>
        )}
      </div>
      <SubagentDialog
        editing={editing}
        takenNames={policy.definitions
          .filter((_, i) => i !== editing?.index)
          .map((item) => item.name)}
        connectionModels={connectionModels}
        defaultModel={policy.model}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    </section>
  );
}

function ModelSelect({
  ariaLabel,
  value,
  models,
  inheritLabel,
  onChange,
}: {
  ariaLabel: string;
  value: string | null;
  models: ConnectionModel[] | null;
  inheritLabel: string;
  onChange: (model: string | null) => void;
}) {
  const known = !value || models?.some((item) => item.id === value);
  return (
    <Select
      value={value ?? INHERIT}
      disabled={!models}
      onValueChange={(next) => onChange(next === INHERIT ? null : next)}
    >
      <SelectTrigger aria-label={ariaLabel} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
        {!known && value && (
          <SelectItem value={value}>{value}（连接里已没有）</SelectItem>
        )}
        {models?.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function definitionError(
  definition: AgentSubagentDefinition,
  takenNames: string[],
): string | null {
  if (!NAME_RE.test(definition.name)) {
    return '名称须为 2-48 位小写字母、数字或连字符，以字母开头';
  }
  if (RESERVED.has(definition.name)) return '名称与内置子代理重名';
  if (takenNames.includes(definition.name)) return '已有同名子代理';
  if (!definition.description.trim()) return '请填写何时使用';
  if (!definition.prompt.trim()) return '请填写提示词';
  const tool = invalidSubagentTool(definition.tools ?? []);
  if (tool) {
    return `工具「${tool}」格式不对：应为工具名，可带括号里的参数，如 Bash(git log:*)`;
  }
  return null;
}

function SubagentDialog({
  editing,
  takenNames,
  connectionModels,
  defaultModel,
  onCancel,
  onSave,
}: {
  editing: { index: number | null; definition: AgentSubagentDefinition } | null;
  takenNames: string[];
  connectionModels: ConnectionModel[] | null;
  /** The Agent's default sub-agent model, which a definition without one runs. */
  defaultModel: string | null;
  onCancel: () => void;
  onSave: (definition: AgentSubagentDefinition) => void;
}) {
  const [draft, setDraft] = useState<AgentSubagentDefinition | null>(null);
  const [toolsText, setToolsText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(editing.definition);
    setToolsText(editing.definition.tools?.join('\n') ?? '');
    setError(null);
  }, [editing]);

  const set = (patch: Partial<AgentSubagentDefinition>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const runsOn = connectionModels?.find(
    (item) => item.id === (draft?.model ?? defaultModel),
  );
  const { efforts, unverified } = subagentEffortChoices(runsOn);
  const takesNone =
    runsOn?.effortsSource === 'declared' && runsOn.efforts.length === 0;
  // A saved level the model does not list stays visible as what is saved.
  const unlistedEffort =
    draft?.effort && !efforts.includes(draft.effort) ? draft.effort : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const tools = parseSubagentTools(toolsText);
    const next: AgentSubagentDefinition = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt.trim(),
      tools: tools.length > 0 ? tools : null,
    };
    const invalid = definitionError(next, takenNames);
    if (invalid) {
      setError(invalid);
      return;
    }
    onSave(next);
  };

  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        {draft && (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {editing?.index === null ? '添加子代理' : '编辑子代理'}
              </DialogTitle>
              <DialogDescription>
                保存智能体后生效；正在运行的会话会在本轮结束后换用新配置。
              </DialogDescription>
            </DialogHeader>
            {error && (
              <div
                role="alert"
                className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
              >
                {error}
              </div>
            )}
            <SettingsField
              label="名称"
              htmlFor="subagent-name"
              description="主 Agent 调用时用的名字，例如 code-reviewer"
            >
              <Input
                id="subagent-name"
                variant="code"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
                placeholder="code-reviewer"
              />
            </SettingsField>
            <SettingsField
              label="何时使用"
              htmlFor="subagent-description"
              description="写给主 Agent 看：什么样的任务该派给它"
            >
              <Textarea
                id="subagent-description"
                rows={2}
                value={draft.description}
                onChange={(e) => set({ description: e.target.value })}
              />
            </SettingsField>
            <SettingsField label="提示词" htmlFor="subagent-prompt">
              <Textarea
                id="subagent-prompt"
                rows={6}
                value={draft.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
              />
            </SettingsField>
            <SettingsField
              label="可用工具"
              htmlFor="subagent-tools"
              description="每行一个，或用逗号分隔，例如 Read、Grep、Bash(git log:*)；留空表示和主 Agent 一样"
            >
              <Textarea
                id="subagent-tools"
                variant="code"
                rows={3}
                value={toolsText}
                onChange={(e) => setToolsText(e.target.value)}
                placeholder="全部工具"
              />
            </SettingsField>
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingsField label="模型" htmlFor="subagent-model">
                <ModelSelect
                  ariaLabel="子代理模型"
                  value={draft.model}
                  models={connectionModels}
                  inheritLabel="默认子代理模型"
                  onChange={(model) => set({ model })}
                />
              </SettingsField>
              <SettingsField
                label="推理等级"
                htmlFor="subagent-effort"
                description={
                  takesNone
                    ? '这个模型不支持推理等级。'
                    : unverified
                      ? '未验证：没有这个模型的资料，所选等级原样下发。'
                      : '模型不支持所选等级时不下发'
                }
              >
                <Select
                  value={draft.effort ?? INHERIT}
                  onValueChange={(next) =>
                    set({
                      effort:
                        next === INHERIT ? null : (next as SubagentEffortLevel),
                    })
                  }
                >
                  <SelectTrigger aria-label="子代理推理等级" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>模型默认</SelectItem>
                    {unlistedEffort && (
                      <SelectItem value={unlistedEffort}>
                        {effortLabel(unlistedEffort)}（该模型不支持）
                      </SelectItem>
                    )}
                    {efforts.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {unverified
                          ? `${effortLabel(effort)}（未验证）`
                          : effortLabel(effort)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                取消
              </Button>
              <Button type="submit">确定</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
