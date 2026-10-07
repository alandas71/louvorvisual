import { cn } from '@/lib/utils';

const base =
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border font-semibold ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.98] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';

const variants = {
  primary: 'border-accent bg-accent text-accent-ink shadow-glow hover:border-accent-strong hover:bg-accent-strong disabled:shadow-none',
  secondary: 'border-border-strong bg-surface-overlay/60 text-foreground hover:border-muted hover:bg-surface-overlay',
  ghost: 'border-transparent text-muted hover:bg-surface-overlay hover:text-foreground',
  danger: 'border-danger/50 bg-danger/5 text-danger hover:border-danger hover:bg-danger hover:text-surface',
} as const;

// Em telas de toque os alvos crescem até a altura recomendada.
const sizes = {
  md: 'min-h-10 px-4 py-2 text-sm pointer-coarse:min-h-11',
  sm: 'min-h-8 rounded-lg px-3 py-1.5 text-xs pointer-coarse:min-h-10',
  lg: 'min-h-12 px-6 py-3 text-base',
} as const;

export function buttonClass(variant: keyof typeof variants = 'secondary', size: keyof typeof sizes = 'md', className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

/** Estado "ligado" de um botão de alternância (aria-pressed). */
export const pressedClass = 'border-accent bg-accent/12 text-accent hover:border-accent hover:bg-accent/15';
