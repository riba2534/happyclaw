import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadErrorNotice } from '@/components/common/LoadErrorNotice';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useChatStore } from '../stores/chat';
import { useWorkItemsStore } from '../stores/work-items';
import {
  WorkItemList,
  buildWorkSections,
  firstWorkItem,
} from '../components/team/WorkItemList';
import { WorkItemDetail } from '../components/team/WorkItemDetail';
import { PhonePageHeader } from '../components/layout/PhonePageHeader';
import { workItemHref } from '../lib/team-mode';
import { isDelegated } from '../lib/multitask';
import type { WorkItemOrigin, WorkItemView } from '../work-items';

const VIEW_OPTIONS: { value: WorkItemOrigin; label: string }[] = [
  { value: 'team', label: '团队工作项' },
  { value: 'delegated', label: '派出的任务' },
];

const EMPTY: Record<WorkItemOrigin, { title: string; description: string }> = {
  team: {
    title: '还没有工作项',
    description: '在飞书普通群的绑定上打开团队模式后，群里的请求会出现在这里。',
  },
  delegated: {
    title: '还没有派出的任务',
    description:
      '多任务工作区里，Agent 把较大的任务交给后台 Worker 后，会出现在这里。',
  },
};

const originOf = (item: Pick<WorkItemView, 'origin'>): WorkItemOrigin =>
  isDelegated(item) ? 'delegated' : 'team';

/**
 * 工作项 (团队模式): what needs me, what runs and what ended on the left, the
 * selected item on the right. Below the desktop width the list and the
 * detail are two screens (`/work` and `/work/:id`). Tasks delegated in
 * multi-task workspaces (派出的任务) list apart from the team's items, once
 * there are any.
 */
export function WorkItemsPage() {
  const navigate = useNavigate();
  const { itemId } = useParams();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const groups = useChatStore((s) => s.groups);
  const itemMap = useWorkItemsStore((s) => s.items);
  const decisionMap = useWorkItemsStore((s) => s.decisions);
  const loaded = useWorkItemsStore((s) => s.loaded);
  const loading = useWorkItemsStore((s) => s.loading);
  const error = useWorkItemsStore((s) => s.error);
  const load = useWorkItemsStore((s) => s.load);

  // Team mode belongs to the workspaces this user owns.
  const workspaceKey = Object.entries(groups)
    .filter(([jid, group]) => jid.startsWith('web:') && group.can_modify)
    .map(([jid]) => jid)
    .sort()
    .join('\n');
  const reload = useMemo(
    () => () => load(workspaceKey ? workspaceKey.split('\n') : []),
    [load, workspaceKey],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const routed = itemId ? itemMap[itemId] : undefined;
  const [chosenView, setChosenView] = useState<WorkItemOrigin | null>(null);
  const items = useMemo(() => Object.values(itemMap), [itemMap]);
  const hasDelegated = items.some(isDelegated);
  const hasTeam =
    items.some((item) => !isDelegated(item)) ||
    Object.values(decisionMap).some((list) => list.length > 0);
  // The routed item's kind wins; otherwise the reader's choice, else team.
  const view: WorkItemOrigin = !hasDelegated
    ? 'team'
    : routed
      ? originOf(routed)
      : (chosenView ?? (hasTeam ? 'team' : 'delegated'));
  const sections = useMemo(
    () =>
      buildWorkSections(
        items.filter((item) => originOf(item) === view),
        view === 'team' ? Object.values(decisionMap).flat() : [],
      ),
    [items, decisionMap, view],
  );
  const changeView = (next: WorkItemOrigin) => {
    setChosenView(next);
    if (itemId) navigate('/work');
  };
  const selected =
    routed ??
    (isDesktop && !itemId ? (firstWorkItem(sections) ?? undefined) : undefined);
  const select = (id: string) => navigate(workItemHref(id));
  const back = () => navigate('/work');

  const header = (
    <div className="px-4 pt-5 pb-3 lg:pt-6 phone:hidden">
      <h1 className="text-title-lg text-foreground">工作项</h1>
    </div>
  );
  const list = (
    <>
      {hasDelegated && (
        <div className="shrink-0 px-4 pb-2 phone:pt-1">
          <SegmentedControl
            label="工作项来源"
            value={view}
            options={VIEW_OPTIONS}
            onChange={changeView}
          />
        </div>
      )}
      <WorkItemList
        sections={sections}
        selectedId={selected?.id ?? null}
        onSelect={select}
        loading={loading && !loaded}
        empty={EMPTY[view]}
      />
    </>
  );
  const notFound = (
    <EmptyState
      icon={ClipboardList}
      title="找不到这个工作项"
      description="它可能不属于你的工作区。"
      action={
        <Button variant="outline" onClick={back}>
          返回列表
        </Button>
      }
    />
  );
  const errorNotice = error && (
    <div className="p-4">
      <LoadErrorNotice
        title="工作项加载失败"
        message={error}
        onRetry={() => void reload()}
      />
    </div>
  );

  if (!isDesktop) {
    if (itemId) {
      if (routed) return <WorkItemDetail item={routed} onBack={back} />;
      return (
        <>
          <PhonePageHeader title="工作项" onBack={back} />
          {loaded ? notFound : null}
        </>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PhonePageHeader title="工作项" />
        {header}
        {errorNotice}
        {list}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="工作项列表"
        className="flex w-80 shrink-0 flex-col border-r border-surface-border"
      >
        {header}
        {errorNotice}
        {list}
      </aside>
      <main className="min-w-0 flex-1">
        {selected ? (
          <WorkItemDetail key={selected.id} item={selected} />
        ) : (
          loaded &&
          (itemId
            ? notFound
            : Object.keys(itemMap).length > 0 && (
                <EmptyState
                  icon={ClipboardList}
                  title="选择一个工作项"
                  description="在左侧选择以查看详情和时间线。"
                />
              ))
        )}
      </main>
    </div>
  );
}
