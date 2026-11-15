import { useMemo } from 'react';
import { Play, Plus, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { SideListRow } from '@/components/common/SideListRow';
import { cn } from '@/lib/utils';
import type { Automation } from '../../lib/automation';
import {
  AUTOMATION_FILTER_LABELS,
  automationCellBadge,
  automationSubtitle,
  matchesAutomationFilter,
  type AutomationFilter,
} from '../../lib/automation-presentation';
import { useAutomationsStore } from '../../stores/automations';
import { useChatStore } from '../../stores/chat';
import { runAutomationNow } from './automation-actions';
import { useAutomationModelLabel } from './automation-model';
import { UnreadDot } from './AutomationSessionBits';
import {
  revealOnRowHover,
  rowIconButtonClass,
} from '../layout/sidebar/WorkspaceTree';

const FILTERS: AutomationFilter[] = ['all', 'active', 'paused', 'completed'];

function AutomationListCell({
  automation,
  selected,
  onSelect,
}: {
  automation: Automation;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const busy = useAutomationsStore((s) => !!s.runBusy[automation.id]);
  const badge = automationCellBadge(automation);
  const modelLabel = useAutomationModelLabel(automation);
  const dimmed = automation.status !== 'active';
  return (
    <li className="group/sidebar-row relative list-none">
      <SideListRow
        selected={selected}
        onSelect={() => onSelect(automation.id)}
        className="pr-10 phone:pr-3"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <UnreadDot automation={automation} />
          <span
            className={cn(
              'min-w-0 truncate text-body font-medium',
              dimmed ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {automation.name}
          </span>
          {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        </span>
        <span
          className={cn(
            'truncate text-caption',
            dimmed ? 'text-faint-foreground' : 'text-muted-foreground',
          )}
        >
          {automationSubtitle(automation)}
        </span>
        {modelLabel && (
          <span
            data-testid="automation-model"
            className="truncate text-caption text-faint-foreground"
          >
            {modelLabel}
          </span>
        )}
      </SideListRow>
      {/* A phone runs it from the detail's top bar instead: a 24px button
          on every row starts a billed run on a stray tap. */}
      <button
        type="button"
        aria-label={`立即运行「${automation.name}」`}
        title="立即运行"
        disabled={busy}
        onClick={() => {
          onSelect(automation.id);
          void runAutomationNow(automation.id);
        }}
        className={cn(
          rowIconButtonClass,
          revealOnRowHover,
          'absolute right-2 bottom-2.5 phone:hidden',
        )}
      >
        <Play className="size-3.5" />
      </button>
    </li>
  );
}

/** The left pane: automations grouped by workspace, with a status filter. */
export function AutomationList({
  automations,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  onCreate,
  loading,
}: {
  automations: Automation[];
  filter: AutomationFilter;
  onFilterChange: (filter: AutomationFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Absent for read-only viewers (guests). */
  onCreate?: () => void;
  loading: boolean;
}) {
  const groups = useChatStore((s) => s.groups);
  const sections = useMemo(() => {
    const byWorkspace = new Map<string, Automation[]>();
    for (const automation of automations) {
      if (!matchesAutomationFilter(automation, filter)) continue;
      const list = byWorkspace.get(automation.workspaceJid) ?? [];
      list.push(automation);
      byWorkspace.set(automation.workspaceJid, list);
    }
    return [...byWorkspace].map(([jid, items]) => ({
      jid,
      name:
        items[0].workspaceName || groups[jid]?.name || items[0].workspaceFolder,
      items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }));
  }, [automations, filter, groups]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <SegmentedControl
          label="按状态筛选"
          size="sm"
          value={filter}
          onChange={onFilterChange}
          options={FILTERS.map((value) => ({
            value,
            label: AUTOMATION_FILTER_LABELS[value],
          }))}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {sections.length === 0 && !loading ? (
          automations.length === 0 ? (
            <EmptyState
              icon={Timer}
              title="暂无自动化"
              description={
                onCreate
                  ? '按计划在会话里运行提示词。也可以在对话里直接让智能体创建。'
                  : '授权给你的工作区里还没有自动化。'
              }
              action={
                onCreate && (
                  <Button onClick={onCreate}>
                    <Plus />
                    新建自动化
                  </Button>
                )
              }
            />
          ) : (
            <p className="px-3 py-6 text-center text-caption text-muted-foreground">
              没有{AUTOMATION_FILTER_LABELS[filter]}的自动化
            </p>
          )
        ) : (
          sections.map((section) => (
            <section key={section.jid} aria-label={section.name}>
              <h2 className="px-3 pt-3 pb-1 text-caption font-medium text-faint-foreground">
                {section.name}
              </h2>
              <ul className="space-y-0.5">
                {section.items.map((automation) => (
                  <AutomationListCell
                    key={automation.id}
                    automation={automation}
                    selected={automation.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
