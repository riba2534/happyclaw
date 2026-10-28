import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
  useImperativeHandle,
  memo,
  type ReactNode,
  type Ref,
} from 'react';
import { toast } from 'sonner';
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent } from '@tiptap/react';
import { Selection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { useStableCallback } from '@/hooks/useStableCallback';
import { successTap } from '../../hooks/useHaptic';
import { useShellStore } from '../../stores/shell';
import { useAuthStore } from '../../stores/auth';
import { cn } from '@/lib/utils';
import { EASE_SNAPPY } from '@/lib/motion';
import { ImageLightbox } from './ImageLightbox';
import {
  useChatStore,
  type FollowUpMode,
  type FollowUpQueueAction,
  type QueuedFollowUp,
} from '../../stores/chat';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useIsPhone } from '../layout/phone';
import {
  alternateFollowUpMode,
  FOLLOW_UP_MODE_KEY,
  FOLLOW_UP_MODE_CHANGED_EVENT,
  getDefaultFollowUpMode,
} from '../../lib/follow-up-preferences';
import { noteComposerInput } from '../../lib/composer-activity';
import { SHORTCUTS } from '../../lib/shortcuts';
import {
  composerTextAfterSend,
  isGlobalStopEscape,
  MAX_MESSAGE_CHARS,
  withUploadedFiles,
} from './composer-helpers';
import {
  isComposerBlankPointerTarget,
  resolveComposerBlankFocusIntent,
} from './composer/cindy/composerBlankPointerFocus';
import { serializeEditorContent } from './composer/cindy/composerContentSerialization';
import {
  composerDocIsEmpty,
  docContainsAtomChip,
} from './composer/cindy/composerDocState';
import {
  handleComposerListEnter,
  handleStructuredListBackspace,
} from './composer/cindy/ComposerListNodes';
import { applyListBackspace } from './composer/cindy/composerListContinuation';
import { plainTextToComposerDocument } from './composer/cindy/composerListDocument';
import { restoreComposerDocument } from './composer/cindy/restoreComposerDocument';
import {
  appendComposerText,
  caretOnEdgeLine,
  composerDocFor,
} from './composer/composerDocument';
import { AttachmentTray } from './composer/AttachmentTray';
import { ComposerPalette, paletteOptionId } from './composer/ComposerPalette';
import { ComposerToolbar } from './composer/ComposerToolbar';
import {
  draftDocFor,
  readPersistedDraft,
  writePersistedDraft,
} from './composer/draftStorage';
import { QueuedFollowUpsPanel } from './composer/QueuedFollowUps';
import { sentMessageHistory } from './composer/sentHistory';
import { UploadProgress } from './composer/UploadProgress';
import { useComposerAttachments } from './composer/useComposerAttachments';
import { useComposerEditor } from './composer/useComposerEditor';
import { useComposerPalette } from './composer/useComposerPalette';

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
  /** Composer placeholder, e.g. naming the agent being addressed. */
  placeholder?: string;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
  /** Conversation-scoped model picker shown in the action bar. */
  modelSelector?: ReactNode;
  /**
   * How full the conversation's context is, in the toolbar after the tools
   * while docked and wider than a phone (a phone's row is full of touch
   * targets).
   */
  contextUsage?: ReactNode;
  /**
   * The run's status (phase, elapsed time), directly above the card while
   * docked. Its row is always reserved there, idle included (the bar then
   * renders nothing), so a run starting or ending never moves the card or
   * the list's bottom row; on a phone it rides with the floating dock and
   * counts in its height.
   */
  statusBar?: ReactNode;
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
  /**
   * `docked` at the bottom of a conversation (default), or `centered` in an
   * empty one: a taller card without the docked bar's backdrop. Switching to
   * `docked` slides the card down to its new place.
   */
  layout?: 'docked' | 'centered';
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
// The phone dock sits 8px above the safe area, or above the keyboard.
const DOCK_LIFT =
  'max(calc(env(safe-area-inset-bottom, 0px) + 8px), calc(var(--keyboard-height, 0px) + 8px))';
// Its feathered top edge (pt-6), over which the conversation fades out.
const DOCK_FEATHER_PX = 24;
// The docking slide covers half the window; a little longer than a fade.
const DOCK_SLIDE_MS = 280;
let focusHandoffAt = Number.NEGATIVE_INFINITY;
let handledFocusRequest = { nonce: 0, at: Number.NEGATIVE_INFINITY };
let handledDraftRequestNonce = 0;

