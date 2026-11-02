import { useEffect, useRef } from 'react';
import {
  ArrowLeft,
  CircleCheck,
  FolderGit2,
  GitBranch,
  RefreshCw,
  ServerOff,
} from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { LoadErrorNotice } from '@/components/common/LoadErrorNotice';
import { ScrollEdgeAffordance } from '@/components/common/ScrollEdgeAffordance';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/common/SegmentedControl';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useBackDismiss } from '@/hooks/useBackDismiss';
import { ReviewDiffBody } from './ReviewDiffView';
import {
  describeReviewFailure,
  FileLineCounts,
  FilePathLabel,
  filePathTitle,
  FileStatusMark,
  fileStatusLabel,
  ReviewWarningNotice,
} from './review-format';
import type {
  GitReviewFile,
  GitReviewScope,
  GitReviewWorktree,
  GitStatusResponse,
  ReviewLoad,
} from './types';
import { useGitReview } from './useGitReview';

export interface ReviewPanelProps {
  groupJid: string;
  /** The open session (its worktree, if it has one); null for the workspace's own checkout. */
  agentId: string | null;
  className?: string;
}

const HEADER_CLASS =
  'flex h-11 shrink-0 items-center gap-2 border-b border-surface-border pr-2';
const HEADER_BUTTON_CLASS = 'text-muted-foreground pointer-coarse:size-9';
const SCOPE_OPTIONS: SegmentedOption<GitReviewScope>[] = [
  { value: 'working', label: '未提交' },
  { value: 'branch', label: '分支改动' },
];

/** Read-only view of the uncommitted changes in a conversation's checkout. */
export function ReviewPanel({
  groupJid,
  agentId,
  className,
}: ReviewPanelProps) {
  // A new scope starts from a clean slate; nothing of the previous one leaks.
  return (
    <ReviewPanelScope
      key={`${groupJid}\n${agentId ?? ''}`}
      groupJid={groupJid}
      agentId={agentId}
      className={className}
    />
  );
}

function ReviewPanelScope({ groupJid, agentId, className }: ReviewPanelProps) {
  const review = useGitReview(groupJid, agentId);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const lastOpenedPath = useRef<string | null>(null);

  const data = review.status.kind === 'loaded' ? review.status.data : null;
  const okStatus = data?.state === 'ok' ? data : null;
  const selected = review.selected;
  // Prefer the latest numbers for the open file once status refreshes.
  const selectedFile = selected
    ? (okStatus?.files.find(
        (file) =>
          file.path === selected.path && file.orig_path === selected.orig_path,
      ) ?? selected)
    : null;
  const refreshing = review.statusRefreshing || review.diffRefreshing;
  // A phone's back steps from a file's diff to the list, not out of the panel.
  useBackDismiss(!!selected, review.closeFile);

  // Move focus into the detail view and back to the row that opened it.
  useEffect(() => {
    if (selected) {
      backButtonRef.current?.focus();
      return;
    }
    const opened = lastOpenedPath.current;
    if (!opened) return;
    lastOpenedPath.current = null;
    const rows =
      listScrollRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-path]',
      ) ?? [];
    for (const row of rows) {
      if (row.dataset.path === opened) {
        row.focus();
        break;
      }
    }
  }, [selected]);

  const openFile = (file: GitReviewFile) => {
    lastOpenedPath.current = file.path;
    review.openFile(file);
  };

  const refreshButton = (
    <IconButton
      label="刷新代码改动"
      icon={<RefreshCw className={cn(refreshing && 'animate-spin')} />}
      onClick={review.refresh}
      className={HEADER_BUTTON_CLASS}
    />
  );

  return (
    <div
      data-testid="review-panel"
      className={cn(
        'flex h-full w-full min-w-0 flex-col overflow-hidden bg-background',
        className,
      )}
    >
      {selectedFile ? (
        <div className={cn(HEADER_CLASS, 'pl-1.5')}>
          {/* No tooltip: focus moves here on open, which would pop it up. */}
          <IconButton
            ref={backButtonRef}
            label="返回文件列表"
            hideTooltip
            icon={<ArrowLeft />}
            onClick={review.closeFile}
            className={HEADER_BUTTON_CLASS}
          />
          <FileStatusMark status={selectedFile.status} />
          <span
            className="flex min-w-0 flex-1 text-label"
            title={filePathTitle(selectedFile)}
          >
            <FilePathLabel file={selectedFile} />
          </span>
          <FileLineCounts file={selectedFile} />
          {refreshButton}
        </div>
      ) : (
        <div className={cn(HEADER_CLASS, 'pl-4')}>
          <h3 className="truncate text-title-sm text-foreground">代码改动</h3>
          {data?.worktree && <WorktreeBadge worktree={data.worktree} />}
          <span className="flex-1" />
          {refreshButton}
        </div>
      )}

      <div
        className={cn('flex min-h-0 flex-1 flex-col', selectedFile && 'hidden')}
      >
        {okStatus && (
          <BranchBar
            status={okStatus}
            scope={review.scope}
            onScopeChange={review.setScope}
          />
        )}
        <div className="relative min-h-0 flex-1">
          <div
            ref={listScrollRef}
            data-testid="review-file-list-scroll"
            className="hc-scroll-pane h-full overflow-y-auto"
          >
            <StatusBody
              status={review.status}
              scope={review.scope}
              onOpenFile={openFile}
              onRetry={review.refresh}
            />
          </div>
          <ScrollEdgeAffordance scrollRef={listScrollRef} />
        </div>
      </div>

      {selectedFile && review.diff && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ReviewDiffBody diff={review.diff} onRetry={review.retryDiff} />
        </div>
      )}
    </div>
  );
}

