import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { FieldError } from './FieldError';
import { fieldClass } from './fieldStyles';

interface InputProps extends React.ComponentProps<'input'> {
  error?: string;
  icon?: React.ReactNode;
}

export function Input({ error, icon, className, 'aria-describedby': describedBy, ...props }: InputProps) {
  const errorId = useId();
  return (
    <div className="w-full">
      <div className="relative">
        <input
          className={fieldClass(error, cn(icon && 'pl-10', className))}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(describedBy, error && errorId) || undefined}
          {...props}
        />
        {icon && (
          <div aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">
            {icon}
          </div>
        )}
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
