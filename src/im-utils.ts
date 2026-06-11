/**
 * Shared IM utilities extracted from qq.ts / dingtalk.ts / wechat.ts
 * to eliminate code duplication.
 *
 */

// ── Markdown → Plain Text ────────────────────────────────

export function markdownToPlainText(md: string): string {
  let text = md;

  // Code blocks: keep content, remove fences
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });

  // Inline code: remove backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Bold: **text** or __text__ → text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strikethrough: ~~text~~ → text
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Italic: *text* → text
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');

  // Headings: # text → text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  return text;
}

// ── Text Chunking ──────────────────────────────────────

export function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── IM Message Deduplication LRU Cache ─────────────────────
//
// 6 个 IM channel（feishu/telegram/qq/dingtalk/wechat/discord）原本各自实现一份
// 完全相同的 isDuplicate / markSeen 逻辑。抽到这里收敛。
//
// 关键不变量：capacity-eviction 必须放在 markSeen 而不是 isDuplicate。
// 否则当 cache 满 + msgId 是 head 时 isDuplicate 会先 evict 掉 msgId 自己，
// 再 has() 返回 false，让重投消息绕过去重 → 双发回复。
//
// 用法：
//   const dedup = createDedupCache({ ttlMs: 30 * 60_000, max: 1000 });
//   if (dedup.isDuplicate(msgId)) return; // 已处理过
//   // ... 处理消息 ...
//   dedup.markSeen(msgId);

export interface DedupCacheOptions {
  /** TTL，毫秒。Map preserves insertion order，过期清理从头扫到首个未过期。 */
  ttlMs: number;
  /** 容量上限，超过时驱逐最旧条目。 */
  max: number;
}

export interface DedupCache {
  isDuplicate(id: string): boolean;
  markSeen(id: string): void;
  /** 重置 cache（断线重连时丢弃旧状态）。 */
  clear(): void;
  /** 仅用于测试 / 监控：当前 cache 大小。 */
  size(): number;
}

export function createDedupCache(opts: DedupCacheOptions): DedupCache {
  const { ttlMs, max } = opts;
  const cache = new Map<string, number>();

  function pruneExpired(now: number): void {
    // Map 按插入顺序遍历，最早的在前；遇到首个未过期 entry 立即停。
    for (const [id, ts] of cache.entries()) {
      if (now - ts > ttlMs) {
        cache.delete(id);
      } else {
        break;
      }
    }
  }

  return {
    isDuplicate(id: string): boolean {
      pruneExpired(Date.now());
      return cache.has(id);
    },
    markSeen(id: string): void {
      // 容量驱逐必须在这里（不是 isDuplicate）—— 否则当 cache 满 + id 是 head
      // 时 isDuplicate 会先把 id 自己驱逐掉再 has()，让重投消息绕过去重。
      if (cache.size >= max) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
      // delete + set 把 id 移到末尾刷新 LRU 顺序。
      cache.delete(id);
      cache.set(id, Date.now());
    },
    clear(): void {
      cache.clear();
    },
    size(): number {
      return cache.size;
    },
  };
}
