import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, Check, Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import {
  useAgentProfilesStore,
  type AgentPromptChatMessage,
} from '../../stores/agent-profiles';
import {
  AGENT_PROMPT_SECTIONS,
  type AgentPromptParts,
  type AgentPromptSection,
} from '../../utils/agent-prompts';
import { AgentSection } from './AgentSection';

interface PromptAssistantMessage extends AgentPromptChatMessage {
  id: number;
  proposedPrompts?: AgentPromptParts;
}

interface LatestProposal {
  prompts: AgentPromptParts;
}

interface AgentPromptAssistantProps {
  profileId: string;
  agentName: string;
  currentPrompts: AgentPromptParts;
  activeSection: AgentPromptSection;
  onApply: (prompts: AgentPromptParts) => void;
}

const QUICK_REQUESTS = [
  '让表达更简洁，回答时先给结论',
  '补充工作边界，避免擅自假设',
  '强化风险意识和执行前检查',
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'AI 调整失败，请稍后重试';
}

export function AgentPromptAssistant({
  profileId,
  agentName,
  currentPrompts,
  activeSection,
  onApply,
}: AgentPromptAssistantProps) {
  const refineProfilePrompt = useAgentProfilesStore(
    (state) => state.refineProfilePrompt,
  );
  const [messages, setMessages] = useState<PromptAssistantMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [latestProposal, setLatestProposal] = useState<LatestProposal | null>(
    null,
  );
  const nextMessageId = useRef(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeProfileId = useRef(profileId);
  activeProfileId.current = profileId;

  useEffect(() => {
    setMessages([]);
    setInput('');
    setSending(false);
    setLatestProposal(null);
    nextMessageId.current = 1;
  }, [profileId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, sending]);

  const sendMessage = async () => {
    const message = input.trim();
    if (!message || sending) return;

    const requestProfileId = profileId;
    const basePrompts = latestProposal?.prompts ?? currentPrompts;
    const history = messages.slice(-12).map(({ role, content }) => ({
      role,
      content,
    }));

    setMessages((current) => [
      ...current,
      { id: nextMessageId.current++, role: 'user', content: message },
    ]);
    setInput('');
    setSending(true);

    try {
      const refinement = await refineProfilePrompt(requestProfileId, {
        section: activeSection,
        message,
        current_prompts: basePrompts,
        history,
      });
      if (activeProfileId.current !== requestProfileId) return;

      setMessages((current) => [
        ...current,
        {
          id: nextMessageId.current++,
          role: 'assistant',
          content: refinement.reply,
          proposedPrompts: {
            identity_prompt: refinement.identity_prompt,
            soul_prompt: refinement.soul_prompt,
            agents_prompt: refinement.agents_prompt,
            tools_prompt: refinement.tools_prompt,
          },
        },
      ]);
      setLatestProposal({
        prompts: {
          identity_prompt: refinement.identity_prompt,
          soul_prompt: refinement.soul_prompt,
          agents_prompt: refinement.agents_prompt,
          tools_prompt: refinement.tools_prompt,
        },
      });
    } catch (err) {
      if (activeProfileId.current !== requestProfileId) return;
      setInput((current) => current || message);
      toast.error(getErrorMessage(err));
    } finally {
      if (activeProfileId.current === requestProfileId) setSending(false);
    }
  };

  const handleApply = (prompts: AgentPromptParts) => {
    onApply(prompts);
    toast.success('候选四段提示词已应用，请保存智能体');
  };

  const activeLabel = AGENT_PROMPT_SECTIONS.find(
    (item) => item.key === activeSection,
  )?.title;

  return (
    <AgentSection
      title="与 AI 调整提示词"
      description={`直接描述你想增加、删减或改变的行为，AI 会生成四段候选提示词。当前重点调整：${activeLabel}。`}
      actions={<Badge variant="neutral">使用全局模型</Badge>}
    >
      <SettingsGroup>
        <div
          ref={viewportRef}
          className="max-h-[360px] min-h-40 space-y-4 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          <div className="flex items-start gap-2.5">
            <AssistantAvatar />
            <div className="max-w-[min(86%,680px)] rounded-xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-body leading-6 text-foreground">
              告诉我你希望「{agentName || '这个智能体'}
              」如何工作。我会基于当前提示词修改，并先给你确认，不会自动保存。
            </div>
          </div>

          {messages.length === 0 && (
            <div className="ml-9 flex flex-wrap gap-1.5">
              {QUICK_REQUESTS.map((request) => (
                <button
                  key={request}
                  type="button"
                  onClick={() => setInput(request)}
                  className="rounded-full bg-background px-3 py-1 text-left text-caption text-muted-foreground ring-1 ring-surface-border transition-colors duration-100 outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
                >
                  {request}
                </button>
              ))}
            </div>
          )}

          {messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[min(86%,680px)] rounded-xl rounded-tr-sm bg-surface-selected px-3.5 py-2.5 text-body leading-6 text-foreground">
                  {message.content}
                </div>
              </div>
            ) : (
              <div key={message.id} className="flex items-start gap-2.5">
                <AssistantAvatar />
                <div className="min-w-0 max-w-[min(86%,680px)] space-y-2">
                  <div className="rounded-xl rounded-tl-sm bg-muted/60 px-3.5 py-2.5 text-body leading-6 text-foreground">
                    {message.content}
                  </div>
                  {message.proposedPrompts && (
                    <div className="rounded-lg bg-background p-3 ring-1 ring-surface-border">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-label text-foreground">
                          <Wand2 className="size-3.5 text-muted-foreground" />
                          已生成四段候选提示词
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            JSON.stringify(currentPrompts) ===
                            JSON.stringify(message.proposedPrompts)
                              ? 'secondary'
                              : 'outline'
                          }
                          disabled={
                            JSON.stringify(currentPrompts) ===
                            JSON.stringify(message.proposedPrompts)
                          }
                          onClick={() => handleApply(message.proposedPrompts!)}
                        >
                          {JSON.stringify(currentPrompts) ===
                          JSON.stringify(message.proposedPrompts) ? (
                            <Check />
                          ) : (
                            <Wand2 />
                          )}
                          {JSON.stringify(currentPrompts) ===
                          JSON.stringify(message.proposedPrompts)
                            ? '已应用'
                            : '应用到提示词'}
                        </Button>
                      </div>
                      <p className="mt-2 max-h-[66px] overflow-hidden text-caption leading-[22px] whitespace-pre-wrap text-muted-foreground">
                        {message.proposedPrompts[
                          AGENT_PROMPT_SECTIONS.find(
                            (item) => item.key === activeSection,
                          )?.field ?? 'identity_prompt'
                        ] || '该段保持为空。'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {sending && (
            <div className="flex items-center gap-2.5 text-caption text-muted-foreground">
              <span className="grid size-7 place-items-center rounded-full bg-muted text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
              </span>
              正在理解你的要求并重写提示词…
            </div>
          )}
        </div>

        <form
          className="p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <div className="rounded-xl bg-background ring-1 ring-surface-border focus-within:ring-ring/60">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              className="max-h-36 min-h-[64px] resize-none border-0 bg-transparent px-3 pt-2.5 text-body leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder="例如：以后回答先给结论，再列风险和下一步；语气更直接一些。"
              aria-label="告诉 AI 如何调整智能体提示词"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-2 text-micro text-faint-foreground">
              <span>Enter 发送，Shift + Enter 换行 · 应用后仍需保存智能体</span>
              <Button
                type="submit"
                size="icon-sm"
                className="rounded-full"
                disabled={!input.trim() || sending}
                aria-label="发送调整要求"
                title="发送"
              >
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              </Button>
            </div>
          </div>
        </form>
      </SettingsGroup>
    </AgentSection>
  );
}

function AssistantAvatar() {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
      <Bot className="size-3.5" />
    </span>
  );
}
