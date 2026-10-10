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
import { copyToClipboard } from '../../utils/clipboard';
import { markdownToPlainText } from '../../lib/markdown-plain-text';
import { toast } from 'sonner';

function copyWithFeedback(text: string) {
  copyToClipboard(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败，请手动选择文本复制'),
  );
}

interface MessageContextMenuProps {
  content: string;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
  align?: 'start' | 'end';
  /** The trigger button (rendered via asChild). */
  children: ReactNode;
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
        {content.trim() && (
          <>
            <DropdownMenuItem
              onClick={() => copyWithFeedback(markdownToPlainText(content))}
            >
              <Copy />
              复制文本
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => copyWithFeedback(content)}>
              <FileText />
              复制 Markdown
            </DropdownMenuItem>
          </>
        )}
        {onShareImage && (
          <DropdownMenuItem onClick={onShareImage}>
            <ImageDown />
            生成分享图片
          </DropdownMenuItem>
        )}
        {chatJid && messageId && (
          <>
            {(content.trim() || onShareImage) && <DropdownMenuSeparator />}
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
