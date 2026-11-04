import type { ReactNode } from 'react';
import { Layers, ListOrdered } from 'lucide-react';
import type { WorkMode } from '../../work-items';
import {
  ModeChoiceGroup,
  type ModeChoiceGroupProps,
  type ModeChoiceOption,
} from './InteractionModeSelector';

const OPTIONS: ModeChoiceOption<WorkMode>[] = [
  {
    value: 'single',
    title: '单任务（默认）',
    description: '消息按顺序处理，一条处理完再处理下一条。',
    icon: ListOrdered,
  },
  {
    value: 'multi',
    title: '多任务',
    description:
      '较大的任务交给后台 Worker 处理，对话不会被卡住，完成后由 Agent 汇报结果。',
    icon: Layers,
  },
];

/**
 * 工作方式: single-task (the default) or multi-task. Compact keeps one row of
 * choices and says below what the selected one means.
 */
export function WorkModeSelector({
  notice,
  ...props
}: Omit<ModeChoiceGroupProps<WorkMode>, 'legend' | 'options' | 'hint'> & {
  /** Below the choices, after what compact says about the selection. */
  notice?: ReactNode;
}) {
  const selected = OPTIONS.find((option) => option.value === props.value);
  return (
    <ModeChoiceGroup
      legend="工作方式"
      options={OPTIONS}
      hint={
        <>
          {props.compact && selected && (
            <p
              data-testid="work-mode-hint"
              className="mt-1.5 text-caption text-muted-foreground"
            >
              {selected.description}
            </p>
          )}
          {notice}
        </>
      }
      {...props}
    />
  );
}
