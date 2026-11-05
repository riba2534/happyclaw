import { useState, type ReactElement } from 'react';
import {
  Copy,
  FileText,
  ImageDown,
  Quote,
  TextSelect,
  Trash2,
} from 'lucide-react';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import { useIsPhone } from '../layout/phone';
import { DetailSheet } from './DetailSheet';
import { useChatStore } from '../../stores/chat';
import { useIsGuest } from '../../stores/auth';
import { useShellStore } from '../../stores/shell';
import { confirmDialog } from '../../stores/confirm';
import { mediumTap } from '../../hooks/useHaptic';
import { copyToClipboard } from '../../utils/clipboard';
import { markdownToPlainText } from '../../lib/markdown-plain-text';
import { toast } from 'sonner';

function copyWithFeedback(text: string) {
  copyToClipboard(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败，请手动选择文本复制'),
  );
}

/** Longest quote the composer takes; past it the quote ends in an ellipsis. */
const QUOTE_MAX_CHARS = 300;

/**
 * A message as a Markdown quote for the composer: its plain text, each line
 * behind `> `, then an empty line and the line the caret lands on. The empty
 * line ends the quote, so what is typed next is not folded into it.
 */
export function quoteForComposer(content: string): string {
  let text = markdownToPlainText(content).trim();
  if (text.length > QUOTE_MAX_CHARS) {
    text = `${text.slice(0, QUOTE_MAX_CHARS).trimEnd()}…`;
  }
  const quoted = text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `${quoted}\n\n`;
}

interface MessageContextMenuProps {
  content: string;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
  align?: 'start' | 'end';
  /** Open state, when the message opens it too (a long press on a phone). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger button. */
  children: ReactElement;
}

/**
 * Per-message actions: quote into the composer, copy as text / Markdown,
 * share image, delete record.
 * A desktop's anchored menu; a phone's action sheet, which a long press on the
 * message opens too. A held finger opens the menu instead of the system's
 * text selection, so the phone menu has 「选择文本」: the text in a sheet of
 * its own, where the system selection works (cindy's message action sheet).
 */
export function MessageContextMenu({
  content,
  chatJid,
  messageId,
  onShareImage,
  align = 'start',
  open,
  onOpenChange,
  children,
}: MessageContextMenuProps) {
  const isPhone = useIsPhone();
  const [selecting, setSelecting] = useState(false);
  // Read-only guests may copy and share, never delete records.
  const isGuest = useIsGuest();
  const canDelete = !isGuest && !!chatJid && !!messageId;
  const handleDelete = async () => {
    if (!chatJid || !messageId) return;
    const confirmed = await confirmDialog({
      title: '删除聊天记录',
      message: '仅删除持久聊天记录，不会撤回正在处理的模型输入。',
      confirmText: '确认删除记录',
      variant: 'danger',
    });
    if (confirmed) {
      await useChatStore.getState().deleteMessage(chatJid, messageId);
    }
  };

  const hasText = !!content.trim();
  // Guests have no composer to quote into.
  const canQuote = hasText && !isGuest;
  const copy: MenuAction[] = hasText
    ? [
        ...(canQuote
          ? [
              {
                label: '引用',
                icon: Quote,
                onSelect: () =>
                  useShellStore
                    .getState()
                    .requestComposerDraft(quoteForComposer(content)),
              },
            ]
          : []),
        {
          label: '复制文本',
          icon: Copy,
          onSelect: () => copyWithFeedback(markdownToPlainText(content)),
        },
        {
          label: '复制 Markdown',
          icon: FileText,
          onSelect: () => copyWithFeedback(content),
        },
        ...(isPhone
          ? [
              {
                label: '选择文本',
                icon: TextSelect,
                onSelect: () => setSelecting(true),
              },
            ]
          : []),
      ]
    : [];
  const share: MenuAction[] = onShareImage
    ? [{ label: '生成分享图片', icon: ImageDown, onSelect: onShareImage }]
    : [];
  const remove: MenuAction[] = canDelete
    ? [
        {
          label: '删除聊天记录',
          icon: Trash2,
          destructive: true,
          onSelect: () => void handleDelete(),
        },
      ]
    : [];

  return (
    <>
      <ResponsiveMenu
        trigger={children}
        title="消息操作"
        align={align}
        open={open}
        onOpenChange={(next) => {
          if (next) mediumTap();
          onOpenChange?.(next);
        }}
        // The desktop menu kept copy and share together, delete apart.
        groups={[[...copy, ...share], remove]}
      />
      {selecting && (
        <DetailSheet title="选择文本" onClose={() => setSelecting(false)}>
          <p
            data-hc-select-text=""
            className="text-body-lg break-words whitespace-pre-wrap text-foreground select-text"
          >
            {markdownToPlainText(content)}
          </p>
        </DetailSheet>
      )}
    </>
  );
}
