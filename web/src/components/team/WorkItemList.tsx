import { AnimatePresence, m } from 'motion/react';
import { ClipboardList, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/common/EmptyState';
import { SideListRow } from '@/components/common/SideListRow';
import { cn } from '@/lib/utils';
import {
  WORK_DECISION_LABELS,
  WORK_RECENT_LIMIT,
  formatWorkTime,
  workItemSource,
  workItemTitle,
  workStageLabel,
  workStageText,
  workStageVariant,
} from '../../lib/team-mode';
import {
  isWorkItemWritable,
  stageNeedsPerson,
  type WorkDecision,
  type WorkItemView,
} from '../../work-items';

export interface WorkSections {
  needsMe: WorkItemView[];
  working: WorkItemView[];
  ended: WorkItemView[];
  decisions: WorkDecision[];
}

const newestFirst = (a: string, b: string) => b.localeCompare(a);

/** The page's order: what waits for a person, what runs, what ended. */
export function buildWorkSections(
  items: WorkItemView[],
  decisions: WorkDecision[],
): WorkSections {
  const open = items
    .filter((item) => item.status === 'open')
    .sort((a, b) => newestFirst(a.updatedAt, b.updatedAt));
  return {
    needsMe: open.filter((item) => stageNeedsPerson(item.stage)),
    working: open.filter((item) => !stageNeedsPerson(item.stage)),
    ended: items
      .filter((item) => item.status === 'ended')
      .sort((a, b) =>
        newestFirst(a.endedAt ?? a.updatedAt, b.endedAt ?? b.updatedAt),
      )
      .slice(0, WORK_RECENT_LIMIT),
    decisions: decisions
      .slice()
      .sort((a, b) => newestFirst(a.createdAt, b.createdAt))
      .slice(0, WORK_RECENT_LIMIT),
  };
}

/** The first item a desktop opens on. */
export function firstWorkItem(sections: WorkSections): WorkItemView | null {
  return (
    sections.needsMe[0] ?? sections.working[0] ?? sections.ended[0] ?? null
  );
}

function WorkItemRow({
  item,
  selected,
  onSelect,
}: {
  item: WorkItemView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const ended = item.status === 'ended';
  const readOnly = !ended && !isWorkItemWritable(item);
  const where = [item.workspaceName, workItemSource(item)]
    .filter(Boolean)
    .join(' · ');
  return (
    <SideListRow selected={selected} onSelect={() => onSelect(item.id)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'min-w-0 truncate text-body font-medium',
            ended ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {workItemTitle(item)}
        </span>
        {readOnly && (
          <Lock
            className="size-3 shrink-0 text-faint-foreground"
            aria-label="只读"
          />
        )}
        <Badge variant={workStageVariant(item)} className="ml-auto">
          {workStageLabel(item)}
        </Badge>
      </span>
      {item.stage === 'answer' && item.attention ? (
        <span className="line-clamp-2 text-caption text-warning">
          {workStageText(item)}
        </span>
      ) : (
        <span className="truncate text-caption text-muted-foreground">
          {[where, formatWorkTime(item.updatedAt)].filter(Boolean).join(' · ')}
        </span>
      )}
    </SideListRow>
  );
}

function DecisionRow({ decision }: { decision: WorkDecision }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <Badge variant="outline">{WORK_DECISION_LABELS[decision.kind]}</Badge>
        <span className="ml-auto shrink-0 text-caption text-faint-foreground tabular-nums">
          {formatWorkTime(decision.createdAt)}
        </span>
      </span>
      <span className="line-clamp-3 text-caption break-words text-foreground">
        {decision.reason || '没有说明'}
      </span>
      {decision.matchedRuleIds.length > 0 && (
        <span className="text-micro text-muted-foreground">
          命中 {decision.matchedRuleIds.length} 条规则
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  description,
  children,
}: {
  title: string;
  count: number;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="flex items-baseline gap-1.5 px-3 pt-3 pb-1 text-caption font-medium text-faint-foreground">
        {title}
        <span className="tabular-nums">{count}</span>
      </h2>
      {description && (
        <p className="px-3 pb-1 text-micro text-faint-foreground">
          {description}
        </p>
      )}
      <ul className="space-y-0.5">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ul>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <m.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="list-none"
    >
      {children}
    </m.li>
  );
}

/**
 * The left pane: 需要我处理, 进行中, 最近结束 and 只记录的决策, each only
 * when it has something.
 */
export function WorkItemList({
  sections,
  selectedId,
  onSelect,
  loading,
  empty: emptyCopy,
}: {
  sections: WorkSections;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  /** What an empty list says. */
  empty: { title: string; description: string };
}) {
  const renderItems = (list: WorkItemView[]) =>
    list.map((item) => (
      <Row key={item.id}>
        <WorkItemRow
          item={item}
          selected={item.id === selectedId}
          onSelect={onSelect}
        />
      </Row>
    ));
  const empty = !loading && Object.values(sections).every((l) => !l.length);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      {empty ? (
        <EmptyState icon={ClipboardList} {...emptyCopy} />
      ) : (
        <>
          {sections.needsMe.length > 0 && (
            <Section title="需要我处理" count={sections.needsMe.length}>
              {renderItems(sections.needsMe)}
            </Section>
          )}
          {sections.working.length > 0 && (
            <Section title="进行中" count={sections.working.length}>
              {renderItems(sections.working)}
            </Section>
          )}
          {sections.ended.length > 0 && (
            <Section title="最近结束" count={sections.ended.length}>
              {renderItems(sections.ended)}
            </Section>
          )}
          {sections.decisions.length > 0 && (
            <Section
              title="只记录的决策"
              count={sections.decisions.length}
              description="接单方式为「只记录」时，机器人本会接下的候选。"
            >
              {sections.decisions.map((decision) => (
                <Row key={decision.id}>
                  <DecisionRow decision={decision} />
                </Row>
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
