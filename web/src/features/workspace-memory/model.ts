import type { ApiError } from '@/api/client';

export const WORKSPACE_MEMORY_KINDS = [
  'fact',
  'decision',
  'lesson',
  'open_loop',
] as const;

export type WorkspaceMemoryKind = (typeof WORKSPACE_MEMORY_KINDS)[number];

export interface WorkspaceSummary {
  jid: string;
  folder: string;
  name: string;
  status: string;
  is_home: boolean;
  interaction_mode: 'assistant' | 'proactive';
  can_modify: boolean;
  updated_at: string;
  agent_profile?: {
    id: string;
    name: string;
    version: number;
  } | null;
}

export interface WorkspaceMemoryProvenance {
  sourceType: string;
  sourceId: string | null;
  sessionId: string | null;
  observedAt: string | null;
}

export interface WorkspaceMemoryItem {
  id: string;
  workspaceJid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonicalKey: string | null;
  status: string;
  importance: number;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  provenance: WorkspaceMemoryProvenance;
}

export interface WorkspaceMemoryVersion {
  workspaceJid: string;
  revision: number;
  changeType: string;
  status: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonicalKey: string | null;
  importance: number;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  createdAt: string;
  actor: {
    type: string;
    id: string | null;
  };
  provenance: WorkspaceMemoryProvenance;
}

export interface WorkspaceMemoryCollection {
  storeRevision: number;
  items: WorkspaceMemoryItem[];
  nextCursor: string | null;
}

export interface WorkspaceMemoryItemResult {
  storeRevision: number;
  item: WorkspaceMemoryItem;
  replayed?: boolean;
}

export interface WorkspaceMemorySearchResult {
  storeRevision: number;
  hits: Array<{
    item: WorkspaceMemoryItem;
    rank: number;
    snippet: string;
  }>;
  nextCursor?: string | null;
}

export interface WorkspaceMemoryVersionsResult {
  storeRevision: number;
  itemId: string;
  versions: WorkspaceMemoryVersion[];
  nextCursor: string | null;
}

export interface RevisionConflict {
  currentRevision: number | null;
  storeRevision: number | null;
}

export const KIND_META: Record<
  WorkspaceMemoryKind,
  { label: string; singular: string; description: string }
> = {
  fact: {
    label: '事实',
    singular: '事实',
    description: '工作区中稳定、可验证的信息',
  },
  decision: {
    label: '决策',
    singular: '决策',
    description: '已经做出的选择及其背景',
  },
  lesson: {
    label: '经验',
    singular: '经验',
    description: '可复用的做法、反例和教训',
  },
  open_loop: {
    label: '待跟进',
    singular: '待跟进',
    description: '尚未关闭的问题、承诺与下一步',
  },
};

export function memoryItemsPath(workspaceJid: string): string {
  return `/api/memory/workspaces/${encodeURIComponent(workspaceJid)}/items`;
}

export function memoryItemPath(workspaceJid: string, itemId: string): string {
  return `${memoryItemsPath(workspaceJid)}/${encodeURIComponent(itemId)}`;
}

export function memoryVersionsPath(
  workspaceJid: string,
  itemId: string,
): string {
  return `${memoryItemPath(workspaceJid, itemId)}/versions`;
}

export function revisionConflictFrom(error: unknown): RevisionConflict | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('status' in error) ||
    (error as ApiError).status !== 409
  ) {
    return null;
  }

  const body = (error as ApiError).body;
  if (body?.error !== 'revision_conflict') return null;

  return {
    currentRevision:
      typeof body.currentRevision === 'number' ? body.currentRevision : null,
    storeRevision:
      typeof body.storeRevision === 'number' ? body.storeRevision : null,
  };
}

export function memoryKindCounts(
  items: WorkspaceMemoryItem[],
): Record<WorkspaceMemoryKind, number> {
  const counts: Record<WorkspaceMemoryKind, number> = {
    fact: 0,
    decision: 0,
    lesson: 0,
    open_loop: 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}
