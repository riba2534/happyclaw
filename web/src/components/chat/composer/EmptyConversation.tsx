import { BookOpen, Code2, Wrench, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAuthStore } from '../../../stores/auth';
import { useShellStore } from '../../../stores/shell';
import { resolveAgentDisplayIdentity } from '../../../utils/agent-identity';
import { EmojiAvatar } from '../../common/EmojiAvatar';

const STARTERS = [
  { icon: Code2, title: '分析代码', desc: '帮我阅读和分析一段代码的逻辑' },
  { icon: Zap, title: '自动化脚本', desc: '编写一个自动化处理任务的脚本' },
  { icon: BookOpen, title: '技术概念', desc: '用简单的语言解释一个技术概念' },
  { icon: Wrench, title: '调试问题', desc: '帮我定位和修复一个 Bug' },
];

// A short fade-up on arrival; none when less motion is asked for.
const ENTER =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none';

export interface AgentLook {
  agentName?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
}

/** Who answers and what to ask: the top of an empty conversation. */
export function EmptyConversationHeading({
  sessionLabel,
  ...look
}: AgentLook & {
  /** The session's name; absent while it has none (named on first send). */
  sessionLabel?: string;
}) {
  const appearance = useAuthStore((state) => state.appearance);
  const identity = resolveAgentDisplayIdentity({
    agentName: look.agentName,
    avatarUrl: look.agentAvatarUrl,
    avatarEmoji: look.agentAvatarEmoji,
    avatarColor: look.agentAvatarColor,
    appearance,
  });
  return (
    <div className={cn('flex flex-col items-center text-center', ENTER)}>
      <EmojiAvatar
        imageUrl={identity.imageUrl}
        emoji={identity.emoji}
        color={identity.color}
        fallbackChar={identity.fallbackChar}
        size="md"
        className="!size-10 !text-lg"
      />
      <h2 className="mt-3 text-display-sm text-foreground">今天想做什么？</h2>
      <p className="mt-1.5 text-body text-muted-foreground">
        {sessionLabel
          ? `在“${sessionLabel}”中与 ${identity.name} 对话`
          : `与 ${identity.name} 开始新对话，发送后自动命名`}
      </p>
    </div>
  );
}

/** Starting points that fill the composer for the user to edit and send. */
export function ConversationStarters({ className }: { className?: string }) {
  const requestComposerDraft = useShellStore((s) => s.requestComposerDraft);
  return (
    <section aria-label="常用起点" className={cn('w-full', ENTER, className)}>
      <h3 className="mb-2 px-1 text-caption text-muted-foreground">
        从这里开始
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((starter) => (
          <button
            key={starter.title}
            type="button"
            data-hc-starter
            onClick={() => requestComposerDraft(starter.desc)}
            className="group flex min-h-16 cursor-pointer items-start gap-3 rounded-[12px] border border-surface-border bg-surface-raised px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none"
          >
            <starter.icon
              aria-hidden
              className="mt-0.5 size-4.5 shrink-0 text-muted-foreground group-hover:text-foreground"
              strokeWidth={1.75}
            />
            <span className="min-w-0">
              <span className="block truncate text-body font-medium text-foreground">
                {starter.title}
              </span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                {starter.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
