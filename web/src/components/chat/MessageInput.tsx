import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  memo,
  type Ref,
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
  MoreHorizontal,
} from 'lucide-react';
import { formatUploadRetryStatus, useFileStore } from '../../stores/files';
import { useShellStore } from '../../stores/shell';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { IconButton } from '../common/IconButton';
import { Shortcut } from '../common/Shortcut';
import { ImageLightbox } from './ImageLightbox';
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
import {
  composerTextAfterSend,
  isGlobalStopEscape,
  parseQueuedImageAttachments,
  queuedFollowUpLabel,
  type QueuedImagePreview,
} from './composer-helpers';

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

export interface MessageInputHandle {
  /**
   * Stage files dropped anywhere on the chat canvas exactly as a drop on the
   * composer: images inline, other files and folders uploaded to the
   * workspace. Must be called while the drop event is still being dispatched.
   */
  acceptDrop: (dataTransfer: DataTransfer) => void;
}

interface MessageInputProps {
  /**
   * 发送回调。返回 boolean 表示发送是否成功：
   * - true：MessageInput 清空本次发出的内容和附件（发送期间新输入的保留）
   * - false：保留输入框内容和附件，用户可重试（弱网/断网场景）
   */
  onSend: (
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => Promise<boolean> | boolean;
  groupJid?: string;
  /**
   * Conversation the draft and pending attachments belong to: the session
   * chat jid (`${groupJid}#agent:${id}`), or the workspace jid for the main
   * conversation. Defaults to `groupJid`.
   */
  draftKey?: string;
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
  ref?: Ref<MessageInputHandle>;
}

// ChatView remounts the composer per conversation. Focus and starter-prompt
// requests live in the shell store and outlast any one instance, so instances
// share what was already handled: a request made in the same tick as a
// switch still reaches the new composer, an old one is not replayed on every
// switch, and a caret in the composer follows the user into the next one.
const FOCUS_HANDOFF_MS = 1000;
// A visual viewport at least this much shorter than the layout viewport means
// a software keyboard is up (a hardware keyboard's shortcut bar is smaller).
const SOFT_KEYBOARD_MIN_PX = 150;
let focusHandoffAt = Number.NEGATIVE_INFINITY;
let handledFocusRequest = { nonce: 0, at: Number.NEGATIVE_INFINITY };
let handledDraftRequestNonce = 0;

// Memoized: ChatView re-renders for dialogs, panels and run status; the
// transcript and composer only need to when their own props change.
export const MessageInput = memo(function MessageInput({
  onSend,
  groupJid,
  draftKey,
  disabled = false,
  contextLabel,
  placeholder = '输入消息...',
  onResetSession,
  onToggleTerminal,
  onStop,
  isRunning = false,
  queuedFollowUps = [],
  onFollowUpAction,
  ref,
}: MessageInputProps) {
  const draftTarget = draftKey ?? groupJid;
  const storedDraft = useChatStore((s) =>
    draftTarget ? s.drafts[draftTarget] : undefined,
  );
  const [content, setContent] = useState(() => storedDraft ?? '');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // "New conversation" (sidebar / ⌘⇧O / ⌘K) asks the composer for focus.
  const composerFocusNonce = useShellStore((s) => s.composerFocusNonce);
  useEffect(() => {
    if (composerFocusNonce === 0) return;
    const now = performance.now();
    if (composerFocusNonce === handledFocusRequest.nonce) {
      // Applied already; only the composer that replaced it moments ago
      // (new session + focus in one tick) still takes it.
      if (now - handledFocusRequest.at > FOCUS_HANDOFF_MS) return;
    } else {
      handledFocusRequest = { nonce: composerFocusNonce, at: now };
    }
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerFocusNonce]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea && performance.now() - focusHandoffAt < FOCUS_HANDOFF_MS) {
      focusHandoffAt = Number.NEGATIVE_INFINITY;
      textarea.focus({ preventScroll: true });
    }
    return () => {
      // Layout cleanups run before the node leaves the DOM.
      if (textarea && document.activeElement === textarea) {
        focusHandoffAt = performance.now();
      }
    };
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const draftTargetRef = useRef(draftTarget);
  draftTargetRef.current = draftTarget;
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  // The send in flight. Its text leaves the stored draft as soon as it starts
  // and stays out of every draft written meanwhile, so a composer remounted
  // for this conversation mid-send never offers it for sending again.
  const inFlightSendRef = useRef<{ key: string; text: string } | null>(null);
  // The stored draft as this instance last wrote or adopted it, and the
  // composer text at the last adoption (see the adoption effect).
  const knownDraftRef = useRef(storedDraft ?? '');
  const adoptedContentRef = useRef(storedDraft ?? '');
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  // The conversation async attachment work may still stage into. Cleared on
  // unmount, so results that resolve after a switch are dropped.
  const stagingTargetRef = useRef<string | null>(null);
  useEffect(() => {
    stagingTargetRef.current = draftTarget ?? '';
    return () => {
      stagingTargetRef.current = null;
    };
  }, [draftTarget]);
  const isCurrentTarget = (target: string | undefined) =>
    stagingTargetRef.current === (target ?? '');

  // 窄 selector：这是 1200+ 行常驻组件，无 selector 的整 store 订阅会让它在
  // 流式输出的每一帧（rAF 级 set()）都重渲染一次。actions 引用稳定。
  const uploadFiles = useFileStore((s) => s.uploadFiles);
  const cancelUpload = useFileStore((s) => s.cancelUpload);
  const uploading = useFileStore((s) => s.uploading);
  const uploadProgress = useFileStore((s) => s.uploadProgress);
  const saveDraft = useChatStore((s) => s.saveDraft);
  /** Store `text` as the draft of `key`, minus a send still in flight. */
  const persistDraft = useCallback(
    (key: string | undefined, text: string) => {
      if (!key) return;
      const inFlight = inFlightSendRef.current;
      const value = (
        inFlight?.key === key
          ? composerTextAfterSend(text, inFlight.text)
          : text
      ).trim();
      if (key === draftTargetRef.current) knownDraftRef.current = value;
      saveDraft(key, value);
    },
    [saveDraft],
  );
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const isTouchInput = useMediaQuery('(pointer: coarse) and (hover: none)');
  const isPhoneWidth = useMediaQuery('(max-width: 639px)');
  const isWideViewport = useMediaQuery('(min-width: 1024px)');

  // iOS keyboard adaptation
  const { keyboardHeight, isKeyboardVisible } = useKeyboardHeight();
  // Enter types a newline where a software keyboard is the input: phones, and
  // any touch screen while one is up. Desktops (narrow windows included) and
  // wide touch screens without one (a tablet on a hardware keyboard) send on
  // Enter. Mod+Enter sends everywhere.
  const enterInsertsNewline =
    isTouchInput && (!isWideViewport || keyboardHeight >= SOFT_KEYBOARD_MIN_PX);

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

  // ChatView remounts the composer per conversation (key = draft key), which
  // restores the draft through the initial state. A parent that reuses one
  // instance across conversations gets the same isolation here.
  const prevDraftTargetRef = useRef(draftTarget);
  useEffect(() => {
    const previous = prevDraftTargetRef.current;
    if (previous === draftTarget) return;
    prevDraftTargetRef.current = draftTarget;
    persistDraft(previous, latestContentRef.current);
    knownDraftRef.current = storedDraft ?? '';
    adoptedContentRef.current = storedDraft ?? '';
    setContent(storedDraft ?? '');
    // Pending attachments were staged for the previous conversation and must
    // not leak into this one (会话隔离). Release their preview URLs.
    setPendingImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview));
      return [];
    });
    setPendingFiles([]);
    setPreviewIndex(null);
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTarget]);

  // A composer that unmounted mid-send settles this conversation's draft when
  // its send resolves (the text comes back after a failure). Follow such a
  // change while nothing has been typed here since.
  useEffect(() => {
    const next = storedDraft ?? '';
    if (next === knownDraftRef.current) return;
    knownDraftRef.current = next;
    if (latestContentRef.current !== adoptedContentRef.current) return;
    adoptedContentRef.current = next;
    setContent(next);
  }, [storedDraft]);

  // On unmount, flush a draft save that is still waiting on its debounce,
  // so the last keystrokes before leaving the conversation are kept, and
  // release the previews of attachments that were never sent.
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
        persistDraft(draftTargetRef.current, latestContentRef.current);
      }
      pendingImagesRef.current.forEach((img) =>
        URL.revokeObjectURL(img.preview),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced draft save
  const debouncedSaveDraft = useCallback(
    (text: string) => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = undefined;
        persistDraft(draftTarget, text);
      }, 300);
    },
    [draftTarget, persistDraft],
  );

  // Starter prompts fill the composer so the user can edit before sending.
  const composerDraftRequest = useShellStore((s) => s.composerDraftRequest);
  useEffect(() => {
    if (
      !composerDraftRequest ||
      composerDraftRequest.nonce === handledDraftRequestNonce
    ) {
      return;
    }
    handledDraftRequestNonce = composerDraftRequest.nonce;
    const text = composerDraftRequest.text;
    const next = content.trim() ? `${content.trimEnd()}\n${text}` : text;
    setContent(next);
    debouncedSaveDraft(next);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
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

  const hasContent = content.trim().length > 0;
  const hasPayload =
    hasContent || pendingFiles.length > 0 || pendingImages.length > 0;
  const canSend = hasPayload && !sending;
  const canStop = isRunning && !!onStop;
  const showStop = canStop && !hasPayload && !sending;

  // IME composition state — prevent Enter from sending while composing (e.g. Chinese input)
  // On Chrome macOS, compositionEnd fires before the Enter keyDown, so we track
  // the timestamp and ignore Enter within 100ms after composition ends.
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari and some Android IMEs deliver the committing Enter after
    // compositionend, marked only by keyCode 229.
    if (
      composingRef.current ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229
    ) {
      return;
    }
    if (e.key === 'Escape') {
      if (showStop) {
        e.preventDefault();
        void handleStop();
      }
      return;
    }
    if (e.key !== 'Enter') return;
    if (Date.now() - compositionEndTimeRef.current < 100) return;
    const withMod = e.metaKey || e.ctrlKey;
    if (e.shiftKey) {
      if (!withMod) return;
      e.preventDefault();
      void handleSend(
        isRunning ? alternateFollowUpMode(followUpMode) : undefined,
      );
      return;
    }
    if (enterInsertsNewline && !withMod) return;
    e.preventDefault();
    void handleSend();
  };

  const handleSend = async (modeOverride?: FollowUpMode) => {
    // Snapshot what this send carries. The composer stays editable while the
    // request is in flight; only this snapshot leaves it on success.
    const sentText = content;
    const trimmed = sentText.trim();
    const sentFiles = pendingFiles;
    const sentImages = pendingImages;
    const target = draftTarget;

    if (!trimmed && sentFiles.length === 0 && sentImages.length === 0) return;
    if (disabled || sending) return;

    setSending(true);
    setSendError(null);
    if (target) {
      inFlightSendRef.current = { key: target, text: sentText };
      persistDraft(target, sentText);
    }

    // 先组装 message 但不立刻清空 pendingFiles/pendingImages，
    // 让 onSend 失败时用户的附件也能保留、可以重试。
    let message = trimmed;
    if (sentFiles.length > 0) {
      const list = sentFiles.map((f) => `- ${f.label}`).join('\n');
      const prefix = `[我上传了以下文件到工作区，请查看并使用]\n${list}`;
      message = message ? `${prefix}\n\n${message}` : prefix;
    }
    const attachments =
      sentImages.length > 0
        ? sentImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
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

    // Switched away mid-flight: this instance's state is gone or belongs to
    // another conversation; only the stored draft of `target` is fixed up.
    const stillHere = isCurrentTarget(target);
    inFlightSendRef.current = null;
    if (ok) {
      successTap();
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      persistDraft(
        target,
        composerTextAfterSend(latestContentRef.current, sentText),
      );
      sentImages.forEach((img) => URL.revokeObjectURL(img.preview));
      if (stillHere) {
        setContent((current) => composerTextAfterSend(current, sentText));
        if (sentFiles.length > 0) {
          setPendingFiles((prev) =>
            prev.filter((file) => !sentFiles.includes(file)),
          );
        }
        if (sentImages.length > 0) {
          setPreviewIndex(null);
          setPendingImages((prev) =>
            prev.filter((img) => !sentImages.includes(img)),
          );
        }
      }
    } else {
      // 失败：保留输入、保留附件；同步保存草稿，切换会话后也能恢复。
      persistDraft(target, latestContentRef.current);
      if (stillHere) {
        setSendError('发送失败，输入已保留，请重试');
        setTimeout(() => setSendError(null), 4000);
      } else {
        toast.error('发送失败，内容已放回该会话的输入框');
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

  // Esc stops the run from the page too, when nothing has focus and no
  // dialog or menu is open (those keep Esc for closing themselves).
  const stopFromPageEscape = useStableCallback((event: KeyboardEvent) => {
    if (previewIndex !== null || !isGlobalStopEscape(event)) return;
    event.preventDefault();
    void handleStop();
  });
  useEffect(() => {
    if (!canStop) return;
    document.addEventListener('keydown', stopFromPageEscape);
    return () => document.removeEventListener('keydown', stopFromPageEscape);
  }, [canStop, stopFromPageEscape]);

  /** Add attachments for `target` unless the composer has moved on. */
  const stageImages = (target: string | undefined, images: PendingImage[]) => {
    if (images.length === 0) return;
    if (!isCurrentTarget(target)) {
      images.forEach((img) => URL.revokeObjectURL(img.preview));
      return;
    }
    setPendingImages((prev) => [...prev, ...images]);
  };
  const stageFiles = (target: string | undefined, files: PendingFile[]) => {
    if (files.length === 0) return;
    if (!isCurrentTarget(target)) {
      toast.info(
        `${files.length} 个文件已上传到工作区，会话已切换，未附加到消息`,
      );
      return;
    }
    setPendingFiles((prev) => [...prev, ...files]);
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

  const toPendingImages = async (files: File[], fallbackName?: string) => {
    const images: PendingImage[] = [];
    for (const file of files) {
      const image = await toPendingImage(file, fallbackName);
      if (image) images.push(image);
    }
    return images;
  };

  const uploadAndStage = async (
    target: string | undefined,
    workspaceJid: string,
    files: File[],
  ) => {
    if (files.length === 0) return;
    const ok = await uploadFiles(workspaceJid, files);
    if (!ok) return;
    stageFiles(
      target,
      files.map((f) => ({
        label:
          (f as unknown as { webkitRelativePath?: string })
            .webkitRelativePath || f.name,
      })),
    );
  };

  // "上传文件" puts every picked file in the workspace, images included, as
  // its label says; "添加图片" is the inline-image path.
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!groupJid || files.length === 0) return;
    await uploadAndStage(draftTarget, groupJid, files);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!groupJid || files.length === 0) return;
    await uploadAndStage(draftTarget, groupJid, files);
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    e.target.value = '';
    if (files.length === 0) return;
    const target = draftTarget;
    stageImages(target, await toPendingImages(files));
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

    const target = draftTarget;
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    stageImages(
      target,
      await toPendingImages(files, `pasted-${Date.now()}.png`),
    );
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

  // Drops land on the whole chat canvas (ChatView) and are routed here.
  const acceptDrop = useStableCallback((dataTransfer: DataTransfer) => {
    // Guard: respect disabled/uploading state. Sending is fine: only the
    // attachments of the in-flight message leave the composer.
    if (!groupJid || disabled) return;
    if (uploading) {
      toast.info('正在上传，请等当前上传完成后再拖入文件');
      return;
    }

    // Capture the targets at drop time to prevent stale-chat attachment
    const targetGroupJid = groupJid;
    const target = draftTarget;

    // Collect files, expanding directories via webkitGetAsEntry.
    // 同步提取所有 item 的 entry/file，避免 drop 事件结束后 DataTransferItemList
    // 被浏览器清理（Firefox/Safari）导致后续 item 返回 null 而静默丢失。
    const collected = Array.from(dataTransfer.items).map((item) => ({
      entry: item.webkitGetAsEntry?.() ?? null,
      file: item.getAsFile(),
    }));

    void (async () => {
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
            if (isCurrentTarget(target)) {
              setSendError('读取文件夹失败');
              setTimeout(() => setSendError(null), 4000);
            }
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
        await uploadAndStage(target, targetGroupJid, allFiles);
        return;
      }

      // For individual files: images inline, regular files to the workspace
      const imageFiles = allFiles.filter((file) =>
        file.type.startsWith('image/'),
      );
      const regularFiles = allFiles.filter(
        (file) => !file.type.startsWith('image/'),
      );
      if (imageFiles.length > 0) {
        stageImages(target, await toPendingImages(imageFiles));
      }
      await uploadAndStage(target, targetGroupJid, regularFiles);
    })();
  });
  useImperativeHandle(ref, () => ({ acceptDrop }), [acceptDrop]);

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removePendingImage = (index: number) => {
    setPreviewIndex(null);
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
    setPreviewIndex(null);
    pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setPendingImages([]);
  };

  // While a run is active, a payload is queued or steers the run depending on
  // the default follow-up mode; mod+shift+enter picks the other one.
  const followUpLabel = (mode: FollowUpMode) =>
    mode === 'steer' ? '引导当前运行' : '加入队列，下一轮发送';
  const sendLabel = showStop
    ? '停止当前运行'
    : isRunning
      ? followUpLabel(followUpMode)
      : '发送消息';

  // Phones get a one-line queue summary: an expanded queue above the
  // composer leaves too little room for the conversation.
  const queueCollapsible = isTouchInput || isPhoneWidth;

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
      data-hc-composer
      className="relative bg-background pt-1 pb-3 max-lg:border-t max-lg:border-surface-border max-lg:bg-background/80 max-lg:backdrop-blur-xl"
      style={{
        paddingBottom: `max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))`,
      }}
    >
      {/* Soft fade so scrolled messages don't end at a hard edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background max-lg:hidden"
      />
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
                  className="inline-flex items-center gap-0.5 hover:text-foreground pointer-coarse:min-h-10 pointer-coarse:px-2"
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
            touch={isTouchInput}
            collapsible={queueCollapsible}
            // Typing with the keyboard up needs the room more than the queue;
            // editing a queued item is the exception (its own field is up).
            collapseNow={!!isKeyboardVisible && !editingFollowUpId}
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

          {/* Attachment tray: image thumbnails and file chips in one row */}
          {(pendingImages.length > 0 || pendingFiles.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
              {pendingImages.map((img, i) => (
                <div key={img.preview} className="group/attachment relative">
                  <button
                    type="button"
                    onClick={() => setPreviewIndex(i)}
                    className="block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    aria-label={`预览图片：${img.name}`}
                  >
                    <img
                      src={img.preview}
                      alt={img.name}
                      className="size-14 rounded-lg object-cover ring-1 ring-surface-border"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removePendingImage(i)}
                    className="absolute -top-2 -right-2 flex size-6 cursor-pointer items-center justify-center rounded-full bg-foreground text-background shadow-menu transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/attachment:opacity-100 pointer-fine:group-focus-within/attachment:opacity-100 focus-visible:opacity-100 pointer-coarse:before:absolute pointer-coarse:before:-inset-2"
                    aria-label="移除图片"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              {pendingFiles.map((file, i) => (
                <span
                  key={`file-${i}`}
                  title={`${file.label}（已上传，发送时将告知 AI）`}
                  className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg bg-muted pl-2.5 text-caption text-foreground ring-1 ring-surface-border pointer-coarse:h-10"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.label}</span>
                  <button
                    type="button"
                    onClick={() => removePendingFile(i)}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground pointer-coarse:size-10"
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
                  className="h-8 cursor-pointer rounded-md px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground pointer-coarse:h-10"
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

            {/* A draft turns the primary action into queue/send; keep stop
                reachable next to it. */}
            {canStop && hasPayload && !sending && (
              <IconButton
                label="停止当前运行"
                icon={
                  stopping ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Square className="size-3 fill-current" />
                  )
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void handleStop()}
                disabled={disabled || stopping}
                tooltipSide="top"
                className="rounded-full text-muted-foreground pointer-coarse:size-10"
              />
            )}

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
                  {sending || (showStop && stopping) ? (
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
                <span className="flex items-center gap-1.5">
                  {sendLabel}
                  {showStop && <Shortcut keys="escape" />}
                </span>
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

      {previewIndex !== null && pendingImages[previewIndex] && (
        <ImageLightbox
          images={pendingImages.map((img) => img.preview)}
          initialIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}

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
  /** Coarse pointer: one row per item, secondary actions in a menu. */
  touch: boolean;
  /** Start as a one-line summary that expands on demand. */
  collapsible: boolean;
  /** Fold an expanded queue back to its summary (keyboard came up). */
  collapseNow: boolean;
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
  touch,
  collapsible,
  collapseNow,
  actingOn,
  editingFollowUpId,
  editingFollowUpContent,
  handleFollowUpAction,
  beginEditingFollowUp,
  saveFollowUpEdit,
  onEditChange,
  onCancelEdit,
}: QueuedFollowUpsPanelProps) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (collapseNow) setExpanded(false);
  }, [collapseNow]);
  // Collapsing mid-edit only hides the editor; the edit itself is kept.
  const open = !collapsible || expanded;
  const steering = queuedFollowUps.some(
    (item) => item.delivery_mode === 'steer',
  );
  const summary = steering
    ? '正在停止当前回复，随后发送引导消息'
    : queuedFollowUps.length > 1
      ? `${queuedFollowUps.length} 条消息已排队，将合并为下一轮`
      : '1 条消息已排队';
  const collapsedSummary = steering
    ? '正在发送引导消息'
    : `${queuedFollowUps.length} 条已排队`;

  return (
    <div
      data-testid="queued-follow-ups"
      data-state={open ? 'open' : 'closed'}
      className={`relative z-0 -mb-3 overflow-hidden bg-app-shell pb-3 ring-1 ring-surface-border ${compact ? 'mx-2 rounded-t-lg' : 'mx-3 rounded-t-xl'}`}
    >
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset pointer-coarse:h-10"
        >
          <Clock3 className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {open ? summary : collapsedSummary}
          </span>
          <span className="shrink-0 font-medium text-foreground/70">
            · {open ? '收起' : '展开'}
          </span>
          {open ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0" />
          ) : (
            <ChevronUp className="ml-auto size-3.5 shrink-0" />
          )}
        </button>
      ) : (
        <div className="flex h-8 items-center gap-2 px-3 text-caption text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          <span>{summary}</span>
        </div>
      )}
      {open && (
        <div
          id={listId}
          data-testid="queued-follow-ups-list"
          className={cn(
            'divide-y divide-surface-border overflow-y-auto overscroll-contain border-t border-surface-border',
            collapsible ? 'max-h-[30dvh]' : 'max-h-56',
          )}
        >
          {queuedFollowUps.map((item, index) => (
            <QueuedFollowUpRow
              key={item.id}
              item={item}
              index={index}
              isLast={index === queuedFollowUps.length - 1}
              touch={touch}
              busy={actingOn.has(item.id)}
              editing={editingFollowUpId === item.id}
              editingFollowUpContent={editingFollowUpContent}
              handleFollowUpAction={handleFollowUpAction}
              beginEditingFollowUp={beginEditingFollowUp}
              saveFollowUpEdit={saveFollowUpEdit}
              onEditChange={onEditChange}
              onCancelEdit={onCancelEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface QueuedFollowUpRowProps {
  item: QueuedFollowUp;
  index: number;
  isLast: boolean;
  touch: boolean;
  busy: boolean;
  editing: boolean;
  editingFollowUpContent: string;
  handleFollowUpAction: QueuedFollowUpsPanelProps['handleFollowUpAction'];
  beginEditingFollowUp: QueuedFollowUpsPanelProps['beginEditingFollowUp'];
  saveFollowUpEdit: QueuedFollowUpsPanelProps['saveFollowUpEdit'];
  onEditChange: QueuedFollowUpsPanelProps['onEditChange'];
  onCancelEdit: QueuedFollowUpsPanelProps['onCancelEdit'];
}

const ROW_ICON_BUTTON =
  'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-10';

/**
 * A steer stops the current reply and releases the queue with it: queued
 * messages go to the next turn together with this one (CLAUDE.md §6.4).
 */
const STEER_NOW_DESCRIPTION = '将停止当前回复，与已排队的消息一起立即发送';

function QueuedFollowUpRow({
  item,
  index,
  isLast,
  touch,
  busy,
  editing,
  editingFollowUpContent,
  handleFollowUpAction,
  beginEditingFollowUp,
  saveFollowUpEdit,
  onEditChange,
  onCancelEdit,
}: QueuedFollowUpRowProps) {
  const steering = item.delivery_mode === 'steer';
  const locked = steering || item.delivery_status === 'promoting';
  const images = useMemo(
    () => parseQueuedImageAttachments(item.attachments),
    [item.attachments],
  );
  const label = queuedFollowUpLabel(item.content, images.length);

  const sendNow = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={busy || locked}
          onClick={() => void handleFollowUpAction(item, 'steer')}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-caption font-medium text-primary-text transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
          aria-label={`立即发送：${label}`}
          aria-description={STEER_NOW_DESCRIPTION}
        >
          {busy || locked ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CornerUpLeft className="h-3.5 w-3.5" />
          )}
          {locked ? '发送中' : '立即发送'}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{STEER_NOW_DESCRIPTION}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="group/queued flex min-w-0 items-start gap-2 px-3 py-1.5">
      <span className="mt-1.5 shrink-0 text-micro font-medium text-faint-foreground tabular-nums pointer-coarse:mt-3">
        {index + 1}
      </span>
      {editing ? (
        <div className="min-w-0 flex-1 space-y-2">
          <textarea
            value={editingFollowUpContent}
            onChange={(event) => onEditChange(event.target.value)}
            onFocus={(event) => {
              // The editor opens with the caret where the message ends, not
              // before it; later focus keeps wherever the user clicked.
              const field = event.currentTarget;
              if (field.dataset.caretPlaced) return;
              field.dataset.caretPlaced = 'true';
              field.setSelectionRange(field.value.length, field.value.length);
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              ) {
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCancelEdit();
              } else if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                void saveFollowUpEdit(item);
              }
            }}
            rows={2}
            autoFocus
            className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-caption leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:text-base"
            aria-label="编辑排队消息"
          />
          <div className="flex items-center justify-end gap-1">
            <span className="mr-auto text-micro text-faint-foreground pointer-coarse:hidden">
              Esc 取消 · <Shortcut keys="mod+enter" /> 保存
            </span>
            <button
              type="button"
              onClick={onCancelEdit}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted-foreground hover:bg-surface-hover hover:text-foreground pointer-coarse:h-10"
            >
              <X className="h-3.5 w-3.5" />
              取消
            </button>
            <button
              type="button"
              disabled={busy || !editingFollowUpContent.trim()}
              onClick={() => void saveFollowUpEdit(item)}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-caption font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-10"
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
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <QueuedFollowUpContent
            content={item.content}
            images={images}
            touch={touch}
          />
          {touch ? (
            // One row per item on touch: the primary action inline, the
            // rest behind a menu instead of a second row of buttons.
            <div className="flex shrink-0 items-center gap-0.5 -mr-1.5">
              {sendNow}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={busy || locked}
                    className={ROW_ICON_BUTTON}
                    aria-label={`更多操作：${label}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-36">
                  <DropdownMenuItem
                    disabled={index === 0}
                    onSelect={() => void handleFollowUpAction(item, 'move_up')}
                  >
                    <ChevronUp />
                    上移
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={isLast}
                    onSelect={() =>
                      void handleFollowUpAction(item, 'move_down')
                    }
                  >
                    <ChevronDown />
                    下移
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => beginEditingFollowUp(item)}>
                    <Pencil />
                    编辑
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void handleFollowUpAction(item, 'cancel')}
                  >
                    <Trash2 />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/queued:opacity-100 pointer-fine:group-focus-within/queued:opacity-100">
              <button
                type="button"
                disabled={busy || locked || index === 0}
                onClick={() => void handleFollowUpAction(item, 'move_up')}
                className={ROW_ICON_BUTTON}
                aria-label={`上移：${label}`}
                title="上移"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={busy || locked || isLast}
                onClick={() => void handleFollowUpAction(item, 'move_down')}
                className={ROW_ICON_BUTTON}
                aria-label={`下移：${label}`}
                title="下移"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => beginEditingFollowUp(item)}
                className={ROW_ICON_BUTTON}
                aria-label={`编辑：${label}`}
                title="编辑"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              {sendNow}
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => void handleFollowUpAction(item, 'cancel')}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-10"
                aria-label={`删除排队消息：${label}`}
                title="删除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QueuedFollowUpContent({
  content,
  images,
  touch,
}: {
  content: string;
  images: QueuedImagePreview[];
  touch: boolean;
}) {
  const text = content.trim();
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5 pt-1 pointer-coarse:pt-2.5">
      {images.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {images.slice(0, 3).map((image, i) => (
            <img
              key={i}
              src={image.src}
              alt=""
              className="size-5 rounded object-cover ring-1 ring-surface-border"
            />
          ))}
          {images.length > 3 && (
            <span className="text-micro text-muted-foreground">
              +{images.length - 3}
            </span>
          )}
        </span>
      )}
      <span
        className={cn(
          'block min-w-0 flex-1 text-caption leading-5 break-words whitespace-pre-wrap',
          text ? 'text-foreground/85' : 'text-muted-foreground',
          touch && 'line-clamp-2',
        )}
        title={text || undefined}
      >
        {text || (images.length > 0 ? '[图片]' : '')}
      </span>
    </div>
  );
}
