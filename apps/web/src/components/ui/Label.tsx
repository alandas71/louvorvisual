import React from 'react';
import { cn } from '@/lib/utils';

interface LabelProps extends React.ComponentProps<'label'> {
  required?: boolean;
}

export function Label({ children, required, className, ...props }: LabelProps) {
  return (
    <label className={cn('mb-1 block text-xs font-semibold uppercase text-muted', className)} {...props}>
      {children}
      {required && (
        <span aria-hidden="true" className="ml-0.5 text-danger">
          *
        </span>
      )}
    </label>
  );
}
