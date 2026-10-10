function copyWithTextarea(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    document.body.removeChild(ta);
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
