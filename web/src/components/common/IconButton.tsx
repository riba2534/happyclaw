import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Shortcut } from './Shortcut';

type ButtonProps = ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  /** Optional shortcut rendered as keycaps inside the tooltip. */
  shortcut?: string;
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
  /** Skip the tooltip when the label is already visible nearby. */
  hideTooltip?: boolean;
}

/** Square ghost button with an accessible label and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      shortcut,
      tooltipSide = 'bottom',
      hideTooltip = false,
      variant = 'ghost',
      size = 'icon-sm',
      ...props
    },
    ref,
  ) {
    const button = (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        size={size}
        aria-label={label}
        {...props}
      >
        {icon}
      </Button>
    );
    if (hideTooltip) return button;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide}>
          {label}
          {shortcut && <Shortcut keys={shortcut} />}
        </TooltipContent>
      </Tooltip>
    );
  },
);
