import { cn } from '@/lib/utils';

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

const variants = {
  primary: 'border-accent bg-accent text-surface hover:brightness-110',
  secondary: 'border-border-strong text-foreground hover:border-accent',
  danger: 'border-danger text-danger hover:bg-danger hover:text-surface',
} as const;

const sizes = { md: 'px-4 py-2', sm: 'px-2.5 py-1.5 text-xs' } as const;

export function buttonClass(variant: keyof typeof variants = 'secondary', size: keyof typeof sizes = 'md', className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}