/** The draft a composer for `key` opens with, chips included when known. */
function initialDraft(
  key: string | undefined,
  stored: string | undefined,
  owner: string | undefined,
): { text: string; doc: JSONContent } {
  const draft = !key
    ? null
    : stored !== undefined
      ? { text: stored, doc: draftDocFor(key, stored) }
      : owner
        ? readPersistedDraft(owner, key)
        : null;
  const text = draft?.text ?? '';
  return { text, doc: composerDocFor(text, draft?.doc) };
}

// Memoized: ChatView re-renders for dialogs, panels and run status; the
// transcript and composer only need to when their own props change.
export const MessageInput = memo(function MessageInput({
  onSend,
  groupJid,
  draftKey,
  disabled = false,
  placeholder = '输入消息...',
  onResetSession,
  onToggleTerminal,
  modelSelector,
  contextUsage,
  statusBar,
  onStop,
  isRunning = false,
  queuedFollowUps = [],
  onFollowUpAction,
  ref,
  layout = 'docked',
}: MessageInputProps) {
  const draftTarget = draftKey ?? groupJid;
  const userId = useAuthStore((s) => s.user?.id);
  const agentProfileId = useChatStore((s) =>
    groupJid ? s.groups[groupJid]?.agent_profile_id : undefined,
  );
  // Read once: the composer follows later changes through a subscription
  // (see the adoption effect) instead of re-rendering on its own saves.
  const [storedAtMount] = useState(() =>
    draftTarget ? useChatStore.getState().drafts[draftTarget] : undefined,
  );
  const [initial] = useState(() =>
    initialDraft(draftTarget, storedAtMount, userId),
  );
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const draftTargetRef = useRef(draftTarget);
  draftTargetRef.current = draftTarget;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  // The composer text as it will be sent (chips expanded), kept current on
  // every document change.
  const latestTextRef = useRef(initial.text);
  // The send in flight. Its text leaves the stored draft as soon as it starts
  // and stays out of every draft written meanwhile, so a composer remounted
  // for this conversation mid-send never offers it for sending again.
  const inFlightSendRef = useRef<{ key: string; text: string } | null>(null);
  // The stored draft as this instance last wrote or adopted it, and the
  // composer text at the last adoption (see the adoption effect).
  const knownDraftRef = useRef(storedAtMount ?? '');
  const adoptedContentRef = useRef(initial.text);
  // A programmatic replacement, not typing: no activity signal, no save.
  const replacingRef = useRef(false);
  // ↑/↓ recall while browsing: the entry shown, the document it put in the
  // editor, and the user's own draft it replaced.
  const recallRef = useRef<{
    index: number;
    doc: PMNode;
    draftBefore: JSONContent;
  } | null>(null);
  // The conversation's draft as of now. A recalled message is not one until
  // it is edited, and recall only starts from an empty composer.
  const draftText = () => (recallRef.current ? '' : latestTextRef.current);

  const paletteListId = useId();

  const showSendError = useCallback((message: string, ms = 4000) => {
    setSendError(message);
    window.setTimeout(
      () => setSendError((current) => (current === message ? null : current)),
      ms,
    );
  }, []);

  const attachments = useComposerAttachments({
    groupJid,
    draftTarget,
    disabled,
    onError: showSendError,
  });
  const { pendingFiles, pendingImages } = attachments;

  const saveDraft = useChatStore((s) => s.saveDraft);
  /** Store `text` as the draft of `key`, minus a send still in flight. */
  const persistDraft = useCallback(
    (key: string | undefined, text: string, editor?: Editor) => {
      if (!key) return;
      const inFlight = inFlightSendRef.current;
      const value = (
        inFlight?.key === key
          ? composerTextAfterSend(text, inFlight.text)
          : text
      ).trim();
      if (key === draftTargetRef.current) knownDraftRef.current = value;
      saveDraft(key, value);
      // The document is kept for its chips (text alone rebuilds the rest),
      // and describes the draft only while nothing was cut from the text.
      const doc =
        editor &&
        !editor.isDestroyed &&
        value === text.trim() &&
        docContainsAtomChip(editor.state.doc)
          ? editor.getJSON()
          : undefined;
      writePersistedDraft(userIdRef.current ?? null, key, value, doc);
    },
    [saveDraft],
  );
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  const isTouchInput = useMediaQuery('(pointer: coarse) and (hover: none)');
  const isPhoneWidth = useMediaQuery('(max-width: 639px)');
  // Too narrow for every tool beside a readable model name.
  const foldToolbarActions = useMediaQuery('(max-width: 479px)');
  // A phone: cindy's floating dock, a pill at rest that opens into the card.
  const phoneDock = useIsPhone();
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

  // Debounced draft save
  const debouncedSaveDraft = useCallback(
    (editor: Editor) => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      const key = draftTargetRef.current;
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = undefined;
        persistDraft(key, draftText(), editor);
      }, 300);
    },
    [persistDraft],
  );

  const { editor, snapshot, setPopupAria } = useComposerEditor({
    content: initial.doc,
    placeholder,
    editable: !disabled,
    handlers: {
      onKeyDown: (view, event) => handleEditorKeyDown(view, event),
      onPasteImages: (files) => void attachments.addPastedImages(files),
      onPasteTooLong: () =>
        showSendError('粘贴的内容超过 64K 字符上限，请改为上传文件', 6000),
      onDocChange: (current) => {
        latestTextRef.current = serializeEditorContent(current).text;
        // Editing a recalled message makes it the user's own draft.
        if (!recallRef.current?.doc.eq(current.state.doc)) {
          recallRef.current = null;
        }
        if (replacingRef.current) return;
        noteComposerInput();
        debouncedSaveDraft(current);
      },
    },
  });

  /**
   * Replace what the composer holds with a draft that is already stored and
   * adopt it. The change handler updates the text synchronously.
   */
  const setEditorText = (text: string, doc?: JSONContent | null) => {
    replacingRef.current = true;
    try {
      restoreComposerDocument(editor, composerDocFor(text, doc));
    } finally {
      replacingRef.current = false;
    }
    adoptedContentRef.current = latestTextRef.current;
  };

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
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed) editor.commands.focus('end');
    });
    return () => cancelAnimationFrame(frame);
  }, [composerFocusNonce, editor]);
  useLayoutEffect(() => {
    const dom = editor.view.dom;
    if (performance.now() - focusHandoffAt < FOCUS_HANDOFF_MS) {
      focusHandoffAt = Number.NEGATIVE_INFINITY;
      dom.focus({ preventScroll: true });
    }
    return () => {
      // Layout cleanups run before the node leaves the DOM.
      if (dom.contains(document.activeElement)) {
        focusHandoffAt = performance.now();
      }
    };
  }, [editor]);

  // ChatView remounts the composer per conversation (key = draft key), which
  // restores the draft through the initial state. A parent that reuses one
  // instance across conversations gets the same isolation here.
  const prevDraftTargetRef = useRef(draftTarget);
  useEffect(() => {
    const previous = prevDraftTargetRef.current;
    if (previous === draftTarget) return;
    prevDraftTargetRef.current = draftTarget;
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    persistDraft(previous, draftText(), editor);
    const stored = draftTarget
      ? useChatStore.getState().drafts[draftTarget]
      : undefined;
    const next = initialDraft(draftTarget, stored, userIdRef.current);
    knownDraftRef.current = stored ?? '';
    setEditorText(next.text, next.doc);
    recallRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTarget]);

  // A composer that unmounted mid-send settles this conversation's draft when
  // its send resolves (the text comes back after a failure). Follow such a
  // change while nothing has been typed here since.
  useEffect(() => {
    if (!draftTarget) return;
    return useChatStore.subscribe((state) => {
      const next = state.drafts[draftTarget] ?? '';
      if (next === knownDraftRef.current) return;
      knownDraftRef.current = next;
      if (latestTextRef.current !== adoptedContentRef.current) return;
      setEditorText(next, draftDocFor(draftTarget, next));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTarget]);

  // On unmount, flush a draft save that is still waiting on its debounce,
  // so the last keystrokes before leaving the conversation are kept.
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
        persistDraft(draftTargetRef.current, draftText(), editor);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    appendComposerText(editor, composerDraftRequest.text, {
      gap: 0,
      focus: true,
    });
    // Only a new request inserts text; typing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerDraftRequest]);

  const hasContent = snapshot.hasMessage;
  const hasPayload =
    hasContent || pendingFiles.length > 0 || pendingImages.length > 0;
  const canSend = hasPayload && !sending;
  const canStop = isRunning && !!onStop;
  const showStop = canStop && !hasPayload && !sending;

  const palette = useComposerPalette({
    editor,
    trigger: snapshot.trigger,
    workspaceJid: groupJid,
    agentProfileId,
    allowReset: !!onResetSession,
  });

  const paletteActive =
    palette.open && palette.items.length > 0 ? palette.activeIndex : -1;
  useEffect(() => {
    setPopupAria(
      palette.open
        ? {
            'aria-controls': paletteListId,
            ...(paletteActive >= 0
              ? {
                  'aria-activedescendant': paletteOptionId(
                    paletteListId,
                    paletteActive,
                  ),
                }
              : {}),
          }
        : {},
    );
  }, [palette.open, paletteActive, paletteListId, setPopupAria]);

  /**
   * ↑ (older) / ↓ (newer) through this conversation's sent messages. While a
   * recalled message shows, the arrows move the caret inside it and only
   * step from its first line (↑) or last line (↓), as in a terminal.
   */
  const recallHistory = (view: EditorView, step: 1 | -1): boolean => {
    const recall = recallRef.current;
    if (!recall && !composerDocIsEmpty(view.state.doc)) return false;
    if (recall && !caretOnEdgeLine(view, step === 1 ? 'up' : 'down')) {
      return false;
    }
    const key = draftTargetRef.current;
    if (!key) return false;
    const history = sentMessageHistory(
      useChatStore.getState(),
      key,
      userIdRef.current,
    );
    const next = (recall?.index ?? -1) + step;
    if (next >= history.length || (next < 0 && !recall)) return false;
    const draftBefore = recall?.draftBefore ?? view.state.doc.toJSON();
    const doc = view.state.schema.nodeFromJSON(
      next < 0 ? draftBefore : plainTextToComposerDocument(history[next]),
    );
    const tr = view.state.tr.replaceWith(
      0,
      view.state.doc.content.size,
      doc.content,
    );
    tr.setSelection(Selection.atEnd(tr.doc));
    // Set before dispatching: the change handler compares against it.
    recallRef.current =
      next < 0 ? null : { index: next, doc: tr.doc, draftBefore };
    view.dispatch(tr.scrollIntoView());
    return true;
  };

  function handleEditorKeyDown(view: EditorView, event: KeyboardEvent) {
    if (palette.captureKey(event)) return true;
    if (event.key === 'Escape') {
      if (!showStop) return false;
      void handleStop();
      return true;
    }
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (
      plain &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      recallHistory(view, event.key === 'ArrowUp' ? 1 : -1)
    ) {
      return true;
    }
    if (
      plain &&
      event.key === 'Backspace' &&
      (handleStructuredListBackspace(view) || applyListBackspace(view))
    ) {
      return true;
    }
    if (event.key !== 'Enter') return false;
    if (event.metaKey || event.ctrlKey) {
      void handleSend(
        event.shiftKey && isRunning
          ? alternateFollowUpMode(followUpMode)
          : undefined,
      );
      return true;
    }
    if (event.shiftKey || event.altKey || enterInsertsNewline) {
      // Newline keys continue or leave a list, otherwise break the line.
      if (!handleComposerListEnter(view, event, 'modifier-enter')) {
        editor.commands.setHardBreak();
      }
      return true;
    }
    void handleSend();
    return true;
  }

  const handleSend = async (modeOverride?: FollowUpMode) => {
    // Snapshot what this send carries. The composer stays editable while the
    // request is in flight; only this snapshot leaves it on success.
    const sentText = serializeEditorContent(editor).text;
    const trimmed = sentText.trim();
    const sentFiles = pendingFiles;
    const sentImages = pendingImages;
    const target = draftTarget;

    if (!trimmed && sentFiles.length === 0 && sentImages.length === 0) return;
    if (disabled || sending) return;

    // 先组装 message 但不立刻清空 pendingFiles/pendingImages，
    // 让 onSend 失败时用户的附件也能保留、可以重试。
    const message = withUploadedFiles(
      trimmed,
      sentFiles.map((file) => file.path),
    );
    if (message.length > MAX_MESSAGE_CHARS) {
      showSendError(
        '消息超过 64K 字符上限，请精简内容，长文本可以改为上传文件',
        6000,
      );
      return;
    }

    setSending(true);
    setSendError(null);
    if (target) {
      inFlightSendRef.current = { key: target, text: sentText };
      persistDraft(target, sentText);
    }
    const attachmentsPayload =
      sentImages.length > 0
        ? sentImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
        : undefined;

    let ok = false;
    try {
      ok = await onSend(
        message,
        attachmentsPayload,
        modeOverride ?? (isRunning ? followUpMode : undefined),
      );
    } catch {
      ok = false;
    }

    // Switched away mid-flight: this instance's state is gone or belongs to
    // another conversation; only the stored draft of `target` is fixed up.
    const stillHere =
      attachments.isCurrentTarget(target) && !editor.isDestroyed;
    inFlightSendRef.current = null;
    if (ok) {
      successTap();
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }
      const remaining = composerTextAfterSend(latestTextRef.current, sentText);
      persistDraft(
        target,
        remaining,
        stillHere && remaining === latestTextRef.current ? editor : undefined,
      );
      if (stillHere && remaining !== latestTextRef.current) {
        setEditorText(remaining);
      }
      recallRef.current = null;
      attachments.releaseSent(sentFiles, sentImages, stillHere);
    } else {
      // 失败：保留输入、保留附件；同步保存草稿，切换会话后也能恢复。
      persistDraft(
        target,
        latestTextRef.current,
        stillHere ? editor : undefined,
      );
      if (stillHere) showSendError('发送失败，输入已保留，请重试');
      else toast.error('发送失败，内容已放回该会话的输入框');
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
    const initialContent = editingFollowUpInitialContentRef.current.trim();
    setEditingFollowUpId(null);
    setEditingFollowUpContent('');
    editingFollowUpInitialContentRef.current = '';
    editingFollowUpContentRef.current = '';

    if (!recovered || recovered === initialContent) return;
    appendComposerText(editor, recovered, { gap: 1, focus: false });
    showSendError('这条消息已开始处理，未保存的修改已移到输入框', 5000);
  }, [
    editor,
    editingFollowUpId,
    queuedFollowUps,
    savingFollowUpId,
    showSendError,
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
    if (attachments.previewIndex !== null || !isGlobalStopEscape(event)) {
      return;
    }
    event.preventDefault();
    void handleStop();
  });
  useEffect(() => {
    if (!canStop) return;
    document.addEventListener('keydown', stopFromPageEscape);
    return () => document.removeEventListener('keydown', stopFromPageEscape);
  }, [canStop, stopFromPageEscape]);

  useImperativeHandle(ref, () => ({ acceptDrop: attachments.acceptDrop }), [
    attachments.acceptDrop,
  ]);

  // Docking after the first message slides the card from where it sat in the
  // empty conversation (a one-shot transform; none when less motion is asked
  // for). The start is read in the render that docks it, while the DOM still
  // shows the centred layout: the card also moves without committing (the
  // editor grows, the page scrolls), so an earlier reading can be stale.
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dockColumnRef = useRef<HTMLDivElement>(null);

  // Text entry inside the dock opens the pill; it closes again when focus
  // leaves for the page. A sheet, menu or popover the dock opened (its
  // trigger is expanded) is not leaving.
  const [textFocused, setTextFocused] = useState(false);
  const noteFocusIn = (event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.isContentEditable || target.matches('input, textarea')) {
      setTextFocused(true);
    }
  };
  const noteFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
    // Focus moving inside a portal the dock opened bubbles here through
    // React; only the dock's own elements losing focus count.
    if (!event.currentTarget.contains(event.target as Node)) return;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    if (event.currentTarget.querySelector('[aria-expanded="true"]')) return;
    setTextFocused(false);
  };

  // The conversation scrolls under the floating dock. The dock publishes
  // its height on the area it floats over (the card and its feathered
  // edge; the keyboard lift is --composer-dock-lift, set alongside, so
  // keyboard frames don't come through here).
  useLayoutEffect(() => {
    const column = dockColumnRef.current;
    const host = rootRef.current?.parentElement?.closest<HTMLElement>(
      '[data-composer-dock-host]',
    );
    if (!column || !host || !phoneDock || layout === 'centered') return;
    host.style.setProperty('--composer-dock-lift', DOCK_LIFT);
    let published = '';
    const update = () => {
      const height = `${column.offsetHeight + DOCK_FEATHER_PX}px`;
      if (height === published) return;
      published = height;
      host.style.setProperty('--composer-dock-height', height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    return () => {
      observer.disconnect();
      host.style.removeProperty('--composer-dock-height');
      host.style.removeProperty('--composer-dock-lift');
    };
  }, [phoneDock, layout]);
  const committedLayoutRef = useRef(layout);
  const dockFromRef = useRef<number | null>(null);
  if (layout === 'docked' && committedLayoutRef.current === 'centered') {
    dockFromRef.current = cardRef.current?.getBoundingClientRect().top ?? null;
  }
  useLayoutEffect(() => {
    committedLayoutRef.current = layout;
    const from = dockFromRef.current;
    dockFromRef.current = null;
    const card = cardRef.current;
    if (from === null || !card) return;
    const offset = from - card.getBoundingClientRect().top;
    if (
      Math.abs(offset) > 1 &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      card.animate?.(
        [{ transform: `translateY(${offset}px)` }, { transform: 'none' }],
        {
          duration: DOCK_SLIDE_MS,
          easing: `cubic-bezier(${EASE_SNAPPY.join(', ')})`,
        },
      );
    }
  }, [layout]);

  // Blank parts of the card (around the text, between toolbar groups) enter
  // the editor instead of dropping focus; the caret stays where it was.
  const focusFromBlankArea = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || editor.isDestroyed) return;
    if (
      !isComposerBlankPointerTarget(
        event.target,
        event.currentTarget,
        editor.view.dom,
        event,
      )
    ) {
      return;
    }
    event.preventDefault();
    const { selection, doc } = editor.state;
    const intent = resolveComposerBlankFocusIntent({
      isDestroyed: editor.isDestroyed,
      isEditable: editor.isEditable,
      isFocused: editor.isFocused,
      caretAtDocStart:
        selection.empty && selection.from === Selection.atStart(doc).from,
    });
    if (intent === 'keep-caret') editor.commands.focus();
    else if (intent === 'doc-end') editor.commands.focus('end');
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

  const centered = layout === 'centered';
  const dock = phoneDock && !centered;
  // The resting pill opens into the card when the text gets focus (in the
  // same tap, so iOS raises its keyboard) and stays open while anything is
  // in it or being worked on.
  const pill =
    dock &&
    !textFocused &&
    !hasPayload &&
    queuedFollowUps.length === 0 &&
    !palette.open &&
    !editingFollowUpId &&
    !sendError;
  const dockCard = dock && !pill;

  return (
    <div
      ref={rootRef}
      data-hc-composer
      data-composer-layout={layout}
      data-composer-dock={dock ? (pill ? 'pill' : 'card') : undefined}
      onFocus={dock ? noteFocusIn : undefined}
      onBlur={dock ? noteFocusOut : undefined}
      className={cn(
        'relative w-full',
        dock
          ? // Floats over the conversation: 16px from the sides, 8px above
            // the safe area (or the keyboard), its top edge feathered into
            // a glass scrim instead of a border.
            'absolute inset-x-0 bottom-0 z-20 bg-[linear-gradient(to_bottom,transparent,var(--glass-bg)_1.5rem)] pt-6'
          : !centered &&
              'bg-background pt-1 pb-3 max-lg:border-t max-lg:border-surface-border max-lg:glass',
      )}
      style={
        centered
          ? undefined
          : {
              paddingBottom: dock
                ? DOCK_LIFT
                : `max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))`,
            }
      }
    >
      {/* Soft fade so scrolled messages don't end at a hard edge. */}
      {!centered && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-background max-lg:hidden"
        />
      )}
      {/* Same column as the message list (max-w-3xl + px-6) so the
          composer edges line up with message content. */}
      <div
        ref={dockColumnRef}
        className={
          isCompact ? 'mx-auto px-4' : 'mx-auto max-w-3xl px-4 lg:px-6'
        }
      >
        <UploadProgress />

        {/* Reserved whenever docked, run or not (cindy's activity frame):
            starting, switching or ending a status never moves the card or
            changes the list's bottom room. */}
        {statusBar && !centered && (
          <div
            data-composer-status-bar
            className="mb-1.5 flex h-8 items-center *:min-w-0 *:flex-1"
          >
            {statusBar}
          </div>
        )}

        {/* Palettes anchor on the whole card, queue included. */}
        <div className="relative">
          {palette.open && (
            <ComposerPalette
              palette={palette}
              touch={isTouchInput}
              listId={paletteListId}
            />
          )}
          {/* One card: the queue on top, then the editor. Focus only
              changes the border color. */}
          <div
            ref={cardRef}
            data-composer-card
            className={cn(
              'relative overflow-hidden border border-surface-border transition-[color,background-color,border-color,border-radius] focus-within:border-foreground/25 motion-reduce:transition-none',
              // Docked on a phone the card is glass over the conversation.
              dock ? 'glass glass-edge' : 'bg-surface-raised',
              !dock
                ? 'rounded-[12px]'
                : pill
                  ? 'rounded-[25px]'
                  : 'rounded-[30px]',
            )}
          >
            {dockCard && (
              // cindy's card handle: a cue that the pill opened into this.
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-2 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-muted-foreground/25"
              />
            )}
            {queuedFollowUps.length > 0 && (
              <QueuedFollowUpsPanel
                queuedFollowUps={queuedFollowUps}
                touch={isTouchInput}
                collapsible={queueCollapsible}
                // Typing with the keyboard up needs the room more than the
                // queue; editing a queued item is the exception (its own
                // field is up).
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

            {sendError && (
              <div className="flex items-center gap-2 border-b border-error/15 bg-error/5 px-3 py-2 text-caption font-medium text-error">
                <span>{sendError}</span>
              </div>
            )}

            {/* cindy's card: the text on top, the toolbar on the bottom
                edge, and blank space between that still focuses the text. */}
            <div
              className={cn(
                pill
                  ? // The pill: + | text | send on one line.
                    'flex min-h-[50px] items-center gap-1.5 px-2 py-2'
                  : 'flex flex-col justify-between px-[11px] pt-[11px] pb-[6px]',
                dockCard && 'min-h-[104px] pt-[22px]',
                !dock &&
                  (centered
                    ? 'min-h-[140px]'
                    : 'min-h-[96px] sm:min-h-[118px]'),
              )}
              onMouseDown={focusFromBlankArea}
            >
              <div className={cn(pill && 'min-w-0 flex-1')}>
                <AttachmentTray
                  images={pendingImages}
                  files={pendingFiles}
                  onPreview={attachments.setPreviewIndex}
                  onRemoveImage={attachments.removeImage}
                  onRemoveFile={attachments.removeFile}
                  onClear={attachments.clearAll}
                />
                <EditorContent
                  editor={editor}
                  className={cn(disabled && 'cursor-not-allowed opacity-50')}
                />
              </div>
              <ComposerToolbar
                canAttach={!!groupJid}
                uploading={attachments.uploading}
                onPickImages={() => imageInputRef.current?.click()}
                onPickFiles={() => fileInputRef.current?.click()}
                onPickFolder={() => folderInputRef.current?.click()}
                onResetSession={onResetSession}
                onToggleTerminal={onToggleTerminal}
                foldActions={foldToolbarActions}
                phone={phoneDock}
                collapsed={pill}
                contextUsage={
                  !centered && !isPhoneWidth ? contextUsage : undefined
                }
                modelSelector={modelSelector}
                // A draft turns the primary action into queue/send; keep
                // stop reachable next to it.
                showSideStop={canStop && hasPayload && !sending}
                stopping={stopping}
                stopDisabled={disabled || stopping}
                onStop={() => void handleStop()}
                send={{
                  glyph:
                    sending || (showStop && stopping)
                      ? 'busy'
                      : showStop
                        ? 'stop'
                        : isRunning && followUpMode === 'queue'
                          ? 'queue'
                          : 'send',
                  disabled: showStop
                    ? disabled || stopping
                    : !canSend || disabled,
                  label: sendLabel,
                  onClick: () =>
                    showStop ? void handleStop() : void handleSend(),
                  escapeStops: showStop,
                  alternate:
                    isRunning && !showStop
                      ? {
                          label: followUpLabel(
                            alternateFollowUpMode(followUpMode),
                          ),
                          shortcut: SHORTCUTS.steer,
                        }
                      : undefined,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {attachments.previewIndex !== null &&
        pendingImages[attachments.previewIndex] && (
          <ImageLightbox
            images={pendingImages.map((img) => img.preview)}
            initialIndex={attachments.previewIndex}
            onClose={() => attachments.setPreviewIndex(null)}
          />
        )}

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={attachments.handleImageSelect}
        className="hidden"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={attachments.handleFileSelect}
        className="hidden"
        disabled={attachments.uploading}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={attachments.handleFileSelect}
        className="hidden"
        disabled={attachments.uploading}
      />
    </div>
  );
});
