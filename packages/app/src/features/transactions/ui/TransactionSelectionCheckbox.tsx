import type React from 'react';
import { Checkbox } from '@shared/ui/checkbox';
import { cn } from '@shared/lib/utils';

export function TransactionSelectionCheckbox({
  className,
  fillCell = false,
  ...props
}: React.ComponentProps<typeof Checkbox> & {
  /** Extend the click target to the nearest positioned table cell. */
  fillCell?: boolean;
}) {
  return (
    <div className="flex size-11 shrink-0 select-none items-center justify-center">
      <Checkbox
        {...props}
        className={cn(
          // The transparent extension belongs to the checkbox itself, preserving
          // pointer modifiers for Shift/Cmd/Ctrl selection across the full target.
          "size-5 cursor-pointer select-none after:absolute after:content-[''] [&_svg]:size-4",
          fillCell
            ? 'static after:inset-0'
            : 'relative after:left-1/2 after:top-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2',
          className
        )}
      />
    </div>
  );
}
