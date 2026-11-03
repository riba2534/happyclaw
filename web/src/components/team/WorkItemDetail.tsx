import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/capabilities/capability-ui';
import { IconButton } from '@/components/common/IconButton';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import {
  WORK_EVENT_LABELS,
  WORK_REPORT_LABELS,
  formatWorkTime,
  subscriptionLabel,
  workItemSource,
  workItemTitle,
  workPermissionText,
  workStageLabel,
  workStageText,
  workStageVariant,
  workOriginWords,
} from '../../lib/team-mode';
import { isDelegated } from '../../lib/multitask';
import { openWorkspaceSession } from '../../lib/chat-navigation';
import { useWorkItemsStore } from '../../stores/work-items';
import { extractErrorMessage } from '../../utils/error';
import {
  isWorkItemWritable,
  type WorkItemView,
  type WorkReportState,
} from '../../work-items';
import { PhonePageHeader, PhoneBarButton } from '../layout/PhonePageHeader';
import { useIsPhone } from '../layout/phone';
import { confirmWorkItemAction } from './work-item-actions';

function requesterText(item: WorkItemView): string {
  const { mandate } = item;
  const who = mandate.requesterName || mandate.requesterImId || '未知成员';
  const role = mandate.requesterIsOwner
    ? '主人'
    : mandate.requesterListed
      ? '名单内'
      : '名单外';
  return `${who}（${role}）`;
}

