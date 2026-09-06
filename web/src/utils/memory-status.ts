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

  // 构造有效期区间文本
  let rangeText = '';
  if (item.validFrom || item.validUntil || item.expiresAt) {
    const fromStr = item.validFrom ? formatDate(item.validFrom) : '即日起';
    const endStr = item.validUntil
      ? formatDate(item.validUntil)
      : item.expiresAt
        ? formatDate(item.expiresAt)
        : '永久有效';
    rangeText = `${fromStr} 至 ${endStr}`;
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

  if (validUntilTime !== null && validUntilTime <= now) {
    return {
      status: 'expired',
      label: '已过期',
      badgeVariant: 'destructive',
      reason: `已过有效截止时间（截止时间：${formatDate(item.validUntil!)}），当前不可召回。`,
      isRecalible: false,
      validityRangeText: rangeText,
    };
  }

  if (expiresAtTime !== null && expiresAtTime <= now) {
    return {
      status: 'expired',
      label: '已过期',
      badgeVariant: 'destructive',
      reason: `已过过期时间（过期时间：${formatDate(item.expiresAt!)}），当前不可召回。`,
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
