import { act } from 'react';
import { vi } from 'vitest';

export const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

/** A fetch answer: `bytes` labelled as `type`. */
export const respondWith =
  (bytes: number[], type = 'application/octet-stream') =>
  async () =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });

/**
 * A share sheet that takes files, on an iPhone unless `iOS` is false. Undo
 * with `unstubShare`; the user agent goes with `vi.restoreAllMocks`.
 */
export function stubShare(
  share: (data: ShareData) => Promise<void> = async () => {},
  { iOS = true } = {},
) {
  if (iOS) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
  const shareMock = vi.fn(share);
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: shareMock,
  });
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: () => true,
  });
  return shareMock;
}

export function unstubShare() {
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
}

/** The names of the files downloads save, in order, from now on. */
export function captureDownloads(): string[] {
  const names: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return names;
}

/** Lets fetches, body reads and the renders they cause settle. */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
