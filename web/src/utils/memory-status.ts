import type { WorkspaceMemoryItem } from '../features/workspace-memory/model';

export type MemoryValidityStatus =
  | 'active_valid'
  | 'future'
  | 'expired'
  | 'proposed'
  | 'conflicted'
  | 'superseded'
  | 'deleted';

export interface MemoryValidityInfo {
  status: MemoryValidityStatus;
  label: string;
  badgeVariant: 'default' | 'secondary' | 'outline' | 'destructive';
  reason: string;
  isRecalible: boolean;
  validityRangeText?: string;
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/**
 * 计算记忆项的真实生效状态、召回可用性及原因
 */
export function getMemoryValidityInfo(
  item: WorkspaceMemoryItem,
  nowDate: Date = new Date(),
): MemoryValidityInfo {
  const now = nowDate.getTime();
  const validFromTime = item.validFrom
    ? new Date(item.validFrom).getTime()
    : null;
  const validUntilTime = item.validUntil
    ? new Date(item.validUntil).getTime()
    : null;
  const expiresAtTime = item.expiresAt
    ? new Date(item.expiresAt).getTime()
    : null;

  // 构造精确的有效期区间文本：实际有效截止必须取 validUntil 与 expiresAt 中的最早者
  const deadlineEntries: Array<{
    time: number;
    label: string;
    dateStr: string;
  }> = [];
  if (validUntilTime !== null && item.validUntil) {
    deadlineEntries.push({
      time: validUntilTime,
      label: '有效截止',
      dateStr: formatDate(item.validUntil),
    });
  }
  if (expiresAtTime !== null && item.expiresAt) {
    deadlineEntries.push({
      time: expiresAtTime,
      label: '过期淘汰(TTL)',
      dateStr: formatDate(item.expiresAt),
    });
  }
  deadlineEntries.sort((a, b) => a.time - b.time);

  let rangeText = '';
  if (item.validFrom || deadlineEntries.length > 0) {
    const fromStr = item.validFrom ? formatDate(item.validFrom) : '即日起';
    if (deadlineEntries.length === 0) {
      rangeText = `${fromStr} 至 永久有效`;
    } else if (deadlineEntries.length === 1) {
      rangeText = `${fromStr} 至 ${deadlineEntries[0].dateStr}`;
    } else {
      // 存在两个截止时间，明确标注最早实际截止
      const earliest = deadlineEntries[0];
      const secondary = deadlineEntries[1];
      if (earliest.time === secondary.time) {
        rangeText = `${fromStr} 至 ${earliest.dateStr}`;
      } else {
        rangeText = `${fromStr} 至 ${earliest.dateStr} (最早截止: ${earliest.label})`;
      }
    }
  }

  // 1. 候选记忆
  if (item.status === 'proposed') {
    return {
      status: 'proposed',
      label: '候选记忆 (待确认)',
      badgeVariant: 'secondary',
      reason: '候选记忆，需确认采纳后方可生效并进入召回池。',
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  // 2. 冲突记忆
  if (item.status === 'conflicted') {
    return {
      status: 'conflicted',
      label: '冲突记忆 (待解决)',
      badgeVariant: 'destructive',
      reason: '存在事实或版本冲突，需解决冲突并保存后方可生效并进入召回池。',
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  // 3. 已废弃
  if (item.status === 'superseded') {
    return {
      status: 'superseded',
      label: '已废弃',
      badgeVariant: 'outline',
      reason: '已被更新的记忆版本废弃取代，不再参与召回。',
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  // 4. 已删除
  if (item.status === 'deleted') {
    return {
      status: 'deleted',
      label: '已删除',
      badgeVariant: 'outline',
      reason: '已被删除，不参与召回。',
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  // 5. active 状态下的有效期校验
  if (validFromTime !== null && validFromTime > now) {
    return {
      status: 'future',
      label: '未来生效',
      badgeVariant: 'secondary',
      reason: `未到生效时间（生效时间：${formatDate(item.validFrom!)}），当前不可召回。`,
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  const expiredReasons: string[] = [];
  if (validUntilTime !== null && validUntilTime <= now) {
    expiredReasons.push(
      `已过有效截止时间（截止时间：${formatDate(item.validUntil!)}）`,
    );
  }
  if (expiresAtTime !== null && expiresAtTime <= now) {
    expiredReasons.push(
      `已过过期淘汰时间(TTL)（过期时间：${formatDate(item.expiresAt!)}）`,
    );
  }

  if (expiredReasons.length > 0) {
    return {
      status: 'expired',
      label: '已过期',
      badgeVariant: 'destructive',
      reason: `${expiredReasons.join('，')}，当前不可召回。`,
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  // 6. 当前有效且可召回
  return {
    status: 'active_valid',
    label: '当前有效',
    badgeVariant: 'default',
    reason: rangeText
      ? `在有效期内（${rangeText}），当前可召回。`
      : '永久有效，当前可召回。',
    isRecalible: true,
    validityRangeText: rangeText,
  };
}
