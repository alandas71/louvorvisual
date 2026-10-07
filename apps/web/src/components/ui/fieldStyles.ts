import { cn } from '@/lib/utils';

export function fieldClass(error: string | undefined, className: string | undefined) {
  return cn(
    'w-full rounded-lg border bg-surface-raised px-4 py-2.5 text-sm text-foreground transition-colors duration-150',
    'placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:opacity-60',
    error ? 'border-danger' : 'border-border-strong',
    className,
  );
}
