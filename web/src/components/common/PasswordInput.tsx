import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { IconButton } from './IconButton';

type PasswordInputProps = Omit<ComponentProps<typeof Input>, 'type'> & {
  /** Classes for the wrapper, e.g. a width; `className` styles the input. */
  containerClassName?: string;
};

/**
 * Password field with a show/hide toggle. The toggle keeps focus in the
 * field, so revealing the password does not close the phone keyboard.
 */
export function PasswordInput({
  className,
  containerClassName,
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn('relative w-full', containerClassName)}>
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        variant="code"
        disabled={disabled}
        className={cn('pr-9', className)}
      />
      {/* Centred with margins, not a translate: the Button's active state
          shifts it by a translate, which would drop the centring mid-press
          and move the button out from under the pointer before mouseup. */}
      <IconButton
        label={visible ? '隐藏密码' : '显示密码'}
        icon={visible ? <EyeOff /> : <Eye />}
        size="icon-xs"
        hideTooltip
        disabled={disabled}
        aria-pressed={visible}
        aria-controls={props.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-1 my-auto text-muted-foreground"
      />
    </div>
  );
}