function WorktreeBadge({
  worktree,
}: {
  worktree: NonNullable<GitReviewWorktree>;
}) {
  const broken = worktree.status === 'broken';
  return (
    <Badge
      variant={broken ? 'warning' : 'neutral'}
      title={`分支 ${worktree.branch}，创建自 ${worktree.base_commit.slice(0, 7)}${
        broken ? '，当前不可用' : ''
      }`}
    >
      独立 worktree
    </Badge>
  );
}

function BranchBar({
  status,
  scope,
  onScopeChange,
}: {
  status: Extract<GitStatusResponse, { state: 'ok' }>;
  scope: GitReviewScope;
  onScopeChange: (scope: GitReviewScope) => void;
}) {
  const showScopeToggle =
    status.worktree !== null || status.baseAhead !== undefined;
  return (
    <div
      data-testid="review-branch-bar"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-surface-border px-4 py-1.5 text-caption"
    >
      <GitBranch
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      {status.branch ? (
        <span className="min-w-0 truncate font-mono text-foreground">
          {status.branch}
        </span>
      ) : (
        <span className="min-w-0 truncate text-foreground">
          分离 HEAD
          {status.head && (
            <span className="ml-1.5 font-mono text-faint-foreground">
              {status.head.slice(0, 7)}
            </span>
          )}
        </span>
      )}
      {status.upstream ? (
        <span
          className="shrink-0 font-mono text-muted-foreground tabular-nums"
          title={`相对 ${status.upstream}`}
        >
          <span aria-hidden="true">
            ↑{status.ahead} ↓{status.behind}
          </span>
          <span className="sr-only">
            领先 {status.ahead} 个提交，落后 {status.behind} 个提交
          </span>
        </span>
      ) : (
        (status.baseAhead ?? 0) > 0 && (
          <span
            className="shrink-0 text-muted-foreground tabular-nums"
            title={
              status.baseCommit
                ? `基于 ${status.baseCommit.slice(0, 7)}`
                : undefined
            }
          >
            领先基底 {status.baseAhead} 个提交
          </span>
        )
      )}
      {showScopeToggle && (
        <SegmentedControl
          size="sm"
          label="改动范围"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={onScopeChange}
        />
      )}
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {status.total_files} 个文件
      </span>
    </div>
  );
}

function StatusBody({
  status,
  scope,
  onOpenFile,
  onRetry,
}: {
  status: ReviewLoad<GitStatusResponse>;
  scope: GitReviewScope;
  onOpenFile: (file: GitReviewFile) => void;
  onRetry: () => void;
}) {
  if (status.kind === 'loading') {
    return (
      <div className="flex h-32 items-center justify-center gap-2 text-caption text-muted-foreground">
        <Spinner className="size-3.5" />
        加载中...
      </div>
    );
  }
  if (status.kind === 'failed') {
    return (
      <LoadErrorNotice
        title="无法加载代码改动"
        message={describeReviewFailure(status.failure)}
        onRetry={onRetry}
      />
    );
  }
  const data = status.data;
  switch (data.state) {
    case 'ok':
      return <FileList status={data} scope={scope} onOpenFile={onOpenFile} />;
    case 'unavailable':
      return data.reason === 'worktree_broken' ? (
        <ReviewWarningNotice
          title="独立 worktree 不可用"
          message={data.message}
        />
      ) : (
        <EmptyState icon={ServerOff} title={data.message} className="px-4" />
      );
    case 'not_git_repo':
      return (
        <EmptyState
          icon={FolderGit2}
          title="工作目录不是 git 仓库"
          className="px-4"
        />
      );
    case 'error':
      return (
        <LoadErrorNotice
          title="读取代码改动失败"
          message={data.error}
          onRetry={onRetry}
        />
      );
    default:
      return (
        <LoadErrorNotice
          title="无法加载代码改动"
          message="服务返回了无法识别的结果"
          onRetry={onRetry}
        />
      );
  }
}

function FileList({
  status,
  scope,
  onOpenFile,
}: {
  status: Extract<GitStatusResponse, { state: 'ok' }>;
  scope: GitReviewScope;
  onOpenFile: (file: GitReviewFile) => void;
}) {
  if (status.files.length === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title={scope === 'branch' ? '分支没有改动' : '没有未提交的改动'}
        className="px-4"
      />
    );
  }
  return (
    <>
      {status.truncated && (
        <p className="px-4 pt-2 pb-1 text-caption text-muted-foreground">
          {status.total_files > status.files.length
            ? `只显示前 ${status.files.length} 个文件（共 ${status.total_files} 个）`
            : '改动较多，列表可能不完整'}
        </p>
      )}
      <ul aria-label="改动的文件" className="flex flex-col gap-px p-1.5">
        {status.files.map((file) => (
          <li key={`${file.orig_path ?? ''}\n${file.path}`}>
            <button
              type="button"
              data-path={file.path}
              title={`${fileStatusLabel(file.status)}：${filePathTitle(file)}`}
              onClick={() => onOpenFile(file)}
              className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-body outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset pointer-coarse:h-11"
            >
              <FileStatusMark status={file.status} />
              <FilePathLabel file={file} />
              <FileLineCounts file={file} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
