'use client';

import { ChevronRightIcon } from '@/components/ui/icons';
import { setLocalQuery } from '@/lib/localQuery';
import { cn } from '@/lib/utils';
import { useSyncEngine, useSyncStatus } from '@/sync/hooks';
import { connectionSummary } from './labels';

/** Estado de conexão e pendências, sempre visível na navegação. */
export function SyncStatusChip({ onNavigate }: { onNavigate?: () => void }) {
  const current = useSyncEngine();
  const status = useSyncStatus(current?.engine ?? null);
  if (!current) return null;
  const { team } = current.session;
  const pending = status.summary?.pending ?? 0;
  const conflicts = status.summary?.conflicts ?? 0;
  const attention = conflicts > 0 || status.connection === 'revoked' || status.connection === 'identity-mismatch' || status.connection === 'auth-required';
  const name = team ? team.workspaceName : 'Perfil pessoal';
  return (
    <a
      href="/app?view=sync"
      data-testid="sync-chip"
      data-connection={status.connection}
      data-pending={status.summary ? pending : undefined}
      data-conflicts={status.summary ? conflicts : undefined}
      data-profile={team ? 'team' : 'personal'}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        setLocalQuery({ view: 'sync', song: null, arranjo: null, repertorio: null, item: null, conflito: null });
        onNavigate?.();
      }}
      className={cn(
        'group flex items-center gap-3 rounded-2xl border bg-surface-overlay/60 p-3 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        attention ? 'border-danger/70 text-danger' : 'border-border text-muted hover:border-border-strong',
      )}
    >
      <span aria-hidden="true" className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold uppercase', team ? 'bg-info/15 text-info' : 'bg-accent/15 text-accent')}>
        {name.trim().charAt(0)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
        <span className="block truncate">{connectionSummary(status.connection, pending, conflicts).short}</span>
        {team && pending > 0 && <span className="block">{pending === 1 ? '1 alteração pendente' : `${pending} alterações pendentes`}</span>}
        {conflicts > 0 && <span className="block font-semibold">{conflicts === 1 ? '1 conflito' : `${conflicts} conflitos`}</span>}
      </span>
      <ChevronRightIcon size={16} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}
