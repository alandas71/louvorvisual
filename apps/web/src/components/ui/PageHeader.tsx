import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Acima do título: caminho de volta ou contexto. */
  before?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** Cabeçalho das vistas: um só h1, descrição curta e as ações principais à direita. */
export function PageHeader({ title, description, before, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-3', className)}>
      {before}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 max-w-2xl flex-1 basis-64">
          <h1 className="text-[1.75rem] font-bold leading-tight md:text-3xl">{title}</h1>
          {description && <p className="mt-2 text-[15px] leading-relaxed text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Título de seção dentro de uma vista. */
export function SectionTitle({ id, children, hint, className }: { id?: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <h2 id={id} className="text-lg font-bold">
        {children}
      </h2>
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** Cartão padrão das seções. */
export const cardClass = 'rounded-2xl border border-border bg-surface-raised shadow-card';
/** Linha de lista clicável ou com ações. */
export const rowClass = 'rounded-2xl border border-border bg-surface-raised shadow-card transition-colors duration-150 hover:border-border-strong';

type EmptyStateProps = { icon: ReactNode; title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>;

/** Lista vazia: diz o que falta e, quando há, qual é o próximo passo. */
export function EmptyState({ icon, title, children, action, className, ...data }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border-strong px-6 py-12 text-center', className)}>
      <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        {icon}
      </span>
      {title && <p className="text-base font-bold">{title}</p>}
      <p className="max-w-md text-sm leading-relaxed text-muted" {...data}>
        {children}
      </p>
      {action}
    </div>
  );
}

/** Carregamento de uma vista ou lista. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-3 py-6 text-sm text-muted">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
      {children}
    </p>
  );
}

const TONES = {
  neutral: 'border-border-strong bg-surface-overlay text-muted',
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  info: 'border-info/40 bg-info/10 text-info',
} as const;

/** Etiqueta curta de estado. */
export function pillClass(tone: keyof typeof TONES = 'neutral', className?: string) {
  return cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', TONES[tone], className);
}

/** Aviso em caixa: erros, pendências e confirmações. */
export function noticeClass(tone: keyof typeof TONES = 'neutral', className?: string) {
  return cn('rounded-xl border px-4 py-3 text-sm leading-relaxed', tone === 'neutral' ? 'border-border-strong bg-surface-overlay text-foreground' : TONES[tone], className);
}
