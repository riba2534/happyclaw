function copyWithTextarea(text: string): void {
  const previousFocus = document.activeElement as HTMLElement | null;
  // Radix menus and dialogs trap focus: a textarea appended to <body> loses
  // focus straight back to them, and execCommand then "copies" an empty
  // selection yet returns true. Attach it inside the open layer instead.
  const host =
    previousFocus?.closest<HTMLElement>(
      '[role="menu"],[role="dialog"],[role="alertdialog"]',
    ) ?? document.body;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  host.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    // iOS Safari ignores select() on a readonly field without a range.
    ta.setSelectionRange(0, text.length);
    if (document.activeElement !== ta) {
      throw new Error('copy fallback could not focus its textarea');
    }
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    host.removeChild(ta);
    previousFocus?.focus?.({ preventScroll: true });
  }
}

/**
 * Clipboard write that also works on plain-HTTP self-hosted installs, where
 * `navigator.clipboard` is missing, and when the async API is refused (focus
 * or permission). Rejects only when every method failed, so callers can show
 * "已复制" on resolve and an error otherwise.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  copyWithTextarea(text);
}
