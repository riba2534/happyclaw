// The share card's layout widths and how sharply each layout can be exported,
// kept free of the DOM so the phone fallback can be tested on its own.

export const SHARE_CARD_DEFAULT_WIDTH = 720;
// A phone's card: as wide as its sheet, so the preview is read at about 1:1
// and the image suits the phone it is shared from.
export const SHARE_CARD_PHONE_WIDTH = 390;
export const SHARE_CARD_MAX_WIDTH = 1200;
export const SHARE_CARD_PADDING = 48; // 24px * 2

export const DEFAULT_EXPORT_PIXEL_RATIO = 2;
// The phone card is narrower; three device pixels keep it as sharp as the
// 720px card's two.
export const PHONE_EXPORT_PIXEL_RATIO = 3;
const MIN_EXPORT_PIXEL_RATIO = 0.6;

export interface CanvasLimits {
  maxPixels: number;
  maxSide: number;
}

/**
 * The largest canvas an export can use. iOS Safari caps the area and the long
 * side; elsewhere html-to-image scales any side above 16384 down itself.
 */
export function canvasLimits(ios: boolean): CanvasLimits {
  return ios
    ? { maxPixels: 14_000_000, maxSide: 14_000 }
    : { maxPixels: 48_000_000, maxSide: 16_384 };
}

/** The card as laid out at one width. */
export interface ShareCardBox {
  width: number;
  height: number;
  /** The reply is taller than the content area allows, so its end is cut. */
  clipped: boolean;
}

/** The ratio a `width` × `height` card actually exports at, `preferred` at most. */
export function exportPixelRatio(
  width: number,
  height: number,
  preferred: number,
  limits: CanvasLimits,
): number {
  let ratio = preferred;
  if (width * height * ratio * ratio > limits.maxPixels) {
    ratio = Math.sqrt(limits.maxPixels / Math.max(width * height, 1));
  }
  ratio = Math.min(ratio, limits.maxSide / Math.max(width, height, 1));
  return Math.max(MIN_EXPORT_PIXEL_RATIO, Math.min(preferred, ratio));
}

export interface ShareCardPlan {
  /** The ratio to export the measured card at. */
  pixelRatio: number;
  /** Lay the card out at this width and plan again instead of exporting it. */
  relayoutWidth?: number;
}

/**
 * How to export a measured card. A phone card narrower than the default one
 * is about 1.6× as tall, so a long reply soon gets cut or hits the canvas's
 * long side; it is kept only while it shows the whole reply at no less than
 * the default card's 2x, and otherwise falls back to the default width.
 */
export function planShareCardExport(
  card: ShareCardBox,
  phone: boolean,
  limits: CanvasLimits,
): ShareCardPlan {
  const phoneLayout = phone && card.width < SHARE_CARD_DEFAULT_WIDTH;
  const pixelRatio = exportPixelRatio(
    card.width,
    card.height,
    phoneLayout ? PHONE_EXPORT_PIXEL_RATIO : DEFAULT_EXPORT_PIXEL_RATIO,
    limits,
  );
  if (
    phoneLayout &&
    (card.clipped || pixelRatio < DEFAULT_EXPORT_PIXEL_RATIO)
  ) {
    return { pixelRatio, relayoutWidth: SHARE_CARD_DEFAULT_WIDTH };
  }
  return { pixelRatio };
}
