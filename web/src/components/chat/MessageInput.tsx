import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from 'react';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
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
} from 'lucide-react';
import { formatUploadRetryStatus, useFileStore } from '../../stores/files';
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
import { getDraftStorageKey } from '../../lib/draft-storage';

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

/** 单张图片大小上限 5MB */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

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
  sessionId?: string | null;
  disabled?: boolean;
  contextLabel?: string;
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

export function MessageInput({
  onSend,
  groupJid,
  sessionId,
  disabled = false,
  contextLabel,
  onResetSession,
  onToggleTerminal,
  onStop,
  isRunning = false,
  queuedFollowUps = [],
  onFollowUpAction,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [showActions, setShowActions] = useState(false);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const currentDraftKey = getDraftStorageKey(groupJid, sessionId);
  const sessionRef = useRef({
    groupJid,
    sessionId: sessionId || 'main',
    draftKey: currentDraftKey,
  });
  const editRevisionRef = useRef(0);
  const editingFollowUpSessionRef = useRef<string | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  // 窄 selector：这是 1200+ 行常驻组件，无 selector 的整 store 订阅会让它在
  // 流式输出的每一帧（rAF 级 set()）都重渲染一次。actions 引用稳定。
  const uploadFiles = useFileStore((s) => s.uploadFiles);
  const cancelUpload = useFileStore((s) => s.cancelUpload);
  const uploading = useFileStore((s) => s.uploading);
  const uploadProgress = useFileStore((s) => s.uploadProgress);
  const drafts = useChatStore((s) => s.drafts);
  const saveDraft = useChatStore((s) => s.saveDraft);
  const clearDraft = useChatStore((s) => s.clearDraft);
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const clearDraftRef = useRef(clearDraft);
  clearDraftRef.current = clearDraft;
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

  // Restore draft when session changes (Workspace + Session)
  useEffect(() => {
    const prev = sessionRef.current;
    if (prev.draftKey && prev.draftKey !== currentDraftKey) {
      const currentText = content.trim();
      if (currentText) {
        saveDraft(prev.draftKey, currentText);
      } else {
        clearDraft(prev.draftKey);
      }

      // 如果此前在旧 Session 有未保存的排队消息编辑，将其清理并存回旧 Session 草稿，绝不污染新 Session
      if (editingFollowUpId) {
        const recovered = editingFollowUpContentRef.current.trim();
        const initial = editingFollowUpInitialContentRef.current.trim();
        if (recovered && recovered !== initial) {
          const origDraft = drafts[prev.draftKey] || '';
          const merged = origDraft
            ? `${origDraft.trimEnd()}\n\n${recovered}`
            : recovered;
          saveDraft(prev.draftKey, merged);
        }
        setEditingFollowUpId(null);
        setEditingFollowUpContent('');
        editingFollowUpInitialContentRef.current = '';
        editingFollowUpContentRef.current = '';
        editingFollowUpSessionRef.current = null;
      }

      // Drop pending attachments staged for the previous session (会话隔离)
      setPendingImages((prevImages) => {
        prevImages.forEach((img) => URL.revokeObjectURL(img.preview));
        return [];
      });
      setPendingFiles([]);
    }

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }

    // Load draft for new session with one-time legacy key migration and tombstone
    const isMain = !sessionId || sessionId === 'main';
    let draft =
      currentDraftKey && drafts[currentDraftKey] ? drafts[currentDraftKey] : '';
    if (!draft && isMain && groupJid && drafts[groupJid]) {
      // 一次性迁移旧 legacy key 并立即清空旧 key，防止旧草稿日后复活
      draft = drafts[groupJid];
      saveDraft(currentDraftKey, draft);
      clearDraft(groupJid);
    } else if (isMain && groupJid && drafts[groupJid]) {
      // 当前键已有明确记录，彻底移除残留旧 legacy key
      clearDraft(groupJid);
    }

    setContent(draft || '');
    editRevisionRef.current += 1;

    sessionRef.current = {
      groupJid,
      sessionId: sessionId || 'main',
      draftKey: currentDraftKey,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDraftKey, groupJid, sessionId]);

  // Cleanup debounce timer on unmount, save or clear current draft safely
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
      const active = sessionRef.current;
      if (active.draftKey) {
        // 使用 contentRef.current 同步捕获，避免 React passive effect 卸载时 textareaRef.current 已为 null
        const text = contentRef.current.trim();
        if (text) {
          saveDraftRef.current(active.draftKey, text);
        } else {
          // 若用户已删空但防抖未触发即离开页面，可靠清理 store 防止旧草稿非预期复活
          clearDraftRef.current(active.draftKey);
          if (active.sessionId === 'main' && active.groupJid) {
            clearDraftRef.current(active.groupJid);
          }
        }
      }
    };
  }, []);

  // Debounced draft save
  const debouncedSaveDraft = useCallback(
    (text: string) => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
      const targetKey = sessionRef.current.draftKey;
      if (!targetKey) return;
      draftTimerRef.current = setTimeout(() => {
        saveDraft(targetKey, text.trim());
      }, 300);
    },
    [saveDraft],
  );

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

    // 锁定当前发送时的会话身份快照与编辑代次，防止异步完成回调污染或清空其他 Session 及新编辑内容
    const sendingSession = { ...sessionRef.current };
    const sendingEditRevision = editRevisionRef.current;
    const currentImages = [...pendingImages];
    const currentFiles = [...pendingFiles];

    // 发送前将当前 draftKey 确保持久化，并捕获该发送版本对应的 store revision (CAS 凭证)
    const sendingDraftRevision = sendingSession.draftKey
      ? useChatStore.getState().saveDraft(sendingSession.draftKey, trimmed)
      : 0;

    setSending(true);
    setSendError(null);

    // 先组装 message 但不立刻清空 pendingFiles/pendingImages，
    // 让 onSend 失败时用户的附件也能保留、可以重试。
    let message = trimmed;
    if (hasPending) {
      const list = currentFiles.map((f) => `- ${f.label}`).join('\n');
      const prefix = `[我上传了以下文件到工作区，请查看并使用]\n${list}`;
      message = message ? `${prefix}\n\n${message}` : prefix;
    }
    const attachments = hasImages
      ? currentImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
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
      // 发送成功：通过 store CAS 条件更新，仅当该 session 的 draft revision 仍等于提交前版本时才清空，
      // 绝不冲毁后来在该 Session 中新键入（无论是同文 ABA 还是新内容）并保存的新草稿！
      if (sendingSession.draftKey) {
        useChatStore
          .getState()
          .clearDraftIfRevision(sendingSession.draftKey, sendingDraftRevision);
        // 若为 main 会话，同步清理旧 legacy key，防止旧草稿日后复活
        if (sendingSession.sessionId === 'main' && sendingSession.groupJid) {
          useChatStore.getState().clearDraft(sendingSession.groupJid);
        }
      }

      // 只有当前用户仍停留在发起发送的同一个 Session，且输入框在此期间未产生新输入修改时，才清空输入框和待发附件
      const isSameSession =
        sessionRef.current.draftKey === sendingSession.draftKey;
      const isUneditedSinceSend =
        editRevisionRef.current === sendingEditRevision;

      if (isSameSession && isUneditedSinceSend) {
        setContent('');
        contentRef.current = '';
        editRevisionRef.current += 1;
        if (draftTimerRef.current) {
          clearTimeout(draftTimerRef.current);
          draftTimerRef.current = undefined;
        }
        if (hasPending) setPendingFiles([]);
        if (hasImages) {
          currentImages.forEach((img) => URL.revokeObjectURL(img.preview));
          setPendingImages([]);
        }
      } else {
        // 用户已切换到其他会话，或者用户切回后已键入新内容：绝不清空当前内容，只清理先前发送的 preview URL
        currentImages.forEach((img) => URL.revokeObjectURL(img.preview));
      }
    } else {
      // 失败分支：通过 store CAS 条件更新，仅当该 session 的 draft revision 仍等于提交前版本时才保留旧草稿供重试，
      // 绝不覆盖后来用户编辑的新草稿或删空操作！
      if (sendingSession.draftKey && trimmed) {
        useChatStore
          .getState()
          .saveDraftIfRevision(
            sendingSession.draftKey,
            trimmed,
            sendingDraftRevision,
          );
      }

      const isSameSession =
        sessionRef.current.draftKey === sendingSession.draftKey;
      const isUneditedSinceSend =
        editRevisionRef.current === sendingEditRevision;

      if (isSameSession && isUneditedSinceSend) {
        setSendError('发送失败，输入已保留，请重试');
        setTimeout(() => setSendError(null), 4000);
      } else {
        // 同一会话已有新编辑内容或已切走：不回滚新内容，给出明确失败提醒
        setSendError('早先消息发送失败，请重试');
        setTimeout(() => setSendError(null), 4000);
      }
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
    editingFollowUpSessionRef.current = sessionRef.current.draftKey;
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
      editingFollowUpSessionRef.current = null;
    }
  };

  // A run can finish while the user is editing the next queued message. The
  // dispatcher is then allowed to claim that item, so it disappears from the
  // queue before Save can be clicked. Never silently discard what the user
  // typed: move an unsaved edit back into the main composer and explain why.
  // 关键会话隔离：仅在同一 Session 内排队消息被消费才恢复至输入框，跨会话绝不恢复污染其他 Session。
  useEffect(() => {
    if (!editingFollowUpId || savingFollowUpId === editingFollowUpId) return;
    if (editingFollowUpSessionRef.current !== currentDraftKey) return;
    if (queuedFollowUps.some((item) => item.id === editingFollowUpId)) return;

    const recovered = editingFollowUpContentRef.current.trim();
    const initial = editingFollowUpInitialContentRef.current.trim();
    setEditingFollowUpId(null);
    setEditingFollowUpContent('');
    editingFollowUpInitialContentRef.current = '';
    editingFollowUpContentRef.current = '';
    editingFollowUpSessionRef.current = null;

    if (!recovered || recovered === initial) return;
    const nextContent = content.trim()
      ? `${content.trimEnd()}\n\n${recovered}`
      : recovered;
    setContent(nextContent);
    editRevisionRef.current += 1;
    debouncedSaveDraft(nextContent);
    setSendError('这条消息已开始处理，未保存的修改已移到输入框');
    const timer = window.setTimeout(() => setSendError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [
    content,
    currentDraftKey,
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
    const targetSession = { ...sessionRef.current };
    if (!targetSession.groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

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
        const imageErrors: string[] = [];
        for (const file of imageFiles) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : `图片 ${file.name} 处理失败`;
            imageErrors.push(msg);
          }
        }
        if (imageErrors.length > 0) {
          setSendError(imageErrors.join('；'));
          setTimeout(() => setSendError(null), 5000);
        }
        if (sessionRef.current.draftKey === targetSession.draftKey) {
          if (newImages.length > 0) {
            setPendingImages((prev) => [...prev, ...newImages]);
          }
        } else {
          newImages.forEach((img) => URL.revokeObjectURL(img.preview));
        }
      }

      // Upload regular files to workspace
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(targetSession.groupJid, regularFiles);
        if (ok && sessionRef.current.draftKey === targetSession.draftKey) {
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
    const targetSession = { ...sessionRef.current };
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

      const newImages: PendingImage[] = [];
      const imageErrors: string[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : `图片 ${file.name} 处理失败`;
            imageErrors.push(msg);
          }
        }
      }
      if (imageErrors.length > 0) {
        setSendError(imageErrors.join('；'));
        setTimeout(() => setSendError(null), 5000);
      }
      if (sessionRef.current.draftKey === targetSession.draftKey) {
        if (newImages.length > 0) {
          setPendingImages((prev) => [...prev, ...newImages]);
        }
      } else {
        newImages.forEach((img) => URL.revokeObjectURL(img.preview));
      }

      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return Promise.reject(
        new Error(
          `图片 ${file.name} 超过 5MB 限制 (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
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

    const targetSession = { ...sessionRef.current };
    const newImages: PendingImage[] = [];
    const imageErrors: string[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const base64 = await readFileAsBase64(file);
        newImages.push({
          name: file.name || `pasted-${Date.now()}.png`,
          data: base64,
          mimeType: file.type,
          preview: URL.createObjectURL(file),
        });
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : `粘贴图片 ${file.name || ''} 处理失败`;
        imageErrors.push(msg);
      }
    }

    if (imageErrors.length > 0) {
      setSendError(imageErrors.join('；'));
      setTimeout(() => setSendError(null), 5000);
    }

    if (sessionRef.current.draftKey === targetSession.draftKey) {
      if (newImages.length > 0) {
        setPendingImages((prev) => [...prev, ...newImages]);
      }
    } else {
      newImages.forEach((img) => URL.revokeObjectURL(img.preview));
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

      // Capture session state at drop time to prevent stale-chat attachment
      const targetSession = { ...sessionRef.current };
      if (!targetSession.groupJid) return;

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
        const ok = await uploadFiles(targetSession.groupJid, allFiles);
        if (ok && sessionRef.current.draftKey === targetSession.draftKey) {
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
        const imageErrors: string[] = [];
        for (const file of imageFiles) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : `图片 ${file.name} 处理失败`;
            imageErrors.push(msg);
          }
        }

        if (imageErrors.length > 0) {
          setSendError(imageErrors.join('；'));
          setTimeout(() => setSendError(null), 5000);
        }

        // Verify session hasn't changed during async processing
        if (sessionRef.current.draftKey === targetSession.draftKey) {
          if (newImages.length > 0) {
            setPendingImages((prev) => [...prev, ...newImages]);
          }
        } else {
          // Conversation switched — revoke preview URLs to avoid memory leak
          newImages.forEach((img) => URL.revokeObjectURL(img.preview));
        }
      }

      // Upload non-image files to workspace (same as handleFileSelect)
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(targetSession.groupJid, regularFiles);
        if (ok && sessionRef.current.draftKey === targetSession.draftKey) {
          const newPending = regularFiles.map((f) => ({ label: f.name }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
      }
    },
    [groupJid, disabled, sending, uploading, uploadFiles],
  );

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetSession = { ...sessionRef.current };
    if (!targetSession.groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);
      const ok = await uploadFiles(targetSession.groupJid, files);
      if (ok && sessionRef.current.draftKey === targetSession.draftKey) {
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
      className="pt-1 pb-3 bg-surface dark:bg-background max-lg:bg-background/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-t max-lg:border-border/40 relative"
      style={{
        paddingBottom: `max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))`,
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/5 dark:bg-primary/10 backdrop-blur-[2px] border-2 border-dashed border-primary rounded-xl pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="w-8 h-8" />
            <span className="text-sm font-medium">松开上传文件</span>
          </div>
        </div>
      )}
      {/* lg:pl-[60px] = avatar w-8 (32px) + gap-3 (12px) + visual balance (16px), aligns input left edge with message card content */}
      <div
        className={
          isCompact ? 'mx-auto px-4' : 'max-w-4xl mx-auto px-4 lg:pl-[60px]'
        }
      >
        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div
            className={`mb-2 px-4 py-2.5 ${isCompact ? 'bg-surface border border-border' : 'bg-surface rounded-xl border border-border shadow-sm'}`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-foreground/70 truncate max-w-[65%]">
                {uploadProgress.currentFile || '完成'}
                {uploadRetryStatus ? (
                  <span data-upload-retry-status>（{uploadRetryStatus}）</span>
                ) : null}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
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
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {queuedFollowUps.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-xl border border-border bg-muted/30">
            <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              <span>
                {queuedFollowUps.some((item) => item.delivery_mode === 'steer')
                  ? '正在停止当前回复，随后发送引导消息'
                  : queuedFollowUps.length > 1
                    ? `${queuedFollowUps.length} 条消息已排队，将合并为下一轮`
                    : '1 条消息已排队'}
              </span>
            </div>
            <div className="max-h-56 divide-y divide-border/70 overflow-y-auto">
              {queuedFollowUps.map((item, index) => {
                const busy = actingOn.has(item.id);
                const steering = item.delivery_mode === 'steer';
                const locked = steering || item.delivery_status === 'promoting';
                const editing = editingFollowUpId === item.id;
                return (
                  <div
                    key={item.id}
                    className="flex min-w-0 items-start gap-2 px-3 py-2"
                  >
                    <span className="mt-1.5 shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    {editing ? (
                      <div className="min-w-0 flex-1 space-y-2">
                        <textarea
                          value={editingFollowUpContent}
                          onChange={(event) => {
                            editingFollowUpContentRef.current =
                              event.target.value;
                            setEditingFollowUpContent(event.target.value);
                          }}
                          rows={2}
                          autoFocus
                          className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-xs leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label="编辑排队消息"
                        />
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingFollowUpId(null);
                              setEditingFollowUpContent('');
                              editingFollowUpInitialContentRef.current = '';
                              editingFollowUpContentRef.current = '';
                            }}
                            className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" />
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={busy || !editingFollowUpContent.trim()}
                            onClick={() => void saveFollowUpEdit(item)}
                            className="inline-flex min-h-8 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
                      <div className="min-w-0 flex-1">
                        <span
                          className="block whitespace-pre-wrap break-words pt-1 text-xs leading-5 text-foreground/80"
                          title={item.content}
                        >
                          {item.content}
                        </span>
                        <div className="mt-1 flex flex-wrap items-center justify-end gap-0.5">
                          <button
                            type="button"
                            disabled={busy || locked || index === 0}
                            onClick={() =>
                              void handleFollowUpAction(item, 'move_up')
                            }
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label={`上移：${item.content}`}
                            title="上移"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy ||
                              locked ||
                              index === queuedFollowUps.length - 1
                            }
                            onClick={() =>
                              void handleFollowUpAction(item, 'move_down')
                            }
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label={`下移：${item.content}`}
                            title="下移"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy || locked}
                            onClick={() => beginEditingFollowUp(item)}
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label={`编辑：${item.content}`}
                            title="编辑"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy || locked}
                            onClick={() =>
                              void handleFollowUpAction(item, 'steer')
                            }
                            className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-primary transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
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
                            onClick={() =>
                              void handleFollowUpAction(item, 'cancel')
                            }
                            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
        )}

        {/* Main input card */}
        <div
          className={
            isCompact
              ? 'bg-surface border border-border rounded-lg'
              : 'bg-surface rounded-2xl border border-border shadow-sm'
          }
        >
          {/* Send error banner */}
          {sendError && (
            <div
              role="alert"
              aria-live="polite"
              className={`px-4 py-2 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-100 dark:border-red-800 flex items-center gap-2 ${isCompact ? 'rounded-t-lg' : 'rounded-t-2xl'}`}
            >
              <span>{sendError}</span>
            </div>
          )}

          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-border">
              <div className="flex items-center gap-1 mb-1.5">
                <ImageIcon className="w-3 h-3 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  已添加 {pendingImages.length} 张图片
                </span>
                <button
                  onClick={clearPendingImages}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground/70 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pb-1.5">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={img.preview}
                      alt={img.name}
                      className="w-16 h-16 object-cover rounded-lg border border-border"
                    />
                    <button
                      onClick={() => removePendingImage(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-foreground/90"
                      aria-label="移除图片"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending files chips */}
          {pendingFiles.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-border">
              <div className="flex items-center gap-1 mb-1">
                <Paperclip className="w-3 h-3 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  已上传 {pendingFiles.length} 个文件，发送时将告知 AI
                </span>
                <button
                  onClick={clearPendingFiles}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground/70 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1 pb-1">
                {pendingFiles.map((file, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 max-w-[200px] px-2 py-0.5 bg-brand-50 text-primary text-[11px] rounded-md"
                  >
                    <span className="truncate">{file.label}</span>
                    <button
                      onClick={() => removePendingFile(i)}
                      className="flex-shrink-0 hover:text-primary cursor-pointer p-1 min-w-[28px] min-h-[28px] flex items-center justify-center"
                      aria-label="移除文件"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action row — shown when attach is toggled */}
          {showActions && groupJid && (
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 border-b border-border">
              <button
                onClick={() => imageInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/40 rounded-lg transition-colors cursor-pointer"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                添加图片
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FileUp className="w-3.5 h-3.5" />
                上传文件
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={uploading}
                className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground/70 bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FolderUp className="w-3.5 h-3.5" />
                上传文件夹
              </button>
            </div>
          )}

          {/* Textarea */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                editRevisionRef.current += 1;
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
              placeholder="输入消息..."
              aria-label={
                contextLabel ? `输入给 ${contextLabel} 的消息` : '输入消息'
              }
              disabled={disabled}
              className="w-full text-base leading-6 resize-none focus:outline-none placeholder:text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed bg-transparent"
              rows={1}
              style={{ minHeight: '28px', maxHeight: '144px' }}
            />
          </div>

          {/* Bottom action bar */}
          <div className="flex items-center px-2 pb-2.5">
            {/* Left: action icons */}
            <div className="flex items-center gap-0.5">
              {groupJid && (
                <button
                  type="button"
                  onClick={() => setShowActions(!showActions)}
                  disabled={uploading}
                  className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                    showActions
                      ? 'bg-brand-50 text-primary'
                      : 'hover:bg-muted text-muted-foreground hover:text-foreground/70'
                  } ${uploading ? 'opacity-40 pointer-events-none' : ''}`}
                  title="添加文件"
                  aria-label="添加文件"
                >
                  <Paperclip className="w-4.5 h-4.5" />
                </button>
              )}
              {onResetSession && (
                <button
                  type="button"
                  onClick={onResetSession}
                  className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-amber-50 dark:hover:bg-amber-950/40 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-all cursor-pointer"
                  title="清除上下文"
                  aria-label="清除当前会话上下文"
                >
                  <Eraser className="w-4.5 h-4.5" />
                </button>
              )}
              {onToggleTerminal && (
                <button
                  type="button"
                  onClick={onToggleTerminal}
                  className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-brand-50 text-muted-foreground hover:text-primary transition-all cursor-pointer"
                  title="终端"
                  aria-label="终端"
                >
                  <TerminalSquare className="w-4.5 h-4.5" />
                </button>
              )}
            </div>

            {contextLabel && (
              <span
                className="ml-1 inline-flex min-w-0 max-w-[min(42vw,180px)] items-center rounded-md bg-brand-50 px-2 py-1 text-[10px] font-medium text-primary dark:bg-brand-700/15 dark:text-brand-300"
                title={`发送到：${contextLabel}`}
              >
                <span className="truncate">{contextLabel}</span>
              </span>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right: one contextual primary action, matching Codex. */}
            <button
              type="button"
              onClick={() => (showStop ? void handleStop() : void handleSend())}
              disabled={
                showStop
                  ? disabled || stopping
                  : !canSend || disabled || sending
              }
              title={showStop ? '停止当前运行' : '发送消息'}
              aria-label={showStop ? '停止当前运行' : '发送消息'}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all cursor-pointer active:scale-90 ${
                showStop && !disabled && !stopping
                  ? 'bg-foreground text-background hover:bg-foreground/90'
                  : canSend && !disabled && !sending
                    ? 'bg-primary text-white hover:bg-primary/90 max-lg:shadow-[0_2px_8px_rgba(249,115,22,0.3)]'
                    : 'bg-muted text-muted-foreground'
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
            >
              {sending || stopping ? (
                <Loader2 className="w-4.5 h-4.5 animate-spin" />
              ) : showStop ? (
                <Square className="w-4 h-4 fill-current" />
              ) : (
                <ArrowUp className="w-4.5 h-4.5" />
              )}
            </button>
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
}
