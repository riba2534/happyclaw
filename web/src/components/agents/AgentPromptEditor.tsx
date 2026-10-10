import { useMemo, useState } from 'react';
import { Eye, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import { confirmDialog } from '@/stores/confirm';
import {
  AGENT_PROMPT_SECTIONS,
  DEFAULT_AGENT_PROMPTS,
  composeAgentPrompt,
  estimatePromptTokens,
  totalPromptStats,
  type AgentPromptMode,
  type AgentPromptParts,
  type AgentPromptSection,
} from '@/utils/agent-prompts';
import {
  AgentSection,
  ChoiceCardBody,
  choiceCardClassName,
} from './AgentSection';

interface AgentPromptEditorProps {
  value: AgentPromptParts;
  mode: AgentPromptMode;
  onChange: (value: AgentPromptParts) => void;
  onModeChange: (mode: AgentPromptMode) => void;
  onOpenAssistant?: (section: AgentPromptSection) => void;
}

export function AgentPromptEditor({
  value,
  mode,
  onChange,
  onModeChange,
  onOpenAssistant,
}: AgentPromptEditorProps) {
  const [activeSection, setActiveSection] =
    useState<AgentPromptSection>('identity');
  const [previewOpen, setPreviewOpen] = useState(false);
  const stats = useMemo(() => totalPromptStats(value), [value]);
  const composed = useMemo(() => composeAgentPrompt(value), [value]);

  const handleFillTemplate = async () => {
    if (
      stats.completedSections > 0 &&
      !(await confirmDialog({
        title: '填入推荐模板',
        message: '用推荐模板替换当前四段提示词？',
        confirmText: '替换',
        variant: 'danger',
      }))
    )
      return;
    onChange(DEFAULT_AGENT_PROMPTS);
  };

  return (
    <AgentSection
      className="scroll-mt-20"
      title="提示词"
      description="分别定义智能体的身份、人格、行为与工具规则，运行时按固定顺序组合。"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleFillTemplate()}
          >
            <Sparkles />
            一键填入推荐模板
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye />
            查看最终提示词
          </Button>
        </>
      }
    >
      <SettingsGroup>
        <div className="px-4 py-3">
          <div
            id="agent-prompt-mode-label"
            className="mb-2 text-label text-foreground"
          >
            Claude Code 默认提示词
          </div>
          <div
            role="radiogroup"
            aria-labelledby="agent-prompt-mode-label"
            className="grid gap-2 sm:grid-cols-2"
          >
            <PromptModeOption
              checked={mode === 'append'}
              title="保留并追加（推荐）"
              description="Assistant 模式保留 Claude Code 默认提示词，再追加下面四部分。"
              onSelect={() => onModeChange('append')}
            />
            <PromptModeOption
              checked={mode === 'replace'}
              title="完全替换"
              description="仅使用下面四部分和 HappyClaw 必需的运行指令。"
              onSelect={() => onModeChange('replace')}
            />
          </div>
          <p className="mt-2 text-caption leading-5 text-muted-foreground">
            主动模式始终使用智能体配置与 HappyClaw
            运行规则组成的独立系统提示词，不继承 Assistant 导向的 Claude Code
            默认提示词；此选项仅影响 Assistant 模式。
          </p>
        </div>

        <Tabs
          value={activeSection}
          onValueChange={(next) => setActiveSection(next as AgentPromptSection)}
          className="gap-0"
        >
          <div className="flex h-10 items-center overflow-x-auto border-b border-surface-border px-3">
            <TabsList variant="line" aria-label="智能体提示词分段">
              {AGENT_PROMPT_SECTIONS.map((section) => {
                const length = value[section.field].length;
                return (
                  <TabsTrigger
                    key={section.key}
                    value={section.key}
                    className="flex-none px-2 text-label"
                  >
                    {section.title}
                    {length > 0 && (
                      <span className="text-micro text-faint-foreground tabular-nums max-sm:hidden">
                        {length}
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          {AGENT_PROMPT_SECTIONS.map((section) => {
            const sectionValue = value[section.field];
            return (
              <TabsContent
                key={section.key}
                value={section.key}
                className="space-y-2 px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <label
                      htmlFor={`agent-prompt-${section.key}`}
                      className="flex items-center gap-2 text-label text-foreground"
                    >
                      {section.title}
                      <span className="font-mono text-micro tracking-wide text-faint-foreground">
                        {section.eyebrow}
                      </span>
                    </label>
                    <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                      {section.description}
                    </p>
                  </div>
                  {onOpenAssistant && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpenAssistant(section.key)}
                    >
                      <Sparkles />用 AI 优化这一段
                    </Button>
                  )}
                </div>
                <Textarea
                  id={`agent-prompt-${section.key}`}
                  value={sectionValue}
                  onChange={(event) =>
                    onChange({ ...value, [section.field]: event.target.value })
                  }
                  className="min-h-[240px] resize-y bg-background text-body leading-6 sm:min-h-[320px]"
                  placeholder={section.placeholder}
                />
                <p className="text-micro text-faint-foreground tabular-nums">
                  {sectionValue.length} 字符 · 约{' '}
                  {estimatePromptTokens(sectionValue)} tokens
                </p>
              </TabsContent>
            );
          })}
        </Tabs>

        <p
          className="px-4 py-2.5 text-caption text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          已填写 {stats.completedSections}/4 段 · {stats.characters} 字符 · 约{' '}
          {stats.estimatedTokens} tokens （估算）
        </p>
      </SettingsGroup>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>四段自定义提示词预览</DialogTitle>
            <DialogDescription>
              {mode === 'append'
                ? '以下内容会追加到 Claude Code 默认提示词之后。预览不包含 Claude Code 默认层及 HappyClaw 强制注入的安全、运行时和渠道规则。'
                : '以下内容会替换 Claude Code 默认提示词。预览不包含 HappyClaw 强制注入的安全、运行时和渠道规则。'}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted/50 p-4 font-mono text-caption leading-6 whitespace-pre-wrap text-foreground">
            {composed || '尚未填写任何提示词。'}
          </pre>
        </DialogContent>
      </Dialog>
    </AgentSection>
  );
}

function PromptModeOption({
  checked,
  title,
  description,
  onSelect,
}: {
  checked: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={choiceCardClassName(checked)}
    >
      <ChoiceCardBody
        checked={checked}
        title={title}
        description={description}
      />
    </button>
  );
}
