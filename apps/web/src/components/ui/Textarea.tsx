import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { FieldError } from './FieldError';
import { fieldClass } from './fieldStyles';

interface TextareaProps extends React.ComponentProps<'textarea'> {
  error?: string;
}

export function Textarea({ error, className, 'aria-describedby': describedBy, ...props }: TextareaProps) {
  const errorId = useId();
  return (
    <div className="w-full">
      <textarea
        className={fieldClass(error, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(describedBy, error && errorId) || undefined}
        {...props}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
