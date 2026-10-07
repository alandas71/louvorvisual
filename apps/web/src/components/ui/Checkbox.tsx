import React from 'react';
import { cn } from '@/lib/utils';

interface CheckboxProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  label: string;
}

export function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-3 text-sm text-foreground">
      <input type="checkbox" className={cn('h-4 w-4 rounded accent-accent', className)} {...props} />
      <span>{label}</span>
    </label>
  );
}
