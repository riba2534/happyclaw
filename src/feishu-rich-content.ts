/**
 * Bounded, best-effort enrichment for Feishu content that is incomplete in
 * im.message.receive_v1 events. This module deliberately contains no routing
 * or persistence: callers must run audience/mention/binding admission before
 * invoking it because every lookup consumes tenant API quota.
 */

export interface FeishuRichContentClient {
  im: {
    v1?: {
      message?: {
        get?: (request: unknown) => Promise<unknown>;
      };
    };
    message?: {
      get?: (request: unknown) => Promise<unknown>;
    };
  };
}

export interface FeishuParsedContent {
  text: string;
  imageKeys?: string[];
  /** File attachments the parser recognized (not downloaded here). */
  fileInfos?: Array<{ fileKey: string; filename: string }>;
  /** Internal completeness signal used when the parsed content is quoted. */
  materialComplete?: boolean;
}

export interface FeishuRichContentLimits {
  /** Timeout for one Feishu API request. */
  requestTimeoutMs: number;
  /** Overall budget for current-message and reference enrichment. */
  totalTimeoutMs: number;
  /** Maximum messages retained from a merged-forward payload. */
  maxForwardItems: number;
  /** Maximum ancestors followed through parent_id/root_id. */
  maxReferenceDepth: number;
  /** Maximum recursively visited card JSON nodes. */
  maxCardNodes: number;
  /** Maximum normalized characters injected into the user message. */
  maxTextChars: number;
  /** Maximum image keys accepted from the current rich message. */
  maxImageKeys: number;
}

export const DEFAULT_FEISHU_RICH_CONTENT_LIMITS: FeishuRichContentLimits = {
  requestTimeoutMs: 1_500,
  totalTimeoutMs: 4_000,
  maxForwardItems: 20,
  maxReferenceDepth: 8,
  maxCardNodes: 500,
  maxTextChars: 20_000,
  maxImageKeys: 12,
};

interface FeishuMessageItem {
  message_id?: string;
  msg_type?: string;
  parent_id?: string;
  root_id?: string;
  upper_message_id?: string;
  create_time?: string;
  deleted?: boolean;
  sender?: {
    id?: string;
    sender_type?: string;
    name?: string;
  };
  body?: { content?: string };
}

interface NormalizedItem {
  messageId: string;
  text: string;
  imageKeys: string[];
  imageRefs: Array<{ messageId: string; imageKey: string }>;
  parentId?: string;
  rootId?: string;
  timestampMs?: number;
  senderLabel?: string;
  materialComplete: boolean;
  forwardMaterialResolved?: boolean;
}

export interface EnrichFeishuInboundContentInput {
  client: FeishuRichContentClient;
  messageId: string;
  messageType: string;
  fallbackText: string;
  fallbackImageKeys?: string[];
  /** Native chain identity from the event, not the newly-created Agent root. */
  parentId?: string;
  nativeRootId?: string;
  /** Whether the current message is inside a real native Feishu thread. */
  threadId?: string;
  parseContent: (messageType: string, content: string) => FeishuParsedContent;
  limits?: Partial<FeishuRichContentLimits>;
}

export interface EnrichedFeishuInboundContent {
  /** Current user-visible message only; quoted ancestors are kept separately. */
  text: string;
  imageKeys?: string[];
  /** Message ownership is required by Feishu's message-resource API. */
  currentImageRefs?: Array<{
    messageId: string;
    imageKey: string;
  }>;
  referencedImageRefs?: Array<{
    messageId: string;
    referenceMessageId: string;
    imageKey: string;
    marker: string;
  }>;
  references?: Array<{
    id: string;
    sender?: string;
    text: string;
    materialResolved?: boolean;
    attachmentHints?: string[];
  }>;
  richMessageResolved: boolean;
  referencedMessages: number;
  /** The current merged-forward shell was expanded without truncation. */
  currentMaterialResolved?: boolean;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Feishu rich-content lookup timed out after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Cut to at most `maxUnits` UTF-16 units without splitting a code point. */
export function sliceFeishuText(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, maxUnits);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function truncationMarker(droppedChars: number): string {
  return `\n[…已截断 ${droppedChars} 字符]`;
}

/**
 * Bound enriched material (never the user's own text) with an explicit
 * marker, so the Agent can tell the material is incomplete. The marker fits
 * inside `maxUnits` whenever the budget can hold it.
 */
export function clipFeishuMaterial(
  text: string,
  maxUnits: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxUnits) return { text, truncated: false };
  const reserve = truncationMarker(codePointLength(text)).length;
  const kept = sliceFeishuText(text, Math.max(0, maxUnits - reserve));
  return {
    text: `${kept}${truncationMarker(codePointLength(text.slice(kept.length)))}`,
    truncated: true,
  };
}

