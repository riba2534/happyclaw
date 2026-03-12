import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';

export interface ImageAttachmentInput {
  type?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

export interface NormalizedImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
}

interface NormalizeOptions {
  onMimeMismatch?: (ctx: {
    declaredMime: string;
    detectedMime: string;
  }) => void;
}

const DATA_URL_BASE64_RE = /^\s*data:([^;,]+);base64,(.*)\s*$/is;

function normalizeImageMimeType(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered.startsWith('image/')) return undefined;
  return lowered;
}

function unwrapBase64Payload(raw: string): {
  base64: string;
  hintedMime?: string;
} {
  const match = DATA_URL_BASE64_RE.exec(raw);
  if (!match) return { base64: raw.replace(/\s+/g, '') };
  return {
    hintedMime: normalizeImageMimeType(match[1]),
    base64: match[2].replace(/\s+/g, ''),
  };
}

function resolveImageMimeType(
  declaredMime: string | undefined,
  detectedMime: string | null,
  options?: NormalizeOptions,
): string {
  if (declaredMime && detectedMime && declaredMime !== detectedMime) {
    options?.onMimeMismatch?.({ declaredMime, detectedMime });
    return detectedMime;
  }
  if (declaredMime) return declaredMime;
  if (detectedMime) return detectedMime;
  return 'image/jpeg';
}

export function normalizeImageAttachment(
  input: ImageAttachmentInput,
  options?: NormalizeOptions,
): NormalizedImageAttachment | null {
  // 历史附件数据可能缺少 type 字段，缺失时默认视为 image
  if ((input.type ?? 'image') !== 'image') return null;
  if (typeof input.data !== 'string' || input.data.length === 0) return null;

  const { base64, hintedMime } = unwrapBase64Payload(input.data);
  if (base64.length === 0) return null;

  const declared = normalizeImageMimeType(input.mimeType) || hintedMime;
  const detected = detectImageMimeTypeFromBase64Strict(base64);
  const mimeType = resolveImageMimeType(declared, detected, options);

  return {
    type: 'image',
    data: base64,
    mimeType,
  };
}

export function normalizeImageAttachments(
  inputs: unknown,
  options?: NormalizeOptions,
): NormalizedImageAttachment[] {
  if (!Array.isArray(inputs)) return [];
  const normalized: NormalizedImageAttachment[] = [];
  for (const item of inputs) {
    if (!item || typeof item !== 'object') continue;
    const out = normalizeImageAttachment(item as ImageAttachmentInput, options);
    if (out) normalized.push(out);
  }
  return normalized;
}

export function toAgentImages(
  attachments: NormalizedImageAttachment[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att) => ({
    data: att.data,
    mimeType: att.mimeType,
  }));
}
