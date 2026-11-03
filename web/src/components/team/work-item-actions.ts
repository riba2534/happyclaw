import { toast } from 'sonner';
import { workItemTitle, workOriginWords } from '../../lib/team-mode';
import { confirmDialog } from '../../stores/confirm';
import { useWorkItemsStore } from '../../stores/work-items';
import { extractErrorMessage } from '../../utils/error';
import type { WorkItemView } from '../../work-items';

/** Confirm, then stop or approve; a failure becomes a toast. */
export async function confirmWorkItemAction(
  item: WorkItemView,
  action: 'stop' | 'approve',
) {
  const title = workItemTitle(item);
  const confirmed = await confirmDialog(
    action === 'stop'
      ? {
          title: `停止 ${title}？`,
          message: workOriginWords(item).stop,
          confirmText: '停止',
          variant: 'danger',
        }
      : {
          title: `批准 ${title} 修改？`,
          message: '批准后，执行会话可以修改文件、提交和推送代码。',
          confirmText: '批准修改',
        },
  );
  if (!confirmed) return;
  try {
    await useWorkItemsStore.getState()[action](item.id);
  } catch (err) {
    toast.error(
      `${action === 'stop' ? '停止' : '批准'}失败：${extractErrorMessage(err)}`,
    );
  }
}