function responseItems(response: unknown): FeishuMessageItem[] {
  if (!response || typeof response !== 'object') return [];
  const result = response as {
    data?: { items?: FeishuMessageItem[] };
    items?: FeishuMessageItem[];
  };
  const items = result.data?.items ?? result.items;
  return Array.isArray(items) ? items : [];
}

async function getMessageItems(
  client: FeishuRichContentClient,
  messageId: string,
  timeoutMs: number,
): Promise<FeishuMessageItem[]> {
  const api = client.im.v1?.message ?? client.im.message;
  if (!api?.get) return [];
  const response = await withTimeout(
    api.get({
      path: { message_id: messageId },
      // Without this flag Feishu returns a lossy card fallback rather than the
      // original user-facing interactive-card JSON.
      params: { card_msg_content_type: 'user_card_content' },
    }),
    timeoutMs,
  );
  return responseItems(response);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function plainText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'title', 'plain_text']) {
    const nested = object[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return undefined;
}

interface NormalizedInteractiveCard extends FeishuParsedContent {
  materialComplete: boolean;
}

/** Recursively harvest user-visible card fields without serializing styling. */
function normalizeFeishuInteractiveCardWithCompleteness(
  rawContent: string,
  limits: Pick<
    FeishuRichContentLimits,
    'maxCardNodes' | 'maxTextChars' | 'maxImageKeys'
  > = DEFAULT_FEISHU_RICH_CONTENT_LIMITS,
): NormalizedInteractiveCard {
  const root = safeJson(rawContent);
  if (typeof root === 'string') {
    return {
      text: root.trim() || '[飞书卡片消息]',
      materialComplete: false,
    };
  }

  const lines: string[] = [];
  const imageKeys = new Set<string>();
  let visited = 0;
  let textChars = 0;
  let droppedChars = 0;
  let materialComplete = true;
  const seenObjects = new Set<object>();

  const addLine = (value: string | undefined) => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized || lines[lines.length - 1] === normalized) return;
    if (textChars >= limits.maxTextChars) {
      materialComplete = false;
      droppedChars += codePointLength(normalized);
      return;
    }
    const remaining = limits.maxTextChars - textChars;
    const clipped = sliceFeishuText(normalized, remaining);
    if (clipped.length < normalized.length) {
      materialComplete = false;
      droppedChars += codePointLength(normalized.slice(clipped.length));
    }
    if (lines[lines.length - 1] !== clipped) {
      lines.push(clipped);
      textChars += clipped.length + 1;
    }
  };

  const visit = (node: unknown, depth: number) => {
    if (node === null || node === undefined) {
      return;
    }
    if (depth > 12 || visited >= limits.maxCardNodes) {
      materialComplete = false;
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);
    visited++;

    const object = node as Record<string, unknown>;
    const imageKey =
      typeof object.image_key === 'string'
        ? object.image_key
        : typeof object.img_key === 'string'
          ? object.img_key
          : undefined;
    if (imageKey && !imageKeys.has(imageKey)) {
      if (imageKeys.size < limits.maxImageKeys) {
        imageKeys.add(imageKey);
        addLine('[图片]');
      } else {
        materialComplete = false;
      }
    }

    const tag = typeof object.tag === 'string' ? object.tag : undefined;
    const label = plainText(object.text) ?? plainText(object.title);
    const href =
      typeof object.href === 'string'
        ? object.href
        : typeof object.url === 'string'
          ? object.url
          : undefined;
    if ((tag === 'a' || tag === 'button') && label) {
      addLine(
        href
          ? `[${label}](${href})`
          : tag === 'button'
            ? `[按钮] ${label}`
            : label,
      );
    } else {
      for (const key of ['title', 'text', 'content', 'plain_text']) {
        const value = object[key];
        if (typeof value === 'string') addLine(value);
      }
    }

    for (const value of Object.values(object)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(root, 0);

  let text = lines.join('\n').trim();
  if (droppedChars > 0) {
    // Say the card was cut instead of silently ending mid-content.
    const marker = truncationMarker(droppedChars);
    text = `${sliceFeishuText(text, Math.max(0, limits.maxTextChars - marker.length))}${marker}`;
  }
  return {
    text: text || '[飞书卡片消息]',
    imageKeys: imageKeys.size > 0 ? [...imageKeys] : undefined,
    materialComplete,
  };
}

export function normalizeFeishuInteractiveCard(
  rawContent: string,
  limits: Pick<
    FeishuRichContentLimits,
    'maxCardNodes' | 'maxTextChars' | 'maxImageKeys'
  > = DEFAULT_FEISHU_RICH_CONTENT_LIMITS,
): FeishuParsedContent {
  const { materialComplete: _materialComplete, ...parsed } =
    normalizeFeishuInteractiveCardWithCompleteness(rawContent, limits);
  return parsed;
}

function normalizeItem(
  item: FeishuMessageItem,
  parseContent: EnrichFeishuInboundContentInput['parseContent'],
  limits: FeishuRichContentLimits,
): NormalizedItem | undefined {
  if (item.deleted) return undefined;
  const messageType = item.msg_type ?? '';
  const rawContent = item.body?.content ?? '';
  const parsed =
    messageType === 'interactive'
      ? normalizeFeishuInteractiveCardWithCompleteness(rawContent, limits)
      : parseContent(messageType, rawContent);
  if (!parsed.text.trim() && !parsed.imageKeys?.length) return undefined;
  const messageId = item.message_id ?? '';
  const imageKeys = parsed.imageKeys ?? [];
  // Files and videos inside quoted/forwarded messages are never downloaded.
  // Say so explicitly instead of letting `[文件: x]` read like an attachment.
  const notDownloaded =
    Boolean(parsed.fileInfos?.length) || messageType === 'media';
  return {
    messageId,
    text: notDownloaded
      ? `${parsed.text.trim()}（未下载）`
      : parsed.text.trim(),
    imageKeys,
    imageRefs: imageKeys.map((imageKey) => ({ messageId, imageKey })),
    materialComplete:
      messageType !== 'interactive' || parsed.materialComplete === true,
    ...(item.parent_id ? { parentId: item.parent_id } : {}),
    ...(item.root_id ? { rootId: item.root_id } : {}),
    ...(item.create_time
      ? { timestampMs: Number(item.create_time) || undefined }
      : {}),
    ...(item.sender?.name || item.sender?.id
      ? { senderLabel: item.sender.name || item.sender.id }
      : {}),
  };
}

/**
 * A recalled/deleted or empty child is part of the forward the user sent;
 * keep its slot as a placeholder so the bundle stays complete.
 */
function placeholderItem(item: FeishuMessageItem): NormalizedItem {
  const messageId = item.message_id ?? '';
  return {
    messageId,
    text: item.deleted ? '[已撤回]' : '[空消息]',
    imageKeys: [],
    imageRefs: [],
    materialComplete: true,
    ...(item.sender?.name || item.sender?.id
      ? { senderLabel: item.sender.name || item.sender.id }
      : {}),
  };
}

/**
 * Merged-forward children. Only a transient read can make the material
 * incomplete: deleted children become placeholders and an over-cap forward
 * is cut with an explicit "共 N 条" note, both counted as resolved.
 */
function normalizeForwardChildren(
  candidates: FeishuMessageItem[],
  parseContent: EnrichFeishuInboundContentInput['parseContent'],
  limits: FeishuRichContentLimits,
): { children: NormalizedItem[]; overflowNote?: string; complete: boolean } {
  const bounded = candidates.slice(0, limits.maxForwardItems);
  const children = bounded.map(
    (item) =>
      normalizeItem(item, parseContent, limits) ?? placeholderItem(item),
  );
  return {
    children,
    ...(candidates.length > bounded.length
      ? {
          overflowNote: `（共 ${candidates.length} 条，仅展示前 ${bounded.length} 条）`,
        }
      : {}),
    complete: children.every((child) => child.materialComplete),
  };
}

function forwardLines(
  children: NormalizedItem[],
  overflowNote: string | undefined,
): string {
  return [
    '[合并转发消息]',
    ...children.map((child) => {
      const sender = child.senderLabel ? `${child.senderLabel}: ` : '';
      return `- ${sender}${child.text}`;
    }),
    ...(overflowNote ? [overflowNote] : []),
  ].join('\n');
}

function normalizeFetchedMessage(
  items: FeishuMessageItem[],
  requestedId: string,
  parseContent: EnrichFeishuInboundContentInput['parseContent'],
  limits: FeishuRichContentLimits,
): { item: FeishuMessageItem; normalized?: NormalizedItem } | undefined {
  const exact =
    items.find((item) => item.message_id === requestedId) ?? items[0];
  if (!exact) return undefined;
  if (exact.msg_type !== 'merge_forward') {
    const normalized = normalizeItem(exact, parseContent, limits);
    if (normalized && !normalized.messageId) {
      normalized.messageId = requestedId;
    }
    return {
      item: exact,
      normalized,
    };
  }

  const childCandidates = items.filter(
    (item) =>
      item !== exact &&
      (item.upper_message_id === requestedId || !!item.upper_message_id),
  );
  if (childCandidates.length === 0) {
    return {
      item: exact,
      normalized: normalizeItem(exact, parseContent, limits),
    };
  }
  const {
    children,
    overflowNote,
    complete: forwardMaterialResolved,
  } = normalizeForwardChildren(childCandidates, parseContent, limits);
  return {
    item: exact,
    normalized: {
      messageId: requestedId,
      text: forwardLines(children, overflowNote),
      imageKeys: children.flatMap((child) => child.imageKeys),
      imageRefs: children.flatMap((child) =>
        child.imageKeys.map((imageKey) => ({
          messageId: requestedId,
          imageKey,
        })),
      ),
      materialComplete: forwardMaterialResolved,
      forwardMaterialResolved,
      ...(exact.parent_id ? { parentId: exact.parent_id } : {}),
      ...(exact.root_id ? { rootId: exact.root_id } : {}),
      ...(exact.create_time
        ? { timestampMs: Number(exact.create_time) || undefined }
        : {}),
      ...(exact.sender?.name || exact.sender?.id
        ? { senderLabel: exact.sender.name || exact.sender.id }
        : {}),
    },
  };
}

async function resolveCurrentRichMessage(
  input: EnrichFeishuInboundContentInput,
  limits: FeishuRichContentLimits,
): Promise<
  | {
      text: string;
      imageRefs: Array<{ messageId: string; imageKey: string }>;
      materialResolved: boolean;
    }
  | undefined
> {
  if (
    input.messageType !== 'interactive' &&
    input.messageType !== 'merge_forward'
  ) {
    return undefined;
  }
  const items = await getMessageItems(
    input.client,
    input.messageId,
    limits.requestTimeoutMs,
  );
  if (items.length === 0) return undefined;

  const forward =
    input.messageType === 'merge_forward' ||
    items.some((item) => !!item.upper_message_id);
  const candidates = items.filter((item) => item.msg_type !== 'merge_forward');
  let normalized: NormalizedItem[];
  let overflowNote: string | undefined;
  let forwardComplete = false;
  if (forward) {
    if (candidates.length === 0) return undefined;
    const forwardChildren = normalizeForwardChildren(
      candidates,
      input.parseContent,
      limits,
    );
    normalized = forwardChildren.children;
    overflowNote = forwardChildren.overflowNote;
    forwardComplete = forwardChildren.complete;
  } else {
    normalized = candidates
      .slice(0, limits.maxForwardItems)
      .map((item) => normalizeItem(item, input.parseContent, limits))
      .filter((item): item is NormalizedItem => !!item);
  }
  if (normalized.length === 0) return undefined;

  const imageRefs: Array<{ messageId: string; imageKey: string }> = [];
  const seenImages = new Set<string>();
  for (const item of normalized) {
    for (const ref of item.imageRefs) {
      // Feishu's resource endpoint owns images embedded in a merged-forward
      // card under the outer message ID. Child IDs returned by message.get
      // look plausible but fail with 234003 in production.
      const messageId = forward
        ? input.messageId
        : ref.messageId || item.messageId || input.messageId;
      const identity = `${messageId}\u0000${ref.imageKey}`;
      if (imageRefs.length < limits.maxImageKeys && !seenImages.has(identity)) {
        seenImages.add(identity);
        imageRefs.push({ messageId, imageKey: ref.imageKey });
      }
    }
  }
  const text = forward
    ? forwardLines(normalized, overflowNote)
    : normalized.map((item) => item.text).join('\n');
  // A deterministic length cut is final material: retrying cannot recover
  // it, so it stays resolved but carries an explicit truncation marker.
  return {
    text: clipFeishuMaterial(text, limits.maxTextChars).text,
    imageRefs,
    materialResolved: forward && forwardComplete,
  };
}

async function resolveReferencedChain(
  input: EnrichFeishuInboundContentInput,
  limits: FeishuRichContentLimits,
): Promise<NormalizedItem[]> {
  if (!input.parentId) return [];
  const visited = new Set<string>([input.messageId]);
  const newestFirst: NormalizedItem[] = [];
  let nextId: string | undefined = input.parentId;
  let lookups = 0;

  while (nextId && lookups < limits.maxReferenceDepth) {
    if (visited.has(nextId)) break;
    visited.add(nextId);
    lookups++;
    const requestedId: string = nextId;
    let items: FeishuMessageItem[];
    try {
      items = await getMessageItems(
        input.client,
        requestedId,
        limits.requestTimeoutMs,
      );
    } catch {
      break;
    }
    if (items.length === 0) break;
    const resolved = normalizeFetchedMessage(
      items,
      requestedId,
      input.parseContent,
      limits,
    );
    if (!resolved) break;
    const exact = resolved.item;
    if (resolved.normalized) newestFirst.push(resolved.normalized);

    const parent = exact.parent_id;
    const root = exact.root_id || input.nativeRootId;
    if (parent && !visited.has(parent)) {
      nextId = parent;
    } else if (root && !visited.has(root) && root !== requestedId) {
      nextId = root;
    } else {
      nextId = undefined;
    }
  }

  return newestFirst.reverse();
}

/**
 * Resolve rich current content and bounded quoted context. All failures return
 * the event-derived fallback unchanged; this function never rejects an
 * already-admitted message.
 */
export async function enrichFeishuInboundContent(
  input: EnrichFeishuInboundContentInput,
): Promise<EnrichedFeishuInboundContent> {
  const limits: FeishuRichContentLimits = {
    ...DEFAULT_FEISHU_RICH_CONTENT_LIMITS,
    ...input.limits,
  };
  const fallbackImages = [...new Set(input.fallbackImageKeys ?? [])].slice(
    0,
    limits.maxImageKeys,
  );
  try {
    return await withTimeout(
      (async () => {
        const [rich, references] = await Promise.all([
          resolveCurrentRichMessage(input, limits).catch(() => undefined),
          resolveReferencedChain(input, limits).catch(() => []),
        ]);
        // Rich material is already bounded with an explicit marker; the
        // user's own text/post body is never cut.
        const currentText = rich?.text || input.fallbackText;
        const candidateCurrentImageRefs = rich?.imageRefs?.length
          ? rich.imageRefs
          : fallbackImages.map((imageKey) => ({
              messageId: input.messageId,
              imageKey,
            }));
        const currentImageRefs: NonNullable<
          EnrichedFeishuInboundContent['currentImageRefs']
        > = [];
        const seenCurrentImages = new Set<string>();
        for (const ref of candidateCurrentImageRefs) {
          const identity = `${ref.messageId}\u0000${ref.imageKey}`;
          if (
            currentImageRefs.length >= limits.maxImageKeys ||
            seenCurrentImages.has(identity)
          ) {
            continue;
          }
          seenCurrentImages.add(identity);
          currentImageRefs.push(ref);
        }
        const currentImages = [
          ...new Set(currentImageRefs.map((ref) => ref.imageKey)),
        ];
        const referencedImageRefs: NonNullable<
          EnrichedFeishuInboundContent['referencedImageRefs']
        > = [];
        let remainingImageBudget = Math.max(
          0,
          limits.maxImageKeys - currentImageRefs.length,
        );
        const normalizedReferences: NonNullable<
          EnrichedFeishuInboundContent['references']
        > = [];
        let remainingReferenceText = Math.floor(limits.maxTextChars / 2);
        for (const item of references) {
          const senderBudget = item.senderLabel
            ? item.senderLabel.length + 2
            : 0;
          const textBudget = Math.max(0, remainingReferenceText - senderBudget);
          if (textBudget <= 0) break;

          const candidateImageRefs: NonNullable<
            EnrichedFeishuInboundContent['referencedImageRefs']
          > = [];
          const markers: string[] = [];
          for (const imageRef of item.imageRefs) {
            if (candidateImageRefs.length >= remainingImageBudget) break;
            const marker = `[引用图片 ${referencedImageRefs.length + candidateImageRefs.length + 1}]`;
            const markerSequence = [...markers, marker].join(' ');
            if (markerSequence.length > textBudget) break;
            candidateImageRefs.push({
              messageId: imageRef.messageId || item.messageId,
              referenceMessageId: item.messageId,
              imageKey: imageRef.imageKey,
              marker,
            });
            markers.push(marker);
          }
          const markerText = markers.length > 0 ? `${markers.join(' ')} ` : '';
          const rawText = `${markerText}${item.text || '[仅包含附件]'}`;
          const bounded = clipFeishuMaterial(rawText, textBudget);
          const boundedText = bounded.text;
          normalizedReferences.push({
            id: item.messageId,
            ...(item.senderLabel ? { sender: item.senderLabel } : {}),
            text: boundedText,
            ...(item.forwardMaterialResolved &&
            !bounded.truncated &&
            candidateImageRefs.length === item.imageRefs.length
              ? { materialResolved: true }
              : {}),
          });
          referencedImageRefs.push(...candidateImageRefs);
          remainingImageBudget -= candidateImageRefs.length;
          remainingReferenceText -=
            senderBudget +
            boundedText.length +
            (normalizedReferences.length > 1 ? 1 : 0);
        }

        // The canonical message remains exactly the current user-visible turn.
        // Quoted ancestors are prompt-only metadata and cannot displace it.
        return {
          text: currentText,
          imageKeys: currentImages.length > 0 ? currentImages : undefined,
          ...(currentImageRefs.length > 0 ? { currentImageRefs } : {}),
          ...(referencedImageRefs.length > 0 ? { referencedImageRefs } : {}),
          ...(normalizedReferences.length > 0
            ? { references: normalizedReferences }
            : {}),
          richMessageResolved: !!rich,
          referencedMessages: references.length,
          ...(rich?.materialResolved ? { currentMaterialResolved: true } : {}),
        };
      })(),
      limits.totalTimeoutMs,
    );
  } catch {
    return {
      text: input.fallbackText,
      imageKeys: fallbackImages.length > 0 ? fallbackImages : undefined,
      ...(fallbackImages.length > 0
        ? {
            currentImageRefs: fallbackImages.map((imageKey) => ({
              messageId: input.messageId,
              imageKey,
            })),
          }
        : {}),
      richMessageResolved: false,
      referencedMessages: 0,
    };
  }
}
