import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  File,
  Folder,
  Lock,
  Trash2,
  RefreshCw,
  Package,
  Puzzle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/common/EmptyState';
import {
  CapabilityMedia,
  DetailPanel,
  DetailSection,
} from '@/components/capabilities/capability-ui';
import { confirmDialog } from '@/stores/confirm';
import {
  useSkillsStore,
  type SkillDetail as SkillDetailType,
} from '../../stores/skills';
import {
  createLatestRequestGate,
  isSelectionCurrent,
  type LatestRequestTicket,
} from '../../utils/latest-request';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface SkillDetailProps {
  skillId: string | null;
  onDeleted?: () => void;
}

export function SkillDetail({ skillId, onDeleted }: SkillDetailProps) {
  const [detailState, setDetailState] = useState<{
    sourceKey: string | null;
    detail: SkillDetailType | null;
    loading: boolean;
    error: string | null;
  }>({ sourceKey: null, detail: null, loading: false, error: null });
  const [pendingActions, setPendingActions] = useState<
    Record<string, 'delete' | 'reinstall'>
  >({});
  const requestGateRef = useRef(createLatestRequestGate());
  const currentSkillIdRef = useRef(skillId);
  currentSkillIdRef.current = skillId;
  const getSkillDetail = useSkillsStore((state) => state.getSkillDetail);
  const deleteSkill = useSkillsStore((state) => state.deleteSkill);
  const reinstallSkill = useSkillsStore((state) => state.reinstallSkill);

  const loadDetail = useCallback(
    (sourceKey: string): LatestRequestTicket => {
      const ticket = requestGateRef.current.begin(sourceKey);
      setDetailState({
        sourceKey,
        detail: null,
        loading: true,
        error: null,
      });
      void getSkillDetail(sourceKey).then(
        (detail) => {
          if (
            !requestGateRef.current.isCurrent(ticket, currentSkillIdRef.current)
          ) {
            return;
          }
          setDetailState({
            sourceKey,
            detail,
            loading: false,
            error: null,
          });
        },
        (error: unknown) => {
          if (
            !requestGateRef.current.isCurrent(ticket, currentSkillIdRef.current)
          ) {
            return;
          }
          setDetailState({
            sourceKey,
            detail: null,
            loading: false,
            error: error instanceof Error ? error.message : '加载失败',
          });
        },
      );
      return ticket;
    },
    [getSkillDetail],
  );

  useEffect(() => {
    if (!skillId) {
      requestGateRef.current.invalidate();
      setDetailState({
        sourceKey: null,
        detail: null,
        loading: false,
        error: null,
      });
      return;
    }
    const ticket = loadDetail(skillId);
    return () => requestGateRef.current.cancel(ticket);
  }, [loadDetail, skillId]);

  const stateMatchesSelection = detailState.sourceKey === skillId;
  const detail = stateMatchesSelection ? detailState.detail : null;
  const loading = !stateMatchesSelection || detailState.loading;
  const error = stateMatchesSelection ? detailState.error : null;
  const deleting = !!skillId && pendingActions[skillId] === 'delete';
  const reinstalling = !!skillId && pendingActions[skillId] === 'reinstall';

  const setActionPending = (
    sourceKey: string,
    action: 'delete' | 'reinstall' | null,
  ) => {
    setPendingActions((current) => {
      if (action) return { ...current, [sourceKey]: action };
      if (!(sourceKey in current)) return current;
      const next = { ...current };
      delete next[sourceKey];
      return next;
    });
  };

  if (!skillId) {
    return (
      <DetailPanel>
        <EmptyState icon={Puzzle} title="选择一个技能查看详情" />
      </DetailPanel>
    );
  }

  if (loading) {
    return (
      <DetailPanel className="flex items-center justify-center py-16">
        <Spinner className="size-5 text-muted-foreground" />
      </DetailPanel>
    );
  }

  if (error || !detail) {
    return (
      <DetailPanel className="px-5 py-12 text-center">
        <p role="alert" className="text-body text-error">
          {error || '加载失败'}
        </p>
      </DetailPanel>
    );
  }

  const handleReinstall = async () => {
    const actionSourceKey = skillId;
    const actionDetail = detail;
    if (!actionSourceKey || detailState.sourceKey !== actionSourceKey) {
      return;
    }
    const confirmed = await confirmDialog({
      title: '重新安装技能',
      message: `确认重新安装技能「${actionDetail.name}」？`,
      confirmText: '重新安装',
    });
    if (!confirmed) return;
    setActionPending(actionSourceKey, 'reinstall');
    try {
      await reinstallSkill(actionDetail.id);
      if (isSelectionCurrent(actionSourceKey, currentSkillIdRef.current)) {
        loadDetail(actionSourceKey);
      }
    } catch {
      // error handled by store
    } finally {
      setActionPending(actionSourceKey, null);
    }
  };

  const handleDelete = async () => {
    const actionSourceKey = skillId;
    const actionDetail = detail;
    if (!actionSourceKey || detailState.sourceKey !== actionSourceKey) {
      return;
    }
    const confirmed = await confirmDialog({
      title: '删除技能',
      message: `确认删除技能「${actionDetail.name}」？`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    setActionPending(actionSourceKey, 'delete');
    try {
      await deleteSkill(actionDetail.id);
      if (isSelectionCurrent(actionSourceKey, currentSkillIdRef.current)) {
        onDeleted?.();
      }
    } catch {
      // error is handled by the store
    } finally {
      setActionPending(actionSourceKey, null);
    }
  };

  const meta: Array<{ label: string; value: ReactNode; icon?: boolean }> = [];
  if (detail.packageName) {
    meta.push({
      label: '来源',
      value: <span className="font-mono">{detail.packageName}</span>,
      icon: true,
    });
  } else if (detail.sourceUrl) {
    meta.push({
      label: '导入来源',
      value: <span className="font-mono break-all">{detail.sourceUrl}</span>,
      icon: true,
    });
  }
  if (detail.installSource) {
    meta.push({
      label: '安装方式',
      value:
        detail.installSource === 'git'
          ? 'Git'
          : detail.installSource === 'zip'
            ? 'ZIP'
            : 'skills.sh',
    });
  }
  if (detail.version) {
    meta.push({
      label: '版本',
      value: (
        <span className="font-mono" title={detail.version}>
          {detail.version.slice(0, 12)}
        </span>
      ),
    });
  }
  if (detail.installedAt) {
    meta.push({
      label: '安装时间',
      value: new Date(detail.installedAt).toLocaleString('zh-CN'),
    });
  }
  if (detail.allowedTools && detail.allowedTools.length > 0) {
    meta.push({
      label: '允许工具',
      value: (
        <span className="flex flex-wrap gap-1">
          {detail.allowedTools.map((tool: string) => (
            <Badge key={tool} variant="neutral" className="font-mono">
              {tool}
            </Badge>
          ))}
        </span>
      ),
    });
  }
  if (detail.argumentHint) {
    meta.push({ label: '参数提示', value: detail.argumentHint });
  }

  return (
    <DetailPanel>
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <CapabilityMedia icon={Puzzle} className="size-9" />
          <div className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <h2 className="min-w-0 truncate text-title text-foreground">
              {detail.name}
            </h2>
            <Badge variant="neutral">
              {detail.source === 'user'
                ? '我的 Skills'
                : detail.source === 'external'
                  ? '宿主机'
                  : 'HappyClaw 内置'}
            </Badge>
            {detail.userInvocable && <Badge variant="outline">可调用</Badge>}
          </div>

          {detail.source !== 'user' ? (
            <Badge
              variant="neutral"
              className="mt-2 shrink-0"
              title="此来源由系统或宿主机管理"
            >
              <Lock />
              只读 · 由{detail.source === 'external' ? '宿主机' : '系统'}管理
            </Badge>
          ) : (
            <div className="flex shrink-0 items-center gap-1">
              {detail.packageName && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reinstalling || deleting}
                  onClick={() => void handleReinstall()}
                >
                  <RefreshCw className={reinstalling ? 'animate-spin' : ''} />
                  {reinstalling ? '重装中...' : '重新安装'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={deleting || reinstalling}
                onClick={() => void handleDelete()}
                className="text-error hover:bg-error/10 hover:text-error"
              >
                <Trash2 />
                {deleting ? '删除中...' : '删除'}
              </Button>
            </div>
          )}
        </div>
        {detail.description && (
          <p className="mt-3 text-caption leading-5 text-muted-foreground">
            {detail.description}
          </p>
        )}
      </div>

      {/* 元信息区域 */}
      {meta.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-t border-surface-border px-5 py-4 text-caption">
          {meta.map((item) => (
            <div key={item.label} className="contents">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                {item.icon && (
                  <Package className="size-3.5 text-faint-foreground" />
                )}
                {item.label}
              </dt>
              <dd className="min-w-0 text-foreground">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* SKILL.md 内容 */}
      <DetailSection title="技能说明">
        <div className="max-w-none">
          <MarkdownRenderer
            content={stripFrontmatter(detail.content)}
            variant="docs"
          />
        </div>
      </DetailSection>

      {/* 文件列表 */}
      {detail.files && detail.files.length > 0 && (
        <DetailSection title="文件列表">
          <ul className="space-y-1">
            {detail.files.map((file) => (
              <li
                key={file.name}
                className="flex items-center gap-2 text-caption text-muted-foreground"
              >
                {file.type === 'directory' ? (
                  <Folder className="size-3.5 text-faint-foreground" />
                ) : (
                  <File className="size-3.5 text-faint-foreground" />
                )}
                <span className="font-mono text-foreground">{file.name}</span>
                {file.type === 'file' && (
                  <span className="text-faint-foreground tabular-nums">
                    ({file.size} B)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {/* 底部操作区 */}
      <div className="border-t border-surface-border bg-muted/40 px-5 py-3">
        <p className="text-caption text-muted-foreground">
          {detail.source === 'user'
            ? detail.packageName
              ? `通过 ${detail.packageName} 安装，可重新安装以获取最新版本`
              : '用户级技能可启用/禁用或删除，也可在对话中让 AI 安装或卸载技能'
            : detail.source === 'external'
              ? '宿主机技能为只读，来自 ~/.claude/skills/'
              : '项目级技能为只读，不可修改或删除'}
        </p>
      </div>
    </DetailPanel>
  );
}

/** SKILL.md frontmatter is already summarised in the header above. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}
