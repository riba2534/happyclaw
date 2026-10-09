import type { ReactNode } from 'react';
import { Copy, FileText, ImageDown, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useChatStore } from '../../stores/chat';
import { confirmDialog } from '../../stores/confirm';
import { mediumTap } from '../../hooks/useHaptic';

interface MessageContextMenuProps {
  content: string;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
  align?: 'start' | 'end';
  /** The trigger button (rendered via asChild). */
  children: ReactNode;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function toPlainText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, (m) =>
      m.replace(/```\w*\n?/, '').replace(/\n?```$/, ''),
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/** Per-message actions: copy as text / Markdown, share image, delete record. */
export function MessageContextMenu({
  content,
  chatJid,
  messageId,
  onShareImage,
  align = 'start',
  children,
}: MessageContextMenuProps) {
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

  return (
    <DropdownMenu onOpenChange={(open) => open && mediumTap()}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem
          onClick={() => void copyToClipboard(toPlainText(content))}
        >
          <Copy />
          复制文本
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyToClipboard(content)}>
          <FileText />
          复制 Markdown
        </DropdownMenuItem>
        {onShareImage && (
          <DropdownMenuItem onClick={onShareImage}>
            <ImageDown />
            生成分享图片
          </DropdownMenuItem>
        )}
        {chatJid && messageId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => void handleDelete()}
            >
              <Trash2 />
              删除聊天记录
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
