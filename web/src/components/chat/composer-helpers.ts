/**
 * Pure helpers for the chat composer (MessageInput). Kept out of the component
 * so the send/queue rules can be unit-tested without rendering it.
 */

/**
 * What the composer should hold after a send succeeded. The textarea stays
 * editable while the request is in flight, so anything typed after the send
 * started must survive: clear only the text that was actually sent.
 */
export function composerTextAfterSend(current: string, sent: string): string {
  if (current === sent || current.trim() === sent.trim()) return '';
  if (sent && current.startsWith(sent)) {
    return current.slice(sent.length).replace(/^\s+/, '');
  }
  return current;
}

export interface QueuedImagePreview {
  src: string;
}

/**
 * Image attachments of a queued follow-up (`attachments` is the stored JSON
 * array). Malformed or non-image entries are skipped.
 */
export function parseQueuedImageAttachments(
  attachments: string | undefined,
): QueuedImagePreview[] {
  if (!attachments) return [];
  try {
    const parsed: unknown = JSON.parse(attachments);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { type, data, mimeType } = entry as {
        type?: unknown;
        data?: unknown;
        mimeType?: unknown;
      };
      if (type !== 'image' || typeof data !== 'string' || !data) return [];
      const mime =
        typeof mimeType === 'string' && mimeType ? mimeType : 'image/png';
      return [{ src: `data:${mime};base64,${data}` }];
    });
  } catch {
    return [];
  }
}

/** Label of a queued item for buttons and screen readers. */
export function queuedFollowUpLabel(
  content: string,
  imageCount: number,
): string {
  const text = content.trim();
  if (text) return text;
  return imageCount > 0 ? '[图片]' : '';
}

const DIALOG_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/**
 * Whether a page-level Escape may stop the active run: nothing has focus
 * (focus is on <body>), no dialog or menu is open, and nobody else consumed
 * the key. Escape inside inputs, dialogs and menus keeps its usual meaning.
 */
export function isGlobalStopEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement)
    return false;
  return !document.querySelector(DIALOG_SELECTOR);
}
