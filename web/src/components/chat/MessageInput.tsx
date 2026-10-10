import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  memo,
} from 'react';
import { toast } from 'sonner';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { useStableCallback } from '@/hooks/useStableCallback';
import { successTap } from '../../hooks/useHaptic';
import {
  ArrowUp,
  Eraser,
  FileUp,
  FolderUp,
  X,
  Paperclip,
  Image as ImageIcon,
  TerminalSquare,
  Loader2,
  Upload,
  Clock3,
  CornerUpLeft,
  Square,
  Pencil,
  ChevronUp,
  ChevronDown,
  Check,
  Trash2,
  Plus,
  ListPlus,
} from 'lucide-react';
import { formatUploadRetryStatus, useFileStore } from '../../stores/files';
import { useShellStore } from '../../stores/shell';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconButton } from '../common/IconButton';
import { Shortcut } from '../common/Shortcut';
import {
  useChatStore,
  type FollowUpMode,
  type FollowUpQueueAction,
  type QueuedFollowUp,
} from '../../stores/chat';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  alternateFollowUpMode,
  FOLLOW_UP_MODE_KEY,
  FOLLOW_UP_MODE_CHANGED_EVENT,
  getDefaultFollowUpMode,
} from '../../lib/follow-up-preferences';
import { planImageClipboardPaste } from '../../lib/mixed-paste';
import { SHORTCUTS } from '../../lib/shortcuts';
import { prepareImageForUpload } from '../../lib/image-upload';

interface PendingFile {
  /** Display name: relative path for folder uploads, file name otherwise */
  label: string;
}

interface PendingImage {
  name: string;
  data: string; // base64 data
  mimeType: string;
  preview: string; // object URL for preview
}

interface MessageInputProps {
  /**
   * 发送回调。返回 boolean 表示发送是否成功：
   * - true：MessageInput 清空输入框和附件
   * - false：保留输入框内容和附件，用户可重试（弱网/断网场景）
   */
  onSend: (
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => Promise<boolean> | boolean;
  groupJid?: string;
  disabled?: boolean;
  contextLabel?: string;
  /** Composer placeholder, e.g. naming the agent being addressed. */
  placeholder?: string;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
  /** Stop the active run when the composer has no follow-up to send. */
  onStop?: () => Promise<boolean> | boolean;
  isRunning?: boolean;
  queuedFollowUps?: QueuedFollowUp[];
  onFollowUpAction?: (
    item: QueuedFollowUp,
    action: FollowUpQueueAction,
    content?: string,
  ) => Promise<boolean> | boolean;
}

// Memoized: ChatView re-renders for dialogs, panels and run status; the
// transcript and composer only need to when their own props change.
export const MessageInput = memo(function MessageInput({
  onSend,
  groupJid,
  disabled = false,
  contextLabel,
  placeholder = '输入消息...',
  onResetSession,
  onToggleTerminal,
  onStop,
  isRunning = false,
  queuedFollowUps = [],
  onFollowUpAction,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>(() =>
    getDefaultFollowUpMode(),
  );
  const [actingOn, setActingOn] = useState<Set<string>>(() => new Set());
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(
    null,
  );
  const [editingFollowUpContent, setEditingFollowUpContent] = useState('');
  const [savingFollowUpId, setSavingFollowUpId] = useState<string | null>(null);
  const editingFollowUpInitialContentRef = useRef('');
  const editingFollowUpContentRef = useRef('');
  const dragCounterRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // "New conversation" (sidebar / ⌘⇧O / ⌘K) asks the composer for focus.
  const composerFocusNonce = useShellStore((s) => s.composerFocusNonce);
  useEffect(() => {
    if (composerFocusNonce === 0) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerFocusNonce]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const prevGroupJidRef = useRef<string | undefined>(groupJid);
  const groupJidRef = useRef(groupJid);
  groupJidRef.current = groupJid;

  // 窄 selector：这是 1200+ 行常驻组件，无 selector 的整 store 订阅会让它在
  // 流式输出的每一帧（rAF 级 set()）都重渲染一次。actions 引用稳定。
  const uploadFiles = useFileStore((s) => s.uploadFiles);
  const cancelUpload = useFileStore((s) => s.cancelUpload);
  const uploading = useFileStore((s) => s.uploading);
  const uploadProgress = useFileStore((s) => s.uploadProgress);
  const drafts = useChatStore((s) => s.drafts);
  const saveDraft = useChatStore((s) => s.saveDraft);
  const clearDraft = useChatStore((s) => s.clearDraft);
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const isMobile = useMediaQuery('(max-width: 1023px)');

  // iOS keyboard adaptation
  useKeyboardHeight();

  useEffect(() => {
    const handlePreferenceChange = (event: Event) => {
      const mode = (event as CustomEvent<FollowUpMode>).detail;
      setFollowUpMode(mode === 'steer' ? 'steer' : 'queue');
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === FOLLOW_UP_MODE_KEY) {
        setFollowUpMode(event.newValue === 'steer' ? 'steer' : 'queue');
      }
    };
    window.addEventListener(
      FOLLOW_UP_MODE_CHANGED_EVENT,
      handlePreferenceChange,
    );
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(
        FOLLOW_UP_MODE_CHANGED_EVENT,
        handlePreferenceChange,
      );
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // Restore draft when groupJid changes (including initial mount)
  useEffect(() => {
    // Save current draft before switching
    if (prevGroupJidRef.current && prevGroupJidRef.current !== groupJid) {
      const currentText = content.trim();
      if (currentText) {
        saveDraft(prevGroupJidRef.current, currentText);
      } else {
        clearDraft(prevGroupJidRef.current);
      }
    }
    prevGroupJidRef.current = groupJid;

    // Load draft for new group
    const draft = groupJid ? drafts[groupJid] || '' : '';
    setContent(draft);
    // Drop pending attachments staged for the previous group — they must not
    // leak into the newly-selected conversation (会话隔离). Release image
    // preview object URLs to avoid a memory leak.
    setPendingImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview));
      return [];
    });
    setPendingFiles([]);
    // Clear any pending debounce timer
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Cleanup debounce timer on unmount, save current draft
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
    };
  }, []);

