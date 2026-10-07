import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { FieldError } from './FieldError';
import { fieldClass } from './fieldStyles';

interface SelectProps extends React.ComponentProps<'select'> {
  error?: string;
}

export function Select({ error, children, className, 'aria-describedby': describedBy, ...props }: SelectProps) {
  const errorId = useId();
  return (
    <div className="w-full">
      <select
        className={fieldClass(error, cn('cursor-pointer px-3', className))}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(describedBy, error && errorId) || undefined}
        {...props}
      >
        {children}
      </select>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
