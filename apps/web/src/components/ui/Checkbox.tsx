import React from 'react';
import { cn } from '@/lib/utils';

interface CheckboxProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  label: string;
}

export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className="flex min-h-8 cursor-pointer select-none items-center gap-3 text-sm text-foreground">
      <input type="checkbox" className={cn('h-[18px] w-[18px] shrink-0 rounded accent-accent', className)} {...props} />
      <span>{label}</span>
    </label>
  );
}
