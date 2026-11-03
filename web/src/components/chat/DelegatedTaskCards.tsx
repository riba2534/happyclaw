import { memo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { Layers, MessageSquare, MoreHorizontal, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import { useIsPhone } from '../layout/phone';
import { openWorkspaceSession } from '../../lib/chat-navigation';
import { sessionDelegations } from '../../lib/multitask';
import {
  workItemTitle,
  workStageLabel,
  workStageVariant,
} from '../../lib/team-mode';
import { useIsGuest } from '../../stores/auth';
import { useWorkItemsStore } from '../../stores/work-items';
import type { WorkItemView } from '../../work-items';
import { confirmWorkItemAction } from '../team/work-item-actions';

function DelegationRow({ item }: { item: WorkItemView }) {
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  // A guest reads the task and cannot stop it.
  const stoppable = !useIsGuest() && item.status === 'open';
  const busy = useWorkItemsStore((s) => !!s.busy[item.id]);
  const title = workItemTitle(item);
  const summary = item.lastSummary ?? item.attention;
  const open = () =>
    openWorkspaceSession(
      navigate,
      { jid: item.workspaceJid, folder: item.workspaceFolder },
      item.agentId,
    );
  const stop = () => void confirmWorkItemAction(item, 'stop');

  return (
    <ListRow
      className="px-3 py-2.5 sm:px-4"
      title={title}
      badges={
        <Badge variant={workStageVariant(item)}>{workStageLabel(item)}</Badge>
      }
      description={summary && <span title={summary}>{summary}</span>}
      actions={
        isPhone ? (
          <ResponsiveMenu
            title={title}
            groups={[
              [
                {
                  label: '查看 Worker 会话',
                  icon: MessageSquare,
                  onSelect: open,
                },
              ],
              stoppable
                ? [
                    {
                      label: '停止',
                      icon: Square,
                      destructive: true,
                      disabled: busy,
                      onSelect: stop,
                    } satisfies MenuAction,
                  ]
                : [],
            ]}
            trigger={
              <IconButton
                label={`${title} 的操作`}
                icon={<MoreHorizontal />}
                hideTooltip
                className="text-muted-foreground"
              />
            }
          />
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={open}>
              查看
            </Button>
            {stoppable && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={stop}
                className="text-error hover:text-error"
              >
                停止
              </Button>
            )}
          </>
        )
      }
    />
  );
}

/**
 * The tasks this session delegated to background workers (多任务模式), at
 * the end of its transcript: open ones always, ended ones until the person
 * writes again. Memoized: the transcript re-renders while it scrolls and
 * streams, the tasks only change with their items.
 */
export const DelegatedTaskCards = memo(function DelegatedTaskCards({
  groupJid,
  sessionId,
  personWroteAt,
}: {
  groupJid: string;
  sessionId: string;
  /** When the person last wrote in the session (`lastPersonMessageAt`). */
  personWroteAt: number;
}) {
  const ensureWorkspace = useWorkItemsStore((s) => s.ensureWorkspace);
  useEffect(() => {
    ensureWorkspace(groupJid, true);
  }, [groupJid, ensureWorkspace]);
  const items = useWorkItemsStore(
    useShallow((s) =>
      sessionDelegations(Object.values(s.items), sessionId, personWroteAt),
    ),
  );
  const running = items.filter((item) => item.status === 'open').length;

  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <m.section
          key="delegations"
          aria-label="后台任务"
          data-testid="delegated-tasks"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="mb-3"
        >
          <h2 className="mb-1.5 flex items-center gap-1.5 px-1 text-caption text-muted-foreground">
            <Layers className="size-3.5 shrink-0" aria-hidden="true" />
            后台任务
            {running > 0 && (
              <span className="tabular-nums">· {running} 个进行中</span>
            )}
          </h2>
          <ListGroup>
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <m.div
                  key={item.id}
                  layout="position"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <DelegationRow item={item} />
                </m.div>
              ))}
            </AnimatePresence>
          </ListGroup>
        </m.section>
      )}
    </AnimatePresence>
  );
});
