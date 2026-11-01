import { useId } from 'react';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { ConfirmChoice, ConfirmSelect } from '../../stores/confirm';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'danger';
  loading?: boolean;
  confirmDisabled?: boolean;
  messageClassName?: string;
  /** Radio options between the message and the buttons. */
  choices?: ConfirmChoice[];
  /** A dropdown between the message and the buttons; its value is `choice`. */
  select?: ConfirmSelect;
  choice?: string;
  onChoiceChange?: (value: string) => void;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  confirmVariant = 'primary',
  loading = false,
  confirmDisabled = false,
  messageClassName,
  choices,
  select,
  choice = '',
  onChoiceChange,
}: ConfirmDialogProps) {
  const selectId = useId();
  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription
            className={cn('whitespace-pre-line', messageClassName)}
          >
            {message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {choices && (
          <ConfirmChoices
            choices={choices}
            value={choice}
            onChange={(value) => onChoiceChange?.(value)}
          />
        )}
        {select && (
          <div className="space-y-1.5">
            <Label htmlFor={selectId} className="text-label">
              {select.label}
            </Label>
            <NativeSelect
              id={selectId}
              value={choice}
              onChange={(event) => onChoiceChange?.(event.target.value)}
              className="w-full"
            >
              {select.options.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={loading || confirmDisabled}
            variant={confirmVariant === 'danger' ? 'destructive' : 'default'}
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The radio options of a confirmChoiceDialog(). */
function ConfirmChoices({
  choices,
  value,
  onChange,
}: {
  choices: ConfirmChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={onChange}
      aria-label="选择处理方式"
      className="gap-1.5"
    >
      {choices.map((choice) => (
        <Label
          key={choice.value}
          htmlFor={`${id}-${choice.value}`}
          className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 font-normal ring-1 ring-surface-border has-data-checked:bg-surface-selected"
        >
          <RadioGroupItem
            id={`${id}-${choice.value}`}
            value={choice.value}
            className="mt-0.5"
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block text-label font-medium text-foreground">
              {choice.label}
            </span>
            {choice.description && (
              <span className="block text-caption text-muted-foreground">
                {choice.description}
              </span>
            )}
          </span>
        </Label>
      ))}
    </RadioGroup>
  );
}