  // Debounced draft save
  const debouncedSaveDraft = useCallback(
    (text: string) => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
      draftTimerRef.current = setTimeout(() => {
        if (groupJid) {
          saveDraft(groupJid, text.trim());
        }
      }, 300);
    },
    [groupJid, saveDraft],
  );

  // Starter prompts fill the composer so the user can edit before sending.
  const composerDraftRequest = useShellStore((s) => s.composerDraftRequest);
  useEffect(() => {
    if (!composerDraftRequest) return;
    const text = composerDraftRequest.text;
    const next = content.trim() ? `${content.trimEnd()}\n${text}` : text;
    setContent(next);
    debouncedSaveDraft(next);
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => cancelAnimationFrame(frame);
    // Only a new request inserts text; typing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerDraftRequest]);

  // Auto-resize textarea (1-6 lines)
  // useLayoutEffect runs BEFORE paint → height update is invisible to the user (no jitter)
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Temporarily hide overflow to prevent scrollbar flash during measurement
    const prevOverflow = textarea.style.overflow;
    textarea.style.overflow = 'hidden';
    textarea.style.height = '0px';
    const scrollHeight = textarea.scrollHeight;
    const lineHeight = 24;
    const maxHeight = lineHeight * 6;
    const newHeight = Math.max(lineHeight, Math.min(scrollHeight, maxHeight));
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflow =
      newHeight >= maxHeight ? 'auto' : prevOverflow || '';
  }, [content]);

  // IME composition state — prevent Enter from sending while composing (e.g. Chinese input)
  // On Chrome macOS, compositionEnd fires before the Enter keyDown, so we track
  // the timestamp and ignore Enter within 100ms after composition ends.
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (
      e.key === 'Enter' &&
      e.shiftKey &&
      (e.metaKey || e.ctrlKey) &&
      !isMobile
    ) {
      if (Date.now() - compositionEndTimeRef.current < 100) return;
      e.preventDefault();
      void handleSend(
        isRunning ? alternateFollowUpMode(followUpMode) : undefined,
      );
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      if (Date.now() - compositionEndTimeRef.current < 100) return;
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async (modeOverride?: FollowUpMode) => {
    const trimmed = content.trim();
    const hasPending = pendingFiles.length > 0;
    const hasImages = pendingImages.length > 0;

    if (!trimmed && !hasPending && !hasImages) return;
    if (disabled || sending) return;

    setSending(true);
    setSendError(null);

    // 先组装 message 但不立刻清空 pendingFiles/pendingImages，
    // 让 onSend 失败时用户的附件也能保留、可以重试。
    let message = trimmed;
    if (hasPending) {
      const list = pendingFiles.map((f) => `- ${f.label}`).join('\n');
      const prefix = `[我上传了以下文件到工作区，请查看并使用]\n${list}`;
      message = message ? `${prefix}\n\n${message}` : prefix;
    }
    const attachments = hasImages
      ? pendingImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
      : undefined;

    let ok = false;
    try {
      ok = await onSend(
        message,
        attachments,
        modeOverride ?? (isRunning ? followUpMode : undefined),
      );
    } catch {
      ok = false;
    }

    if (ok) {
      successTap();
      setContent('');
      if (groupJid) clearDraft(groupJid);
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      if (hasPending) setPendingFiles([]);
      if (hasImages) {
        pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
        setPendingImages([]);
      }
    } else {
      // 失败：保留输入、保留附件；同步保存草稿，刷新/崩溃也能恢复。
      if (groupJid && trimmed) saveDraft(groupJid, trimmed);
      setSendError('发送失败，输入已保留，请重试');
      setTimeout(() => setSendError(null), 4000);
    }
    setSending(false);
  };

  const handleFollowUpAction = async (
    item: QueuedFollowUp,
    action: FollowUpQueueAction,
    nextContent?: string,
  ): Promise<boolean> => {
    if (!onFollowUpAction || actingOn.has(item.id)) return false;
    setActingOn((current) => new Set(current).add(item.id));
    try {
      return await onFollowUpAction(item, action, nextContent);
    } finally {
      setActingOn((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const beginEditingFollowUp = (item: QueuedFollowUp) => {
    setEditingFollowUpId(item.id);
    setEditingFollowUpContent(item.content);
    editingFollowUpInitialContentRef.current = item.content;
    editingFollowUpContentRef.current = item.content;
  };

  const saveFollowUpEdit = async (item: QueuedFollowUp) => {
    const nextContent = editingFollowUpContentRef.current.trim();
    if (!nextContent) return;
    setSavingFollowUpId(item.id);
    const saved = await handleFollowUpAction(item, 'edit', nextContent);
    setSavingFollowUpId(null);
    if (saved) {
      setEditingFollowUpId(null);
      setEditingFollowUpContent('');
      editingFollowUpInitialContentRef.current = '';
      editingFollowUpContentRef.current = '';
    }
  };

  const followUpAction = useStableCallback(
    (item: QueuedFollowUp, action: FollowUpQueueAction) =>
      handleFollowUpAction(item, action),
  );
  const beginEditFollowUp = useStableCallback(beginEditingFollowUp);
  const saveEditedFollowUp = useStableCallback(saveFollowUpEdit);
  const changeEditedFollowUp = useStableCallback((value: string) => {
    editingFollowUpContentRef.current = value;
    setEditingFollowUpContent(value);
  });
  const cancelFollowUpEdit = useStableCallback(() => {
    setEditingFollowUpId(null);
    setEditingFollowUpContent('');
    editingFollowUpInitialContentRef.current = '';
    editingFollowUpContentRef.current = '';
  });

  // A run can finish while the user is editing the next queued message. The
  // dispatcher is then allowed to claim that item, so it disappears from the
  // queue before Save can be clicked. Never silently discard what the user
  // typed: move an unsaved edit back into the main composer and explain why.
  useEffect(() => {
    if (!editingFollowUpId || savingFollowUpId === editingFollowUpId) return;
    if (queuedFollowUps.some((item) => item.id === editingFollowUpId)) return;

    const recovered = editingFollowUpContentRef.current.trim();
    const initial = editingFollowUpInitialContentRef.current.trim();
    setEditingFollowUpId(null);
    setEditingFollowUpContent('');
    editingFollowUpInitialContentRef.current = '';
    editingFollowUpContentRef.current = '';

    if (!recovered || recovered === initial) return;
    const nextContent = content.trim()
      ? `${content.trimEnd()}\n\n${recovered}`
      : recovered;
    setContent(nextContent);
    debouncedSaveDraft(nextContent);
    setSendError('这条消息已开始处理，未保存的修改已移到输入框');
    const timer = window.setTimeout(() => setSendError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [
    content,
    debouncedSaveDraft,
    editingFollowUpId,
    queuedFollowUps,
    savingFollowUpId,
  ]);

  const handleStop = async () => {
    if (!onStop || stopping || disabled) return;
    setStopping(true);
    try {
      const stopped = await onStop();
      if (!stopped) setStopping(false);
    } catch {
      setStopping(false);
    }
  };

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);

      // Separate image files from regular files
      const imageFiles: File[] = [];
      const regularFiles: File[] = [];
      files.forEach((file) => {
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else {
          regularFiles.push(file);
        }
      });

      // Process image files
      if (imageFiles.length > 0) {
        const newImages: PendingImage[] = [];
        for (const file of imageFiles) {
          const image = await toPendingImage(file);
          if (image) newImages.push(image);
        }
        setPendingImages((prev) => [...prev, ...newImages]);
      }

      // Upload regular files to workspace
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(groupJid, regularFiles);
        if (ok) {
          const newPending = regularFiles.map((f) => ({
            label: f.webkitRelativePath || f.name,
          }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);

      const newImages: PendingImage[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          const image = await toPendingImage(file);
          if (image) newImages.push(image);
        }
      }
      setPendingImages((prev) => [...prev, ...newImages]);

      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  /** Downscale and encode one image; reports oversize/undecodable files. */
  const toPendingImage = async (
    file: File,
    fallbackName?: string,
  ): Promise<PendingImage | null> => {
    try {
      const prepared = await prepareImageForUpload(file);
      return {
        name: file.name || fallbackName || `image-${Date.now()}.png`,
        data: prepared.data,
        mimeType: prepared.mimeType,
        preview: URL.createObjectURL(file),
      };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '图片读取失败');
      return null;
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length === 0) return;

    const textarea = e.currentTarget;
    const pastePlan = planImageClipboardPaste({
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      text: e.clipboardData.getData('text/plain'),
      imageItemCount: imageItems.length,
    });
    e.preventDefault();

    if (pastePlan.value !== textarea.value) {
      setContent(pastePlan.value);
      debouncedSaveDraft(pastePlan.value);
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.setSelectionRange(pastePlan.selectionStart, pastePlan.selectionEnd);
    });

    const newImages: PendingImage[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const image = await toPendingImage(file, `pasted-${Date.now()}.png`);
      if (image) newImages.push(image);
    }

    if (newImages.length > 0) {
      setPendingImages((prev) => [...prev, ...newImages]);
    }
  };

  // --- Drag and drop helpers ---

  /** Recursively traverse a dropped directory entry and collect all files */
  const readEntriesRecursively = (
    entry: FileSystemDirectoryEntry,
  ): Promise<File[]> => {
    return new Promise((resolve, reject) => {
      const reader = entry.createReader();
      const allFiles: File[] = [];

      const readBatch = () => {
        reader.readEntries(
          async (entries) => {
            if (entries.length === 0) {
              resolve(allFiles);
              return;
            }
            for (const e of entries) {
              if (e.isFile) {
                const file = await new Promise<File>((res, rej) =>
                  (e as FileSystemFileEntry).file(res, (err) => rej(err)),
                );
                // Attach relative path for display
                Object.defineProperty(file, 'webkitRelativePath', {
                  value: e.fullPath.slice(1), // remove leading "/"
                  writable: false,
                });
                allFiles.push(file);
              } else if (e.isDirectory) {
                const subFiles = await readEntriesRecursively(
                  e as FileSystemDirectoryEntry,
                );
                allFiles.push(...subFiles);
              }
            }
            // readEntries may return partial results; keep reading until empty
            readBatch();
          },
          (err) => reject(err),
        );
      };
      readBatch();
    });
  };

  // --- Drag and drop handlers ---
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      // Only handle file drops; let text/URL drops through to the textarea
      if (!e.dataTransfer.types.includes('Files')) return;

      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      // Guard: respect disabled/sending/uploading state
      if (!groupJid || disabled || sending || uploading) return;

      // Capture groupJid at drop time to prevent stale-chat attachment
      const targetGroupJid = groupJid;

      // Collect files, expanding directories via webkitGetAsEntry.
      // 同步提取所有 item 的 entry/file，避免 drop 事件结束后 DataTransferItemList
      // 被浏览器清理（Firefox/Safari）导致后续 item 返回 null 而静默丢失。
      const items = Array.from(e.dataTransfer.items);
      const collected: Array<{
        entry: FileSystemEntry | null;
        file: File | null;
      }> = [];
      for (const item of items) {
        collected.push({
          entry: item.webkitGetAsEntry?.() ?? null,
          file: item.getAsFile(),
        });
      }

      const allFiles: File[] = [];
      let hasDirectory = false;

      for (const { entry, file } of collected) {
        if (entry?.isDirectory) {
          hasDirectory = true;
          try {
            const dirFiles = await readEntriesRecursively(
              entry as FileSystemDirectoryEntry,
            );
            allFiles.push(...dirFiles);
          } catch (err) {
            setSendError('读取文件夹失败');
            setTimeout(() => setSendError(null), 4000);
            console.warn('读取文件夹失败:', err);
            return;
          }
        } else if (file) {
          allFiles.push(file);
        }
      }

      if (allFiles.length === 0) return;

      // If a directory was dropped, upload ALL files to workspace (including images)
      // to match the button-based folder upload behavior.
      if (hasDirectory) {
        const ok = await uploadFiles(targetGroupJid, allFiles);
        if (ok && targetGroupJid === groupJidRef.current) {
          const newPending = allFiles.map((f) => ({
            label:
              (f as unknown as { webkitRelativePath?: string })
                .webkitRelativePath || f.name,
          }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
        return;
      }

      // For individual files: split images (inline) from regular files (workspace)
      const imageFiles: File[] = [];
      const regularFiles: File[] = [];
      allFiles.forEach((file) => {
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else {
          regularFiles.push(file);
        }
      });

      // Process images inline (same as handleImageSelect)
      if (imageFiles.length > 0) {
        const newImages: PendingImage[] = [];
        for (const file of imageFiles) {
          const image = await toPendingImage(file);
          if (image) newImages.push(image);
        }
        // Verify groupJid hasn't changed during async processing (use ref for live value)
        if (targetGroupJid === groupJidRef.current) {
          setPendingImages((prev) => [...prev, ...newImages]);
        } else {
          // Conversation switched — revoke preview URLs to avoid memory leak
          newImages.forEach((img) => URL.revokeObjectURL(img.preview));
        }
      }

      // Upload non-image files to workspace (same as handleFileSelect)
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(targetGroupJid, regularFiles);
        if (ok && targetGroupJid === groupJidRef.current) {
          const newPending = regularFiles.map((f) => ({ label: f.name }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
      }
    },
    [groupJid, disabled, sending, uploading, uploadFiles],
  );

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      const ok = await uploadFiles(groupJid, files);
      if (ok) {
        const newPending = files.map((f) => ({
          label: f.webkitRelativePath || f.name,
        }));
        setPendingFiles((prev) => [...prev, ...newPending]);
      }
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearPendingFiles = () => {
    setPendingFiles([]);
  };

  const clearPendingImages = () => {
    pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setPendingImages([]);
  };

  const hasContent = content.trim().length > 0;
  const hasPayload =
    hasContent || pendingFiles.length > 0 || pendingImages.length > 0;
  const canSend = hasPayload && !sending;
  const showStop = isRunning && !hasPayload && !sending && !!onStop;
  // While a run is active, a payload is queued or steers the run depending on
  // the default follow-up mode; mod+shift+enter picks the other one.
  const followUpLabel = (mode: FollowUpMode) =>
    mode === 'steer' ? '引导当前运行' : '加入队列，下一轮发送';
  const sendLabel = showStop
    ? '停止当前运行'
    : isRunning
      ? followUpLabel(followUpMode)
      : '发送消息';

  const progressPercent =
    uploadProgress && uploadProgress.totalBytes > 0
      ? Math.round(
          (uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100,
        )
      : 0;
  const uploadRetryStatus = uploadProgress
    ? formatUploadRetryStatus(uploadProgress)
    : null;

  return (
    <div
      className="relative bg-background pt-1 pb-3 max-lg:border-t max-lg:border-surface-border max-lg:bg-background/80 max-lg:backdrop-blur-xl"
      style={{
        paddingBottom: `max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))`,
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Soft fade so scrolled messages don't end at a hard edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background max-lg:hidden"
      />
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 dark:bg-primary/10 backdrop-blur-[2px] border-2 border-dashed border-primary rounded-xl pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary-text">
            <Upload className="w-8 h-8" />
            <span className="text-sm font-medium">松开上传文件</span>
          </div>
        </div>
      )}
      {/* Same column as the message list (max-w-3xl + px-6) so the
          composer edges line up with message content. */}
      <div
        className={
          isCompact ? 'mx-auto px-4' : 'mx-auto max-w-3xl px-4 lg:px-6'
        }
      >
        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div
            className={`mb-2 bg-surface-raised px-4 py-2.5 ring-1 ring-surface-border ${isCompact ? 'rounded-lg' : 'rounded-xl'}`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="max-w-[65%] truncate text-caption text-foreground/80">
                {uploadProgress.currentFile || '完成'}
                {uploadRetryStatus ? (
                  <span data-upload-retry-status>（{uploadRetryStatus}）</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 text-caption text-muted-foreground tabular-nums">
                {uploadProgress.completed}/{uploadProgress.total} ·{' '}
                {progressPercent}%
                <button
                  type="button"
                  data-upload-cancel
                  onClick={cancelUpload}
                  className="inline-flex items-center gap-0.5 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  取消
                </button>
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Queue tucks behind the composer like a card in a stack. */}
        {queuedFollowUps.length > 0 && (
          <QueuedFollowUpsPanel
            queuedFollowUps={queuedFollowUps}
            compact={isCompact}
            actingOn={actingOn}
            editingFollowUpId={editingFollowUpId}
            editingFollowUpContent={editingFollowUpContent}
            handleFollowUpAction={followUpAction}
            beginEditingFollowUp={beginEditFollowUp}
            saveFollowUpEdit={saveEditedFollowUp}
            onEditChange={changeEditedFollowUp}
            onCancelEdit={cancelFollowUpEdit}
          />
        )}

        {/* Main input card */}
        <div
          className={
            isCompact
              ? 'relative z-10 rounded-lg bg-surface-raised ring-1 ring-surface-border transition-shadow focus-within:ring-foreground/20'
              : 'relative z-10 rounded-2xl bg-surface-raised shadow-canvas ring-1 ring-surface-border transition-shadow focus-within:shadow-menu focus-within:ring-foreground/20'
          }
        >
          {/* Send error banner */}
          {sendError && (
            <div
              className={`flex items-center gap-2 border-b border-error/15 bg-error/5 px-4 py-2 text-caption font-medium text-error ${isCompact ? 'rounded-t-lg' : 'rounded-t-2xl'}`}
            >
              <span>{sendError}</span>
            </div>
          )}

          {/* Pending images preview */}
          {/* Attachment tray: image thumbnails and file chips in one row */}
          {(pendingImages.length > 0 || pendingFiles.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
              {pendingImages.map((img, i) => (
                <div key={`img-${i}`} className="group/attachment relative">
                  <img
                    src={img.preview}
                    alt={img.name}
                    className="size-14 rounded-lg object-cover ring-1 ring-surface-border"
                  />
                  <button
                    type="button"
                    onClick={() => removePendingImage(i)}
                    className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-foreground text-background shadow-menu transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/attachment:opacity-100 focus-visible:opacity-100"
                    aria-label="移除图片"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {pendingFiles.map((file, i) => (
                <span
                  key={`file-${i}`}
                  title={`${file.label}（已上传，发送时将告知 AI）`}
                  className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg bg-muted pl-2.5 text-caption text-foreground ring-1 ring-surface-border"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.label}</span>
                  <button
                    type="button"
                    onClick={() => removePendingFile(i)}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                    aria-label="移除文件"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
              {pendingImages.length + pendingFiles.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    clearPendingImages();
                    clearPendingFiles();
                  }}
                  className="h-8 cursor-pointer rounded-md px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                >
                  清空
                </button>
              )}
            </div>
          )}

          {/* Textarea */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                debouncedSaveDraft(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
                compositionEndTimeRef.current = Date.now();
              }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              className="w-full resize-none bg-transparent text-base leading-6 placeholder:text-faint-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:text-body-lg"
              rows={1}
              style={{ minHeight: '28px', maxHeight: '144px' }}
            />
          </div>

          {/* Bottom action bar */}
          <div className="flex items-center gap-1 px-2 pb-2">
            {/* Left: action icons */}
            <div className="flex items-center gap-0.5">
              {groupJid && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={uploading}
                      aria-label="添加文件"
                      className="text-muted-foreground pointer-coarse:size-10"
                    >
                      <Plus />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    side="top"
                    className="w-44"
                  >
                    <DropdownMenuItem
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <ImageIcon />
                      添加图片
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileUp />
                      上传文件
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={uploading}
                      className="max-lg:hidden"
                      onClick={() => folderInputRef.current?.click()}
                    >
                      <FolderUp />
                      上传文件夹
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {onResetSession && (
                <IconButton
                  label="清除当前会话上下文"
                  icon={<Eraser />}
                  onClick={onResetSession}
                  tooltipSide="top"
                  className="text-muted-foreground pointer-coarse:size-10"
                />
              )}
              {onToggleTerminal && (
                <IconButton
                  label="终端"
                  icon={<TerminalSquare />}
                  onClick={onToggleTerminal}
                  tooltipSide="top"
                  className="text-muted-foreground pointer-coarse:size-10"
                />
              )}
            </div>

            {contextLabel && (
              <span
                className="ml-1 inline-flex h-6 max-w-[min(42vw,180px)] min-w-0 items-center rounded-md bg-muted px-2 text-micro font-medium text-muted-foreground"
                title={`发送到：${contextLabel}`}
              >
                <span className="truncate">{contextLabel}</span>
              </span>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right: one contextual primary action, matching Codex. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  // Keep the caret (and the mobile keyboard) in the composer.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    showStop ? void handleStop() : void handleSend()
                  }
                  disabled={
                    showStop
                      ? disabled || stopping
                      : !canSend || disabled || sending
                  }
                  aria-label={sendLabel}
                  className={`flex size-8 cursor-pointer items-center justify-center rounded-full transition-[background-color,color,transform] duration-100 active:scale-90 pointer-coarse:size-10 ${
                    showStop && !disabled && !stopping
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : canSend && !disabled && !sending
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'bg-muted text-faint-foreground'
                  } focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none`}
                >
                  {sending || stopping ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : showStop ? (
                    <Square className="size-3.5 fill-current" />
                  ) : isRunning && followUpMode === 'queue' ? (
                    <ListPlus className="size-4" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="flex-col items-start">
                <span>{sendLabel}</span>
                {isRunning && !showStop && (
                  <span className="flex items-center gap-1.5 opacity-70">
                    {followUpLabel(alternateFollowUpMode(followUpMode))}
                    <Shortcut keys={SHORTCUTS.steer} />
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleImageSelect}
        className="hidden"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        disabled={uploading}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleFolderSelect}
        className="hidden"
        disabled={uploading}
      />
    </div>
  );
});

interface QueuedFollowUpsPanelProps {
  queuedFollowUps: QueuedFollowUp[];
  compact: boolean;
  actingOn: Set<string>;
  editingFollowUpId: string | null;
  editingFollowUpContent: string;
  handleFollowUpAction: (
    item: QueuedFollowUp,
    action: FollowUpQueueAction,
  ) => Promise<boolean>;
  beginEditingFollowUp: (item: QueuedFollowUp) => void;
  saveFollowUpEdit: (item: QueuedFollowUp) => Promise<void>;
  onEditChange: (value: string) => void;
  onCancelEdit: () => void;
}

/**
 * Queued follow-ups above the composer. Memoized with stable handlers, so
 * typing in the composer does not re-render every queued message.
 */
const QueuedFollowUpsPanel = memo(function QueuedFollowUpsPanel({
  queuedFollowUps,
  compact,
  actingOn,
  editingFollowUpId,
  editingFollowUpContent,
  handleFollowUpAction,
  beginEditingFollowUp,
  saveFollowUpEdit,
  onEditChange,
  onCancelEdit,
}: QueuedFollowUpsPanelProps) {
  return (
    <div
      className={`relative z-0 -mb-3 overflow-hidden bg-app-shell pb-3 ring-1 ring-surface-border ${compact ? 'mx-2 rounded-t-lg' : 'mx-3 rounded-t-xl'}`}
    >
      <div className="flex h-8 items-center gap-2 border-b border-surface-border px-3 text-caption text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
        <span>
          {queuedFollowUps.some((item) => item.delivery_mode === 'steer')
            ? '正在停止当前回复，随后发送引导消息'
            : queuedFollowUps.length > 1
              ? `${queuedFollowUps.length} 条消息已排队，将合并为下一轮`
              : '1 条消息已排队'}
        </span>
      </div>
      <div className="max-h-56 divide-y divide-surface-border overflow-y-auto">
        {queuedFollowUps.map((item, index) => {
          const busy = actingOn.has(item.id);
          const steering = item.delivery_mode === 'steer';
          const locked = steering || item.delivery_status === 'promoting';
          const editing = editingFollowUpId === item.id;
          return (
            <div
              key={item.id}
              className="group/queued flex min-w-0 items-start gap-2 px-3 py-1.5"
            >
              <span className="mt-1.5 shrink-0 text-micro font-medium text-faint-foreground tabular-nums">
                {index + 1}
              </span>
              {editing ? (
                <div className="min-w-0 flex-1 space-y-2">
                  <textarea
                    value={editingFollowUpContent}
                    onChange={(event) => onEditChange(event.target.value)}
                    rows={2}
                    autoFocus
                    className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-caption leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-label="编辑排队消息"
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={onCancelEdit}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={busy || !editingFollowUpContent.trim()}
                      onClick={() => void saveFollowUpEdit(item)}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-caption font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2 pointer-coarse:flex-col pointer-coarse:gap-0.5">
                  <span
                    className="block min-w-0 flex-1 pt-1 text-caption leading-5 break-words whitespace-pre-wrap text-foreground/85 pointer-coarse:w-full"
                    title={item.content}
                  >
                    {item.content}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-coarse:-mr-1.5 pointer-coarse:self-end pointer-fine:opacity-0 pointer-fine:group-hover/queued:opacity-100 pointer-fine:group-focus-within/queued:opacity-100">
                    <button
                      type="button"
                      disabled={busy || locked || index === 0}
                      onClick={() => void handleFollowUpAction(item, 'move_up')}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-9"
                      aria-label={`上移：${item.content}`}
                      title="上移"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy || locked || index === queuedFollowUps.length - 1
                      }
                      onClick={() =>
                        void handleFollowUpAction(item, 'move_down')
                      }
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-9"
                      aria-label={`下移：${item.content}`}
                      title="下移"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busy || locked}
                      onClick={() => beginEditingFollowUp(item)}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-9"
                      aria-label={`编辑：${item.content}`}
                      title="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busy || locked}
                      onClick={() => void handleFollowUpAction(item, 'steer')}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-caption font-medium text-primary-text transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-9"
                      aria-label={`立即发送：${item.content}`}
                    >
                      {busy || locked ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CornerUpLeft className="h-3.5 w-3.5" />
                      )}
                      {locked ? '发送中' : '发送'}
                    </button>
                    <button
                      type="button"
                      disabled={busy || locked}
                      onClick={() => void handleFollowUpAction(item, 'cancel')}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-9"
                      aria-label={`删除排队消息：${item.content}`}
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