export function WorkItemDetail({
  item,
  onBack,
}: {
  item: WorkItemView;
  /** Phones: back to the list. */
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const detail = useWorkItemsStore((s) => s.details[item.id]);
  const busy = useWorkItemsStore((s) => !!s.busy[item.id]);
  const loadDetail = useWorkItemsStore((s) => s.loadDetail);

  useEffect(() => {
    void loadDetail(item.id).catch((err) =>
      toast.error(`加载工作项失败：${extractErrorMessage(err)}`),
    );
  }, [item.id, loadDetail]);

  const open = item.status === 'open';
  const delegated = isDelegated(item);
  const canApprove = open && !isWorkItemWritable(item);
  const words = workOriginWords(item);
  const variant = workStageVariant(item);
  const openSession = () =>
    openWorkspaceSession(
      navigate,
      { jid: item.workspaceJid, folder: item.workspaceFolder },
      item.agentId,
    );
  const title = workItemTitle(item);
  const stopAction: MenuAction = {
    label: '停止',
    icon: Square,
    destructive: true,
    disabled: busy,
    onSelect: () => void confirmWorkItemAction(item, 'stop'),
  };
  const approveAction: MenuAction = {
    label: '批准修改',
    icon: Check,
    disabled: busy,
    onSelect: () => void confirmWorkItemAction(item, 'approve'),
  };
  const menuGroups: MenuAction[][] = [
    canApprove ? [approveAction] : [],
    open ? [stopAction] : [],
  ];
  // The original request (a delegated task's assignment), recorded as the
  // input whose trigger is the item's source message.
  const request = detail?.events.find(
    (event) =>
      event.kind === 'input' && event.triggerMessageId === item.sourceMessageId,
  );
  const reportState = (state: string | null) =>
    WORK_REPORT_LABELS[state as WorkReportState] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PhonePageHeader
        title={`#${item.seq}`}
        onBack={onBack}
        action={
          <PhoneBarButton
            label={`打开${words.session}`}
            icon={<MessageSquare />}
            onClick={openSession}
          />
        }
        menu={open ? { title, groups: menuGroups } : undefined}
      />
      <header className="flex shrink-0 items-start gap-2 border-b border-surface-border px-5 py-4 phone:px-4 phone:pt-0 phone:pb-3">
        {onBack && !isPhone && (
          <IconButton
            label="返回工作项列表"
            icon={<ArrowLeft />}
            onClick={onBack}
            hideTooltip
            className="-ml-1.5 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-title break-words text-foreground">{title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
            <Badge variant={variant}>{workStageLabel(item)}</Badge>
            <span>
              {[item.workspaceName, workItemSource(item)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>
        {!isPhone && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={openSession}>
              <MessageSquare />
              {words.session}
            </Button>
            {canApprove && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void confirmWorkItemAction(item, 'approve')}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Check />}
                批准修改
              </Button>
            )}
            {open && (
              <ResponsiveMenu
                title="更多操作"
                groups={[[stopAction]]}
                trigger={
                  <IconButton
                    label="更多操作"
                    icon={<MoreHorizontal />}
                    hideTooltip
                  />
                }
              />
            )}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4 phone:px-4">
        {item.stage !== 'working' && item.stage !== 'ended' && (
          <Callout
            tone={
              variant === 'error' || variant === 'warning' ? variant : 'muted'
            }
            role="status"
          >
            <span className="break-words">
              {workStageText(item)}
              {(item.stage === 'blocked' || item.stage === 'failed') &&
                item.lastSummary &&
                `：${item.lastSummary}`}
            </span>
          </Callout>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
          {delegated ? (
            <>
              <dt className="text-muted-foreground">来源会话</dt>
              <dd className="break-words text-foreground">
                {item.originSessionName ?? '已删除'}
              </dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">发起人</dt>
              <dd className="break-words text-foreground">
                {requesterText(item)}
              </dd>
              <dt className="text-muted-foreground">授权依据</dt>
              <dd className="text-foreground">
                {item.mandate.strength === 'explicit'
                  ? '明确请求'
                  : '按规则推断'}
              </dd>
              {item.mandate.matchedRules.length > 0 && (
                <>
                  <dt className="text-muted-foreground">命中规则</dt>
                  <dd className="space-y-0.5 text-foreground">
                    {item.mandate.matchedRules.map((rule) => (
                      <p key={rule.id} className="break-words">
                        {rule.name}
                        <span className="text-caption text-muted-foreground">
                          {' '}
                          · {rule.instruction}
                        </span>
                      </p>
                    ))}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">权限</dt>
              <dd className="text-foreground">{workPermissionText(item)}</dd>
            </>
          )}
          {item.lastSummary && item.stage !== 'blocked' && (
            <>
              <dt className="text-muted-foreground">最新进展</dt>
              <dd className="break-words whitespace-pre-wrap text-foreground">
                {item.lastSummary}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">开始于</dt>
          <dd className="text-foreground tabular-nums">
            {formatWorkTime(item.createdAt)}
          </dd>
          {item.endedAt && (
            <>
              <dt className="text-muted-foreground">结束于</dt>
              <dd className="text-foreground tabular-nums">
                {formatWorkTime(item.endedAt)}
              </dd>
            </>
          )}
        </dl>

        <section className="space-y-2">
          <h2 className="text-label font-medium text-foreground">
            {words.request}
          </h2>
          {request?.text ? (
            <blockquote className="border-l-2 border-surface-border pl-3 text-body break-words whitespace-pre-wrap text-foreground">
              {request.text}
            </blockquote>
          ) : (
            <p className="text-caption text-muted-foreground">
              {!delegated
                ? `消息 ${item.sourceMessageId}`
                : detail
                  ? '没有记录。'
                  : '正在加载…'}
            </p>
          )}
        </section>

        {!delegated && (
          <section className="space-y-2">
            <h2 className="text-label font-medium text-foreground">
              订阅的话题 · {detail?.subscriptions.length ?? 0}
            </h2>
            {detail && detail.subscriptions.length > 0 ? (
              <ul className="space-y-0.5 text-caption break-all text-muted-foreground">
                {detail.subscriptions.map((sub) => (
                  <li key={`${sub.channelJid}:${sub.subKey}`}>
                    {subscriptionLabel(sub.subKey)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">
                {detail ? '没有订阅。' : '正在加载…'}
              </p>
            )}
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-label font-medium text-foreground">时间线</h2>
          {!detail ? (
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在加载…
            </p>
          ) : detail.events.length === 0 ? (
            <p className="text-caption text-muted-foreground">暂无事件。</p>
          ) : (
            <ol className="space-y-3 border-l border-surface-border pl-4">
              {detail.events.map((event) => (
                <li key={event.id} className="space-y-0.5">
                  <p className="flex flex-wrap items-baseline gap-x-1.5 text-label text-foreground">
                    {WORK_EVENT_LABELS[event.kind] ?? event.kind}
                    {event.kind === 'report' && (
                      <span className="text-caption text-muted-foreground">
                        {reportState(event.state)}
                      </span>
                    )}
                    <span className="text-caption text-faint-foreground tabular-nums">
                      {formatWorkTime(event.createdAt)}
                    </span>
                  </p>
                  {event.text && (
                    <p className="text-caption break-words whitespace-pre-wrap text-muted-foreground">
                      {event.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
