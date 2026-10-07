import { cn } from '@/lib/utils';

export function fieldClass(error: string | undefined, className: string | undefined) {
  return cn(
    'w-full rounded-xl border bg-surface-overlay/70 px-3.5 py-2.5 text-sm text-foreground transition-[border-color,background-color,box-shadow] duration-150',
    'placeholder:text-muted hover:border-muted focus-visible:border-accent focus-visible:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:opacity-60',
    // 16 px em telas de toque: o iOS amplia a página ao focar campos menores.
    'pointer-coarse:text-base',
    error ? 'border-danger' : 'border-border-strong',
    className,
  );
}
